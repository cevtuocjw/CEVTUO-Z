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

  return <View className="cevtuo-wallpaper" ref={ref as never} />;
}
