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

export function TopBar({ title, children, root = false }: TopBarProps) {
  const bp = useBreakpoint();
  const back = !root;

  const onBack = () => {
    // ⚠️ The route we are leaving, captured before anything moves.
    const before = typeof window !== 'undefined' ? window.location.hash : '';
    const HOME = '/pages/home/index';

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

    // ⚠️ The safety net, and the reason the user was sometimes tapping twice.
    //
    // `navigateBack` reports success even when nothing moves — tapped while the
    // page is still transitioning in, or against a stack Taro has not finished
    // building, it simply does nothing and no `fail` fires. The user sees a dead
    // button and taps again. This watches the route it was trying to leave and,
    // if we are still on it, goes to the index directly. On the normal path the
    // hash has already changed and this is a no-op.
    //
    // ⚠️ 500ms, not a shorter guess. Too short and a slow-but-working pop would
    // have the index pushed on top of it, which is a worse bug than the one
    // being fixed: back would then return to the page you just left.
    if (typeof window === 'undefined' || !before) return;
    setTimeout(() => {
      if (window.location.hash === before) {
        try {
          Taro.navigateTo({ url: HOME });
        } catch {
          /* the index route is the last resort; there is nothing under it */
        }
      }
    }, 500);
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
