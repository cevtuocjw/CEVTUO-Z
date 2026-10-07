/**
 * Section stack — the shared layout every page is built from.
 *
 * One panel per capability, filling the viewport, snapping as you scroll. The
 * title sits in the RIGHT margin, vertically set; the rail tracks position and
 * jumps on tap; a chevron at the foot of each panel promises more below.
 *
 * ⚠️ The rail is rendered ONCE by `PageStack`, not per panel. A rail inside a
 * panel would scroll away with it.
 *
 * ⚠️ Nothing here reads `process.env` — see the note in platform/data.ts. This
 * runs in the mini program and the browser alike, so it feature-detects.
 */

import { tv } from '../platform/prefs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

// ⚠️ Required. Taro only bundles a stylesheet that some module imports, and
// nothing else pulls this one in — without this line the panels, the rail and
// the cue all render completely unstyled, with no build error to say so.
import '../styles/section.scss';

export interface Stat {
  value: string;
  label: string;
  note?: string;
}

/**
 * 数字的档位由**字符数**决定 —— 阈值不是拍脑袋，是按真机量到的宽度反推的。
 *
 * ⚠️⚠️ 起因（2026-09-28）：主页 CHEALTH 那两格接上真数据之后，
 *    `9686` 压在 `5.78h` 上，两个数字叠在一起。
 *
 * 量出来的事实（390px 视口，Playwright 读真实布局，不是估的）：
 *
 *     .stats__item   宽 118px
 *     .stats__value  字号 62.4px（= clamp(48px, 16vw, 92px) 在 390px 上的结果）
 *
 *     "7"     118px ✓        "1215"  133px ✗ 溢出 15
 *     "37m"   133px ✗        "15.7h" 159px ✗ 溢出 41
 *     "9686"  159px ✗        "5.78h" 171px ✗ 溢出 53
 *
 * ⚠️ 也就是说**凡是 3 个字符以上的值都在溢出** —— COOF 和 CAPPERR 一直如此，
 *    只是它们最长的那个值恰好排在最后一格，溢出部分落进了右边的空白里。
 *    CHEALTH 是第一个「长值在左、右边还有一格」的组合，所以第一个炸。
 *
 * ⚠️⚠️ 而它藏了这么久，是因为在此之前四格全是「—」：**一个占位符比真数据短，
 *    于是它替真数据挡了一整类版式 bug。** 这是「占位符必须长得像占位符」
 *    那条规矩的反面 —— 占位符还必须是**最坏情况**的形状。
 *
 * ⚠️ CSS 做不到「字号随自己的内容长度变」，所以只能在渲染时按字符数分档。
 *    分档而不是测量后回写：测量要等 layout、读完 DOM 再改字号，会闪一下。
 */
function statSize(value: string): string {
  const n = value.length;
  if (n <= 2) return '';
  if (n === 3) return ' stats__value--t3';
  if (n === 4) return ' stats__value--t4';
  if (n === 5) return ' stats__value--t5';
  return ' stats__value--t6';
}

export interface SectionProps {
  /** Zero-based position, rendered as "01", "02" in the margin. */
  index: number;
  /**
   * 不渲染序号（标题照常）。
   *
   * ⚠️ 首页最前面多了一屏 hero，它**不是**四个类别之一 —— 给它编「01」会让
   *    COOF 变成「02」，而读者认的编号是「COOF 是第一个」。
   *    ⇒ 那一屏不编号，序号从 COOF 起算 01。
   */
  noIndex?: boolean;
  /** Margin title. Kept short — it is set vertically and must not wrap. */
  title: string;
  lede?: string;
  stats?: Stat[];
  /** Rendered after the stat grid — charts, lists, anything page-specific. */
  children?: React.ReactNode;
  /** Suppressed on the final panel — a cue there promises nothing. */
  showCue?: boolean;
  /**
   * Makes the entire panel body the tap target.
   *
   * ⚠️ The entry point must not be a small label. Tapping the numbers, the
   * label under them, or the empty space beside them all mean the same thing to
   * the person doing it — and a 10px "打开" with a hairline border around it is
   * a target you have to aim at. The whole body is one control, because the
   * whole body is one destination.
   */
  onPress?: () => void;
  /**
   * Set vertically UNDER the title, in the same margin band.
   *
   * ⚠️ Under, and vertical, on purpose: the margin is the only place on a phone
   * where a year label costs no content width. Laying it out horizontally above
   * the grid would take a full row away from the posters.
   */
  subtitle?: string;
  /** Makes `subtitle` a control — tapping it opens the picker. */
  onSubtitlePress?: () => void;
  /**
   * Lets the panel body outgrow the 900px text measure.
   *
   * ⚠️ The 900px cap exists so a paragraph does not become a full-width stripe
   * on a desktop. A poster GRID has the opposite problem: capping it forces the
   * tiles small and the column count low. Measured on a 1440px laptop: 900px +
   * `--tile-min: 190px` gives 4 columns, which is what the user objected to.
   */
  wide?: boolean;
  /**
   * A full-panel layer painted **behind everything in this panel**.
   *
   * ⚠️ It is a sibling of `.section__body`, not a child, and that is the whole
   * point: `.section__body` is a flex column that scrolls, and it carries the
   * panel's padding. A backdrop dropped in there would be clipped to the
   * content column and would scroll with the text — which is exactly what a
   * backdrop must not do.
   *
   * ⚠️ It also must not be placed with `z-index: 0`. `.section__body` is
   * unpositioned, so a positioned `z-index: 0` sibling paints ON TOP of it —
   * covering every word in the panel while every rect and colour still reads
   * correct. The layer is responsible for its own `z-index: -1`; see
   * `HeroBackdrop.scss`.
   */
  backdrop?: React.ReactNode;
  /**
   * 这一屏**不参与进场动画**，内容一上来就是终态。
   *
   * ⚠️⚠️ 和 `backdrop` **不是一个东西**，别合并。
   *    第一版我把这条判据写成「有 `backdrop` 就跳过」，于是给 CHEALTH 那一屏
   *    加上背投玻璃（`ChealthGlass`）之后，它**顺带丢掉了进场动画** ——
   *    而这两件事本来毫无关系。
   *    ⇒ 要跳过就**明写** `noReveal`。
   *
   * 现在有两处要：主页第一屏、CNSR 第一屏 —— 读者要它们「**直接就出现**」，
   * 而它们自己的构图各有各的动画。
   */
  noReveal?: boolean;
  /**
   * The scroll cue's wording. Defaults to a bare "下滑".
   *
   * ⚠️ A generic "下滑" tells you the gesture but not the payoff. On the COOF
   * page there IS something specific below — the films themselves — and naming
   * it is what turns a decorative arrow into a reason to move.
   */
  cueText?: string;
  /** Bottom-of-panel provenance line, e.g. "更新于 2026-09-23 10:44". */
  /**
   * The freshness line under the body, as a whole sentence.
   *
   * ⚠️ Was `updatedAt`, a bare timestamp the component prefixed with 更新于.
   * That framing is wrong for CAPPERR, where there are TWO times and the
   * difference between them is the entire point: when the device last reached
   * us, and when the numbers last actually moved. The reader spent a round
   * believing a working sync was broken precisely because the only visible line
   * was the second one.
   */
  footnote?: string | null;
  /**
   * Masthead, rendered above everything else in the body.
   *
   * ⚠️ This exists because the index and a brand page were rendering the SAME
   * panel shape — a lede, two large numbers, a rule. Tapping through landed you
   * on what looked like the page you just left, which makes the navigation feel
   * broken even though it worked. A hero gives the destination its own identity.
   */
  hero?: React.ReactNode;
  /**
   * Shrinks the stat block.
   *
   * ⚠️ Pairs with `hero`. The giant numbers are the HOME page's device — they
   * are what an index panel is FOR. A brand page has a hero doing that job, so
   * repeating the 92px numerals underneath it restores exactly the sameness the
   * hero was added to break.
   */
  compact?: boolean;
  /**
   * Rendered in the same row as the stat block, to its right.
   *
   * ⚠️ A row, not a stack, for the same reason the stat block is shrunk at all:
   * the COOF overview already carries a hero, a lede, chips, a recent strip and
   * a cue, and a full-width chart underneath the numbers pushes the panel past
   * the viewport on a phone — where the cue is absolutely positioned, so the
   * overflow lands on top of it instead of scrolling.
   */
  statsAside?: React.ReactNode;
  /**
   * Shrinks the stat block a further step and stacks it in one narrow column.
   *
   * ⚠️ Distinct from `compact`. `compact` is "this page has a hero, so the
   * numbers should not shout"; `dense` is "these numbers share their row with
   * something else". Only the second one may stack them.
   */
  dense?: boolean;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/**
 * The masthead a brand page opens with.
 *
 * ⚠️ Every brand page is the same panel shape as the index that leads to it, so
 * tapping through used to land on something visually indistinguishable from the
 * page you left. This is the cheapest thing that makes a destination read as a
 * destination: a welcome line and the brand's name set large.
 */
export function PageHero({ brand, welcome = tv("欢迎来到", "Welcome to") }: { brand: string; welcome?: string }) {
  return (
    <View className="hero">
      <Text className="hero__welcome">{welcome}</Text>
      <Text className="hero__title">{brand}</Text>
    </View>
  );
}

/**
 * A single full-height panel.
 *
 * ⚠️ The chevron is a text glyph, not an icon font or an image. Both renderers
 * have `▼` in their system font, and an SVG would need a different inlining
 * strategy per target for no gain.
 */
export function Section({
  index,
  noIndex = false,
  title,
  subtitle,
  onSubtitlePress,
  lede,
  stats,
  children,
  showCue = true,
  onPress,
  wide = false,
  cueText = tv("下滑", "Scroll"),
  footnote,
  hero,
  compact = false,
  statsAside,
  dense = false,
  backdrop,
  noReveal = false,
}: SectionProps) {
  const statsClass = `stats${compact ? ' stats--compact' : ''}${dense ? ' stats--dense' : ''}`;
  const statBlocks = stats?.length ? (
    <View className={statsClass}>
      {stats.map((s) => (
        <View className="stats__item" key={s.label}>
          <Text className={`stats__value${statSize(s.value)}`}>{s.value}</Text>
          <Text className="stats__label">{s.label}</Text>
          {s.note ? <Text className="stats__note">{s.note}</Text> : null}
        </View>
      ))}
    </View>
  ) : null;

  /**
   * ⚠️⚠️ 面板自己感知「内容有没有滚到底」，并据此改那句提示。
   *
   * 起因（2026-09-28 实测）：CHEALTH 六屏里**四屏**的内容比面板高 ——
   * 运动要滚 562px、分析要滚 1353px。而提示一直写着「下滑」。
   * 读者滑一下，**滚动的是面板内部**，不是到下一屏 ——
   * 提示说的和做的是两件事，读者会以为卡住了。
   *
   * ⇒ 没到底时说「本屏还有内容」，到底了才说「下滑」。
   *   同一句话在两种状态下含义不同，所以让**状态自己决定说什么**，
   *   而不是让每个调用点自己去猜该传哪个 cueText。
   */
  const bodyRef = useRef<HTMLElement | null>(null);
  const [scrollCue, setScrollCue] = useState('');

  /**
   * ⚠️⚠️ **进场动画：这一屏滚进视口时，body 的直接子元素按顺序渐入。**
   *
   *    读者 2026-10-04：「整个网站所有地方**进入的时候都需要有顺序的渐动的
   *    动画效果，每个组件**」。
   *
   * ── 为什么做在这里，而不是每个页面各写一遍 ────────────────────
   *
   *    `Section` 是**五个页面每一屏都在用**的那个组件 —— 在这里做一次，
   *    五页全覆盖；抄五份的结果是**有一页忘了**，而那一页的症状是"没有动画"，
   *    看起来只是"这页比较素"。
   *
   * ── ⚠️ 它和已有的 `useReveal`（platform/reveal.ts）**不是同一套**，别合并 ──
   *
   *    `useReveal` 是**按选择器点名**的，而且它顺手驱动图表内部那些
   *    「柱子从基线长出来」的动画（`.pc-reveal--in .pc-bars__bar`）。
   *    这一套是**兜底**：凡是没被点名过的直接子元素，都按 `nth-child` 错开浮起。
   *
   *    ⇒ 样式里用 `:not(.reveal):not(.pc-reveal)` 把点过名的让出去。
   *      ⚠️ 判据必须是 CSS 的 `:not()`，**不能在 JS 里读 class** ——
   *        `useReveal` 在**页面组件**里调，而它是 `Section` 的父级，
   *        React 的布局副作用**子先父后** ⇒ 这里跑的时候那些类还没加上。
   *        读 class 会稳定读到"没有"，于是两套动画叠在同一个元素上。
   *
   * ── ⚠️ 极性：**没有这个类 = 可见** ────────────────────────────
   *
   *    起始态（`opacity: 0`）挂在 `--enter` 这个**由 JS 加上**的类上。
   *    所以 JS 没跑、IO 不存在、脚本挂了的时候，内容是**照常显示**的。
   *    （`useReveal` 那套正好相反 —— 它的隐藏态写在基础类里，
   *      所以它必须自己带一条"没有 IO 就全部显示"的兜底。）
   *
   * ⚠️ 有 `backdrop` 的那两屏（主页第一屏、CNSR 第一屏）**不参与**：
   *    读者要的是那两屏「**直接就出现**」，而它们自己的构图也各有动画。
   */
  const sectionRef = useRef<HTMLElement | null>(null);
  /**
   * ⚠️⚠️ **"藏起来"写进第一次渲染，不写进 effect —— 这才是那个闪的正解。**
   *
   *    读者 2026-10-04：「刷新的时候它这个块**先有了然后又重新闪现进来**，
   *    我只需要**开始没有，然后闪现进来**」。
   *
   *    真因：隐藏态挂在"由 JS 加上"的类上，而那个类是**绘制之后**才挂的
   *    ⇒ 顺序变成「先画一遍（看得见）→ 类挂上 → 动画从 opacity 0 重跑」。
   *
   *    ⚠️ 我试过两条错路，都留在这里：
   *      ① `useLayoutEffect` + **"这一屏在不在视口里"的快路径**（同步 setState）。
   *         它确实不闪了，但**当场弄坏了一个弹窗**：`verify-chealth-ui` 报
   *         「六个图标入口都能开出铺满视口的弹窗 → zones: 面板跑到视口外」。
   *         二分两次才定到是**这一条** —— 不是 `transform`、也不是折射
   *         （那两处都做过负向对照，都排除了）。
   *      ② 把进场动画改成只动 `opacity`（见 `section.scss`）—— 那是个改进，
   *         但**没有**修掉上面那条。
   *
   *    ⇒ 正解是**根本不管时序**：`--pending` 是**第一次渲染就带上的类**，
   *      所以它一定在"应用画出来的第一帧"上 —— 没有"先亮一下"可发生。
   *      ⚠️ 而且它**不依赖 JS 有没有跑过**：类是这个组件自己渲染出来的；
   *        组件没渲染就没有 `.section__body`，也就没有东西可藏。
   *
   *    ⚠️ 没有 IntersectionObserver ⇒ 直接给"已完成"（**内容照常可见，只是没动画**）。
   *      「少一个动画是遗憾，一个永远看不见的组件是 bug」—— `reveal.ts` 头上同一条。
   */
  const canReveal = !noReveal && typeof IntersectionObserver !== 'undefined';
  const [entered, setEntered] = useState(!canReveal);

  /**
   * ⚠️⚠️ **`useLayoutEffect`，不是 `useEffect` —— 这一条就是读者报的那个 bug。**
   *
   *    读者 2026-10-04：「刷新的时候它这个块**先有了然后又重新闪现进来**，
   *    动画不对，我只需要**开始没有，然后闪现进来**」。
   *
   *    真因：`useEffect` 跑在**首帧绘制之后**。而"起始态"（`opacity: 0`）
   *    是挂在 `--enter` 这个**由 JS 加上**的类上的 ⇒ 顺序变成
   *      **先画一遍（看得见）→ 类挂上 → 动画从 opacity 0 重跑**
   *    ⇒ 一次肉眼可见的"亮一下又没了"，正是「先有了然后又闪现进来」。
   *
   *    ⇒ 两处都要改：
   *      ① 用 `useLayoutEffect`：`setEntered` 在**绘制之前**同步冲刷，
   *         类在首帧就已经在了 ⇒ 第一次画出来就是 `opacity: 0`。
   *      ② **首帧之前就问一次"这一屏现在在不在视口里"** ——
   *         在的话立刻 `entered = true`（也就是"一上来就播"），
   *         不靠 IntersectionObserver 那颗"挂载之后才来"的回调。
   *         （IO 在挂载后**异步**回调，用它做"首屏"就是慢一帧＝闪一下。）
   *
   *    ⚠️ 判据用 `rootMargin` 提前**35% 视口**触发，不是 `threshold`：
   *      滚动容器一屏一屏地跳，等 15% 露出来才挂类，读者会先看到一小条真的内容
   *      再看着它消失重播 —— 同一个"闪一下"，只是短一点。
   *
   *    ⚠️ 没有 IntersectionObserver ⇒ **什么都不做**（内容照常可见，只是没有动画）。
   *      「少一个动画是遗憾，一个永远看不见的组件是 bug」—— `reveal.ts` 头上同一条。
   */
  useEffect(() => {
    if (!canReveal || entered) return undefined;
    const el = sectionRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          setEntered(true);
          io.disconnect();
        }
      },
      // ⚠️ `rootMargin` 提前**35% 视口**触发，不是 `threshold`：滚动容器一屏一屏
      //    地跳，等露出一点才挂类，读者会先看到一小条真的内容再看着它消失重播。
      { threshold: 0, rootMargin: '0px 0px 35% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canReveal, entered]);

  // ⚠️ 故意**不写依赖数组** —— 内容变高变矮（切筛选器、展开会话卡片）
  //    都不会触发 scroll 事件，只在挂载时算一次会永远停在一个错的答案上。
  //    每轮渲染重算一次的代价是读一个 scrollHeight；而 setState 同值时
  //    React 会自己跳过重渲染，不会死循环。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const sync = () => {
      // ⚠️ 4px 容差：亚像素取整会让「已经到底」也算成还剩一点，
      //    于是提示永远停在「还有内容」，而那等于没说。
      const more = el.scrollHeight - el.clientHeight - el.scrollTop;
      setScrollCue(more > 4 ? tv("本屏还有内容", "More on this screen") : '');
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  });

  return (
    <View className="section" ref={sectionRef as never}>
      {/* ⚠️ 背景层在 DOM 里**排最前**：它和壁纸同在根层叠上下文里（见
          `HeroBackdrop.scss` 那段 `z-index: -1`），同层之间谁后画谁在上，
          所以「排在壁纸之后、排在正文之前」这个顺序本身就是它的定位机制。 */}
      {backdrop}

      {/* ⚠️ Order matters for screen readers and for the visual stack: the
          margin title is absolutely positioned, so it must come first only if
          the body should read after it. It is decorative framing, so it goes
          first and the body carries the meaning. */}
      <View className="section__head">
        {noIndex ? null : <Text className="section__index">{pad2(index + 1)}</Text>}
        <Text className="section__title">{title}</Text>
        {subtitle ? (
          <Text
            className={`section__subtitle${onSubtitlePress ? ' section__subtitle--action' : ''}`}
            onClick={onSubtitlePress}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <View
        ref={bodyRef}
        className={`section__body${onPress ? ' section__body--pressable' : ''}${
          wide ? ' section__body--wide' : ''
        }${entered ? ' section__body--enter' : canReveal ? ' section__body--pending' : ''}`}
        onClick={onPress}
      >
        {hero}

        {lede ? <Text className="section__lede">{lede}</Text> : null}

        {/* ⚠️ The wrapper is emitted only when there is something to put beside
            the numbers. Wrapping unconditionally would put a div into the body
            of every panel on every page for no reason, and those panels are
            laid out by `justify-content` on their own flex column. */}
        {statsAside ? (
          <View className="section__split">
            {statBlocks}
            {statsAside}
          </View>
        ) : (
          statBlocks
        )}

        {children}

        {footnote ? <Text className="section__updated">{footnote}</Text> : null}
      </View>

      {showCue ? (
        <View className="section__cue">
          {/* ⚠️ 没滚到底时说「本屏还有内容」—— 见上面 scrollCue 的注释。
              两者都是「往下」，但一个是**在这一屏里**，一个是**到下一屏**。 */}
          <Text className="section__cue-text">{scrollCue || cueText}</Text>
          {/*
            ⚠️ 读者 2026-09-29：「给全站的下滑箭头都更改更现代一些，而且要玻璃效果」。

            ⚠️ 原来是 `<Text>▼</Text>` —— 一个 **Unicode 三角**，两件事都不对：
              ① 字形取决于装了哪套字体（这个项目在侧边栏 `▦ ≋ ▤` 上栽过一次，
                 装错字体就是方框）⇒ 换成**内联 SVG**
              ② 实心三角读起来像**段落标记**，不像「还能往下」的提示
                 ⇒ 换成细 chevron
            ⚠️ 圆片的玻璃质感在 CSS 里（`.section__cue-mark`），不在这里 ——
              它出现在四个品牌页的每一屏上，样式只有一处。
          */}
          <View className="section__cue-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                d="M6 9.5l6 6 6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Imperative handle on the stack, for controls that live outside it. */
export interface PageStackApi {
  /** Scroll panel `i` to the top of the viewport. */
  scrollTo: (i: number) => void;
}

export interface PageStackProps {
  /** Number of panels, so the rail can render one mark each. */
  count: number;
  children: React.ReactNode;
  /**
   * Filled with the scroll handle on mount.
   *
   * ⚠️ Exists because the COOF overview's year sheet has a button that must
   * land the reader on the poster panel — and the rail was previously the only
   * thing in the app that could move the stack, from inside. A ref rather than
   * context or a store: there is exactly one caller and one method.
   */
  apiRef?: React.MutableRefObject<PageStackApi | null>;
  /**
   * Panel to open on. Used when arriving at a page that was asked for a
   * specific panel — the back control sends the reader to the panel whose
   * brand they just left, not to the top of the index.
   */
  initialIndex?: number;
  /**
   * 当前在第几屏 —— 每次变化都报一次。
   *
   * ⚠️ 给**底部 Cnowbar** 用的：高亮哪一项必须跟着**滚动**走，
   *    不能只在点的时候记一个数（读者手动滑一屏，高亮就骗人了）。
   *
   * ⚠️⚠️ 下面用 ref 存回调、**不是**加进那个大 effect 的依赖：
   *    那个 effect 里带着 `initialIndex` 的跳转，多一个依赖会让它在
   *    父组件每次重渲染时重跑一遍 —— 读者会被**拽回**初始那一屏。
   */
  onActiveChange?: (index: number) => void;
  /**
   * 拿到滚动句柄（和 `apiRef` 同一样东西，这里用回调给）。
   *
   * ⚠️ 存在的理由：几个页面**没有** `useRef`（它们的 react import 里就没有），
   *    而底部条要 `scrollTo(i)`。加一个回调省掉「每页都去改 import」。
   *    ⚠️ 和 `apiRef` **可以同时用**：内部分别赋值，互不干扰。
   */
  onReady?: (api: PageStackApi) => void;
}

/**
 * The scroll container plus the nav rail.
 *
 * Track position by DIVIDING scrollTop by the container height rather than
 * reading each panel's `offsetTop`: panels are exactly one container-height
 * tall, so the arithmetic is exact, and it survives the panel list changing
 * length without re-measuring anything.
 */
export function PageStack({ count, children, apiRef, initialIndex = 0, onActiveChange, onReady }: PageStackProps) {
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLElement | null>(null);
  const height = useRef(1);

  /**
   * ⚠️ **小程序专用：跳转只能靠受控 props。**
   *
   * 小程序里 `containerRef.current` 是 **Taro 组件实例**，不是 DOM 节点 ——
   * 没有 `addEventListener`、也没有可写的 `scrollTop`。上面 `ref` 那段注释
   * 早就写了"the rail stays on panel 1"，但**同一条 ref 也是跳转的入口**：
   * 点底部条的分区、点字标回顶、点返回落回某一屏 —— **在手机上全都不动**，
   * 而且一句错都不报（读者原话：「点击导航滑动页面还是跳转不了」）。
   *
   * ⇒ 没有 DOM 时改走 `ScrollView` 的 `scrollTop` 受控属性 + `onScroll` 回读。
   * ⚠️ 判据是**能力探测**（有没有 `scrollTop`/`addEventListener`），不是平台名 ——
   *    不新增一个平台判断，也不会因为 Taro 改了 ref 语义就失准。
   */
  const [jumpTop, setJumpTop] = useState<number | null>(null);

  /**
   * 一屏多高。
   * ⚠️ 小程序里量不到 `clientHeight`（容器不是 DOM 节点）⇒ 退回系统窗口高。
   */
  const measure = useCallback(() => {
    const el = containerRef.current as unknown as HTMLElement | null;
    const h = el && typeof el.clientHeight === 'number' ? el.clientHeight : 0;
    if (h > 1) {
      height.current = h;
      return;
    }
    try {
      height.current = Taro.getSystemInfoSync().windowHeight || 1;
    } catch {
      height.current = 1;
    }
  }, []);

  /** 跳到第 i 屏。**两条路**：有 DOM 直接写；没有（小程序）走受控 props。 */
  const goTo = useCallback(
    (i: number, smooth: boolean) => {
      measure();
      const top = i * height.current;
      const el = containerRef.current as unknown as HTMLElement | null;
      if (el && typeof el.scrollTo === 'function') {
        el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
        return;
      }
      if (el && typeof el.scrollTop === 'number') {
        el.scrollTop = top;
        return;
      }
      setJumpTop(top); // 小程序
    },
    [measure],
  );

  // ⚠️ 回调走 ref（见 props 上那段）：加进依赖会让 `initialIndex` 的跳转重跑。
  const activeCb = useRef(onActiveChange);
  useEffect(() => {
    activeCb.current = onActiveChange;
  }, [onActiveChange]);

  const readyCb = useRef(onReady);
  useEffect(() => {
    readyCb.current = onReady;
  }, [onReady]);

  // ⚠️ Smooth, unlike the rail's own jump. The rail is a position indicator you
  // nudge; this handle is called by a button whose label PROMISES a journey
  // ("查看 COOF2026"), and teleporting after a promise of movement reads as the
  // sheet having closed onto nothing.
  useEffect(() => {
    const api: PageStackApi = {
      scrollTo: (i: number) => goTo(i, true),
    };
    if (apiRef) apiRef.current = api;
    // ⚠️ 没有 apiRef 的页面靠这条拿到句柄（见 props 上 `onReady` 那段）。
    readyCb.current?.(api);
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef]);

  // ⚠️ The rail is a real control, so tapping it must scroll the container.
  // `scrollTo` is called on the DOM node directly because Taro's `pageScrollTo`
  // targets the WINDOW, and our scroller is a `ScrollView` — a different
  // element entirely, and the window never moves.
  const scrollTo = useCallback((i: number) => goTo(i, false), [goTo]);

  /**
   * ⚠️ 滚动事件**两边都要用**：
   *   · H5 —— DOM 监听已经在做同一件事，这里重复一次是幂等的（同一个算式）；
   *   · 小程序 —— 这是**唯一**能拿到滚动位置的路（那边没有 DOM 监听）。
   */
  const onStackScroll = useCallback(
    (e: { detail?: { scrollTop?: number } }) => {
      const st = e?.detail?.scrollTop;
      if (typeof st !== 'number') return;
      // ⚠️ 到达目标后把受控值清掉 —— 否则再点**同一屏**时值没变，不会触发跳转。
      if (jumpTop !== null && Math.abs(st - jumpTop) <= 2) setJumpTop(null);
      measure();
      const i = Math.round(st / height.current);
      setActive(i);
      activeCb.current?.(i);
    },
    [jumpTop, measure],
  );

  useEffect(() => {
    const el = containerRef.current as unknown as HTMLElement | null;
    if (!el) return;

    /*
     * ⚠️⚠️ **小程序：这个 ref 不是 DOM 节点**（是 Taro 组件实例）——
     *    没有 `addEventListener`，`scrollTop` 也写不进去。
     *    下面整套「挂监听 + 命令式跳转」在手机上一步都跑不了，
     *    而且 `el.addEventListener` 那一行会**直接抛**。
     * ⇒ 提前返回。位置改由 `ScrollView` 的 `onScroll` 报（见 `onStackScroll`），
     *    跳转走 `goTo`（它自己会挑受控 props 那条路）。
     */
    if (typeof el.addEventListener !== 'function') {
      measure();
      if (initialIndex > 0) {
        setActive(initialIndex);
        activeCb.current?.(initialIndex);
        goTo(initialIndex, false);
      }
      return;
    }

    measure();

    // ⚠️ Jump instantly, and BEFORE the scroll listener is attached.
    // A smooth scroll here would animate the index from the top panel down
    // every time someone pressed back out of a brand page — a journey the
    // reader did not ask for and has already taken once.
    /**
     * ⚠️⚠️ **偶发不生效，2026-10-04 抓到的，补一次下一帧的重跳。**
     *
     *    实测：同一段代码连跑三次，有一次 `scrollTop` 停在 **0**（页面留在第一屏），
     *    另外两次是 3600。而"回品牌页"那条路（`homePanelUrl`）走的就是这里 ——
     *    读者会看到**点返回有时候落在封面上**。
     *
     *    真因是这一行：
     *        `height.current = el.clientHeight || 1`
     *    布局还没量准（`clientHeight` 读到 **0**）时它退化成 **1**，
     *    于是这一跳只滚 `5 × 1 = 5px` —— 而 `.stack` 是
     *    `scroll-snap-type: y mandatory`，**5px 被吸回 0**，
     *    看起来就和"没跳"一模一样，而且不报任何错。
     *
     *    ⇒ `jump()` 是幂等的（直接写 `scrollTop`），多跳一次没有副作用；
     *      下一帧布局一定已经稳定，那一次必然是对的。
     *      ⚠️ 不用定时器：`requestAnimationFrame` 和绘制同一帧节奏，
     *        而定时器会在这段空隙里让读者看到第一屏闪一下。
     *
     * ⚠️⚠️ **如实记：这一行没有验证过。**
     *    放回去（`requestAnimationFrame(jump)` 注释掉）跑 6 次、留着跑 6 次，
     *    **12 次全部是 3600** —— 那个偶发一次都没再出现。
     *    ⇒ 它是**无害的防守**（针对 `clientHeight || 1` 那个退化分支：
     *      `clientHeight` 真的是 0 时这一跳只滚 5px，会被 scroll-snap 吸回 0），
     *      **不是"已修好的 bug"**。哪天它再出现，先来这里量 `clientHeight`。
     */
    const jump = () => {
      measure();
      el.scrollTop = initialIndex * height.current;
    };
    if (initialIndex > 0) {
      jump();
      setActive(initialIndex);
      activeCb.current?.(initialIndex);
      requestAnimationFrame(jump);
    }

    const onScroll = () => {
      // Guard against a zero height during the first paint, which would make
      // this a division by zero and pin the rail to the last panel.
      if (height.current <= 1) measure();
      const i = Math.round(el.scrollTop / height.current);
      setActive(i);
      // ⚠️ 一起报出去 —— 底部 Cnowbar 的高亮跟着**滚动**走（见 props 上那段）。
      activeCb.current?.(i);
    };

    el.addEventListener('scroll', onScroll, { passive: true });

    // ⚠️ Re-measure on resize. Rotating the Fold or unfolding it changes the
    // panel height, and a stale value would make every rail jump land between
    // two panels.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        // ⚠️ Re-measure only. Re-applying `initialIndex` here would yank the
        // reader back every time the Fold is unfolded.
        measure();
      });
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, []);

  return (
    <>
      <ScrollView
        className="stack"
        scrollY
        /*
         * ⚠️ **小程序唯一能用的跳转入口。** H5 上 Taro 把这两个属性映射成
         *    `scrollTop` 赋值/平滑滚动，和原来手写的行为等价，所以无条件给。
         * ⚠️ `jumpTop` 必须是 `undefined` 而不是 `null` —— Taro 会把它拼进
         *    组件属性，`null` 在某些版本下会被序列化成字符串 "null"。
         */
        scrollTop={jumpTop ?? undefined}
        scrollWithAnimation
        onScroll={onStackScroll as never}
        // ⚠️ `ref` here reaches the ScrollView's inner element in H5. In the
        // mini program it is a Taro component instance, so the DOM listener
        // below simply never attaches and the rail stays on panel 1 — the
        // layout still works, only the indicator is static.
        ref={containerRef as never}
      >
        {children}
      </ScrollView>

      {count > 1 ? (
        <View className="rail">
          {Array.from({ length: count }, (_, i) => (
            <View
              key={i}
              className={`rail__dot ${i === active ? 'rail__dot--on' : ''}`}
              onClick={() => scrollTo(i)}
            >
              <View className="rail__dot-mark" />
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}
