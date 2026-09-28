import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Text, View } from '@tarojs/components';

import { BarRow, HeartChart, Legend, SeriesChart, Spark } from '../../components/ChealthCharts';
import { Icon, typeIcon } from '../../components/ChealthIcons';
import {
  hrZones,
  personalBests,
  powerStats,
  restingHrCompare,
  stepStreak,
  typeBreakdown,
  typeLabel,
  weekCompare,
} from '../../platform/health-analysis';
import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { homePanelUrl } from '../../platform/panels';
import { Wallpaper } from '../../components/Wallpaper';
import {
  fetchChealthHeartbeat,
  fetchChealthIndex,
  type ChealthDay,
  type ChealthSession,
  type ChealthHeartbeat,
  type ChealthIndex,
} from '../../platform/data';

import '../../styles/demo.scss';

/**
 * CHEALTH — Samsung Health, via Health Connect on the phone.
 *
 * ```
 * Galaxy Watch8 Classic ─▶ Samsung Health ─▶ Health Connect
 *                                                 │
 *                                     CEVTUO Health (Android)
 *                                                 │ POST every 15 min
 *                                                 ▼
 *                                      阿里云 ─▶ gh-pages ─▶ here
 * ```
 *
 * ⚠️⚠️ Four things this page must not do, each of which it would do by default.
 *
 * 1. **Sum the step sources.** Three apps write step records into Health
 *    Connect at once — Samsung Health (bridged by Health Sync), Google Fit, and
 *    the handset's own sensor — all counting the same walking. Measured
 *    2026-09-24: 210 / 226 / 169 records over one 48-hour window. The phone
 *    picks one and the server records `stepSources`; nothing here adds them.
 *
 * 2. **Present total calories as calories burned.** `calories` comes from
 *    `TotalCaloriesBurnedRecord`, which INCLUDES basal metabolic rate. A day
 *    with no activity at all still reports ~1662 kcal — flat, for eleven days
 *    running, in the first real data set. That is not a fault, and on a chart
 *    with no label it is indistinguishable from a dead sensor. So the basal and
 *    active halves are drawn and named separately.
 *
 * 3. **Render today as a finished day.** Today's step count is whatever has
 *    happened so far. At 15:00 it read 3,163 against a 30-day median near
 *    22,000 — a collapse that is simply the clock.
 *
 * 4. **Treat an empty metric as a zero.** HRV, respiratory rate, skin
 *    temperature and weight had ZERO records in 30 days. A missing metric is
 *    drawn as absent and said to be absent, never as a bar of height zero.
 */
/**
 * Where the passphrase comes from.
 *
 * ⚠️ Order matters. `location.hash` first, because a URL that carries
 * `#/pages/chealth/index?k=...` never sends the fragment to any server — it is
 * stripped by the browser before the request — so a bookmarked link can simply
 * work without the key ever touching a log. Then localStorage, so it is typed
 * once per device rather than once per visit.
 *
 * ⚠️ Absent is a normal state, not an error. The page renders a prompt, and
 * the sealed file stays sealed.
 */
const PASS_KEY = 'cevtuo.chealth.pass';

/*
 * ⚠️ 这里原来有一个 `sessionLabel()`，把运动类型映射成「🚴 骑行」这样的 emoji
 *    字符串。已删除，改用 `platform/health-analysis.ts` 的 `typeLabel()` +
 *    `ChealthIcons` 的内联 SVG。
 *
 * 两条理由，都会复发：
 *   · **emoji 长什么样取决于机器上装了什么字体**，而且它是彩色的，
 *     和页面这套黑白排版不是同一种语言。项目里已经因为 Unicode 符号
 *     （`▦ ≋ ▤`）在不同设备上显示不一致踩过一次。
 *   · 那份映射表是**局部**的，只覆盖 11 个类型；`typeLabel()` 覆盖 20 多个，
 *     而且未知类型会**原样显示机器名**（`TYPE_0`）而不是「未知」——
 *     一个编号还能去查，「未知」是死路。
 */

function readPass(): string {
  try {
    const m = /[?&]k=([^&]+)/.exec(window.location.hash);
    if (m?.[1]) {
      const v = decodeURIComponent(m[1]);
      window.localStorage.setItem(PASS_KEY, v);
      return v;
    }
    return window.localStorage.getItem(PASS_KEY) ?? '';
  } catch {
    // ⚠️ The mini-program build has no `window`. There the passphrase has to
    // come from a prompt — but it must not throw on the way to saying so.
    return '';
  }
}

export default function Chealth() {
  const [index, setIndex] = useState<ChealthIndex | null>(null);
  const [beat, setBeat] = useState<ChealthHeartbeat | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [pass, setPass] = useState<string>(() => readPass());

  useEffect(() => {
    if (!pass) return undefined;
    let alive = true;
    fetchChealthIndex(pass)
      .then((d) => alive && setIndex(d))
      // ⚠️ "Wrong passphrase" and "no data" must not look the same. AES-GCM
      // fails its tag check on a bad key, so a caught error here is almost
      // always the passphrase — saying so is the difference between a reader
      // retyping it and a reader reporting a broken pipeline.
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    // ⚠️ Fetched separately and allowed to fail silently. It is the only thing
    // on the page that comes from the Aliyun box rather than the CDN, because
    // "the phone reached us" is a fact only the receiving machine knows.
    fetchChealthHeartbeat().then((b) => alive && setBeat(b));
    return () => {
      alive = false;
    };
  }, [pass]);

  const days = index?.days ?? [];
  const today = index?.to ?? '';
  const t = index?.totals;

  /**
   * ⚠️ The last 14 days, ending on the data's own last day — not on the
   * viewer's today. A window keyed to the browser would render an empty chart
   * for anyone opening this before the phone's first sync of the day.
   */
  const recent = useMemo(() => days.slice(-14), [days]);

  const have = (k: keyof ChealthDay) => recent.some((d) => typeof d[k] === 'number');
  const median = useMemo(() => {
    const v = days.map((d) => d.steps).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
    return v.length ? (v[Math.floor(v.length / 2)] ?? null) : null;
  }, [days]);

  const partial = t !== undefined && t.stepsToday !== null && median !== null && t.stepsToday < median * 0.5;

  /**
   * How far behind the phone's own pushes the DATA is, in days.
   *
   * ⚠️⚠️ This is the verdict the two stamps above were missing, and it is the
   * exact failure this project keeps paying for: "回执是成功、数据没动".
   *
   * Measured 2026-09-28: `lastPushAt` 10:58 that morning — the phone pushing
   * every 15 minutes, on schedule — while `to` had not moved off 2026-09-24
   * for four days. The page rendered both numbers, side by side, in the same
   * sentence, and drew no conclusion from them. The reader has to notice a
   * four-day gap between two timestamps by eye, which is not a thing anyone
   * does.
   *
   * ⚠️ Computed from the two SERVER-side stamps and never from `new Date()`.
   * Both carry +08:00; measuring them against the viewer's clock would give a
   * reader in London a different verdict about the same data — the mistake
   * `formatUpdatedAt` already exists to avoid.
   */
  const stallDays = useMemo(() => {
    const pushDay = beat?.lastPushAt?.slice(0, 10);
    const dataDay = index?.to;
    if (!pushDay || !dataDay) return 0;
    const a = Date.parse(`${dataDay}T00:00:00+08:00`);
    const b = Date.parse(`${pushDay}T00:00:00+08:00`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.round((b - a) / 86_400_000);
  }, [beat, index]);

  // ── 分析 ────────────────────────────────────────────────────
  //
  // ⚠️ 全部从索引里**已经有**的数据算出来，不额外取数、不额外存储 ——
  //    所以这些分析没有增加任何采集负担，只是把已有的数读出了更多意思。
  //
  // ⚠️ 心率区间和功率分析是**以前算不出来**的：它们要用过程序列
  //    （`hrSeries` / `powerSeries`），而那三组序列 2026-09-28 才打通。
  //    在那之前，页面只有一个平均值，画不出也分不出区间。
  const sessions = useMemo(() => index?.sessions ?? [], [index]);

  /** 心率区间的基准 = 最近 30 天**实际观测到**的最高心率。见 `hrZones` 的注释。 */
  const refMaxHr = useMemo(
    () => Math.max(0, ...sessions.map((s) => s.hrMax ?? 0), ...days.map((d) => d.hrMax ?? 0)),
    [sessions, days],
  );
  const zones = useMemo(() => (refMaxHr > 0 ? hrZones(sessions, refMaxHr) : []), [sessions, refMaxHr]);
  const zoneMinutes = useMemo(() => zones.reduce((a, z) => a + z.minutes, 0), [zones]);

  const week = useMemo(() => (index?.to ? weekCompare(days, index.to) : []), [days, index]);
  const rhr = useMemo(() => (index?.to ? restingHrCompare(days, index.to) : null), [days, index]);
  const bests = useMemo(() => personalBests(sessions, days), [sessions, days]);
  const streak = useMemo(() => (index?.to ? stepStreak(days, index.to) : 0), [days, index]);
  const kinds = useMemo(() => typeBreakdown(sessions), [sessions]);

  /** 有功率序列的场次 —— 只有它们谈得上功率分析。 */
  const powered = useMemo(
    () =>
      sessions
        .map((s) => ({ s, p: powerStats(s.powerSeries, s.powerAvg, s.powerMax) }))
        .filter((x): x is { s: ChealthSession; p: NonNullable<ReturnType<typeof powerStats>> } => x.p !== null)
        .filter((x) => x.p.np > 0),
    [sessions],
  );

  // ⚠️ 运动类型筛选（读者 2026-09-28 点名要的：「要可以筛选器形跑步这些还是全部」）。
  //    `ALL` 是默认值；只列出**这个窗口里真的出现过**的类型，不铺一长串空分类。
  const [kind, setKind] = useState<string>('ALL');
  const shown = useMemo(
    () => (kind === 'ALL' ? sessions : sessions.filter((s) => s.type === kind)),
    [sessions, kind],
  );

  // ⚠️ 展开哪一条运动。默认**全收起** —— 每条运动有四条曲线，全展开时这一屏
  //    实测 2868px（面板只有 844px），要滚很久才看得到第二条。
  //    三星健康的列表也是先给摘要、点开才给细节。
  const [open, setOpen] = useState<string | null>(null);

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CHEALTH" backTo={homePanelUrl('chealth')} />

      {!pass ? (
        <Section index={0} title="需要口令" lede="健康数据是加密发布在公开 CDN 上的，需要口令才能解开。" compact>
          <View className="card">
            <Text className="card__label">健康索引在 gh-pages 上是 AES-GCM 密文，公开可下载但不可读。</Text>
            <Text className="card__label">
              在地址后面加 ?k=你的口令 一次即可记住；口令放在 URL 的 # 之后，浏览器不会把它发给任何服务器。
            </Text>
          </View>
        </Section>
      ) : null}

      <PageStack count={6}>
        <Section
          index={0}
          title="CHEALTH"
          hero={<PageHero brand="CHEALTH" />}
          compact
          lede="三星健康 → Health Connect → 手机上的 CEVTUO Health → 阿里云 → 这里。每 15 分钟一次，中间没有电脑。"
        >
          {/*
            ⚠️ 这里原来用 `stats={[...]}`，出来是**等分的 2×2 四宫格**。
            读者 2026-09-28 明确说「不要完全对得太齐」，并给了 Depo Studio 那套
            参考：**块与块大小不等**，而且有一个强烈的蓝色。

            ⚠️ 但不等大小是**为了表达层级**，不是为了花：
            今日步数最大（块最宽、字最大、蓝色实底），其余按重要性递减。
            四个块都做成不一样大就变成噪音了。
          */}
          <View className="chc__mosaic">
            {/*
              ⚠️ 每块的结构是「**彩色圆底图标 + 标签**」在上、大数字在下 —— 这是
              三星健康最有辨识度的一处排法，读者点名要「图标尽量一样」。
              原来只有一行文字标签，没有任何图形，所以整页读起来像表格。
            */}
            <View className="chc__tile chc__tile--wide chc__tile--blue">
              <View className="chc__mhead">
                <View className="chc__badge chc__badge--steps">
                  <Icon name="steps" />
                </View>
                <Text className="chc__mlabel">今日步数</Text>
              </View>
              <Text className="chc__tile-v">
                {t?.stepsToday !== null && t?.stepsToday !== undefined
                  ? Math.round(t.stepsToday).toLocaleString('en-US') : '—'}
                <Text className="chc__tile-u">步</Text>
              </Text>
              {/* ⚠️ 「截至现在」必须说出来。不说的话，早上读到 3,123
                  而中位数接近 22,000，看起来像塌了。 */}
              <Text className="chc__tile-note">{partial ? '截至现在 · 今天还没过完' : '至今'}</Text>
            </View>

            <View className="chc__tile chc__tile--narrow">
              <View className="chc__mhead">
                <View className="chc__badge chc__badge--sleep">
                  <Icon name="moon" />
                </View>
                <Text className="chc__mlabel">睡眠</Text>
              </View>
              <Text className="chc__tile-v">
                {t?.sleep7dHours ?? '—'}
                <Text className="chc__tile-u">h</Text>
              </Text>
            </View>

            <View className="chc__tile chc__tile--half">
              <View className="chc__mhead">
                <View className="chc__badge chc__badge--kcal">
                  <Icon name="flame" />
                </View>
                <Text className="chc__mlabel">活动消耗</Text>
              </View>
              <Text className="chc__tile-v">
                {t?.activeCalories7d !== undefined ? Math.round(t.activeCalories7d).toLocaleString('en-US') : '—'}
                <Text className="chc__tile-u">kcal</Text>
              </Text>
            </View>

            <View className="chc__tile chc__tile--half">
              <View className="chc__mhead">
                <View className="chc__badge chc__badge--dist">
                  <Icon name="route" />
                </View>
                <Text className="chc__mlabel">距离</Text>
              </View>
              <Text className="chc__tile-v">
                {t?.distance7dKm ?? '—'}
                <Text className="chc__tile-u">km</Text>
              </Text>
            </View>
          </View>
          {/* ⚠️ 「7 天」从标签里挪到这里**统一说一次**。放在每个块里会把窄块
              的标签挤成三行（实测：「7 天睡眠」折成「7/天/睡眠」）。 */}
          <Text className="chc__tile-note" style={{ marginTop: 7 }}>
            睡眠 · 活动消耗 · 距离 都是最近 7 天；步数是今天
          </Text>
        </Section>

        {/*
          ⚠️「正在骑 MyWhoosh」——这个徽标**只在 true 时出现**，false 时什么都不显示。
          因为 `ridingNow: false` 的真实含义是「没检测到」，不是「确定没在骑」
          （用户没给「使用情况访问」权限时它永远是 false）。显示成「未骑行」就是
          把一个不知道的事说成一个知道的事 —— 这个项目已经栽过好几次。
        */}
        {index?.ridingNow ? (
          <View className="card chc__stack">
            <Text className="card__label">🚴 正在 MyWhoosh 上骑车</Text>
          </View>
        ) : null}

        <Section
          index={1}
          title="运动"
          lede="只显示走路以外的活动。走路照样在采集，只是按你的要求不上页面。"
        >
          {!index?.sessions?.length ? (
            <View className="card chc__stack">
              <Text className="card__label">最近 30 天没有非走路的运动记录。</Text>
              {/*
                ⚠️ 说明为什么可能是空的，而不是让它看起来像坏了。
                MyWhoosh 不支持 Health Connect，它必须先经 Strava 或三星健康过桥，
                而 Health Sync 的后台同步**确实会漏掉整天**（实测 09-23 那次骑行
                是手动「对特定日期重新同步」才捞回来的）。
              */}
              <Text className="card__label">
                提示：MyWhoosh 不支持 Health Connect，骑行要先过桥（三星健康 → Health Sync，或 Strava）。
                如果刚骑完这里没有，在 Health Sync 里用「对特定日期重新同步」把那天捞一次。
              </Text>
            </View>
          ) : (
            <>
              {/* 筛选器：全部 / 各类运动。只列出这个窗口里真的出现过的类型。 */}
              <View className="chc__chips">
                {[{ k: 'ALL', label: '全部' }, ...kinds.map((x) => ({ k: x.type, label: typeLabel(x.type) }))].map((c) => (
                  <View
                    key={c.k}
                    className={`chc__chip${kind === c.k ? ' chc__chip--on' : ''}`}
                    onClick={() => setKind(c.k)}
                  >
                    {c.k === 'ALL' ? <Icon name="signal" /> : <Icon name={typeIcon(c.k)} />}
                    <Text>{c.label}</Text>
                    <Text className="chc__chip-n">
                      {c.k === 'ALL' ? sessions.length : kinds.find((x) => x.type === c.k)?.count ?? 0}
                    </Text>
                  </View>
                ))}
              </View>

              {shown.length === 0 ? (
                <View className="card chc__stack">
                  <Text className="card__label">这个筛选下没有记录。</Text>
                </View>
              ) : null}

              {shown.map((sess: ChealthSession) => {
                const isOpen = open === sess.start;
                return (
              <View className="card chc__stack" key={sess.start}>
                <View className="chc__fold" onClick={() => setOpen(isOpen ? null : sess.start)}>
                  <Icon name={typeIcon(sess.type)} className="chc__ico" />
                  <Text className="card__label">
                    {typeLabel(sess.type, sess.exerciseType)} · {sess.start.slice(5, 16).replace('T', ' ')} · {sess.minutes} 分钟
                  </Text>
                  <Icon name="chev" className={`chc__fold-mark${isOpen ? ' chc__fold-mark--open' : ''}`} />
                </View>
                <View className="chc__legend">
                  {sess.distanceM !== undefined ? (
                    <Text className="chc__key">距离 <Text className="chc__num">{(sess.distanceM / 1000).toFixed(2)} km</Text></Text>
                  ) : null}
                  {sess.powerAvg !== undefined ? (
                    <Text className="chc__key">平均功率 <Text className="chc__num">{sess.powerAvg} W</Text></Text>
                  ) : null}
                  {sess.powerMax !== undefined ? (
                    <Text className="chc__key">峰值功率 <Text className="chc__num">{sess.powerMax} W</Text></Text>
                  ) : null}
                  {sess.cadenceAvg !== undefined ? (
                    <Text className="chc__key">踏频 <Text className="chc__num">{sess.cadenceAvg} rpm</Text></Text>
                  ) : null}
                  {sess.speedMaxMps !== undefined ? (
                    <Text className="chc__key">最高速度 <Text className="chc__num">{(sess.speedMaxMps * 3.6).toFixed(1)} km/h</Text></Text>
                  ) : null}
                  {sess.hrAvg !== undefined ? (
                    <Text className="chc__key">心率 <Text className="chc__num">{sess.hrAvg}</Text> 均 / <Text className="chc__num">{sess.hrMax ?? '—'}</Text> 峰</Text>
                  ) : null}
                  {sess.activeCalories !== undefined ? (
                    <Text className="chc__key">活动消耗 <Text className="chc__num">{sess.activeCalories}</Text> kcal</Text>
                  ) : null}
                </View>
                {/* ⚠️ 细节**默认收起**：四条曲线加起来比面板还高。点标题展开。 */}
                {isOpen ? (
                  <>
                {/*
                  ⚠️⚠️ THE HEART-RATE CURVE — the reader asked for this by name.
                  An average cannot be drawn, so the phone sends the series.
                */}
                {sess.hrSeries && sess.hrSeries.length > 1 ? (
                  <View>
                    <Text className="card__label">心率曲线</Text>
                    <HeartChart series={sess.hrSeries} />
                  </View>
                ) : null}

                {/*
                  ⚠️ 功率 / 踏频 / 速度的**过程曲线**，不只是平均值。
                  读者要的是「经历过程中」的变化：平均功率会把
                  「4 分钟 400W + 4 分钟 100W」和「全程 250W」显示成同一个数字，
                  而这两件事在训练上完全不同。
                  ⚠️ 四张图共用 SeriesChart —— 各写一遍必然漂移。
                */}
                {sess.powerSeries && sess.powerSeries.length > 1 ? (
                  <View>
                    <Text className="card__label">功率曲线</Text>
                    <SeriesChart series={sess.powerSeries} name="功率曲线" unit=" W" peakNote="（原始峰值见上）" />
                  </View>
                ) : null}

                {sess.cadenceSeries && sess.cadenceSeries.length > 1 ? (
                  <View>
                    <Text className="card__label">踏频曲线</Text>
                    <SeriesChart series={sess.cadenceSeries} name="踏频曲线" unit=" rpm" />
                  </View>
                ) : null}

                {/*
                  ⚠️ 速度存的是 m/s（Health Connect 的单位），**在渲染时换成 km/h** ——
                  页面别的地方、以及读者的常识，用的都是 km/h。换算只在这一处做。
                */}
                {sess.speedSeries && sess.speedSeries.length > 1 ? (
                  <View>
                    <Text className="card__label">速度曲线</Text>
                    <SeriesChart
                      series={sess.speedSeries.map(([t, v]) => [t, Math.round(v * 36) / 10] as [number, number])}
                      name="速度曲线"
                      unit=" km/h"
                    />
                  </View>
                ) : null}

                {/*
                  ⚠️ 来源要写清楚，而且**一场骑行常常是两个来源**。
                  手表测心率（三星健康），MyWhoosh 测功率踏频，谁也测不全 ——
                  手机把它们合成一条。不写出来，读者会困惑为什么一条骑行
                  既有手表的心率又有功率；写出来，这就是一个完整的解释。
                */}
                <Text className="card__label">
                  记录来源 {(sess.sources ?? [sess.source])
                    .map((x: string) => x.split('.').pop())
                    .join(' + ')}
                  {sess.powerAvg === undefined ? '（这次没有功率/踏频数据）' : ''}
                  {sess.hrSource ? ` · 心率取自 ${sess.hrSource.split('.').pop()}` : ''}
                </Text>
                  </>
                ) : null}
              </View>
                );
              })}
            </>
          )}
        </Section>

        <Section
          index={2}
          title="步数与睡眠"
          lede="柱状是每天的总量，最近 14 天。空白的那天是没记录，不是零。"
        >
          <View className="card chc__stack">
            <Text className="card__label">步数 · 最近 14 天</Text>
            <BarRow days={recent} pick={(d) => d.steps} today={today} unit=" 步" />
          </View>

          <View className="card chc__stack">
            <Text className="card__label">睡眠 · 最近 14 天（小时）</Text>
            <BarRow days={recent} pick={(d) => (d.sleepSeconds ? d.sleepSeconds / 3600 : undefined)} today={today} unit=" 小时" />
            {/* ⚠️ Said rather than silently tolerated. Sessions can overlap —
                the watch and the phone both write, and a session crossing
                midnight lands in two days — so a single day can exceed 24h.
                Measured: 2026-09-08 reported 27.9 hours. */}
            {recent.some((d) => (d.sleepSeconds ?? 0) > 20 * 3600) ? (
              <Text className="card__label">
                ⚠️ 有单日超过 20 小时 —— 睡眠会话在手表和手机之间重叠时会重复计入
              </Text>
            ) : null}
          </View>
        </Section>

        <Section
          index={3}
          title="消耗"
          lede="两条线分开：基础代谢是躺着也在烧的那部分，活动消耗才是动出来的。"
        >
          <View className="card chc__stack">
            <Text className="card__label">7 天合计</Text>
            <Text className="card__label">
              总消耗 {t ? Math.round(t.calories7d).toLocaleString('en-US') : '—'} kcal
              ｜ 其中活动 {t ? Math.round(t.activeCalories7d).toLocaleString('en-US') : '—'} kcal
            </Text>
            {/* ⚠️⚠️ The label is the whole point of this panel.
                `calories7d` sums TotalCaloriesBurnedRecord, which includes BMR.
                In the first real data set it was 1662 on ELEVEN consecutive
                days with no other data at all — a dead-flat line that any
                reader would file as a broken sensor, when it is the most
                correct number on the page. */}
            <Text className="card__label">
              总消耗含基础代谢（静息也要消耗），所以没活动的日子也在 1600 左右。两者相减才是走路跑步花掉的。
            </Text>
            <Legend
              items={[
                { label: '总消耗（含基础代谢）', color: 'var(--chart-3)' },
                { label: '活动消耗', color: 'var(--chart-1)' },
              ]}
            />
          </View>
          <View className="card chc__stack">
            <Text className="card__label">总消耗 · 最近 14 天</Text>
            <BarRow days={recent} pick={(d) => d.calories} today={today} unit=" kcal" />
          </View>
          <View className="card chc__stack">
            <Text className="card__label">活动消耗 · 最近 14 天</Text>
            <BarRow days={recent} pick={(d) => d.activeCalories} today={today} unit=" kcal" />
          </View>
        </Section>

        <Section
          index={4}
          title="心率与来源"
          lede="手表测的，经 Health Sync 过桥到 Health Connect，再由手机上报。"
          showCue={false}
        >
          {have('hrAvg') ? (
            <View className="card chc__stack">
              <Text className="card__label">日均心率 · 最近 14 天</Text>
              <Spark points={recent.map((d) => d.hrAvg)} />
            </View>
          ) : null}

          <View className="card chc__stack">
            <Text className="card__label">各项指标（7 天）</Text>
            <Text className="card__label">
              静息心率 {t?.restingHr7d ?? '—'} ｜ 血氧 {t?.spo2_7d ?? '—'}% ｜ 体重 {t?.weightKgLatest ?? '—'} kg
              ｜ 距离 {t ? `${t.distance7dKm} km` : '—'}
            </Text>
            <Text className="card__label">
              ⚠️ HRV、呼吸率、皮温、体重在最近 30 天里一条记录都没有 —— 是三星健康不往 Health Connect 写，
              不是这里读漏了。显示成 0 会让它看起来像「测出来是零」。
            </Text>
          </View>

          {/*
            ⚠️ THIS TABLE IS THE MOST USEFUL THING ON THE PAGE, and it exists
            because of a specific afternoon. Step counts read "latest 06:27" at
            15:00 and that looked like a dead watch. It was not: the handset
            sensor was still writing a minute earlier, while Health Sync and
            Google Fit had both stopped ~21 hours before. Three sources, two
            dead, one alive — invisible in every total, obvious here.
          */}
          <View className="card chc__stack">
            <Text className="card__label">数据来源（谁在写、多久没写了）</Text>
            <table className="chc__src">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>条数</th>
                  <th>最后写入</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(index?.origins ?? {}).map(([pkg, o]) => {
                  const mins = o.lastAt ? (Date.now() - new Date(o.lastAt).getTime()) / 60000 : NaN;
                  // ⚠️ Two hours, because the phone's own sensor writes every
                  // few minutes while a bridged source batches. Anything older
                  // than that is a stall, not a rhythm.
                  const stale = Number.isFinite(mins) && mins > 120;
                  return (
                    <tr key={pkg}>
                      <td>{pkg}</td>
                      <td>{o.count}</td>
                      <td className={stale ? 'chc__stale' : 'chc__fresh'}>
                        {Number.isFinite(mins)
                          ? mins < 90 ? `${Math.round(mins)} 分钟前` : `${(mins / 60).toFixed(1)} 小时前`
                          : '—'}
                        {stale ? ' ⚠️' : ''}
                      </td>
                    </tr>
                  );
                })}
                {!Object.keys(index?.origins ?? {}).length ? (
                  <tr><td colSpan={3}>还没有来源信息 —— 手机端 v1.3 起才有</td></tr>
                ) : null}
              </tbody>
            </table>
          </View>

          <View className="card chc__stack">
            <Text className="card__label">同步</Text>
            {/*
              ⚠️ Both stamps, because they answer different questions.
              `lastPushAt` ("手机来过了") comes from the ingest over an
              uncached connection and moves on EVERY push, including one that
              changed nothing. `updatedAt` ("数字变了") comes from the published
              file and obeys a 10-minute CDN cache. Showing only the second is
              how a working sync came to look broken for a week on CAPPERR.
            */}
            <Text className="card__label">
              手机上报 {beat?.lastPushAt ? beat.lastPushAt.slice(5).replace('T', ' ') : '—'}
              ｜ 数据更新 {index?.updatedAt ? index.updatedAt.slice(5).replace('T', ' ') : '—'}
            </Text>
            <Text className="card__label">
              累计 {index?.dayCount ?? 0} 天（{index?.from ?? '—'} → {index?.to ?? '—'}）· 手机端 v{index?.appVersion ?? '—'}
            </Text>
            {/*
              ⚠️ The verdict, not another stamp. See `stallDays` above for why
              two timestamps in one sentence are not a warning.
            */}
            {stallDays >= 2 ? (
              <Text className="card__label chc__stale">
                ⚠️ 手机一直在推，数据却没动 —— 最新一天是 {index?.to}，比手机最后一次上报早 {stallDays} 天。
                三星健康国行不写 Health Connect，Health Sync 是它唯一的入口，先去手机上确认它还在同步。
              </Text>
            ) : null}
            {!beat ? (
              <Text className="card__label">
                ⚠️ 读不到上报心跳 —— 阿里云那边可能没响应，数据本身仍是最新发布的那份
              </Text>
            ) : null}
          </View>
        </Section>
        <Section
          index={5}
          title="分析"
          lede="全部从上面那份索引里算出来 —— 不额外采集、不额外存储。心率区间和功率分析以前算不出来，它们要用过程序列。"
        >
          {zoneMinutes > 0 ? (
            <View className="card chc__stack">
              <Text className="card__label">
                <Icon name="heart" className="chc__ico" />
                心率区间 · 最近 30 天共 {Math.round(zoneMinutes)} 分钟
              </Text>
              <View className="chc__zones">
                {zones.map((z) => {
                  const pct = zoneMinutes > 0 ? (z.minutes / zoneMinutes) * 100 : 0;
                  return (
                    <View className="chc__zone" key={z.key}>
                      <Text className="chc__zone-label">{z.label}</Text>
                      {/* ⚠️ 宽度只来自这一个数 —— 不写死像素。这个项目吃过亏：
                          柱状图曾用 88/84/76/72 四个手写数字，眼睛会把「高度差」
                          读成「数据差」。 */}
                      <View className="chc__zone-bar" style={{ '--pct': String(Math.max(1, Math.round(pct))) } as CSSProperties}>
                        <i />
                      </View>
                      <Text className="chc__zone-min">{Math.round(z.minutes)} 分</Text>
                    </View>
                  );
                })}
              </View>
              <Text className="card__label">
                基准最高心率 {refMaxHr} —— 取的是**最近 30 天实测到的最高值**，不是 220−年龄。
                代价是它偏低（没尽全力就到不了真最大值），所以这个划分整体偏严。
              </Text>
            </View>
          ) : null}

          {week.length ? (
            <View className="card chc__stack">
              <Text className="card__label">
                <Icon name="signal" className="chc__ico" />
                最近 7 天 vs 再往前 7 天
              </Text>
              <View className="chc__grid">
                {week.map((w) => {
                  const d = w.deltaPct;
                  const cls = d === null || Math.abs(d) < 3 ? 'chc__flat' : d > 0 ? 'chc__up' : 'chc__down';
                  const ico = d === null || Math.abs(d) < 3 ? 'flat' : d > 0 ? 'up' : 'down';
                  return (
                    <View className="chc__cell" key={w.label}>
                      <Text>{w.label}</Text>
                      <Text className="chc__cell-v">
                        {w.cur.toLocaleString('en-US')}
                        {w.unit}
                      </Text>
                      <Text className={cls}>
                        <Icon name={ico} />
                        {d === null ? '' : `${d > 0 ? '+' : ''}${d}%`}
                      </Text>
                    </View>
                  );
                })}
                {/* ⚠️ 静息心率**单独一行**，因为它是「越低越好」的指标 ——
                    混在上面用同一套箭头方向会上反。 */}
                {rhr ? (
                  <View className="chc__cell">
                    <Text>{rhr.label}</Text>
                    <Text className="chc__cell-v">{rhr.cur} {rhr.unit}</Text>
                    <Text
                      className={
                        rhr.deltaPct === null || Math.abs(rhr.deltaPct) < 3
                          ? 'chc__flat'
                          : rhr.deltaPct < 0
                            ? 'chc__up'
                            : 'chc__down'
                      }
                    >
                      <Icon name={rhr.deltaPct === null || Math.abs(rhr.deltaPct) < 3 ? 'flat' : rhr.deltaPct < 0 ? 'down' : 'up'} />
                      {rhr.deltaPct === null ? '' : `${rhr.deltaPct > 0 ? '+' : ''}${rhr.deltaPct}%`}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text className="card__label">
                ⚠️ 「—」是**上周没有可比数据**，不是上周为零。两者用一个百分比表示会得到一个
                看起来很确定、实际没有依据的数。静息心率是**越低越好**，箭头按那个方向画。
              </Text>
            </View>
          ) : null}

          {bests.length ? (
            <View className="card chc__stack">
              <Text className="card__label">
                <Icon name="trophy" className="chc__ico" />
                个人记录 · 最近 30 天
              </Text>
              <View className="chc__grid">
                {bests.map((b) => (
                  <View className="chc__cell" key={b.label}>
                    <Icon name={b.icon as never} className="chc__ico" />
                    <Text>{b.label}</Text>
                    <Text className="chc__cell-v">{b.value}</Text>
                    <Text className="chc__flat">{b.when}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {streak > 0 ? (
            <View className="card chc__stack">
              <Text className="card__label">
                <Icon name="steps" className="chc__ico" />
                连续达标 {streak} 天（每天 ≥ 8,000 步）
              </Text>
              <Text className="card__label">
                ⚠️ 从最新一天往回数，**缺数据的日子算断**，不算跳过 —— 那天可能确实没走，
                也可能手机没同步，我们不知道，所以不替它猜。
              </Text>
            </View>
          ) : null}

          {kinds.length ? (
            <View className="card chc__stack">
              <Text className="card__label">
                <Icon name="clock" className="chc__ico" />
                运动类型分布 · 最近 30 天
              </Text>
              <View className="chc__zones">
                {kinds.map((k) => {
                  const total = kinds.reduce((a, x) => a + x.minutes, 0);
                  const pct = total > 0 ? (k.minutes / total) * 100 : 0;
                  return (
                    <View className="chc__zone" key={k.type}>
                      <Icon name={typeIcon(k.type)} className="chc__ico" />
                      <Text className="chc__zone-label">{typeLabel(k.type)}</Text>
                      <View className="chc__zone-bar" style={{ '--pct': String(Math.max(1, Math.round(pct))) } as CSSProperties}>
                        <i />
                      </View>
                      <Text className="chc__zone-min">{k.count} 次</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          {powered.map(({ s, p }) => (
            <View className="card chc__stack" key={`pw-${s.start}`}>
              <View className="chc__sesshead">
                <Icon name="power" className="chc__ico" />
                <Text className="card__label">
                  功率分析 · {typeLabel(s.type)} {s.start.slice(5, 16).replace('T', ' ')}
                </Text>
              </View>
              <View className="chc__grid">
                <View className="chc__cell"><Text>平均</Text><Text className="chc__cell-v">{p.avg} W</Text></View>
                <View className="chc__cell"><Text>峰值</Text><Text className="chc__cell-v">{p.max} W</Text></View>
                {p.np > 0 ? (
                  <View className="chc__cell"><Text>标准化 NP</Text><Text className="chc__cell-v">{p.np} W</Text></View>
                ) : null}
                {p.best20 !== null ? (
                  <View className="chc__cell"><Text>最佳 20 分钟</Text><Text className="chc__cell-v">{p.best20} W</Text></View>
                ) : null}
              </View>
              <Text className="card__label">
                ⚠️ NP 是给「间歇骑比匀速骑累得多」这件事用的：30 秒滚动平均后取四次方平均再开四次方。
                **但我们没有 30 秒数据** —— 手机端发来的已经是逐分钟聚合过的，所以这个 NP **偏低**。
                ⚠️ 不算 IF / TSS：那两个都要 FTP，而 FTP 得专门测。拿「最佳 20 分钟 × 0.95」估一个再算 TSS，
                会得到一个看起来很专业、其实是我们编的数字。
              </Text>
            </View>
          ))}
        </Section>
      </PageStack>

      {err ? (
        <View className="card">
          <Text className="card__label">读不到健康数据：{err}</Text>
        </View>
      ) : null}
    </View>
  );
}
