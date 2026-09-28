import { Text, View } from '@tarojs/components';

import type { ChealthDay } from '../platform/data';

import './ChealthCharts.scss';

/**
 * Chealth's charts.
 *
 * ⚠️ Live here, not in the page, for the reason `ChealthCharts.scss` records at
 * length: home renders these too, and the CAPPERR page lost a day to exactly
 * this split.
 */

function n(v: number | undefined | null): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/**
 * ⚠️ `today` is passed in, never derived from `new Date()` inside the chart.
 *
 * The data's last day IS today until the phone stops reporting, and a chart
 * that decides "today" from the viewer's clock disagrees with the data the
 * moment someone opens the page at 00:05 or from another timezone.
 */
export function BarRow({
  days,
  pick,
  today,
}: {
  days: ChealthDay[];
  pick: (d: ChealthDay) => number | undefined;
  today: string;
}) {
  const vals = days.map(pick);
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  return (
    <View className="chc__rows">
      <View className="chc__plot">
        {days.map((d) => {
          const v = pick(d);
          const empty = v === undefined || v === null;
          const h = empty ? 0 : Math.max(2, Math.round(((v as number) / max) * 100));
          return (
            <View
              key={d.date}
              className={`chc__bar${empty ? ' chc__bar--empty' : ''}${d.date === today ? ' chc__bar--today' : ''}`}
              // ⚠️ `height` on the bar, not on the plot. The plot owns the
              // $chart-h baseline so every chart's zero line is the same line;
              // a percentage height inside an auto-height parent is a
              // coincidence, not a layout.
              style={{ height: `${h}%` }}
            />
          );
        })}
      </View>
      <View className="chc__axis">
        <Text>{days[0]?.date.slice(5) ?? ''}</Text>
        <Text>峰值 {n(max)}</Text>
        <Text>{days[days.length - 1]?.date.slice(5) ?? ''}</Text>
      </View>
    </View>
  );
}

/** A 7-day trend line. Values already filtered by the caller. */
export function Spark({ points }: { points: (number | undefined)[] }) {
  const vals = points.filter((v): v is number => typeof v === 'number');
  if (vals.length < 2) return <Text className="chc__axis">数据不足</Text>;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const W = 300;
  const H = 48;
  const at = (i: number, v: number) => [((i + 0.5) / points.length) * W, H - ((v - lo) / span) * (H - 8) - 4];
  const d = points
    .map((v, i) => (typeof v === 'number' ? `${i === 0 ? 'M' : 'L'}${at(i, v).map((x) => x.toFixed(1)).join(',')}` : ''))
    .filter(Boolean)
    .join(' ');
  const area = `${d} L${W},${H} L0,${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chc__spark" preserveAspectRatio="none">
      <path d={area} className="chc__area" />
      <path d={d} className="chc__line" />
    </svg>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <View className="chc__legend">
      {items.map((it) => (
        <View key={it.label} className="chc__key">
          <View className="chc__dot" style={{ background: it.color }} />
          <Text>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A session's heart-rate curve.
 *
 * ⚠️ The reader asked for this specifically, and an average cannot be drawn.
 * The phone sends `[minutesSinceStart, bpm]` pairs, already downsampled and with
 * the peak forced in.
 *
 * ⚠️ Two things this deliberately does that a plain sparkline would not:
 *
 *   · **The y-axis starts at the series minimum, not at zero.** A heart rate
 *     between 90 and 182 drawn from zero is a nearly flat line with a small
 *     wobble — technically correct and informationally empty. The labels state
 *     the range so the reader is never misled about the scale.
 *   · **The peak is marked.** It is the one number a heart-rate chart exists to
 *     show, and it is exactly what a smoothed line hides.
 */
export function HeartChart({ series }: { series: [number, number][] }) {
  if (!series || series.length < 2) return <Text className="chc__axis">心率曲线数据不足</Text>;

  const W = 300;
  const H = 56;
  // ⚠️ 全部走显式索引并给默认值，不是防御性编程 —— 是 `noUncheckedIndexedAccess`
  //    下 `series[i]` 的类型就是 `[number, number] | undefined`，不处理编译不过。
  //    这个严格性值得：它在别处抓到过真的越界。
  const pts: [number, number][] = series.map((p) => [p[0] ?? 0, p[1] ?? 0]);
  const bpms = pts.map((p) => p[1]);
  const lo = Math.min(...bpms);
  const hi = Math.max(...bpms);
  const span = hi - lo || 1;
  const tMax = pts[pts.length - 1]?.[0] || 1;

  const x = (t: number) => (t / tMax) * W;
  const y = (v: number) => H - 6 - ((v - lo) / span) * (H - 12);

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const area = `${d} L${W},${H} L0,${H} Z`;
  const peak = pts.reduce<[number, number]>((a, b) => (b[1] > a[1] ? b : a), pts[0] ?? [0, 0]);

  return (
    <View>
      {/* ⚠️ `style` 是对象，不是字符串 —— 原生 <svg> 上写字符串是 React #62，整页白屏。 */}
      <svg viewBox={`0 0 ${W} ${H}`} className="chc__spark" preserveAspectRatio="none">
        <path d={area} className="chc__area" />
        <path d={d} className="chc__line" />
        <circle cx={x(peak[0])} cy={y(peak[1])} r={2.5} className="chc__peak" />
      </svg>
      {/*
        ⚠️⚠️ 「曲线最低/最高」**不是**卡片上那个「心率 143 均 / 182 峰」。
        曲线是**逐分钟平均**之后的序列，聚合会削峰 —— 实测这条骑行原始峰值
        182，而曲线的最高点是 176。两个数都对，但摆在一起会让人以为有一个错了。
        所以这里的标签写明它描述的是**曲线**，不是那一段的极值。
        ⚠️ 不要把两者合并：峰值是心率图上唯一非要看不可的数，
           而画出来的线必须是平滑的，两者本来就该不同。
      */}
      <View className="chc__axis">
        <Text>{Math.round(pts[0]?.[0] ?? 0)} 分</Text>
        <Text>曲线 {lo}–{hi}（原始峰值见上）</Text>
        <Text>{Math.round(tMax)} 分</Text>
      </View>
    </View>
  );
}
