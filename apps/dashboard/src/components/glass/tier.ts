/**
 * Glass capability detection.
 *
 * Resolves which of three rendering tiers the current runtime supports, so the
 * same markup degrades gracefully instead of silently rendering wrong.
 *
 *   A — backdrop-filter with a multi-function list (blur + saturate)
 *   B — backdrop-filter with a single function only (WeChat Skyline)
 *   C — no backdrop-filter at all (opaque fallback)
 *
 * ⚠️ Every failure path lands on C, never A. A `backdrop-filter` that silently
 * does nothing leaves a near-transparent card over a busy wallpaper — far worse
 * than an opaque card. Fail opaque.
 *
 * The result is memoised: detection runs once per launch, not per component.
 */

import Taro from '@tarojs/taro';

export type GlassTier = 'a' | 'b' | 'c';

let cached: GlassTier | null = null;

/** Runtime renderer. Set by WeChat; absent everywhere else. */
interface WeChatRuntime {
  getRenderer?: () => string;
}

function rendererName(): string | null {
  try {
    const wx = (globalThis as { wx?: WeChatRuntime }).wx;
    return typeof wx?.getRenderer === 'function' ? wx.getRenderer() : null;
  } catch {
    return null;
  }
}

/**
 * CSS.supports is absent in the mini-program JSCore. Returning `null` (rather
 * than `false`) lets callers distinguish "unsupported syntax" from "we could not
 * ask", though both currently resolve to Tier C.
 */
function supportsBackdropFilter(value: string): boolean | null {
  try {
    const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
    if (typeof css?.supports !== 'function') return null;
    return css.supports('backdrop-filter', value) || css.supports('-webkit-backdrop-filter', value);
  } catch {
    return null;
  }
}

export function detectGlassTier(): GlassTier {
  if (cached) return cached;

  // Skyline accepts a single backdrop-filter function only — no multi-function
  // list, no drop-shadow, no url() — and blurs inconsistently when combined
  // with opacity. Treat it as Tier B even if the feature query says otherwise.
  if (rendererName() === 'skyline') {
    cached = 'b';
    return cached;
  }

  const multi = supportsBackdropFilter('blur(1px) saturate(1)');
  if (multi === true) {
    cached = 'a';
    return cached;
  }

  const single = supportsBackdropFilter('blur(1px)');
  if (single === true) {
    cached = 'b';
    return cached;
  }

  // Includes the `null` case: if we cannot prove the effect works, don't use it.
  cached = 'c';
  return cached;
}

/** The class to place on the root element. */
export function tierClass(tier: GlassTier): string {
  return `tier-${tier}`;
}

/**
 * Writes the tier and theme onto the root element so the SCSS ladder matches.
 *
 * `Taro.getAppBaseInfo()` is the current API — `getSystemInfoSync()` is
 * deprecated and returns fewer fields on newer base libraries.
 */
export function applyRootClasses(): GlassTier {
  const tier = detectGlassTier();

  let theme: 'dark' | 'light' = 'dark';
  try {
    const info = Taro.getAppBaseInfo();
    if (info?.theme === 'light') theme = 'light';
  } catch {
    // Older base library: keep the dark default rather than guessing.
  }

  const classes = `${tierClass(tier)} theme-${theme}`;

  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      // ⚠️ MERGE, never assign. The inline script in index.html stamps
      // `theme-light` / `theme-dark` before first paint so the wallpaper is the
      // right tone immediately. Assigning `className` here erased that and
      // replaced it with this function's answer — which on H5 comes from
      // `Taro.getAppBaseInfo()`, a different source than `matchMedia`, so the
      // two could disagree and the page would repaint the wrong theme at boot.
      //
      // Removing the stale `theme-*` first keeps this idempotent: without it,
      // repeated calls (useLaunch + every useDidShow) would accumulate both
      // theme classes and the later rule in source order would win by accident.
      const el = document.documentElement;
      el.className = el.className
        .split(/\s+/)
        .filter((c) => c && c !== 'theme-light' && c !== 'theme-dark' && !c.startsWith('tier-'))
        .concat(classes.split(' '))
        .join(' ');
    }
    // Mini programs style from the page root; set it there too.
    const page = Taro.getCurrentInstance()?.page;
    if (page) page.setData?.({ __glassRootClass: classes });
  } catch {
    // Root styling is best-effort: if it fails we simply get Tier C defaults.
  }

  return tier;
}

/** Test seam — lets the verify script exercise detection without a DOM. */
export function __resetTierCache(): void {
  cached = null;
}
