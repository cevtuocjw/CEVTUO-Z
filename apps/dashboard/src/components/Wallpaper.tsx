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

import { useEffect, useRef } from 'react';
import { View } from '@tarojs/components';

import { applyBackground } from '../platform/background';
// ⚠️ 画框和壁纸**是一对**：读者要的是「每个页面必须有一张图，而且都有画框」。
//    放在这里而不是每个页面各写一次 —— 五个品牌页 + 主页各写一遍的结果，
//    是有人加新页面时忘了加画框，而页面看起来**完全正常**（只是少了一件东西）。
import { GalleryFrame } from './GalleryFrame';

export function Wallpaper() {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // ⚠️ The ref is a Taro component instance in the mini program and a DOM node
    // in H5. `applyBackground` no-ops on anything without a `style`, so the mini
    // program simply renders the scrim with no photo — acceptable, since the
    // mini program has no valid image origin until the mainland server is filed
    // (see docs/HOSTING.md), and it must not throw.
    return applyBackground(ref.current as unknown as HTMLElement | null);
  }, []);

  return (
    <>
      <View className="cevtuo-wallpaper" ref={ref as never} />
      <GalleryFrame />
    </>
  );
}
