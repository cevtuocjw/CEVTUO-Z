/**
 * Foldable breakpoint tracking.
 *
 * Galaxy Z Fold 5:
 *   cover screen ~361dp  → compact
 *   unfolded     ~673dp  → medium
 *   tablet / H5  ≥840dp  → expanded
 *
 * Tiers are keyed on WIDTH ONLY. The inner screen's natural orientation is
 * landscape-ish (2176x1812), so conditioning on orientation would make the whole
 * layout jump when the device is merely rotated.
 *
 * ⚠️ `Taro.getWindowInfo()` is the current API. `getSystemInfoSync()` is
 * deprecated and returns fewer fields on newer base libraries.
 * ⚠️ Skyline does not fire width media queries, which is one more reason the app
 * stays on the WebView renderer. `onWindowResize` fires on unfold regardless.
 */

import Taro from '@tarojs/taro';
import { useEffect, useMemo, useState } from 'react';

export type Breakpoint = 'compact' | 'medium' | 'expanded';

/** Must match $bp-medium / $bp-expanded in styles/tokens.scss. */
export const BP_MEDIUM = 600;
export const BP_EXPANDED = 840;

export interface BreakpointInfo {
  tier: Breakpoint;
  width: number;
  height: number;
  /** True on the unfolded inner screen or wider. */
  isUnfolded: boolean;
  /** Column count every page's block grid should use at this tier. */
  columns: 1 | 2 | 3;
}

export function tierFor(width: number): Breakpoint {
  if (width >= BP_EXPANDED) return 'expanded';
  if (width >= BP_MEDIUM) return 'medium';
  return 'compact';
}

function columnsFor(tier: Breakpoint): 1 | 2 | 3 {
  if (tier === 'expanded') return 3;
  if (tier === 'medium') return 2;
  return 1;
}

function readWindow(): { width: number; height: number } {
  try {
    const info = Taro.getWindowInfo();
    return { width: info.windowWidth, height: info.windowHeight };
  } catch {
    return { width: 375, height: 812 };
  }
}

export function useBreakpoint(): BreakpointInfo {
  const [size, setSize] = useState(readWindow);

  useEffect(() => {
    const onChange = (res: { size?: { windowWidth: number; windowHeight: number } }) => {
      if (!res?.size) return;
      setSize({ width: res.size.windowWidth, height: res.size.windowHeight });
    };

    try {
      Taro.onWindowResize(onChange);
    } catch {
      // Not supported on this base library — the initial size still applies.
    }

    return () => {
      try {
        Taro.offWindowResize(onChange);
      } catch {
        /* noop */
      }
    };
  }, []);

  return useMemo(() => {
    const tier = tierFor(size.width);
    return {
      tier,
      width: size.width,
      height: size.height,
      isUnfolded: tier !== 'compact',
      columns: columnsFor(tier),
    };
  }, [size.width, size.height]);
}
