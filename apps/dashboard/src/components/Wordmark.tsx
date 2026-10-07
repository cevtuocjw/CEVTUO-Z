import { Text, View } from '@tarojs/components';
import { useEffect, useState } from 'react';

import { assetUrl } from '../platform/data';
import { isMiniProgram } from '../platform/env';
import { goHome } from '../platform/nav';

import './Wordmark.scss';

/**
 * 常驻的站名 —— 顶栏被底部 Cnowbar 取代之后，**页面身份由它来说**。
 *
 * 读者 2026-10-05：用 `Ela Sans Regular Italic` 写「CEVTUO Z」（中间空一格）、
 * 大、无背景、一直在、居中，点一下回主页最上边。
 *
 * ⚠️⚠️ **许可**：Ela Sans 是**商业字体**（TypeType）。读者把它用在自己的站点上、
 *    字体文件在他自己的机器上 —— 这是**他本人的决定**，记在这里是为了
 *    下一个人知道这不是疏忽，**不要"顺手"换成一个开源衬线体**。
 *    想换：改 `FONT_FAMILY` 和下面的 `@font-face`，别的都不用动。
 */

const FONT_FAMILY = 'Ela Sans';

/**
 * ⚠️⚠️ **小程序不走反色混合（2026-10-07，真模拟器截图实测）。**
 *
 * 这个字标是**纯白** + `mix-blend-mode: difference` —— 反色是**靠混合**实现的。
 * 而小程序里那段混合不生效 ⇒ 它就退回成"纯白字"⇒ 浅色背景上
 * **白字压白底，整个字标看不见**（首屏那一大片本来该有「CEVTUO Z」，实际空着）。
 *
 * ⇒ 小程序退回普通墨色。判据走 `platform/env.ts` 那一份（全站唯一）。
 */
const PLAIN_INK = isMiniProgram();
/** 相对仓库根的路径 —— 交给 `assetUrl()` 拼运行时前缀（见下面那段）。 */
const FONT_PATH = 'static/fonts/ela-sans-italic.ttf';

/**
 * 注入 `@font-face`，**只做一次**。
 *
 * ⚠️ 为什么用 JS 而不是写在 scss 里：静态资源全部走 `assetUrl()`（运行时前缀，
 *    兼容子路径部署和国内镜像）。CSS 的 `url()` 由 webpack 解析、
 *    Taro 的 `staticDirectory` 拷贝又不经过 webpack ⇒ 写死路径在子路径/镜像上
 *    会 404，而且**字体失败是静默的**（回落到下一个 family，看起来只是"字体不对"）。
 *
 * ⚠️ 字符串拼接而不是模板字符串：这个仓库被模板字符串坑过三次
 *    （`bun -e` / `page.evaluate` 里反引号提前结束），一律避开。
 */
let fontInjected = false;

function ensureFont(): void {
  if (fontInjected || typeof document === 'undefined') return;
  fontInjected = true;

  const url = assetUrl(FONT_PATH);

  // 先 preload：字标是**首屏第一眼**要的东西，等 CSSOM 解析完再请求会闪一下系统字体。
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'font';
  link.type = 'font/ttf';
  // ⚠️ 同源字体不需要 `crossorigin` —— 加了反而会变成一次多余的 CORS 请求
  //    （而 `assetUrl` 给的就是同源）。跨域时才需要。
  link.href = url;
  document.head.appendChild(link);

  const style = document.createElement('style');
  style.setAttribute('data-cnw-font', FONT_FAMILY);
  style.textContent =
    "@font-face{font-family:'" + FONT_FAMILY + "';" +
    "src:url('" + url + "') format('truetype');" +
    'font-style:italic;font-weight:400;font-display:swap}';
  document.head.appendChild(style);
}

export function Wordmark({ onHome }: {
  /**
   * 主页自己传 —— 已经在主页时**不导航**，直接滚回最上边那一屏。
   * 别的页面不传，走 `goHome()`（导航到主页，且不带 `?panel=` ⇒ 落在 hero）。
   */
  onHome?: () => void;
}) {
  ensureFont();

  /*
   * ⚠️ **「第一页居中」**（读者 2026-10-07：「然后 CEVTUO Z 改为第一个页面
   *    居中的位置，其余的不变」）。
   *
   * 做法是**只由滚动位置驱动的一个属性**，没有新增任何数据流：
   *   字标本体是 `position: fixed`，所以"居中"只能是"在**主页第一屏**时居中" ——
   *   一旦滚到第二屏，它必须回到顶上，否则它会悬在别人那一屏的正中间。
   *
   * ⚠️ 判据用**第一屏的矩形**，不用 `scrollTop`：`--cnw-h` 是 rem 化的，
   *    换个视口/字号，`scrollTop` 该是多少就变了，而"第一屏在不在视口中间"
   *    这个说法在任何尺寸下都成立。
   * ⚠️ 滚动回调必须过 `requestAnimationFrame` —— 它是高频事件，直接在里面
   *    读 `getBoundingClientRect` 会强制同步布局（每一帧一次）。
   */
  const [hero, setHero] = useState(false);

  useEffect(() => {
    if (!onHome || typeof window === 'undefined') return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const stack = document.querySelector('.stack') as HTMLElement | null;
      const first = stack?.querySelector('.section') as HTMLElement | null;
      if (!first) return setHero(true);
      const r = first.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      setHero(Math.abs(r.top + r.height / 2 - vh / 2) < vh * 0.25);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const stack = document.querySelector('.stack') as HTMLElement | null;
    measure();
    (stack ?? window).addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      (stack ?? window).removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [onHome]);

  return (
    <View className="wordmark">
      <Text
        className={`wordmark__text${PLAIN_INK ? ' wordmark__text--plain' : ''}`}
        data-hero={hero ? 'true' : 'false'}
        onClick={() => (onHome ? onHome() : goHome())}
      >
        CEVTUO Z
      </Text>
    </View>
  );
}
