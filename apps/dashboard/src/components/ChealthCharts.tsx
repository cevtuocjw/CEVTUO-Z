import { useState, type CSSProperties } from 'react';
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
  unit = '',
  tone = 'steps',
  target,
}: {
  days: ChealthDay[];
  pick: (d: ChealthDay) => number | undefined;
  today: string;
  /** 单位后缀，只用在选中的那根柱子的数值气泡上。 */
  unit?: string;
  /**
   * 这个指标的颜色，对应 `.chc__mosaic` 上那组 `--m-*` token。
   *
   * ⚠️ 三星健康最有辨识度的一点是**每个指标一个固定的色**：步数绿、睡眠紫、
   *    消耗橙、距离蓝、心率红。读者扫一眼颜色就知道自己在看哪个指标，
   *    不用回去读标题。之前四张图共用 `--chart-3` 一个灰，
   *    四张图长得一模一样，颜色不承载任何信息。
   *
   * ⚠️ 这里传的只是**名字**，不是色值。色值只在 `ChealthCharts.scss` 的
   *    `--m-*` 那一行定义一次 —— 传色值就一定会有两份定义，然后漂移。
   */
  tone?: 'steps' | 'sleep' | 'kcal' | 'dist' | 'heart';
  /**
   * 目标值 —— 画一条虚线和一条达标进度。
   *
   * ⚠️⚠️ 三星健康那一半辨识度就在这里：「9,686」是一个数，而
   *    「9,686 / 目标 10,000 · 97%」才是**信息**。只有一个裸数字时，
   *    读者要自己去想「这算多还是少」，而那个判断标准只在他脑子里、
   *    每天都在变。
   *
   * ⚠️ 目标必须**参与纵轴刻度**，不能只画一条线。
   *    不参与的话，当所有柱子都远低于目标时（这是常态 —— 步数目标是 8000，
   *    而实测中位数接近 22000，但睡眠目标是另一回事），
   *    目标线会跑到绘图区**外面**去，读者看到的是一条不存在的线。
   */
  target?: number;
}) {
  const vals = days.map(pick);
  /** 数据的峰值 —— 轴标签上写的还是它，不是刻度上限。 */
  const peak = Math.max(1, ...vals.map((v) => v ?? 0));
  /**
   * ⚠️ 刻度上限和「峰值」是**两个数**，第一版把它们合成一个，于是目标线
   *    一旦高于峰值就画不出来（`bottom` 超过 100%）。分开之后：
   *    柱子按 `scale` 定高，标签按 `peak` 说话。
   */
  const scale = target !== undefined && target > 0 ? Math.max(peak, target) : peak;
  const targetPct = target !== undefined && target > 0 ? (target / scale) * 100 : 0;

  // ⚠️⚠️ 点柱子**必须有反馈**。三星健康那种图表是「点一根柱子，它亮起来、
  //    上面出现那天的数值」—— 这是读者 2026-09-28 明确要求的，
  //    原话是「点击没有任何反馈，也没有标记出来」。
  //
  // ⚠️ 默认选中**最后一天**（= 数据里的今天），不是「什么都不选」。
  //    空选中态下一个数都不显示，看起来像图表没数据。
  /**
   * ⚠️⚠️「选的是第几根」和「用户点过没有」是**两件事**。第一版把它们合成了一件，
   *    于是注释里那句「默认选中最后一天（= 数据里的今天）」**从来没有生效过**。
   *
   * 原来写的是 `useState(Math.max(0, days.length - 1))`。问题在于组件挂载那一刻
   * `days` 还是空数组 —— `Math.max(0, -1)` = 0 —— 而 `useState` 的初值只在
   * **首次渲染**取一次。数据到了之后 `days` 变成 14 天，`sel` 依然是 0，
   * 也就是 14 天里**最老的那一天**。
   *
   * 实测（2026-09-28 线上）：`选中第几根: 0`、`今天是第几根: 13`，
   * 气泡上写着 09-15。**页面上没有任何东西说这是错的。**
   *
   * ⚠️ 修法不是「把 0 改成 13」—— 那还是同一个陷阱，只是这次恰好蒙对了。
   *    改成：**没点过就跟着最后一天走，点过才钉住**。这样数据晚到、
   *    或者天数变多，都不用再管。
   */
  const [picked, setPicked] = useState<number | null>(null);
  const sel = picked === null ? Math.max(0, days.length - 1) : Math.min(picked, days.length - 1);
  const cur = days[sel];
  const curV = cur ? pick(cur) : undefined;

  return (
    <View
      className="chc__rows"
      // ⚠️ 自定义属性必须 `as CSSProperties` —— TS 的 CSSProperties 不认 `--x`，
      //    不转的话是类型错误，而运行时其实完全正常。
      style={{ ['--m' as string]: `var(--m-${tone})` } as CSSProperties}
    >
      {/* 数值气泡：跟着选中的那根柱子。没有这一行，点击就只是「变了个颜色」，
          读者还是不知道那根柱子是多少。 */}
      {/* ⚠️⚠️ 缺数据时**不能只显示一个 `—`**。
          气泡的字号是 21px 粗体，而破折号在那个字号下**就是一根横线** ——
          实测截图里「活动消耗」那一格看起来像一条分隔线，不像「这天没数据」。
          两个读者都会以为那是排版，不会以为那是缺失。

          ⇒ 缺数据时换成一个小字号的「无数据」，加一个和正常值明显不同的样式。
            它必须长得**像一句话**，不像一个符号。 */}
      <View className="chc__readout">
        <Text className="chc__readout-date">{cur?.date.slice(5) ?? ''}</Text>
        {curV === undefined || curV === null || Number.isNaN(curV) ? (
          <Text className="chc__readout-none">无数据</Text>
        ) : (
          <Text className="chc__readout-v">
            {n(curV)}
            {unit ? <Text className="chc__readout-u">{unit}</Text> : null}
          </Text>
        )}
        {/*
          ⚠️ 达标进度写在**读数那一行**，不写在图里 —— 画在图里就会和柱子抢
          位置（读数上方恰好是柱子最矮的地方，但最矮不等于空）。
          这里它紧贴着下面的虚线和图，读者不用二次寻找。
        */}
        {target !== undefined && target > 0 && curV !== undefined && curV !== null && !Number.isNaN(curV) ? (
          <Text className="chc__readout-goal">
            <Text className="chc__readout-goal-n">{Math.round((curV / target) * 100)}%</Text>
            {' '}目标 {n(target)}
          </Text>
        ) : null}
      </View>
      <View className="chc__plot">
        {/*
          ⚠️ 目标线画在**柱子之前**（DOM 顺序），所以它天然在柱子下面 ——
          不需要 z-index，也就不需要维护一个 z-index。
        */}
        {target !== undefined && target > 0 ? (
          <View className="chc__target" style={{ bottom: `${targetPct}%` }} />
        ) : null}
        {days.map((d, i) => {
          const v = pick(d);
          const empty = v === undefined || v === null;
          const h = empty ? 0 : Math.max(2, Math.round(((v as number) / scale) * 100));
          const isSel = i === sel;
          return (
            <View
              key={d.date}
              className={`chc__bar${empty ? ' chc__bar--empty' : ''}${d.date === today ? ' chc__bar--today' : ''}${isSel ? ' chc__bar--sel' : ''}`}
              // ⚠️ `height` on the bar, not on the plot. The plot owns the
              // $chart-h baseline so every chart's zero line is the same line;
              // a percentage height inside an auto-height parent is a
              // coincidence, not a layout.
              style={{ height: `${h}%` }}
              onClick={() => setPicked(i)}
            />
          );
        })}
      </View>
      <View className="chc__axis">
        <Text>{days[0]?.date.slice(5) ?? ''}</Text>
        {/* ⚠️ 这里是**数据的峰值**，不是刻度上限 —— 有目标线时两者不同，
            而读者关心的是「这几天最多走了多少」。 */}
        <Text>峰值 {n(peak)}</Text>
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
export function SeriesChart({
  series,
  name,
  unit = '',
  peakNote = '',
}: {
  series: [number, number][];
  /** 曲线名，用于「数据不足」那句 —— 四个指标共用这一个组件。 */
  name: string;
  /** 数值单位，拼在范围标签后面（`W` / `rpm` / `km/h`；心率留空）。 */
  unit?: string;
  /** 说明这条线是**曲线**的极值、不等于上面那个原始峰值。 */
  peakNote?: string;
}) {
  if (!series || series.length < 2) return <Text className="chc__axis">{name}数据不足</Text>;

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
        <Text>曲线 {lo}–{hi}{unit}{peakNote}</Text>
        <Text>{Math.round(tMax)} 分</Text>
      </View>
    </View>
  );
}

/**
 * 一次运动的心率曲线。
 *
 * ⚠️ 读者点名要的，而平均值画不出来。手机端发的是 `[距开始几分钟, bpm]`，
 *    已经降采样、并强制包含峰值。
 *
 * ⚠️ 它现在只是 [SeriesChart] 的一层薄包装 —— 功率/踏频/速度也要画同一种图，
 *    四份实现必然漂移（这个项目因为「同一件事两处实现」吃过亏：字数统计算法
 *    一篇文章数出 127 和 109）。
 */
export function HeartChart({ series }: { series: [number, number][] }) {
  return (
    <SeriesChart
      series={series}
      name="心率曲线"
      peakNote="（原始峰值见上）"
    />
  );
}
