/**
 * 品牌动画（APNG）—— **保留原色 + 真透明底**。
 *
 * ─────────────────────────────────────────────────────────────
 * ⚠️⚠️ 这里换过一次做法，值得记住为什么。
 *
 *   素材原件是**不透明黑底**的。第一版我用 CSS 遮罩
 *   （`mask-mode: luminance` + `background-color: currentColor`）把黑遮掉 ——
 *   透明是做出来了，但**遮罩只决定「哪里露出」，露出的颜色来自背景色**
 *   ⇒ 整个动画变成**单色**。读者一眼就看出来了：
 *   「开屏动画这个你做了反色之后变成了只有黑白，我需要它有颜色，
 *     只是背景的黑色没有而不是全部反色」。
 *
 *   ⇒ 现在改用 **APNG**：`scripts/prep-brand-gifs.mjs` 在离线阶段做
 *     **unpremultiply**（`alpha = max(r,g,b)`，`原色 = 观察值 / alpha`），
 *     把黑底抠成 8 位 alpha。颜色全留着，边缘也不出锯齿。
 *     顺带**比 GIF 还小**（开屏 9.31MB → 1.38MB）。
 *
 *   ⚠️ 换文件的代价是**必须配套重跑那个脚本**：这里写的是 `.png`，
 *     而它同时会删掉同名的旧 `.gif`，免得两份并存时谁也说不清用的是哪份。
 */
import { useEffect, useRef, useState } from 'react';
import { Image, View } from '@tarojs/components';

import { imageUrl } from '../../platform/data';
import { isMiniProgram } from '../../platform/env';

import './BrandGif.scss';

/**
 * 每个动画的真实时长（毫秒）。
 *
 * ⚠️ 由 `scripts/prep-brand-gifs.mjs` 从 GIF 的 Graphic Control Extension
 *    逐帧累加 delay 得到，**不是估的**。换素材要重新量。
 */
export const DUR: Record<string, number> = {
  'title-coof': 5040,
  'title-cnsr': 2700,
  'title-chealth': 4500,
  'title-cevtuo': 3870,
  'title-main': 3420,
  splash: 4500,
};

interface BrandGifProps {
  /** `static/brand/` 下的文件名（不含扩展名）。 */
  name: string;
  className?: string;
  /** 播完就淡出。主页那几枚要（读者：「显示完一次就消失」）。 */
  once?: boolean;
  /**
   * `ink` —— 这枚是**透明底 + 黑墨线稿**（`rose-mark`）。
   *          深色主题下要 `invert` 把它翻白，否则黑墨落在深色底上等于看不见。
   * ⚠️ 默认那批**不要传** —— 它们现在是带 alpha 的彩色 APNG，翻色会把颜色毁掉，
   *    而「毁掉颜色」正是读者这次提的意见。
   */
  mode?: 'color' | 'ink';
  /** 无障碍名。这是**装饰**，默认对读屏器隐藏。 */
  label?: string;
}

export default function BrandGif({
  name,
  className = '',
  once = false,
  mode = 'color',
  label = '',
}: BrandGifProps) {
  const [gone, setGone] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);
  const url = imageUrl(`static/brand/${name}.png`);

  /**
   * ⚠️⚠️ **进到看得见之前，不要下载这个文件**（2026-10-04，为国内首屏）。
   *
   *    这批是 APNG，**是整站最重的几个文件**：
   *    `title-coof` 862KB、`title-cnsr` 560KB、`title-main` 247KB、
   *    `title-cevtuo` 173KB、`title-chealth` 159KB、`splash` **1.38MB**。
   *
   *    ⚠️ 而 `background-image` 是**急加载**的 —— 浏览器不会因为它在第四屏
   *      就不下载。于是打开首页，四个板块的字标连同开屏动画
   *      **一共三兆多，在第一屏就要排队**。
   *
   *    ⇒ 用 `IntersectionObserver` 把「下载」推迟到它**快进视口**的时候
   *      （`rootMargin: 100%` ⇒ 提前一屏开始拉，进场时看不出等过）。
   *      这一条不改变任何观感，只是把字节挪到它们该来的时刻。
   *
   *    ⚠️ 没有 IO 的环境（老 WebView / 小程序）**必须立刻 arm**，
   *      否则字标永远不出现 —— 那是比慢更坏的结果。
   */
  const [armed, setArmed] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (armed) return undefined;
    const el = hostRef.current as unknown as HTMLElement | null;
    if (!el) {
      setArmed(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setArmed(true);
      },
      { rootMargin: '100% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [armed]);

  useEffect(() => {
    // ⚠️ 计时从**图上场那一刻**开始算，不是从挂载算 ——
    //    否则推迟下载会让动画还没播完就被 `bgif--gone` 淡掉。
    if (!armed || !once) return undefined;
    const ms = DUR[name] ?? 4000;
    const t = setTimeout(() => setGone(true), ms);
    return () => clearTimeout(t);
  }, [armed, once, name]);

  const cls = `bgif bgif--${mode}${gone ? ' bgif--gone' : ''} ${className}`.trim();

  /**
   * ⚠️⚠️ **小程序必须用 `<Image>`（2026-10-07）。**
   *
   * 下面那个 `<View>` + 内联 `background-image: url(远程)` 在网页上是对的，
   * 而 **WXSS 的 `background-image` 不渲染网络图片**（只认包内相对路径和 base64）
   * ⇒ 小程序里品牌动画**整块是空的**。而它看起来只是"还没到播的时候"，
   * 一句错都不报（读者原话：「主页第一页还是没什么东西」）。
   *
   * ⚠️ 判据和壁纸、字标走**同一份** `platform/env.ts`。
   * ⚠️ 无障碍属性两边都要带 —— 这是**装饰**，默认对读屏器隐藏。
   */
  if (isMiniProgram()) {
    return (
      /*
       * ⚠️ `Image` 的 props 里**没有 `role` / `aria-*`**（Taro 的类型就是这么定的），
       *    所以无障碍属性留在外面那个 `<View>` 上 —— 它也是原来就在承担这件事的元素。
       *    语义上正好：装饰图藏在一个 `aria-hidden` 的容器里。
       */
      <View
        className={cls}
        role={label ? 'img' : undefined}
        aria-label={label || undefined}
        aria-hidden={label ? undefined : 'true'}
      >
        <Image
          className="bgif__img"
          src={armed ? url : ''}
          // 网页那边是 `background-size: contain`，对应 `aspectFit`。
          mode="aspectFit"
        />
      </View>
    );
  }

  return (
    <View
      ref={hostRef as never}
      className={cls}
      style={{ backgroundImage: armed ? `url("${url}")` : undefined } as never}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
    />
  );
}
