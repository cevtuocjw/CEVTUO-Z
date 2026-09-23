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
}

/**
 * Whether this page is the bottom of the stack.
 *
 * ⚠️ Wrapped in try/catch: `getCurrentPages` is unavailable during the very
 * first render in some base libraries, and a throw here would take down the
 * whole page rather than just hiding a button.
 */
function canGoBack(): boolean {
  try {
    return (Taro.getCurrentPages()?.length ?? 0) > 1;
  } catch {
    return false;
  }
}

export function TopBar({ title, children }: TopBarProps) {
  const bp = useBreakpoint();
  const back = canGoBack();

  const onBack = () => {
    try {
      Taro.navigateBack();
    } catch {
      // No stack to pop. Nothing useful to do, and throwing here would be worse
      // than a button that quietly does nothing.
    }
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
