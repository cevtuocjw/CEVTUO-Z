import { Text, View } from '@tarojs/components';
import { useEffect, useRef, useState } from 'react';

import { goBack } from '../platform/nav';
import { tv, useLang, useT } from '../platform/prefs';
import { Icon } from './ChealthIcons';
import { Nowbar } from './Nowbar';

import './Cnowbar.scss';

/**
 * 底部导航条 —— **取代顶栏**，全尺寸都用。
 *
 * 读者 2026-10-05 定的版式（第 2 张参考图）：
 *   最左 `←` 返回键，然后一个 `UO` 占位按钮，其余是**这一页的各个分区**，
 *   点一下跳到那个分区。选中的长成一个深色药丸（标签 + 白圆），其余的只是圆盘。
 *
 * ⚠️ **返回和 UO 不是"分区"**，所以不参与 `activeKey` —— 它们没有"选中"这个状态。
 * ⚠️ 主页是栈底（`root`）⇒ **不渲染返回键**，和旧的 TopBar 同一条规矩。
 *
 * ── 2026-10-07 读者改的两件事 ────────────────────────────────────
 *
 * ① 「当点击 UO 时候，UO 就写小一些然后中间一个叉 X，再次点击，所有的都收回」
 *    ⇒ UO 圆盘在展开时**缩小并换成叉**（用 `x` 图标 —— 它当年就是为"关闭"画的，
 *      见 `ChealthIcons` 里那段：关闭不该用 `chev`）。
 * ② 「cnowbar 最多展示 5 个，其余的折叠堆放的感觉」
 *    ⇒ 第 6 个开始**折成一摞**（后面露两层边），点它才摊开。
 *      ⚠️ 是"折叠"不是"隐藏"：摊开的那一下要有宽度动画，不能是 `display` 切换
 *        （`display` 天生不可过渡 —— 那就是"切过去的一帧"）。
 */

export interface CnowbarItem {
  key: string;
  /** 选中时展开显示的文字。 */
  label: string;
  /**
   * 英文那一半（读者 2026-10-07：「英文的话就是所有的中文的地方全部替换为英文」）。
   * ⚠️ 缺省就退回 `label` —— 品牌名（COOF/CNSR…）本来就不翻。
   */
  labelEn?: string;
  /** 圆盘里那个字形；缺省取标签的第一个字符。 */
  glyph?: string;
  /**
   * ⚠️ 英文模式下圆盘里那个字。缺省取**已经翻译好的 `label` 的首字母** ——
   *    实测：标签翻成 `Overview` 了、圆盘里还是 `览`，而那是**页面上唯一一个
   *    还写着中文的地方**，看起来像"没翻干净"。只有刻意挑过的字形
   *    （比如 CHEALTH 的 `H`）才需要显式给这一项。
   */
  glyphEn?: string;
  /**
   * 圆盘里那枚**图标**（`ChealthIcons` 的名字）。
   *
   * ⚠️ 优先于 `glyph`。用法上的分界：**能用 SVG 就用 SVG**。
   *    `glyph` 走的是字符（`⌂`、`◐` 这种），而字符的形状/基线/宽度
   *    **取决于机器上装了什么字体** —— 读者 2026-10-07 报的
   *    「bar 上主页的 logo 不居中而且不好看」就是这个原因。
   */
  icon?: string;
}

/** ⚠️ 一条上最多摆几个分区，其余折起来。读者定的数。 */
const MAX_VISIBLE = 5;

/**
 * 窄屏上少摆一个。
 *
 * ⚠️ 为什么是**代码**而不是一条媒体查询：媒体查询只能改尺寸，改不了"摆几个"，
 *    而"装不下"的后果是**最后一个分区被圆端切掉** —— 那就是一个功能消失了，
 *    而它和"条短了一点"长得一模一样（`overflow: hidden` 之后连量都量不出来）。
 * ⚠️ 阈值 400 和 `Cnowbar.scss` 里那个媒体查询是**同一个数**，改一个要改两个；
 *    下面的探针会在 320/360/390/430 各量一次真实溢出。
 */
function useMaxVisible(): number {
  /**
   * ⚠️ 档位是**量出来的**，不是估的（`scripts/shot-cnowbar.mjs` 会扫一遍宽度，
   *    报告"最后一个孩子有没有越过条的右内边缘"）：
   *
   *      430px  余 1px 富余   · 390px  余 1px（太紧）· 360px  溢 0.3px · 320px 溢 16.3px
   *
   *    ⇒ 320/360 必须少摆一个。390 那 1px 也不可信 —— 换个字体就翻，
   *      所以 380 以下也收一档。
   */
  const pick = (w: number) => (w <= 380 ? 3 : w <= 440 ? 4 : MAX_VISIBLE);
  const [n, setN] = useState(() =>
    typeof window === 'undefined' ? MAX_VISIBLE : pick(window.innerWidth),
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    // ⚠️ 两个断点各挂一个 —— 只挂一个的话，从一个窄档直接跨到宽档（转屏）
    //    不会重新算。
    const mqs = [window.matchMedia('(max-width: 380px)'), window.matchMedia('(max-width: 440px)')];
    const on = () => setN(pick(window.innerWidth));
    on();
    for (const mq of mqs) mq.addEventListener('change', on);
    return () => {
      for (const mq of mqs) mq.removeEventListener('change', on);
    };
  }, []);
  return n;
}

export function Cnowbar({
  items,
  activeKey,
  onPick,
  root = false,
  backTo,
  onUO,
}: {
  items: CnowbarItem[];
  /** 当前分区。⚠️ 由**调用方**给 —— 它才知道滚动到第几屏了。 */
  activeKey?: string;
  onPick: (key: string) => void;
  /** 栈底（主页）—— 不渲染返回键。 */
  root?: boolean;
  /**
   * 没有上一页可 pop 时返回**哪里**（默认主页最上边）。
   *
   * ⚠️ 内页传 `homePanelUrl('coof')` 这种 —— 从 COOF 返回应当落在主页的 COOF
   *    那一屏，而不是主页封面。旧的 TopBar 就是为这件事才有这个 prop
   *    （见它 `backTo` 上那段注释：深链直接进 CAPPERR 的读者每次都要再滑一遍）。
   */
  backTo?: string;
  /** ⚠️ 可省 —— 省了就打开内置的 `Nowbar` 面板（状态 + 最近 24 小时）。 */
  onUO?: () => void;
}) {
  const [uo, setUo] = useState(false);
  const [more, setMore] = useState(false);
  /** ⚠️ `.cnb__items` —— 鼠标拖动改的是它的 `scrollLeft`（手指那半走原生滚动）。 */
  const itemsRef = useRef<HTMLElement | null>(null);

  const maxVisible = useMaxVisible();
  const shown = items.slice(0, maxVisible);
  const rest = items.slice(maxVisible);
  /**
   * ⚠️ 展开的那一摞在**页面一滚动就自己折回去**（读者：「如果滑动了，也把下边的
   *    折叠好」）。读者开始滚动，注意力已经不在条上了 —— 让一摞摊开的按钮跟着走，
   *    等于每次都换一遍宽度，那是噪声。
   * ⚠️ `passive: true`：滚动是高频事件，不设它会让主线程等这个回调。
   */
  useEffect(() => {
    if (!more) return undefined;
    const onScroll = () => setMore(false);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [more]);

  /**
   * ── 鼠标拖动（读者 2026-10-07：「可以用鼠标和手指拖动来回查看」）──────────
   *
   * ⚠️ **手指那一半不用写。** `touch-action: pan-x` 之后浏览器自己会滚，
   *    而且带惯性、带回弹、还顺带屏蔽了系统手势 —— 手写一套只会跟它打架。
   *    鼠标不一样：桌面上横向没有滚轮，`overflow-x: auto` 用鼠标**够不着**
   *    （只有触控板双指或 Shift+滚轮），所以这一半必须自己实现。
   *
   * ⚠️⚠️ **拖完那一下 `click` 必须吃掉**（而且要在 capture 阶段拦）——
   *    否则"拖着看看右边的分区"会变成"点进了某个分区"：条会跳走，
   *    而读者以为自己只是滑了一下。
   *    这是拖动实现里最容易漏掉的一步，而且**只有鼠标能触发**，手指测不出来。
   */
  useEffect(() => {
    const el = itemsRef.current;
    if (!el || typeof window === 'undefined') return undefined;
    /** ⚠️ 小于这个位移算"点击"，不算"拖动" —— 否则手抖一下分区就点不动了。 */
    const DEAD = 6;
    let down = false;
    let startX = 0;
    let startLeft = 0;
    let moved = 0;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return; // 手指交给原生滚动
      down = true;
      moved = 0;
      startX = e.clientX;
      startLeft = el.scrollLeft;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      if (moved < DEAD) return;
      el.scrollLeft = startLeft - dx;
      e.preventDefault();
    };
    const onUp = () => {
      down = false;
    };
    const onClickCapture = (e: MouseEvent) => {
      if (moved < DEAD) return;
      e.stopPropagation();
      e.preventDefault();
      moved = 0; // ⚠️ 只吃掉紧跟着的那一次
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onUp);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onUp);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, []);

  /**
   * ⚠️ **选中的那一项可能被滚到可视区外面去** —— 必须把它带回来。
   *    带不回来，"我现在在哪一屏"这条信息就会随着拖动**永久消失**
   *    （`aria-current` 还在，但没人看得见它）。
   *
   * ⚠️ 手算 `scrollLeft`，**不用 `scrollIntoView`**：后者会连带滚动**祖先** ——
   *    这条是 `position: fixed`，祖先链一直到 document，`block:'nearest'`
   *    通常能挡住，但它依赖"当时元素正好完全可见"，这种赌不值得打。
   *    用矩形差手算就只动这一个容器。
   */
  useEffect(() => {
    const el = itemsRef.current;
    if (!el) return;
    const cur = el.querySelector('[aria-current="page"]') as HTMLElement | null;
    if (!cur) return;
    const a = cur.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    // 让选中项的中心落在容器中心
    const delta = a.left - b.left - (b.width - a.width) / 2;
    const max = el.scrollWidth - el.clientWidth;
    const left = Math.max(0, Math.min(el.scrollLeft + delta, max));
    if (Math.abs(left - el.scrollLeft) < 2) return;
    el.scrollTo({ left, behavior: 'smooth' });
  }, [activeKey, more]);

  const toggleUO = () => {
    if (onUO) onUO();
    else setUo((v) => !v);
  };

  return (
    <>
    {/*
      ⚠️⚠️ `Nowbar` 必须是 `.cnowbar` 的**兄弟**，不能塞进去 ——
      `.cnowbar` 有 `backdrop-filter`，而它会让**自己成为 fixed 后代的包含块**：
      那个本该铺满视口的蒙层会只盖住这条药丸，而且**看起来完全正常**。
      （`CornerMenu` 踩过同一个坑，它当年是靠 `createPortal(document.body)` 绕的。）
    */}
    <View className="cnowbar" role="navigation" aria-label={tv("页面导航", "Page navigation")}>
      {/* ⚠️ 主页上不渲染 —— 它上面没有东西了，一个点了没反应的返回键
          比没有返回键更糟。 */}
      {!root && (
        <View
          className="cnb__btn cnb__btn--back"
          role="button"
          aria-label={tv("返回", "Back")}
          onClick={() => goBack(backTo)}
        >
          <View className="cnb__disc">
            <Text>←</Text>
          </View>
        </View>
      )}

      <View
        className="cnb__btn cnb__btn--uo"
        role="button"
        aria-label={uo ? tv("收起状态面板", "Close status panel") : tv("设备状态与最近动态", "Device status and recent activity")}
        aria-expanded={uo}
        data-open={uo ? 'true' : 'false'}
        onClick={toggleUO}
      >
        {/*
          ⚠️ 两个字形**同时在 DOM 里**，靠透明度交叉 —— 不是把文字换掉。
             换 `textContent` 是「两帧之间换了个字形」，那就是**切**
             （kinetic-web 那条：没有一帧是切过去的）。
        */}
        <View className="cnb__disc">
          <Text className="cnb__glyph cnb__glyph--uo">UO</Text>
          <Text className="cnb__glyph cnb__glyph--x">
            <Icon name="x" />
          </Text>
        </View>
      </View>

      <View className="cnb__split" />

      <View className="cnb__items" ref={itemsRef as never}>
        {shown.map((it) => (
          <Item key={it.key} it={it} on={it.key === activeKey} onPick={onPick} />
        ))}

        {rest.length > 0 && (
          // ⚠️ 摊开的那几个是**兄弟**，不是这个按钮的子元素 ——
          //    按钮里套按钮（两个 `role="button"`）是无障碍上的错，
          //    读屏会读成"一个按钮里有一个按钮"。
          <View
            className="cnb__btn cnb__btn--more"
            role="button"
            aria-label={more ? tv("收起其余分区", "Collapse the other sections") : tv(`展开其余 ${rest.length} 个分区`, `Show ${rest.length} more sections`)}
            aria-expanded={more}
            data-open={more ? 'true' : 'false'}
            onClick={() => setMore((v) => !v)}
          >
            {/*
              ⚠️「一摞」的观感 = 后面露出的两层边。它们是**装饰**（`aria-hidden`），
                 真正可点的是整个按钮。折起来时露着，摊开时收掉 —— 这样
                 "还有东西"这件事是**看得见**的，而不是靠一个 `+3` 让人猜。
            */}
            <View className="cnb__stack" aria-hidden="true">
              <View className="cnb__stack-layer" />
              <View className="cnb__stack-layer" />
            </View>
            <View className="cnb__disc">
              {/*
                ⚠️ **箭头，不是 `+N`**（读者 2026-10-07：「点 +1 这个过后，全展开，
                    但是还是显示 +1 而不是缩回，能不能改为右折现和左折现这种
                    展开的 icon」）。
                ⇒ 收起时朝**右**（还有东西在这边），展开时翻成朝**左**（收回去）。
                  ⚠️ 两个方向**同一个字形**靠 CSS 转 —— 换字形就是在两帧之间换了个
                    东西，那正是"切"。
                ⚠️ 原来那个 `+N` 是**死的**：展开之后它照旧写着 `+3`，
                    读者没法从它判断"现在再点会收起来还是继续展开"。
              */}
              <Icon name="chev" className="cnb__chev" />
            </View>
          </View>
        )}

        {more && (
          <View className="cnb__more-body">
            {rest.map((it) => (
              <Item key={it.key} it={it} on={it.key === activeKey} onPick={onPick} />
            ))}
          </View>
        )}
      </View>
    </View>
    <Nowbar open={uo} onClose={() => setUo(false)} />
    </>
  );
}

function Item({
  it,
  on,
  onPick,
}: {
  it: CnowbarItem;
  on: boolean;
  onPick: (key: string) => void;
}) {
  // ⚠️ 在**这个小件里**取 `T` —— 它是 Hook，得跟着这个组件重渲染。
  //    在父层取好再传下来也行，但那要多一个 prop，而这里只有一处要用。
  const T = useT();
  const lang = useLang();
  return (
    <View
      className="cnb__btn"
      role="button"
      aria-current={on ? 'page' : undefined}
      data-on={on ? 'true' : 'false'}
      onClick={() => onPick(it.key)}
    >
      <Text className="cnb__label">{T(it.label, it.labelEn ?? it.label)}</Text>
      <View className="cnb__disc">
        {it.icon ? (
          <Icon name={it.icon as never} />
        ) : (
          /*
           * ⚠️⚠️ `glyph` 是**单独传进来的一个字**（`览` / `架`），它不会跟着
           *    `label` 翻 —— 实测：英文模式下标签变成 `Overview` 了，
           *    圆盘里还是 `览`。而那是**页面上唯一一个还写着中文的地方**，
           *    看起来像"没翻干净"。
           * ⇒ 英文模式下**用英文标签的首字母**；只有调用方显式给了 `glyphEn`
           *    才用它（有些字形是刻意挑的，比如 CHEALTH 的 `H`）。
           */
          <Text>{lang === 'en' ? (it.glyphEn ?? it.label.slice(0, 1)) : (it.glyph ?? it.label.slice(0, 1))}</Text>
        )}
      </View>
    </View>
  );
}
