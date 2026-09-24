/**
 * Four charts for the CAPPERR page — donut, smooth curve, bars, heatmap.
 *
 * ⚠️ The `<svg>` here is raw JSX, not a Taro component. Taro ships no SVG
 * primitive. On H5 the tags reach react-dom, which creates them in the SVG
 * namespace. If a mini-program build is ever attempted this file must be
 * swapped for a canvas implementation — it will not compile there. (Same
 * constraint and same wording as MonthlyWave.tsx.)
 *
 * ⚠️ `preserveAspectRatio="none"` with a stretched viewBox, exactly as COOF's
 * wave does it: the drawing box is a coordinate system, not a size. Laying the
 * charts out in real pixels would make them non-responsive on the foldable
 * widths this app targets.
 *
 * ── Interactivity ──────────────────────────────────────────────
 * Discrete targets (a donut segment, a bar, a heat cell) use Taro's `onClick`,
 * which is reliable. The CURVE does not: picking a point on a line needs a
 * position, and Taro's event list has no dependable `mousemove`. Its listeners
 * are bound to the DOM node directly, the same way `MonthlyWave` and
 * `PageStack` do it — see the note there.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

// ── Shared ───────────────────────────────────────────────────

/** `--chart-N`, the monochrome scale. Colour belongs to the wallpaper. */
const INK = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-5)', 'var(--chart-7)'];

const pad2 = (n: number): string => String(n).padStart(2, '0');
const dayLabel = (d: string): string => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;
const mins = (s: number): string => (s >= 3600 ? `${(s / 3600).toFixed(1)} 小时` : `${Math.round(s / 60)} 分钟`);
/**
 * Compact duration, for the places that have no room for a unit word.
 *
 * ⚠️ The weekday bars are ~40px wide. `mins()` rendered "3.7 小时" there, which
 * wrapped to two lines and made every bar label read "3.7 小 / 时".
 */
const hm = (s: number): string => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`);

interface Pt {
  x: number;
  y: number;
}

/**
 * Catmull-Rom through the points, emitted as cubic béziers.
 *
 * ⚠️ Control points are clamped to the drawing box. An unclamped spline
 * overshoots on a sharp change of direction — on the COOF data, where February's
 * 40 films drop to March's 3, the curve dipped below the baseline and out of the
 * plot, which reads as a negative number of films. Same hazard here: a rest day
 * between two heavy ones is exactly a sharp change.
 */
function smooth(points: Pt[], vbH: number, padT: number, padB: number): string {
  if (!points.length) return '';
  const first = points[0]!;
  if (points.length === 1) return `M ${first.x} ${first.y}`;

  const clamp = (v: number) => Math.min(vbH - padB, Math.max(padT, v));
  let d = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p0 = points[i - 1] ?? p1;
    const p3 = points[i + 2] ?? p2;
    d +=
      ` C ${(p1.x + (p2.x - p0.x) / 6).toFixed(2)} ${clamp(p1.y + (p2.y - p0.y) / 6).toFixed(2)},` +
      ` ${(p2.x - (p3.x - p1.x) / 6).toFixed(2)} ${clamp(p2.y - (p3.y - p1.y) / 6).toFixed(2)},` +
      ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** A one-off nudge, said once per page load rather than on every touch. */
function hintOnce(ref: { current: boolean }, title: string): void {
  if (ref.current) return;
  ref.current = true;
  Taro.showToast({ title, icon: 'none', duration: 1800 });
}

// ── Donut ────────────────────────────────────────────────────

export interface Slice {
  key: string;
  label: string;
  value: number;
}

export interface CompositionDonutProps {
  slices: Slice[];
  /**
   * Formats every number this chart prints.
   *
   * ⚠️ Required, and that is deliberate. The first version took a `unit` string
   * and printed `{value} {unit}` — which rendered a category's value as
   * "44559 分钟" instead of "742.7 小时", and put the literal word "分钟" under a
   * centre readout that said "15.7h". One prop was answering two different
   * questions.
   */
  format: (v: number) => string;
}

/**
 * What the reading time is made of.
 *
 * Drawn with `stroke-dasharray` on concentric circles rather than arc paths:
 * the dash technique needs no trigonometry, and each segment stays a real
 * clickable element instead of a slice of one path.
 */
export function CompositionDonut({ slices, format }: CompositionDonutProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const total = slices.reduce((n, s) => n + s.value, 0);

  const R = 54;
  const C = 2 * Math.PI * R;
  const arcs = useMemo(() => {
    let acc = 0;
    return slices.map((s) => {
      const frac = total > 0 ? s.value / total : 0;
      const arc = { ...s, frac, offset: acc };
      acc += frac;
      return arc;
    });
  }, [slices, total]);

  const active = arcs.find((a) => a.key === picked) ?? null;
  const fmt = format;

  return (
    <View className="pc-donut">
      <View className="pc-donut__plot">
        <svg className="pc-donut__svg" viewBox="0 0 140 140" aria-hidden="true">
          <circle className="pc-donut__ring" cx="70" cy="70" r={R} />
          {arcs.map((a, i) =>
            a.frac <= 0 ? null : (
              <circle
                key={a.key}
                className={picked === a.key ? 'pc-donut__seg pc-donut__seg--on' : 'pc-donut__seg'}
                cx="70"
                cy="70"
                r={R}
                stroke={INK[i % INK.length]}
                // ⚠️ A tiny gap between segments, subtracted from the dash
                // length. Without it adjacent segments of similar tone merge
                // into one band and the donut reads as a single ring.
                strokeDasharray={`${Math.max(0, a.frac * C - 2).toFixed(2)} ${(C - a.frac * C + 2).toFixed(2)}`}
                strokeDashoffset={(-a.offset * C).toFixed(2)}
                onClick={() => setPicked(picked === a.key ? null : a.key)}
              />
            ),
          )}
        </svg>
        <View className="pc-donut__center">
          <Text className="pc-donut__value">
            {active ? `${Math.round(active.frac * 100)}%` : fmt(total)}
          </Text>
          <Text className="pc-donut__unit">{active ? active.label : '合计'}</Text>
        </View>
      </View>

      <View className="pc-legend">
        {arcs.map((a, i) => (
          <View
            key={a.key}
            className={picked === a.key ? 'pc-legend__row pc-legend__row--on' : 'pc-legend__row'}
            onClick={() => setPicked(picked === a.key ? null : a.key)}
          >
            <View className="pc-legend__dot" style={`background-color:${INK[i % INK.length]}`} />
            <Text className="pc-legend__label">{a.label}</Text>
            <Text className="pc-legend__value">{fmt(a.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Smooth curve ─────────────────────────────────────────────

export interface CurvePoint {
  d: string;
  s: number;
  p: number;
}

export function ReadingCurve({ days }: { days: CurvePoint[] }) {
  const VB_W = 320;
  const VB_H = 96;
  const PAD_T = 12;
  const PAD_B = 10;

  const [at, setAt] = useState<number | null>(null);
  const boxRef = useRef<HTMLElement | null>(null);
  const hinted = useRef(false);

  const peak = Math.max(1, ...days.map((d) => d.s));
  const points = useMemo<Pt[]>(() => {
    if (!days.length) return [];
    const usable = VB_H - PAD_T - PAD_B;
    const step = days.length > 1 ? VB_W / (days.length - 1) : 0;
    return days.map((d, i) => ({ x: i * step, y: VB_H - PAD_B - (d.s / peak) * usable }));
  }, [days, peak]);

  const line = useMemo(() => smooth(points, VB_H, PAD_T, PAD_B), [points]);
  const area = useMemo(() => (line ? `${line} L ${VB_W} ${VB_H} L 0 ${VB_H} Z` : ''), [line]);

  useEffect(() => {
    const el = boxRef.current as unknown as HTMLElement | null;
    if (!el || days.length < 2) return undefined;

    const pick = (clientX: number): number => {
      const r = el.getBoundingClientRect();
      if (!r.width) return 0;
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(f * (days.length - 1));
    };
    const onMove = (e: MouseEvent) => setAt(pick(e.clientX));
    const onLeave = () => setAt(null);
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      setAt(pick(t.clientX));
      hintOnce(hinted, '左右拖动查看每天的时长');
    };

    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('touchstart', onTouch);
    el.addEventListener('touchmove', onTouch);
    el.addEventListener('touchend', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('touchstart', onTouch);
      el.removeEventListener('touchmove', onTouch);
      el.removeEventListener('touchend', onLeave);
    };
  }, [days.length]);

  const idx = at !== null && at >= 0 && at < days.length ? at : null;
  const here = idx !== null ? days[idx] : undefined;
  const totalSec = days.reduce((n, d) => n + d.s, 0);

  return (
    <View className="pc-curve">
      <Text className="pc-readout">
        {here
          ? `${dayLabel(here.d)} · ${mins(here.s)} · 翻 ${here.p} 页`
          : `${days.length} 天共 ${mins(totalSec)} · 峰值 ${mins(peak)}`}
      </Text>

      <View className="pc-curve__hit" ref={boxRef as never}>
        <svg className="pc-curve__svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true">
          {/* ⚠️ `pathLength={1}` normalises the geometry so the entrance
              animation's dash offset is exact regardless of how long the path
              is. Guessing a dasharray in user units makes a short path finish
              its draw in the first tenth of the timeline and a long one never
              finish it. */}
          <path className="pc-curve__area" d={area} />
          <path className="pc-curve__line" d={line} pathLength={1} />
          {idx !== null && points[idx] ? (
            <>
              <line className="pc-curve__guide" x1={points[idx]!.x} y1={PAD_T - 8} x2={points[idx]!.x} y2={VB_H} />
              <circle className="pc-curve__dot" cx={points[idx]!.x} cy={points[idx]!.y} r="3.2" />
            </>
          ) : null}
        </svg>
      </View>
    </View>
  );
}

// ── Bars ─────────────────────────────────────────────────────

export interface Bar {
  key: string;
  label: string;
  value: number;
}

/** Reading by weekday — the one cut the daily series can actually support. */
export function WeekdayBars({
  bars,
  unit,
  activeKey,
}: {
  bars: Bar[];
  unit: string;
  /**
   * The bar to mark as "now".
   *
   * ⚠️ Only meaningful when the bars are a WEEK. On a month's weekday totals
   * every column is still in progress, so highlighting one would be a claim the
   * data cannot support — the caller passes nothing there.
   */
  activeKey?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const peak = Math.max(1, ...bars.map((b) => b.value));
  const active = bars.find((b) => b.key === picked);

  return (
    <View className="pc-bars">
      <Text className="pc-readout">
        {active
          ? `${active.label} · ${mins(active.value)}`
          : `最集中在周${bars.reduce((a, b) => (b.value > a.value ? b : a), bars[0]!).label}`}
      </Text>
      <View className="pc-bars__row">
        {bars.map((b) => (
          <View
            key={b.key}
            className={[
              'pc-bars__col',
              picked === b.key ? 'pc-bars__col--on' : '',
              activeKey === b.key ? 'pc-bars__col--now' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setPicked(picked === b.key ? null : b.key)}
          >
            <View className="pc-bars__track">
              <View
                className="pc-bars__bar"
                // 2% floor: a weekday with no reading at all must still show a
                // mark, or the column looks like a rendering failure.
                style={`height:${Math.max(2, (b.value / peak) * 100)}%`}
              />
            </View>
            <Text className="pc-bars__label">{b.label}</Text>
            <Text className="pc-bars__value">{b.value > 0 ? hm(b.value) : '—'}</Text>
          </View>
        ))}
      </View>
      <Text className="pc-note">单位：{unit}</Text>
    </View>
  );
}

// ── Heatmap ──────────────────────────────────────────────────

export interface HeatDay {
  d: string;
  s: number;
}

/**
 * A calendar of the last `weeks` weeks, GitHub-shaped.
 *
 * ⚠️ Columns are WEEKS and rows are weekdays, which is the only arrangement in
 * which a run of consecutive days reads as a run. Laying it out as a plain grid
 * of the last N days breaks the row at an arbitrary point each week.
 */
export function ReadingHeat({ days, weeks = 12 }: { days: HeatDay[]; weeks?: number }) {
  const [picked, setPicked] = useState<HeatDay | null>(null);
  const hinted = useRef(false);

  const { cells, cols, peak } = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.d, d.s]));
    const peak = Math.max(1, ...days.map((d) => d.s));
    if (!days.length) return { cells: [], cols: 0, peak };

    // Anchor on the LAST day in the data, not on today: the data is the
    // device's, and today may be days after the last sync.
    const last = days[days.length - 1]!.d;
    const [y, m, dd] = last.split('-').map(Number) as [number, number, number];
    const end = new Date(Date.UTC(y, m - 1, dd));
    // ⚠️ `getUTCDay()` with a +0 offset would put Monday at 1 but make the
    // column start mid-week for a Sunday. Shift so the column starts Monday.
    const dow = (end.getUTCDay() + 6) % 7;
    const start = new Date(end.getTime() - (weeks * 7 - 1 - (6 - dow)) * 86_400_000);

    const out: Array<{ d: string; s: number; col: number; row: number }> = [];
    for (let i = 0; i < weeks * 7; i += 1) {
      const t = new Date(start.getTime() + i * 86_400_000);
      const key = `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
      out.push({ d: key, s: byDay.get(key) ?? 0, col: Math.floor(i / 7), row: i % 7 });
    }
    return { cells: out, cols: weeks, peak };
  }, [days, weeks]);

  const level = (s: number): number => {
    if (s <= 0) return 0;
    const f = s / peak;
    if (f > 0.66) return 4;
    if (f > 0.33) return 3;
    if (f > 0.12) return 2;
    return 1;
  };

  const CW = 12;
  const CH = 12;
  const GAP = 3;

  return (
    <View className="pc-heat">
      <Text className="pc-readout">
        {picked
          ? `${dayLabel(picked.d)} · ${picked.s > 0 ? mins(picked.s) : '没有阅读'}`
          : `最近 ${weeks} 周 · 有记录 ${days.length} 天`}
      </Text>

      <View className="pc-heat__scroll">
        <svg
          className="pc-heat__svg"
          // ⚠️ Cap at the natural size, do NOT stretch.
          //
          // The viewBox is in cell units — 12px squares plus a 3px gutter — so
          // `width: 100%` scales the whole grid up with the column. In a 343px
          // cell that is 12px squares rendered at 23px, which is what "热力图
          // 过大" was: the chart was not sized, it was being magnified. On a
          // narrow phone the same rule would shrink it, so `width: 100%` stays
          // and `max-width` does the capping.
          // ⚠️ An OBJECT, not a template string. Every other `style` in this file
          // is a string, because Taro's <View> accepts one — but this is a raw
          // <svg>, which React renders as a DOM element, and React demands a
          // mapping there. A string throws "The `style` prop expects a mapping
          // from style properties to values, not a string", which takes down
          // the whole page with an error that names no component.
          style={{ maxWidth: `${cols * (CW + GAP) - GAP}px` }}
          viewBox={`0 0 ${cols * (CW + GAP)} ${7 * (CH + GAP)}`}
          aria-hidden="true"
        >
          {cells.map((c) => (
            <rect
              key={c.d}
              className={`pc-heat__cell pc-heat__cell--l${level(c.s)}${picked?.d === c.d ? ' pc-heat__cell--on' : ''}`}
              x={c.col * (CW + GAP)}
              y={c.row * (CH + GAP)}
              width={CW}
              height={CH}
              rx="1.5"
              onClick={() => {
                setPicked(picked?.d === c.d ? null : { d: c.d, s: c.s });
                hintOnce(hinted, '点格子看那天的时长');
              }}
            />
          ))}
        </svg>
      </View>

      <View className="pc-heat__scale">
        <Text className="pc-note">少</Text>
        {[0, 1, 2, 3, 4].map((l) => (
          <View key={l} className={`pc-heat__swatch pc-heat__cell--l${l}`} />
        ))}
        <Text className="pc-note">多</Text>
      </View>
    </View>
  );
}

// ── Hour grid ────────────────────────────────────────────────

export interface HourBucket {
  h: number;
  s: number;
}

/**
 * Seconds read in each hour of the day.
 *
 * ⚠️ This is the one chart that needed the DEVICE to change. It cannot be
 * derived from a daily total — it needs each session's start time, and the
 * day-level aggregate throws that away. The plugin now runs a second `GROUP BY`
 * over the same table for it (see `koreader-plugin/cevtuo-capperr.koplugin/`).
 *
 * ⚠️ Renders an honest empty state when the array is all zeros, which is what a
 * device that has not updated its plugin sends. A chart of 24 flat bars would
 * read as "you never read" rather than "this data has not arrived yet".
 */
export function HourGrid({ hours }: { hours: HourBucket[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const peak = Math.max(0, ...hours.map((x) => x.s));
  const active = picked !== null ? hours[picked] : undefined;
  const busiest = hours.reduce((a, b) => (b.s > a.s ? b : a), hours[0]!);

  if (peak === 0) {
    return (
      <View className="pc-hours">
        <Text className="pc-readout">时段数据还没有</Text>
        <Text className="pc-note">
          需要新版插件（它会额外按小时聚合一次）。设备下次同步后这里就有图了。
        </Text>
      </View>
    );
  }

  return (
    <View className="pc-hours">
      <Text className="pc-readout">
        {active
          ? `${active.h} 点 – ${active.h + 1} 点 · ${mins(active.s)}`
          : `最常在 ${busiest.h} 点读 · ${mins(busiest.s)}`}
      </Text>
      <View className="pc-hours__row">
        {hours.map((x, i) => (
          <View
            key={x.h}
            className={picked === i ? 'pc-hours__col pc-hours__col--on' : 'pc-hours__col'}
            onClick={() => setPicked(picked === i ? null : i)}
          >
            <View className="pc-hours__track">
              <View
                className="pc-hours__bar"
                // A 2% floor so a hour with no reading still shows a mark; a
                // column of literal nothing reads as a rendering fault.
                style={`height:${Math.max(2, (x.s / peak) * 100)}%`}
              />
            </View>
            {/* Every third hour, or the labels collide at phone width. */}
            <Text className="pc-hours__label">{i % 3 === 0 ? String(i) : ''}</Text>
          </View>
        ))}
      </View>
      <Text className="pc-note">一天里每个小时的累计时长（本地时间）</Text>
    </View>
  );
}

// ── Records ──────────────────────────────────────────────────

export interface RecordItem {
  label: string;
  value: string;
  note?: string;
}

/** Personal bests. A plain row of numbers — no chart, because they are single values. */
export function Records({ items }: { items: RecordItem[] }) {
  return (
    <View className="pc-records">
      {items.map((r) => (
        <View key={r.label} className="pc-records__cell">
          <Text className="pc-records__value">{r.value}</Text>
          <Text className="pc-records__label">{r.label}</Text>
          {r.note && <Text className="pc-records__note">{r.note}</Text>}
        </View>
      ))}
    </View>
  );
}

// ── Monthly bars ─────────────────────────────────────────────

export interface MonthBucket {
  m: string;
  s: number;
}

/**
 * Seconds read per calendar month.
 *
 * ⚠️ Hidden entirely below two months. One bar is not a trend, and a "monthly
 * chart" with a single column implies history the device does not have yet.
 */
export function MonthBars({ months }: { months: MonthBucket[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (months.length < 2) return null;

  const peak = Math.max(1, ...months.map((x) => x.s));
  const active = months.find((x) => x.m === picked);

  return (
    <View className="pc-months">
      <Text className="pc-readout">
        {active ? `${active.m} · ${mins(active.s)}` : `${months.length} 个月 · 峰值 ${mins(peak)}`}
      </Text>
      <View className="pc-months__row">
        {months.map((x) => (
          <View
            key={x.m}
            className={picked === x.m ? 'pc-months__col pc-months__col--on' : 'pc-months__col'}
            onClick={() => setPicked(picked === x.m ? null : x.m)}
          >
            <View className="pc-months__track">
              <View className="pc-months__bar" style={`height:${Math.max(3, (x.s / peak) * 100)}%`} />
            </View>
            <Text className="pc-months__label">{x.m.slice(5)} 月</Text>
          </View>
        ))}
      </View>
    </View>
  );
}


// ── Progress bands ───────────────────────────────────────────

export interface ProgressBand {
  label: string;
  count: number;
}

/**
 * How far into things the reader actually is.
 *
 * ⚠️ This is the chart that answers a question the shelf cannot. A list sorted
 * by recency shows what was opened last; it does not show that eleven books are
 * sitting between 10% and 30% — a shape you only see when you put them in
 * buckets. The finished bar is drawn in the accent because it is the one bar
 * whose height is good news.
 */
export function ProgressBands({ bands, doneFrom }: { bands: ProgressBand[]; doneFrom: number }) {
  const peak = Math.max(1, ...bands.map((b) => b.count));
  return (
    <View className="pc-bands">
      <Text className="pc-readout">
        {bands.reduce((n, b) => n + b.count, 0)} 本，按进度分档
      </Text>
      <View className="pc-bands__row">
        {bands.map((b, i) => (
          <View key={b.label} className="pc-bands__col">
            <Text className="pc-bands__count">{b.count > 0 ? b.count : ''}</Text>
            <View className="pc-bands__track">
              <View
                className={
                  // The bands at or past the finish line are the ones that count
                  // as read, and they are the same 70% the rest of the page uses.
                  i * 10 >= doneFrom ? 'pc-bands__bar pc-bands__bar--done' : 'pc-bands__bar'
                }
                style={`height:${Math.max(2, (b.count / peak) * 100)}%`}
              />
            </View>
            <Text className="pc-bands__label">{b.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Today / this week / this month ───────────────────────────

export interface PeriodRow {
  key: string;
  label: string;
  seconds: number;
  pages: number;
  /**
   * The same figure for the period immediately before — yesterday, last week,
   * the previous month. ⚠️ `null` when there is no previous period in the data
   * at all, which is different from a previous period of zero: one means "no
   * comparison possible", the other means "you read nothing then".
   */
  prevSeconds: number | null;
  prevLabel: string;
}

/**
 * The three windows a reader actually thinks in.
 *
 * ⚠️ These are DELTAS against the previous window, not totals. Every other
 * number on this page only ever goes up — "15.7h 累计" cannot answer "am I
 * reading more than last week", and that is the question someone opening this
 * page at 11pm actually has.
 */
export function PeriodStats({ periods, format }: { periods: PeriodRow[]; format: (s: number) => string }) {
  return (
    <View className="pc-periods">
      {periods.map((p) => {
        const delta =
          p.prevSeconds == null || p.prevSeconds === 0
            ? null
            : Math.round(((p.seconds - p.prevSeconds) / p.prevSeconds) * 100);
        return (
          <View key={p.key} className="pc-periods__col">
            <Text className="pc-periods__label">{p.label}</Text>
            <Text className="pc-periods__value">{p.seconds > 0 ? format(p.seconds) : '—'}</Text>
            <Text className="pc-periods__note">
              {p.pages > 0 ? `${p.pages} 页` : '没有翻页'}
            </Text>
            {/* ⚠️ A delta needs a previous period to compare against. Saying
                "+100%" on a first week with no history is arithmetically true
                and completely useless. */}
            <Text
              className={
                delta == null
                  ? 'pc-periods__delta'
                  : delta >= 0
                    ? 'pc-periods__delta pc-periods__delta--up'
                    : 'pc-periods__delta pc-periods__delta--down'
              }
            >
              {delta == null
                ? `没有${p.prevLabel}可比`
                : `${delta >= 0 ? '+' : ''}${delta}% 比${p.prevLabel}`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ── This month, as a calendar ────────────────────────────────

export interface CalendarDay {
  d: string;
  s: number;
}

/**
 * The current month laid out as a calendar.
 *
 * ⚠️ Replaces the rolling 12-week heatmap. That one answered "what does the
 * last quarter look like" — a question whose answer barely changes from one day
 * to the next. A calendar answers "how is THIS month going", and it puts the
 * blank days next to the busy ones where the shape of the month is visible at a
 * glance, including the days that have not happened yet.
 */
export function MonthCalendar({ days, peak }: { days: CalendarDay[]; peak: number }) {
  const [picked, setPicked] = useState<CalendarDay | null>(null);

  const { weeks, month, label } = useMemo(() => {
    if (!days.length) return { weeks: [] as Array<Array<CalendarDay | null>>, month: '', label: '' };
    // ⚠️ Anchored on the LAST day in the data, never on `new Date()`. The data
    // is the device's, and the device may not have synced for days — anchoring
    // on today would render an empty month and look like the sync had failed.
    const last = days[days.length - 1]!.d;
    const [y, m] = last.split('-').map(Number) as [number, number];
    const monthKey = `${y}-${pad2(m)}`;
    const byDay = new Map(days.filter((d) => d.d.startsWith(monthKey)).map((d) => [d.d, d.s]));

    const first = new Date(Date.UTC(y, m - 1, 1));
    // Monday-first, matching the bar charts' 一…日.
    const lead = (first.getUTCDay() + 6) % 7;
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();

    const cells: Array<CalendarDay | null> = [];
    for (let i = 0; i < lead; i += 1) cells.push(null);
    for (let d = 1; d <= count; d += 1) {
      const key = `${monthKey}-${pad2(d)}`;
      cells.push({ d: key, s: byDay.get(key) ?? 0 });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const out: Array<Array<CalendarDay | null>> = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return { weeks: out, month: monthKey, label: `${y} 年 ${m} 月` };
  }, [days]);

  const level = (s: number): number => {
    if (s <= 0) return 0;
    const f = s / Math.max(1, peak);
    if (f > 0.66) return 4;
    if (f > 0.33) return 3;
    if (f > 0.12) return 2;
    return 1;
  };

  return (
    <View className="pc-cal">
      <Text className="pc-readout">
        {picked
          ? `${dayLabel(picked.d)} · ${picked.s > 0 ? mins(picked.s) : '没有阅读'}`
          : label}
      </Text>
      <View className="pc-cal__head">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <Text key={w} className="pc-cal__wd">{w}</Text>
        ))}
      </View>
      {weeks.map((row, ri) => (
        <View key={`${month}-${ri}`} className="pc-cal__row">
          {row.map((c, ci) => (
            <View key={c?.d ?? `pad-${ri}-${ci}`} className="pc-cal__cellwrap">
              {c ? (
                <View
                  className={`pc-cal__cell pc-cal__cell--l${level(c.s)}${
                    picked?.d === c.d ? ' pc-cal__cell--on' : ''
                  }`}
                  onClick={() => setPicked(picked?.d === c.d ? null : c)}
                >
                  <Text className="pc-cal__day">{Number(c.d.slice(8))}</Text>
                </View>
              ) : (
                <View className="pc-cal__cell pc-cal__cell--blank" />
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
