/**
 * Section stack — the shared layout every page is built from.
 *
 * One panel per capability, filling the viewport, snapping as you scroll. The
 * title sits in the RIGHT margin, vertically set; the rail tracks position and
 * jumps on tap; a chevron at the foot of each panel promises more below.
 *
 * ⚠️ The rail is rendered ONCE by `PageStack`, not per panel. A rail inside a
 * panel would scroll away with it.
 *
 * ⚠️ Nothing here reads `process.env` — see the note in platform/data.ts. This
 * runs in the mini program and the browser alike, so it feature-detects.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';

// ⚠️ Required. Taro only bundles a stylesheet that some module imports, and
// nothing else pulls this one in — without this line the panels, the rail and
// the cue all render completely unstyled, with no build error to say so.
import '../styles/section.scss';

export interface Stat {
  value: string;
  label: string;
  note?: string;
}

export interface SectionProps {
  /** Zero-based position, rendered as "01", "02" in the margin. */
  index: number;
  /** Margin title. Kept short — it is set vertically and must not wrap. */
  title: string;
  lede?: string;
  stats?: Stat[];
  /** Rendered after the stat grid — charts, lists, anything page-specific. */
  children?: React.ReactNode;
  /** Suppressed on the final panel — a cue there promises nothing. */
  showCue?: boolean;
  /**
   * Makes the entire panel body the tap target.
   *
   * ⚠️ The entry point must not be a small label. Tapping the numbers, the
   * label under them, or the empty space beside them all mean the same thing to
   * the person doing it — and a 10px "打开" with a hairline border around it is
   * a target you have to aim at. The whole body is one control, because the
   * whole body is one destination.
   */
  onPress?: () => void;
  /**
   * Set vertically UNDER the title, in the same margin band.
   *
   * ⚠️ Under, and vertical, on purpose: the margin is the only place on a phone
   * where a year label costs no content width. Laying it out horizontally above
   * the grid would take a full row away from the posters.
   */
  subtitle?: string;
  /** Makes `subtitle` a control — tapping it opens the picker. */
  onSubtitlePress?: () => void;
  /**
   * Lets the panel body outgrow the 900px text measure.
   *
   * ⚠️ The 900px cap exists so a paragraph does not become a full-width stripe
   * on a desktop. A poster GRID has the opposite problem: capping it forces the
   * tiles small and the column count low. Measured on a 1440px laptop: 900px +
   * `--tile-min: 190px` gives 4 columns, which is what the user objected to.
   */
  wide?: boolean;
  /**
   * The scroll cue's wording. Defaults to a bare "下滑".
   *
   * ⚠️ A generic "下滑" tells you the gesture but not the payoff. On the COOF
   * page there IS something specific below — the films themselves — and naming
   * it is what turns a decorative arrow into a reason to move.
   */
  cueText?: string;
  /** Bottom-of-panel provenance line, e.g. "更新于 2026-09-23 10:44". */
  updatedAt?: string | null;
  /**
   * Masthead, rendered above everything else in the body.
   *
   * ⚠️ This exists because the index and a brand page were rendering the SAME
   * panel shape — a lede, two large numbers, a rule. Tapping through landed you
   * on what looked like the page you just left, which makes the navigation feel
   * broken even though it worked. A hero gives the destination its own identity.
   */
  hero?: React.ReactNode;
  /**
   * Shrinks the stat block.
   *
   * ⚠️ Pairs with `hero`. The giant numbers are the HOME page's device — they
   * are what an index panel is FOR. A brand page has a hero doing that job, so
   * repeating the 92px numerals underneath it restores exactly the sameness the
   * hero was added to break.
   */
  compact?: boolean;
  /**
   * Rendered in the same row as the stat block, to its right.
   *
   * ⚠️ A row, not a stack, for the same reason the stat block is shrunk at all:
   * the COOF overview already carries a hero, a lede, chips, a recent strip and
   * a cue, and a full-width chart underneath the numbers pushes the panel past
   * the viewport on a phone — where the cue is absolutely positioned, so the
   * overflow lands on top of it instead of scrolling.
   */
  statsAside?: React.ReactNode;
  /**
   * Shrinks the stat block a further step and stacks it in one narrow column.
   *
   * ⚠️ Distinct from `compact`. `compact` is "this page has a hero, so the
   * numbers should not shout"; `dense` is "these numbers share their row with
   * something else". Only the second one may stack them.
   */
  dense?: boolean;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/**
 * The masthead a brand page opens with.
 *
 * ⚠️ Every brand page is the same panel shape as the index that leads to it, so
 * tapping through used to land on something visually indistinguishable from the
 * page you left. This is the cheapest thing that makes a destination read as a
 * destination: a welcome line and the brand's name set large.
 */
export function PageHero({ brand, welcome = '欢迎来到' }: { brand: string; welcome?: string }) {
  return (
    <View className="hero">
      <Text className="hero__welcome">{welcome}</Text>
      <Text className="hero__title">{brand}</Text>
    </View>
  );
}

/**
 * A single full-height panel.
 *
 * ⚠️ The chevron is a text glyph, not an icon font or an image. Both renderers
 * have `▼` in their system font, and an SVG would need a different inlining
 * strategy per target for no gain.
 */
export function Section({
  index,
  title,
  subtitle,
  onSubtitlePress,
  lede,
  stats,
  children,
  showCue = true,
  onPress,
  wide = false,
  cueText = '下滑',
  updatedAt,
  hero,
  compact = false,
  statsAside,
  dense = false,
}: SectionProps) {
  const statsClass = `stats${compact ? ' stats--compact' : ''}${dense ? ' stats--dense' : ''}`;
  const statBlocks = stats?.length ? (
    <View className={statsClass}>
      {stats.map((s) => (
        <View className="stats__item" key={s.label}>
          <Text className="stats__value">{s.value}</Text>
          <Text className="stats__label">{s.label}</Text>
          {s.note ? <Text className="stats__note">{s.note}</Text> : null}
        </View>
      ))}
    </View>
  ) : null;

  return (
    <View className="section">
      {/* ⚠️ Order matters for screen readers and for the visual stack: the
          margin title is absolutely positioned, so it must come first only if
          the body should read after it. It is decorative framing, so it goes
          first and the body carries the meaning. */}
      <View className="section__head">
        <Text className="section__index">{pad2(index + 1)}</Text>
        <Text className="section__title">{title}</Text>
        {subtitle ? (
          <Text
            className={`section__subtitle${onSubtitlePress ? ' section__subtitle--action' : ''}`}
            onClick={onSubtitlePress}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <View
        className={`section__body${onPress ? ' section__body--pressable' : ''}${
          wide ? ' section__body--wide' : ''
        }`}
        onClick={onPress}
      >
        {hero}

        {lede ? <Text className="section__lede">{lede}</Text> : null}

        {/* ⚠️ The wrapper is emitted only when there is something to put beside
            the numbers. Wrapping unconditionally would put a div into the body
            of every panel on every page for no reason, and those panels are
            laid out by `justify-content` on their own flex column. */}
        {statsAside ? (
          <View className="section__split">
            {statBlocks}
            {statsAside}
          </View>
        ) : (
          statBlocks
        )}

        {children}

        {updatedAt ? <Text className="section__updated">更新于 {updatedAt}</Text> : null}
      </View>

      {showCue ? (
        <View className="section__cue">
          <Text className="section__cue-text">{cueText}</Text>
          <Text className="section__cue-mark">▼</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Imperative handle on the stack, for controls that live outside it. */
export interface PageStackApi {
  /** Scroll panel `i` to the top of the viewport. */
  scrollTo: (i: number) => void;
}

export interface PageStackProps {
  /** Number of panels, so the rail can render one mark each. */
  count: number;
  children: React.ReactNode;
  /**
   * Filled with the scroll handle on mount.
   *
   * ⚠️ Exists because the COOF overview's year sheet has a button that must
   * land the reader on the poster panel — and the rail was previously the only
   * thing in the app that could move the stack, from inside. A ref rather than
   * context or a store: there is exactly one caller and one method.
   */
  apiRef?: React.MutableRefObject<PageStackApi | null>;
}

/**
 * The scroll container plus the nav rail.
 *
 * Track position by DIVIDING scrollTop by the container height rather than
 * reading each panel's `offsetTop`: panels are exactly one container-height
 * tall, so the arithmetic is exact, and it survives the panel list changing
 * length without re-measuring anything.
 */
export function PageStack({ count, children, apiRef }: PageStackProps) {
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLElement | null>(null);
  const height = useRef(1);

  // ⚠️ Smooth, unlike the rail's own jump. The rail is a position indicator you
  // nudge; this handle is called by a button whose label PROMISES a journey
  // ("查看 COOF2026"), and teleporting after a promise of movement reads as the
  // sheet having closed onto nothing.
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = {
      scrollTo: (i: number) => {
        const el = containerRef.current;
        if (!el) return;
        const top = i * height.current;
        if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' });
        else el.scrollTop = top;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  // ⚠️ The rail is a real control, so tapping it must scroll the container.
  // `scrollTo` is called on the DOM node directly because Taro's `pageScrollTo`
  // targets the WINDOW, and our scroller is a `ScrollView` — a different
  // element entirely, and the window never moves.
  const scrollTo = useCallback((i: number) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = i * height.current;
  }, []);

  useEffect(() => {
    const el = containerRef.current as unknown as HTMLElement | null;
    if (!el) return;

    const measure = () => {
      height.current = el.clientHeight || 1;
    };
    measure();

    const onScroll = () => {
      // Guard against a zero height during the first paint, which would make
      // this a division by zero and pin the rail to the last panel.
      if (height.current <= 1) measure();
      setActive(Math.round(el.scrollTop / height.current));
    };

    el.addEventListener('scroll', onScroll, { passive: true });

    // ⚠️ Re-measure on resize. Rotating the Fold or unfolding it changes the
    // panel height, and a stale value would make every rail jump land between
    // two panels.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, []);

  return (
    <>
      <ScrollView
        className="stack"
        scrollY
        // ⚠️ `ref` here reaches the ScrollView's inner element in H5. In the
        // mini program it is a Taro component instance, so the DOM listener
        // below simply never attaches and the rail stays on panel 1 — the
        // layout still works, only the indicator is static.
        ref={containerRef as never}
      >
        {children}
      </ScrollView>

      {count > 1 ? (
        <View className="rail">
          {Array.from({ length: count }, (_, i) => (
            <View
              key={i}
              className={`rail__dot ${i === active ? 'rail__dot--on' : ''}`}
              onClick={() => scrollTo(i)}
            >
              <View className="rail__dot-mark" />
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}
