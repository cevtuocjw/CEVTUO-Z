/**
 * MonthlyWave — one calendar year's viewing volume as a single smooth line.
 *
 * Twelve points, one per month, joined by a Catmull-Rom spline so the shape
 * reads as a wave rather than a bar chart with the bars left out. Hover (mouse)
 * or drag (touch) moves a guide line across the months and reports the month
 * under the pointer.
 *
 * ⚠️ H5-only interactions, and that is a deliberate ceiling rather than an
 * oversight. `getBoundingClientRect` and pointer events have no equivalent in
 * the mini-program renderer, so there the chart renders and animates but does
 * not respond — a still chart is an honest degradation; a chart that looks
 * interactive and is not is worse.
 *
 * ⚠️ The `<svg>` here is raw JSX, not a Taro component. Taro ships no SVG
 * primitive. On H5 the tags reach react-dom, which creates them in the SVG
 * namespace (`getIntrinsicNamespace('svg')`). If a mini-program build is ever
 * attempted this file must be swapped for a canvas implementation — it will not
 * compile there.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import type { CoofTitle } from '../platform/data';

import '../styles/wave.scss';

// ⚠️ No space before 月. The readout shares its line with a caveat and has to
// fit 260px on a 390px phone; twelve interpuncts of whitespace is the cheapest
// thing to give up.
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** The drawing box. Stretched to fit the panel — see `.wave__svg`. */
const VB_W = 320;
const VB_H = 92;
const PAD_T = 10;
const PAD_B = 8;

interface Pt {
  x: number;
  y: number;
}

/**
 * Catmull-Rom through the points, emitted as cubic béziers.
 *
 * ⚠️ Control points are clamped to the drawing box. An unclamped spline
 * overshoots into the padding on a sharp change of direction — measured on the
 * 2026 data, where February's 40 films drop to March's 3, the curve dipped
 * below the baseline and out of the plot. The clamp flattens the peak very
 * slightly; leaving it out puts the line under the axis, which reads as a
 * negative number of films.
 */
function smooth(points: Pt[]): string {
  // ⚠️ The `!`s here are the index bounds, not a shrug. The loop below runs
  // `i` from 0 to `length - 2`, so `points[i]` and `points[i + 1]` always
  // exist; `p0` and `p3` are the deliberate out-of-range neighbours, which the
  // `?? ` fallbacks resolve to the endpoint itself (the standard way to give a
  // spline a flat tangent at its ends).
  if (!points.length) return '';
  const first = points[0]!;
  if (points.length === 1) return `M ${first.x} ${first.y}`;

  const lo = PAD_T;
  const hi = VB_H - PAD_B;
  const clamp = (v: number) => Math.min(hi, Math.max(lo, v));

  let d = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p0 = points[i - 1] ?? p1;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6);
    d +=
      ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)},` +
      ` ${c2x.toFixed(2)} ${c2y.toFixed(2)},` +
      ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/**
 * Films watched per month, plus how many rows could not be placed at all.
 *
 * ⚠️ Rows are bucketed only when the date's YEAR matches the calendar being
 * shown. A calendar is not guaranteed to contain only its own year's dates
 * (the source data is a Notion library whose rows were migrated by hand), and
 * silently counting a stray 2025 date under a chart titled 2026 would be a
 * small lie that nothing on screen could reveal.
 */
function tally(titles: CoofTitle[], year: string) {
  const months = new Array<number>(12).fill(0);
  let undated = 0;
  for (const t of titles) {
    const d = t.watchedAt;
    if (!d || d.slice(0, 4) !== year) {
      undated += 1;
      continue;
    }
    const m = Number(d.slice(5, 7));
    if (m >= 1 && m <= 12) months[m - 1] = (months[m - 1] ?? 0) + 1;
    else undated += 1;
  }
  return { months, undated };
}

export interface MonthlyWaveProps {
  titles: CoofTitle[];
  /** The calendar, e.g. "2026". For a June holiday the month slice handles it. */
  year: string;
}

export function MonthlyWave({ titles, year }: MonthlyWaveProps) {
  const [active, setActive] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const boxRef = useRef<HTMLElement | null>(null);
  const hinted = useRef(false);

  const { months, undated } = useMemo(() => tally(titles, year), [titles, year]);
  const peak = Math.max(1, ...months);
  const total = months.reduce((n, m) => n + m, 0);
  // ⚠️ Clamped to 0. On an all-zero month list `indexOf(peak)` is -1, and
  // `MONTHS[-1]` is `undefined` — the readout would print "峰值 undefined 1 部"
  // during the frame before the first calendar loads.
  const peakAt = Math.max(0, months.indexOf(peak));

  const points = useMemo<Pt[]>(() => {
    const usable = VB_H - PAD_T - PAD_B;
    const step = VB_W / (months.length - 1);
    return months.map((n, i) => ({
      x: i * step,
      y: VB_H - PAD_B - (n / peak) * usable,
    }));
  }, [months, peak]);

  const line = useMemo(() => smooth(points), [points]);
  // Close the path along the baseline so the fill is the area under the curve.
  const area = useMemo(() => `${line} L ${VB_W} ${VB_H} L 0 ${VB_H} Z`, [line]);

  /**
   * ⚠️ Listeners are attached to the DOM node directly, not through Taro's
   * `onMouseMove` / `onTouchMove` props.
   *
   * Taro's components expose a fixed event list (click, touchstart, touchmove,
   * touchend, longpress …) and `mousemove` is not reliably among them — the
   * handlers would be dropped silently, leaving a chart that animates and then
   * does nothing. `PageStack` already binds its scroll listener this way for the
   * same reason.
   */
  useEffect(() => {
    const el = boxRef.current as unknown as HTMLElement | null;
    if (!el) return undefined;

    const pick = (clientX: number): number => {
      const r = el.getBoundingClientRect();
      if (!r.width) return 0;
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(f * (months.length - 1));
    };

    const onMove = (e: MouseEvent) => setActive(pick(e.clientX));
    const onLeave = () => setActive(null);

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      setDrag(true);
      setActive(pick(t.clientX));
      // ⚠️ Said once per page load, not on every touch. A gesture this one
      // (press, then slide sideways) is not discoverable from the chart alone,
      // and the alternative — a permanent instruction line — costs a row of the
      // panel's height to say the same thing.
      if (!hinted.current) {
        hinted.current = true;
        Taro.showToast({ title: '左右拖动查看每月数据', icon: 'none', duration: 1800 });
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) setActive(pick(t.clientX));
    };

    const onTouchEnd = () => setDrag(false);

    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);

    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [months.length]);

  const at = active !== null && active >= 0 && active < months.length ? active : null;
  const readout =
    at !== null
      ? `${MONTHS[at]} · ${months[at] ?? 0} 部`
      : total
        ? `全年 ${total} 部 · 峰值 ${MONTHS[peakAt]} ${peak} 部`
        : '暂无带日期的记录';

  // ⚠️ On the SAME line as the readout, not on a row of its own.
  //
  // The caveat still has to be stated — the wave counts only dated rows, so its
  // total can sit one or two below the record count printed beside it, and a
  // chart that quietly disagrees with its neighbour reads as broken data.
  // But a separate line costs 14px on a panel that measured 1px clear of the
  // scroll cue. Appended here it costs nothing, because the line already exists.
  //
  // Shown only at rest: the note is a property of the whole chart, and hanging
  // it off a per-month reading ("3 月 · 3 部 · 另有 1 条无日期") reads as if the
  // missing date belonged to that month.
  const note = at === null && undated ? ` · 缺 ${undated} 条日期` : '';

  // "今年" only while it IS this year — the same chart is reused for COOF2022,
  // where that word would be plainly wrong.
  const label = Number(year) === new Date().getFullYear() ? '今年每个月的观影量' : `${year} 年每个月的观影量`;

  return (
    <View className="wave">
      <Text className="wave__title">{label}</Text>

      <View
        className={`wave__hit${drag ? ' wave__hit--live' : ''}`}
        ref={boxRef as never}
      >
        {/* ⚠️ Keyed by year so the draw-on animation replays when the calendar
            changes. Without the key React reuses the node, the `animation`
            property never restarts, and switching years looks like a redraw
            that silently did nothing. */}
        <View className="wave__plot" key={year}>
          <svg
            className="wave__svg"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="coofWaveFill" x1="0" y1="0" x2="0" y2="1">
                <stop className="wave__stop wave__stop--a" offset="0%" />
                <stop className="wave__stop wave__stop--b" offset="100%" />
              </linearGradient>
            </defs>
            <path className="wave__area" d={area} fill="url(#coofWaveFill)" />
            <line className="wave__zero" x1="0" y1={VB_H - PAD_B} x2={VB_W} y2={VB_H - PAD_B} />
            <path className="wave__line" d={line} />
            {at !== null && points[at] ? (
              <line
                className="wave__guide"
                x1={points[at]!.x}
                y1={PAD_T - 6}
                x2={points[at]!.x}
                y2={VB_H}
              />
            ) : null}
          </svg>

          {at !== null && points[at] ? (
            <View
              className="wave__dot"
              style={{
                left: `${(points[at]!.x / VB_W) * 100}%`,
                top: `${(points[at]!.y / VB_H) * 100}%`,
              }}
            />
          ) : null}
        </View>
      </View>

      {/* The x scale. Drawn from the same `months.length` the curve uses, so
          the two can never disagree about how many points there are. */}
      <View className="wave__ticks">
        {months.map((_, i) => (
          <Text
            className="wave__tick"
            key={i}
            style={{ left: `${(i / (months.length - 1)) * 100}%` }}
          >
            {i + 1}
          </Text>
        ))}
      </View>

      <Text className="wave__read">
        {readout}
        {note}
      </Text>
    </View>
  );
}
