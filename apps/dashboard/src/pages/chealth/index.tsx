import { useEffect, useMemo, useState } from 'react';
import { Text, View } from '@tarojs/components';

import { BarRow, HeartChart, Legend, SeriesChart, Spark } from '../../components/ChealthCharts';
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

/**
 * ⚠️ Health Connect's exercise types are machine names (`BIKING`,
 * `BIKING_STATIONARY`). Unknown numbers arrive as `TYPE_<n>` and are shown
 * as-is rather than as "未知" — a number is something a reader can look up,
 * "unknown" is a dead end.
 */
function sessionLabel(type: string): string {
  const map: Record<string, string> = {
    BIKING: '🚴 骑行',
    BIKING_STATIONARY: '🚴 室内骑行',
    RUNNING: '🏃 跑步',
    RUNNING_TREADMILL: '🏃 跑步机',
    HIKING: '🥾 徒步',
    SWIMMING_POOL: '🏊 游泳',
    STRENGTH_TRAINING: '🏋️ 力量训练',
    YOGA: '🧘 瑜伽',
    ELLIPTICAL: '椭圆机',
    ROWING_MACHINE: '🚣 划船机',
    STAIR_CLIMBING_MACHINE: '爬楼机',
  };
  return map[type] ?? type;
}

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

      <PageStack count={5}>
        <Section
          index={0}
          title="CHEALTH"
          hero={<PageHero brand="CHEALTH" />}
          compact
          lede="三星健康 → Health Connect → 手机上的 CEVTUO Health → 阿里云 → 这里。每 15 分钟一次，中间没有电脑。"
          stats={[
            {
              value: t?.stepsToday !== null && t?.stepsToday !== undefined
                ? Math.round(t.stepsToday).toLocaleString('en-US') : '—',
              label: '今日步数',
              // ⚠️ Says "so far" out loud. Without it, a morning reading of
              // 3,163 against a ~22,000 median reads as a collapse.
              note: partial ? '截至现在' : '至今',
            },
            {
              value: t?.sleep7dHours !== undefined ? `${t.sleep7dHours}h` : '—',
              label: '7 天睡眠',
              note: '共',
            },
            {
              value: t?.activeCalories7d !== undefined ? Math.round(t.activeCalories7d).toLocaleString('en-US') : '—',
              label: '7 天活动消耗',
              note: 'kcal',
            },
            {
              value: t?.distance7dKm !== undefined ? `${t.distance7dKm}` : '—',
              label: '7 天距离',
              note: 'km',
            },
          ]}
        />

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
            index.sessions.map((sess: ChealthSession) => (
              <View className="card chc__stack" key={sess.start}>
                <Text className="card__label">
                  {sessionLabel(sess.type)} · {sess.start.slice(5, 16).replace('T', ' ')} · {sess.minutes} 分钟
                </Text>
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
              </View>
            ))
          )}
        </Section>

        <Section
          index={2}
          title="步数与睡眠"
          lede="柱状是每天的总量，最近 14 天。空白的那天是没记录，不是零。"
        >
          <View className="card chc__stack">
            <Text className="card__label">步数 · 最近 14 天</Text>
            <BarRow days={recent} pick={(d) => d.steps} today={today} />
          </View>

          <View className="card chc__stack">
            <Text className="card__label">睡眠 · 最近 14 天（小时）</Text>
            <BarRow days={recent} pick={(d) => (d.sleepSeconds ? d.sleepSeconds / 3600 : undefined)} today={today} />
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
            <BarRow days={recent} pick={(d) => d.calories} today={today} />
          </View>
          <View className="card chc__stack">
            <Text className="card__label">活动消耗 · 最近 14 天</Text>
            <BarRow days={recent} pick={(d) => d.activeCalories} today={today} />
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
      </PageStack>

      {err ? (
        <View className="card">
          <Text className="card__label">读不到健康数据：{err}</Text>
        </View>
      ) : null}
    </View>
  );
}
