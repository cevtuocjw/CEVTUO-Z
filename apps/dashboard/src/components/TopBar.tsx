/**
 * Persistent top bar.
 *
 * Always present, on every page, with a back control that appears only when
 * there is somewhere to go back to.
 *
 * ⚠️ `Taro.getCurrentPages()` is what decides that, not `window.history`.
 * Taro's H5 router keeps its own page stack — and in the mini program there is
 * no `window` at all — so reading the browser history would give a different
 * answer per target and, worse, would offer "back" on the entry page where
 * pressing it leaves the app.
 *
 * ⚠️ Navigation goes through `Taro.navigateBack()`, which pops Taro's stack. The
 * alternative (`history.back()`) would move the browser's history without Taro
 * knowing, so the next `navigateTo` would build on a stale stack.
 */

import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { useBreakpoint } from '../hooks/useBreakpoint';

export interface TopBarProps {
  /** Shown in the centre-left. Kept short — this bar is fixed height. */
  title: string;
  /** Right-hand slot for page-specific controls (view switches, filters). */
  children?: React.ReactNode;
  /** The index itself — there is nowhere above it, so it offers no way back. */
  root?: boolean;
  /**
   * Where "back" goes when there is no page to pop.
   *
   * ⚠️ Not always the index's first panel. Deep-linking straight into CAPPERR
   * and pressing back used to land on the home page's TOP — panel 1, COOF —
   * because that is what `navigateTo('/pages/home/index')` renders. The reader
   * had come from CAPPERR and had to swipe back down to it every time.
   *
   * A pop keeps the previous page's scroll position by itself, so this only
   * matters on the push path — but it is the push path that a shared link, a
   * bookmark or a refresh always takes.
   */
  backTo?: string;
}

/**
 * Whether this page is the bottom of the stack.
 *
 * ⚠️ Wrapped in try/catch: `getCurrentPages` is unavailable during the very
 * first render in some base libraries, and a throw here would take down the
 * whole page rather than just hiding a button.
 */
function stackDepth(): number {
  try {
    return Taro.getCurrentPages()?.length ?? 0;
  } catch {
    return 0;
  }
}

export function TopBar({ title, children, root = false, backTo }: TopBarProps) {
  const bp = useBreakpoint();
  const back = !root;

  const onBack = () => {
    // ⚠️ The route we are leaving, captured before anything moves.
    const before = typeof window !== 'undefined' ? window.location.hash : '';
    const HOME = backTo ?? '/pages/home/index';

    try {
      // ⚠️ Pop when there is a stack, otherwise go to the index.
      //
      // Every page here is deep-linkable — the URLs are shared, and the app was
      // opened at a sub-page more than once during development. With a pop-only
      // handler those arrivals showed no back control at all (the wordmark
      // branch), leaving the browser button as the only way out, which on a
      // phone is not on screen. Falling back to the index gives the same
      // destination a pop would have reached anyway.
      if (stackDepth() > 1) Taro.navigateBack({ fail: () => Taro.navigateTo({ url: HOME }) });
      else Taro.navigateTo({ url: HOME });
    } catch {
      try {
        Taro.navigateTo({ url: HOME });
      } catch {
        // Nothing useful to do; throwing here would be worse than a button that
        // quietly does nothing. The net below still runs.
      }
    }

    // ⚠️ The safety net, and why it RETRIES THE POP rather than navigating home.
    //
    // `navigateBack` reports success even when nothing moves — tapped while the
    // page is still transitioning in, or against a stack Taro has not finished
    // building, it does nothing and no `fail` fires. The user sees a dead button
    // and taps again; that was the original complaint.
    //
    // ⚠️⚠️ The first version of this net called `navigateTo(HOME)` after 500ms.
    // On a LIGHT page the pop finishes well inside 500ms, so it never ran. On
    // the CNSR page — four nested date trees, a heatmap and a timeline to tear
    // down — the pop is still in flight at 500ms, the net fired, and home was
    // PUSHED on top. That is a forward page transition, so the user saw CNSR's
    // back animate differently from COOF's on a button that had actually
    // worked. Confirmed by comparing the two pages: same code, different
    // animation, and the difference tracked page weight exactly.
    //
    // So the net re-issues the pop — same direction, same animation — and only
    // falls back to pushing the index if a second attempt also leaves us here,
    // which means the stack really is unusable rather than merely slow.
    if (typeof window === 'undefined' || !before) return;

    const stillHere = () => window.location.hash === before;

    setTimeout(() => {
      if (!stillHere()) return;
      try {
        if (stackDepth() > 1) Taro.navigateBack({ fail: () => Taro.navigateTo({ url: HOME }) });
        else Taro.navigateTo({ url: HOME });
      } catch {
        /* the fallback below is the last resort */
      }
      setTimeout(() => {
        if (!stillHere()) return;
        try {
          Taro.navigateTo({ url: HOME });
        } catch {
          /* nothing under the index; there is nowhere further to go */
        }
      }, 700);
    }, 450);
  };

  return (
    <View className="topbar">
      <View className="topbar__left">
        {back ? (
          <View className="topbar__back" onClick={onBack}>
            {/* ⚠️ A text glyph, not an icon font or an SVG. Both renderers have
                it in their system font, and an SVG would need a different
                inlining strategy per target for no gain. */}
            <Text className="topbar__back-mark">←</Text>
            <Text className="topbar__back-label">返回</Text>
          </View>
        ) : (
          // ⚠️ A wordmark, not empty space. Without it the title would sit hard
          // against the left edge on the entry page and shift sideways on every
          // navigation, because the back control appears and disappears.
          <View className="topbar__mark">
            <Text className="topbar__mark-text">Z</Text>
          </View>
        )}
        <Text className="topbar__title">{title}</Text>
      </View>

      <View className="topbar__right">
        {children}
        {/* The viewport width is genuinely useful while tuning the foldable
            layout, and this is the only chrome that is always on screen. */}
        <Text className="topbar__meta">
          {bp.width}×{bp.height}
        </Text>
      </View>
    </View>
  );
}
