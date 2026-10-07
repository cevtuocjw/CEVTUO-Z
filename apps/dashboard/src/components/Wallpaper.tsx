/**
 * The background photo layer.
 *
 * A component rather than a bare `<View className="cevtuo-wallpaper" />` because
 * the image URL has to be resolved at runtime — see platform/background.ts for
 * why neither a stylesheet rule nor a CSS variable can do it correctly.
 *
 * ⚠️ Only the IMAGE is set here. The scrim (the per-theme gradient that keeps
 * type legible over a variable photo) stays in styles/wallpaper.scss, layered on
 * top of this inline image and inherited through the same custom properties as
 * the rest of the theme.
 */

import { useEffect, useRef, useState } from 'react';
import { Image, View } from '@tarojs/components';
import { useDidShow } from '@tarojs/taro';

import { applyBackground, backgroundUrl } from '../platform/background';
import { isMiniProgram } from '../platform/env';
import { onGalleryReroll, rerollGallery } from '../platform/gallery';
// ⚠️ 画框和壁纸**是一对**：读者要的是「每个页面必须有一张图，而且都有画框」。
//    放在这里而不是每个页面各写一次 —— 五个品牌页 + 主页各写一遍的结果，
//    是有人加新页面时忘了加画框，而页面看起来**完全正常**（只是少了一件东西）。
import { GalleryFrame } from './GalleryFrame';

export function Wallpaper() {
  const ref = useRef<HTMLElement | null>(null);

  /**
   * ⚠️⚠️ **小程序：`background-image` 不渲染网络图片**（WXSS 只认包内相对路径
   *    和 base64）⇒ 壁纸整张是**空的**。
   *
   * 这里原来那段注释写着「小程序没有可用的图片源，所以只画 scrim 没有照片，
   * 可以接受」—— 那条假设**已经过期了**：域名早备案好了，数据都能取回来。
   * 而它掩盖了一个看着不像 bug 的症状：**整页没有背景**（读者原话
   * 「主页第一页还是没什么东西」）。
   *
   * ⚠️ 判据就在同一屏里：**带画框的图正常，壁纸和品牌动画是空的** ——
   *    差别正是前者走 `<Image src>`、后者走 `background-image`。
   *
   * ⇒ 小程序改用 `<Image>`。而 `<Image>` 的 `src` 是**渲染期**定的，
   *    所以「换一批」必须触发重渲染（订 `onGalleryReroll`）。
   */
  const [, setEpoch] = useState(0);
  useEffect(() => {
    if (!isMiniProgram()) return undefined;
    return onGalleryReroll(() => setEpoch((n) => n + 1));
  }, []);

  useEffect(() => {
    // ⚠️ H5：这个 ref 是 DOM 节点，`applyBackground` 把**照片 + scrim**一次写进
    //    `background-image`。小程序里它是 Taro 组件实例、写不进去 —— 照片那半
    //    由下面的 `<Image>` 负责（见上）。
    return applyBackground(ref.current as unknown as HTMLElement | null);
  }, []);

  /**
   * ⚠️⚠️ **换一批的触发点：每次"这一页又被显示出来"。**
   *
   *    读者 2026-10-04：「现在的每次链接对于 chrome 的地址栏 enter 刷新一下都会让
   *    第一屏幕会变色，很好的，但是**下边的背景和画框要每次点击刷新键才会**，
   *    我希望是**用户下拉或者返回或者在地址栏 enter 时候都会变化**」。
   *
   * ── 为什么是 `useDidShow`，不是 `hashchange` / `pageshow` / 存储 ────
   *
   *    判据来自**已经成立的事实**：第一屏（`HeroBackdrop`）在三种情况下都变色了，
   *    而它用的就是 `useDidShow`。⇒ 这个钩子**恰好**覆盖了读者要的那三种进入
   *    （下拉 / 返回 / 地址栏 enter），别的都不用猜。
   *
   *    ⚠️ 反面例子：`hashchange` 要求在**同一个文档里 hash 真的变了**，
   *      地址栏 Enter 打的是同一个 URL —— hash 没变，事件根本不来。
   *      `pageshow` 只在真正的加载/bfcache 恢复时来，也对不上。
   *      （`gallery.ts` 里那段注释记着 bfcache 那一类坑。）
   *
   * ⚠️ **第一次跳过**：模块加载时 `gallery.ts` 已经洗过一次牌了，
   *    不跳的话首帧会先画 A 再换成 B —— 一次肉眼可见的闪。
   *    （和 `pages/home/index.tsx` 里 `heroEntry` 那次跳过是同一个理由。）
   *
   * ⚠️ 放在 `Wallpaper` 里而不是五个页面各写一遍：它是**每一页都挂**的组件，
   *    而「哪一页忘了写」的症状是**那一页不换图**，看起来只是"这次没随到新的"。
   */
  const firstShow = useRef(true);
  useDidShow(() => {
    if (firstShow.current) {
      firstShow.current = false;
      return;
    }
    rerollGallery();
  });

  return (
    <>
      <View className="cevtuo-wallpaper" ref={ref as never}>
        {isMiniProgram() ? (
          <Image className="cevtuo-wallpaper__photo" src={backgroundUrl()} mode="aspectFill" />
        ) : null}
        {/* ⚠️ 玻璃流动层 —— 是**子元素**不是背景的一部分，因为它要动，
            而背景是 JS 一次写完就不动的（见 platform/background.ts）。
            为什么要它、为什么不能靠调淡白色遮罩解决，见
            styles/wallpaper.scss 里那段注释。 */}
        <View className="cevtuo-glass" />
      </View>
      <GalleryFrame />
    </>
  );
}
