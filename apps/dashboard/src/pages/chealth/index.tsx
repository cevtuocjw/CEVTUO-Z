import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Input, Text, View } from '@tarojs/components';

import {
  BarRow,
  Gauge,
  GoalCalendar,
  HeartChart,
  Rings,
  // ⚠️ 三星「能量得分」右边那排七日点条（读者 2026-09-29 点名要的形状）。
  ScoreBars,
  SeriesChart,
  Spark,
} from '../../components/ChealthCharts';
import { Icon, typeIcon } from '../../components/ChealthIcons';
import {
  HR_BANDS,
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
import { IconGrid, Sheet } from '../../components/Sheet';
import { TopBar } from '../../components/TopBar';
import { homePanelUrl } from '../../platform/panels';
import { Wallpaper } from '../../components/Wallpaper';
import {
  fetchChealthHeartbeat,
  fetchChealthIndex,
  // ⚠️ 三屏的「数据更新 …」用它 —— 和主页那一格**同一个格式化器**。
  //    自己 `slice(5).replace('T',' ')` 会多带一个 `+08:00`（见下面 freshness 那段）。
  formatUpdatedAt,
  type ChealthDay,
  type ChealthSession,
  type ChealthHeartbeat,
  type ChealthIndex,
} from '../../platform/data';
// ⚠️ 口令读取抽到了 platform/health-pass.ts —— 主页索引卡也要用它，而且必须
//    读**同一个键**，否则在 CHEALTH 页输过口令之后主页仍然显示「—」且不报错。
import { readPass, savePass } from '../../platform/health-pass';

import '../../styles/demo.scss';

// ⚠️ 目标值住在 platform 里 —— 主页那格 CHEALTH 也要用同一个分母。见该文件抬头。
import { STEP_GOAL, ACTIVE_KCAL_GOAL, ACTIVE_MIN_GOAL, SLEEP_GOAL_H } from '../../platform/chealth-goals';

/**
 * 小时 → 「7h32m」。
 *
 * ⚠️ 三星健康展示睡眠用的是**时长**，不是「7.53 小时」。后者读者要在脑子里
 *    做一次乘法才知道是 7 点半，而睡眠是这一页上唯一一个「小数没意义」的指标。
 */
function hm(hours: number): string {
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m`;
}

/**
 * 分钟 → 「3:44:40」。
 *
 * ⚠️ 三星运动页那个大字总时长就是这个格式，而它**不是**随便挑的：
 *    同一个数写成「224 分钟」要多做一次心算，写成「3.7 小时」会把秒抹掉，
 *    而运动时长恰恰是少数几个「秒有意义」的指标。
 */
function hms(minutes: number): string {
  const s = Math.round(minutes * 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * `YYYY-MM-DD` 加减天数。
 *
 * ⚠️ 用 **UTC** 做算术。用本地时区的话，读者在 UTC-5 打开页面时
 *    「最后一天往回数 7 天」会少算一天 —— 而窗口是所有统计的分母，
 *    差一天不会报错，只会让每个汇总数都轻微不同。
 */
function shiftDate(date: string, delta: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

/** 运动页那个分段控件的三档，以及各档往回数几天。 */
const SPANS = [
  { k: 'day', label: '天', days: 1 },
  { k: 'week', label: '周', days: 7 },
  { k: 'month', label: '月', days: 30 },
] as const;
type SpanKey = (typeof SPANS)[number]['k'];

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return '';
  return WEEKDAY[new Date(t).getUTCDay()] ?? '';
}

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
/*
 * ⚠️⚠️ 2026-09-28 晚：这一页从**十屏**收成了**三屏 + 六个弹窗**。
 *
 * 读者的原话是「把 10 屏尽量处理进 3 屏，可以通过弹窗的形式来归并，
 * 但是要尽量展示多的是在外边的是图标，而文字尽量缩减和折叠，大小也减小」。
 *
 * 为什么不是「再拆几屏」：十屏摊开之后，读者每看一遍要翻十次，而其中八屏
 * 他每次都不看；侧边进度条变成十个小方块，密集到分不出「我在第几屏」；
 * 每一屏都自带一段 lede 和一堆说明文字，**翻页的成本被文字吃掉了**。
 *
 * ⇒ 主屏只留一眼要看的（今天怎么样 / 动了什么 / 趋势什么样），
 *   细节（心率、周对比、功率、连续达标、类型分布、数据来源）点图标再展开。
 *
 * ⚠️⚠️ 接线方式：**把 `<Section>` 的开闭标签整个换成 `<Sheet>`**，
 *    children 一个字节都不动。
 *
 *    上一轮我试过写脚本跨 300 行搬 JSX，typecheck 报了 9 处语法错误
 *    （打开的 `<Sheet ...>` 没被正确闭合），只能整体回退。
 *    ⚠️ 搬 JSX 是**结构**操作，而脚本擅长的是**文本**操作 —— 两者在这里不等价。
 *
 * ⚠️ 弹窗**全部渲染在 `</PageStack>` 外面**，不是留在原来的位置。
 *    `.sheet` 是 `position: fixed`，而 `fixed` 的包含块是**最近一个带
 *    transform / filter / backdrop-filter / contain 的祖先**。留在栈里就得
 *    赌 `.stack` 和 `.section` 上没有这些属性 —— 赌赢一次，下次有人给某个
 *    容器加一句 `will-change` 就静默失效（弹窗跑到某一屏里面去）。
 */
export default function Chealth() {
  const [index, setIndex] = useState<ChealthIndex | null>(null);
  const [beat, setBeat] = useState<ChealthHeartbeat | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [pass, setPass] = useState<string>(() => readPass());

  /**
   * ⚠️⚠️ 这一整块（typed / busy / unlockErr / submit）是 2026-09-28 补的，
   *    因为**在这一天之前，这一页没有地方可以输入口令**。
   *
   * 未解锁时它只显示一段说明：「在地址后面加 ?k=你的口令」——
   * 也就是要求读者**手改地址栏**。在手机上这基本等于没有入口。
   * 读者当天的话是「我在网站上看到的完全没有数据和展示」：他打开站点，
   * CHEALTH 那格写着「未解锁」，而没有任何地方能把它解开。
   *
   * ⚠️ 一个需要输入却只有输入框的页面是半成品；**一个需要输入却连输入框
   *    都没有的页面，读者只会认为它坏了。**
   */
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);

  /**
   * ⚠️ 先**验证再记住** —— 顺序不能反。
   *
   * 记住一个错的口令比不记住更糟：下次打开时页面不会说「口令不对」，
   * 而是直接渲染成一个**没有数据的 CHEALTH 页**，看起来像管道断了。
   * 读者会去查手机、查服务器，不会想到问题在自己设备的 localStorage 里。
   */
  const submitPass = async () => {
    const v = typed.trim();
    if (!v || busy) return;
    setBusy(true);
    setUnlockErr(null);
    try {
      await fetchChealthIndex(v);
      savePass(v);
      setPass(v);
    } catch {
      // ⚠️ AES-GCM 解不开只有两种可能：口令错，或者文件没取到。
      //    两者都写出来，不替读者猜是哪一个。
      setUnlockErr('解不开。口令不对，或者索引没取到。');
    } finally {
      setBusy(false);
    }
  };

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
   * ⚠️ 读者 2026-09-29：「CHEALTH 各处要有更新时间的功能」。
   *
   *    三屏各挂一次，用的是**同一个值**（不是三个各自的「最后一条数据时间」）——
   *    这一项答的是「这份索引是什么时候生成的」，三屏看到的不该不一样。
   *
   * ⚠️ 只有 `updatedAt` 真的存在才显示，**不写「—」**：
   *    一个写着「数据更新 —」的时间戳比没有时间戳更糟，它看起来像
   *    「更新过一次，但值是空的」，而实际是「我们根本没拿到这份索引」。
   *    （同样的话主页那边也是这么处理的。）
   */
  // ⚠️ 走 `formatUpdatedAt`，**不要自己 `slice(5).replace('T',' ')`** ——
  //    第一版就是那么写的，页面上显示成「09-29 15:17+08:00」：
  //    那个 `+08:00` 是给机器看的，读者要的是「几点更新的」。
  //    ⚠️ 而且主页同一格用的是 `formatUpdatedAt` —— 同一个字段两种显示，
  //      迟早会一处改了另一处没改（这个项目已经吃过两次）。
  /**
   * 七日点条用的数据 —— **最后 7 个自然日**，每天一个 0–1 的进度。
   *
   * ⚠️ 分母是 `STEP_GOAL`（和这一页那三个环、柱状图的目标线**同一个定义**）——
   *    各写一个 9,000 迟早漂移。
   * ⚠️ 没有步数的那天传 `null`（画成空轨道），**不是 0**。
   *    这个项目反复栽在「把不知道画成零」上：空轨道和「走了 0 步」必须不一样。
   */
  const scoreDays = useMemo(() => {
    const last7 = days.slice(-7);
    return last7.map((d, i) => ({
      key: d.date,
      // 「09」→「9」：三星那一排也是不补零的（23 24 25…29）
      label: d.date.slice(8).replace(/^0/, ''),
      score: typeof d.steps === 'number' ? Math.min(1, d.steps / STEP_GOAL) : null,
      now: i === last7.length - 1,
    }));
  }, [days]);

  /**
   * ⚠️ 三个**手机一直在同步、类型里也声明了、但页面从来没渲染过**的指标
   *    （读者 2026-09-29：「能展示的内容能展示出来什么」）。
   *
   *    补它们之前先量了一遍真实覆盖（`scripts/chealth-coverage.ts`，31 天）：
   *
   *        平均速度 speedAvgMps      24/31 天有值
   *        运动次数 exerciseCount     21/31 天有非零值
   *        步频     stepsCadenceAvg  14/31 天有值
   *        体重     weightKg          2/31 天   ← 太少，不做
   *        楼层     floors            0/31 天   ← 一条都没有
   *        HRV / 呼吸率               0/31 天   ← 一条都没有
   *
   *    ⚠️⚠️ **「躺在类型里」和「躺在数据里」是两件事。** 这个项目已经因为
   *      「以为有数」栽过一次（HRV / 呼吸率 / 皮温 / 体重在 30 天里一条记录都没有，
   *      而页面差点把它们画成 0）。**做新指标之前先量一遍，量完再决定做哪几个** ——
   *      上面那三个 0/31 的就是量完之后**决定不做**的，不是忘了。
   *
   *    ⚠️ 均值只除**有记录的那些天**，不是除 7 —— 步频只有 14/31 天有值，
   *      除以 7 会把「没走路的那天」当成「步频 0」，把均值拉低近一半。
   *      （同一类错误：把「不知道」当成「零」。）
   */
  const extra7d = useMemo(() => {
    const win = days.slice(-7);
    const nums = (k: keyof ChealthDay) =>
      win.map((d) => d[k]).filter((x): x is number => typeof x === 'number');
    const avg = (k: keyof ChealthDay, digits: number) => {
      const v = nums(k);
      return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(digits) : null;
    };
    const sum = (k: keyof ChealthDay) => {
      const v = nums(k);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0)) : null;
    };
    return {
      speedAvg: avg('speedAvgMps', 2),
      cadence: avg('stepsCadenceAvg', 1),
      exercise7d: sum('exerciseCount'),
    };
  }, [days]);

  const stamp = formatUpdatedAt(index?.updatedAt);
  const freshness = stamp ? `数据更新 ${stamp}` : null;

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
   * ⚠️⚠️ 睡眠显示的是**最近一晚**，不是「7 天累计」。
   *
   *    原来 hero 上那块写着「37.7h」，标签是「睡眠」。**37.7 小时不是任何人
   *    理解睡眠的方式** —— 那是七天的和，而读者脑子里问的是「我昨晚睡了多久」。
   *    三星健康展示的也是昨夜（或每晚均值），不是一段时间的总和。
   *
   * ⚠️ 取**最后一条真的有记录的那天**，不是 `days[days.length-1]`。
   *    最新一天可能还没同步到睡眠（手机早上推的时候手表那条还没过桥），
   *    直接取末日会显示成「—」，看起来像睡眠数据断了。
   *
   * ⚠️ 日期也一起返回：把它印在页面上，读者才知道「最近一晚」是哪一晚。
   *    不印的话，一个停在三周前的管道会显示成「昨晚睡了 7 小时」。
   */
  const lastSleep = useMemo(() => {
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const d = days[i];
      if (d && typeof d.sleepSeconds === 'number' && d.sleepSeconds > 0) {
        return { date: d.date, hours: d.sleepSeconds / 3600 };
      }
    }
    return null;
  }, [days]);

  /** 数据里**最后一天**那一整条 —— 三个环读的就是「今天」。 */
  const lastDay = useMemo(() => days.find((d) => d.date.slice(0, 10) === today) ?? null, [days, today]);

  const stepsToday = typeof t?.stepsToday === 'number' ? t.stepsToday : null;
  /** ⚠️ 环上画的是**活动消耗** —— 见 `ACTIVE_KCAL_GOAL` 那段。 */
  const kcalToday = typeof lastDay?.activeCalories === 'number' ? lastDay.activeCalories : null;

  /**
   * ⚠️ 总消耗**单独标出来**，不进环。读者 2026-09-29：
   *    「总消耗每天要格外标记出来一下」。
   *
   *    它含基础代谢，所以和活动消耗不是一回事 —— 摆进同一个环里会让读者
   *    以为「今天烧了 1,953」是自己动出来的。⚠️ 而这个项目抬头第 2 条
   *    记的正是这个数：没活动的日子也恒在 1,662，像一个坏掉的传感器。
   */
  // ⚠️ 这里原来是 `kcalTotalToday`（取**最后一天**的 `calories`）。2026-09-29 删掉，
  //    换成下面的 `lastCalDay`（取**最近一条真有记录的那天**）——
  //    因为三星是延迟写 `TotalCaloriesBurnedRecord` 的：当天 HC 里一条都没有，
  //    而昨天那条好端端躺着。取最后一天 ⇒ 永远「未采集」。

  /**
   * ⚠️ 活动时间 —— 手机端派生的字段，**历史数据没有**。
   *    没有的时候传 `null`（渲染成「未采集」），不是 0。
   */
  const activeMinToday = typeof lastDay?.activeMinutes === 'number' ? lastDay.activeMinutes : null;

  /** 每晚均值 —— 和「最近一晚」并排，两者回答的是不同的问题。 */
  const avgSleep = useMemo(() => {
    const v = recent.map((d) => (d.sleepSeconds ? d.sleepSeconds / 3600 : undefined)).filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }, [recent]);

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
  const streak = useMemo(() => (index?.to ? stepStreak(days, index.to, STEP_GOAL) : 0), [days, index]);
  const kinds = useMemo(() => typeBreakdown(sessions), [sessions]);

  /**
   * 有**任何**功率数据的场次。
   *
   * ⚠️⚠️ 这里原来多一句 `.filter((x) => x.p.np > 0)`，而 `np`（标准化功率）
   *    **只有拿到过程序列才算得出来**（`powerStats` 的注释里写着）。
   *    于是那一句的含义变成了「只列出有功率序列的骑行」——
   *    一句看起来像「滤掉没功率的」的代码，实际滤掉的是「只有平均值的」。
   *
   *    代价（读者 2026-09-30：「功率与个人记录我记得有更多的功能，补充回来」）：
   *    服务器把序列清掉之后，`powered` **一场都不剩**，整屏只剩「个人记录」。
   *    而数据其实在 —— 那些骑行有 `powerAvg` / `powerMax`（汇总值一直都在）。
   *
   *    ⚠️ `powerStats` **自己就处理了这种情况**（没有序列时回退到
   *      `fallbackAvg`/`fallbackMax`，返回 `np: 0`）—— 那个分支一直是**死代码**，
   *      因为调用处先把它们滤掉了。
   *    ⇒ 去掉那句话。`powerStats` 返回 `null` 才是「这场真的没有功率数据」，
   *      那个判断它自己做得对。
   */
  const powered = useMemo(
    () =>
      sessions
        .map((s) => ({ s, p: powerStats(s.powerSeries, s.powerAvg, s.powerMax) }))
        .filter((x): x is { s: ChealthSession; p: NonNullable<ReturnType<typeof powerStats>> } => x.p !== null),
    [sessions],
  );

  // ⚠️ 运动类型筛选（读者 2026-09-28 点名要的：「要可以筛选器形跑步这些还是全部」）。
  //    `ALL` 是默认值；只列出**这个窗口里真的出现过**的类型，不铺一长串空分类。
  const [kind, setKind] = useState<string>('ALL');

  /**
   * 运动页的 天 / 周 / 月（三星那一屏顶上就是一个三段胶囊）。
   *
   * ⚠️ 默认**周**，不是天。三星默认天，是因为它一天常有好几场运动；
   *    我们 31 天只有 8 场 —— 默认天的话，大多数时候点进来是一屏「没有记录」。
   *    **默认值该按这份数据的密度挑，不是照抄别人的默认值。**
   */
  /**
   * ⚠️ 默认改成**月**（读者 2026-09-29：「运动改为记录最近一个月的记录」）。
   *    原来默认周。⚠️ 这一条**取代**了当天早些时候那句「周作为默认」——
   *    同一屏同一个控件，读者要的是更长的窗口。
   *
   * ⚠️ 为什么改的是 `span` 而不是「只把列表换成 30 天」：上面那张摘要卡写着
   *    「最近 {spanDef.days} 天」，列表跟着 `shown` 走。只换列表的话，
   *    摘要说 7 天、列表给 30 天，**两个数互相打架而各自都看着对**。
   */
  const [span, setSpan] = useState<SpanKey>('month');

  /**
   * 日期分组默认只画前几组，其余折叠。
   *
   * ⚠️ 一个月最多 30 个日期头 × 每头几场，展开着读完要滚好几屏 ——
   *    而这一屏要先回答「最近练了多少」，不是「把每一场都列出来」。
   *
   * ⚠️⚠️ 折叠只影响**画出来多少**，不影响**算进去多少**：窗口仍然是 30 天，
   *    摘要卡上的总时长/次数/消耗都是整月的。把折叠做成「换窗口」的话，
   *    上面那几个数就和列表对不上了。
   */
  const FOLD_DAYS = 3;
  const [showAllDays, setShowAllDays] = useState(false);
  const spanDef = SPANS.find((s) => s.k === span) ?? SPANS[1];

  /**
   * ⚠️ 窗口的右端是 `index.to`（**数据自己的最后一天**），不是浏览器的今天 ——
   *    和这一页所有别的窗口一致。按浏览器算的话，数据落后三天时
   *    「最近 7 天」里有三天是空的，看起来像运动记录丢了。
   */
  const dataTo = index?.to ?? '';
  const spanFrom = dataTo ? shiftDate(dataTo, -(spanDef.days - 1)) : '';

  const inSpan = useMemo(
    () =>
      spanFrom
        ? sessions.filter((s) => {
            const d = s.start.slice(0, 10);
            return d >= spanFrom && d <= dataTo;
          })
        : [],
    [sessions, spanFrom, dataTo],
  );

  const shown = useMemo(
    () => (kind === 'ALL' ? inSpan : inSpan.filter((s) => s.type === kind)),
    [inSpan, kind],
  );

  const spanSum = useMemo(
    () => ({
      minutes: inSpan.reduce((a, s) => a + s.minutes, 0),
      kcal: inSpan.reduce((a, s) => a + (s.activeCalories ?? 0), 0),
      km: inSpan.reduce((a, s) => a + (s.distanceM ?? 0), 0) / 1000,
    }),
    [inSpan],
  );

  /**
   * 每天的运动分钟数 —— 喂给「每天的运动时长」那张柱状图。
   * ⚠️ 全天窗扫描，**不受类型筛选器影响** —— 那张图的标题写的是「全部类型」。
   */
  const minutesByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      const d = s.start.slice(0, 10);
      m.set(d, (m.get(d) ?? 0) + s.minutes);
    }
    return m;
  }, [sessions]);

  /** 窗口内的**自然日**（不是有运动的那几天）—— 柱状图的横轴，没运动的那天也在。 */
  const spanDaysList = useMemo(
    () => (spanFrom ? days.filter((d) => d.date.slice(0, 10) >= spanFrom && d.date.slice(0, 10) <= dataTo) : []),
    [days, spanFrom, dataTo],
  );

  /**
   * 按天分组 —— 三星运动列表就是这个形状：一个日期头（左边日期、
   * 右边那天的合计），下面挂那天的几场。
   */
  const grouped = useMemo(() => {
    const m = new Map<string, ChealthSession[]>();
    for (const s of shown) {
      const d = s.start.slice(0, 10);
      const arr = m.get(d) ?? [];
      arr.push(s);
      m.set(d, arr);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [shown]);

  /** 折叠后**真正画出来**的那几组。见 `FOLD_DAYS` 那段。 */
  const shownGroups = showAllDays ? grouped : grouped.slice(0, FOLD_DAYS);

  /**
   * 完全没有步数记录的日子。
   *
   * ⚠️ 这个列表是**可执行的**：它告诉读者「哪几天要去 Health Sync 补」。
   *    只写一个「有 N 天没数据」是不够的 —— 那样读者知道有问题，但不知道从哪下手。
   */
  const missingDays = useMemo(
    () => days.filter((d) => typeof d.steps !== 'number').map((d) => d.date.slice(5)),
    [days],
  );

  /**
   * 睡眠达标率 —— **有记录的晚**里，睡够 `SLEEP_GOAL_H` 的比例。
   *
   * ⚠️⚠️ 三星的「睡眠得分」是它自己的专有算法（掺了睡眠阶段、翻身、血氧、
   *    呼吸…），我们**没有、也不编**。这里用它的**形状**画一件我们量得到的
   *    事：「最近这些晚里，有几晚睡够了」。
   *
   * ⚠️ 分母是**有睡眠记录的那些晚**，不是「最近 30 晚」——
   *    没同步的那几晚我们不知道他睡了多久，不能算成没睡够。
   *    （和 `monthStats` 同一个规矩。）
   */
  /**
   * ⚠️ 读者 2026-09-29：「能展示的内容能展示出来什么吗得分」。
   *
   *    我们能诚实算的得分**就这四个** —— 步数、睡眠、活动时间、活动消耗 ——
   *    因为每一个的分母都是**我们自己定的目标**（`platform/chealth-goals.ts`）。
   *    ⚠️ 三星那种 0–100 的「能量得分」我们**没有、也不编**（它是专有算法，
   *      掺了睡眠阶段、心率变异性、血氧、呼吸…）。
   *      这张卡的诚实之处全在「分母写清楚」那一行。
   *
   * ⚠️ 分母和步数那条一致：**有记录的天/晚**，不是「这个月过了几天」。
   * ⚠️ `activeMinutes` 是 2026-09-29 才开始上报的字段，历史天没有 ⇒
   *    它的分母会明显小于步数那个。所以每一格下面都写「N/M」——
   *    不写的话，两个百分比会被当成同一段时间的比例。
   */
  const activeMinStats = useMemo(() => {
    const month = dataTo.slice(0, 7);
    const md = days.filter((d) => d.date.slice(0, 7) === month && typeof d.activeMinutes === 'number');
    return { tracked: md.length, hit: md.filter((d) => (d.activeMinutes as number) >= ACTIVE_MIN_GOAL).length };
  }, [days, dataTo]);

  const activeKcalStats = useMemo(() => {
    const month = dataTo.slice(0, 7);
    const md = days.filter((d) => d.date.slice(0, 7) === month && typeof d.activeCalories === 'number');
    return { tracked: md.length, hit: md.filter((d) => (d.activeCalories as number) >= ACTIVE_KCAL_GOAL).length };
  }, [days, dataTo]);

  /**
   * ⚠️⚠️ 总消耗取**最近一条真的有记录的那天**，不是「最后一天」。
   *
   *    和「最近一晚」的睡眠是同一个做法（见 `chealthSleepDay`）。
   *    实测 2026-09-29：Health Connect 里当天**一条
   *    `TotalCaloriesBurnedRecord` 都没有**（三星是延迟写入的），
   *    而昨天那条 1,943 好好躺着。直接取最后一天 ⇒ 永远显示「未采集」，
   *    读者看到的是「这一项坏了」，实际是「今天那次还没到」。
   *
   *    ⚠️ 所以**日期必须一起显示** —— 不显示的话，「1,943 千卡」
   *      会被读成今天的。
   */
  const lastCalDay = useMemo(() => {
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const d = days[i];
      if (d && typeof d.calories === 'number' && d.calories > 0) return d;
    }
    return null;
  }, [days]);

  const sleepStats = useMemo(() => {
    const withData = days.filter((d) => typeof d.sleepSeconds === 'number' && d.sleepSeconds > 0);
    return {
      tracked: withData.length,
      hit: withData.filter((d) => (d.sleepSeconds as number) >= SLEEP_GOAL_H * 3600).length,
    };
  }, [days]);

  /**
   * 本月的达标情况 —— 读者给的三星截图里那张「目标已实现 27/29 天」。
   *
   * ⚠️⚠️ 分母是**有记录的天数**，不是「这个月过了几天」。
   *    三星用的是后者，但那个数会把「手机没同步的那几天」算成「没达标」——
   *    也就是**把「我们不知道」记成了「他没做到」**。
   *    所以这里分成两个数说清楚：`tracked` 天有记录，其中 `hit` 天达标。
   */
  const monthStats = useMemo(() => {
    const month = dataTo.slice(0, 7);
    const md = days.filter((d) => d.date.slice(0, 7) === month);
    const tracked = md.filter((d) => typeof d.steps === 'number');
    return {
      month,
      tracked: tracked.length,
      hit: tracked.filter((d) => (d.steps as number) >= STEP_GOAL).length,
      steps: tracked.reduce((a, d) => a + (d.steps as number), 0),
      km: md.reduce((a, d) => a + (d.distanceM ?? 0), 0) / 1000,
      kcal: md.reduce((a, d) => a + (d.calories ?? 0), 0),
    };
  }, [days, dataTo]);

  /**
   * ⚠️⚠️ **一个** `sheet` 字符串，不是六个 boolean。
   *
   * 「同时开着心率区间和功率两个弹窗」是一个**用不了的状态** ——
   * 六个 boolean 能表示它，而它不该能被表示出来。用不了的状态一旦可表示，
   * 迟早会有人表示出来，然后读者看到两层蒙层叠在一起。
   *
   * ⚠️ 单场运动单独一个 `openSess`：它多带一个「哪一场」的载荷，
   *    而那个载荷不是弹窗的名字。`sheet === 'session'` 时它一定有值。
   */
  const [sheet, setSheet] = useState<string | null>(null);
  const [openSess, setOpenSess] = useState<ChealthSession | null>(null);
  const openSheet = (k: string) => setSheet(k);
  const closeSheet = () => {
    setSheet(null);
    setOpenSess(null);
  };

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CHEALTH" backTo={homePanelUrl('chealth')} />

      {/*
        ⚠️⚠️ 2026-09-28：这一屏原来**没有输入框**。

        它只显示一段说明：「在地址后面加 ?k=你的口令」—— 也就是要求读者
        **手改地址栏**。在手机上这基本等于没有入口。读者当天的话是
        「我在网站上看到的完全没有数据和展示」：他打开站点，CHEALTH 写着
        「未解锁」，而没有任何地方能把它解开。

        ⚠️ 一个需要输入却连输入框都没有的页面，读者只会认为它坏了。

        ⚠️ 条件也从「没有口令」扩到「没有口令**或口令解不开**」。
           存着一个错的口令时，原来会渲染成一个**没有数据的 CHEALTH 页** ——
           看起来像管道断了，读者会去查手机、查服务器，不会想到问题在
           自己设备的 localStorage 里。现在它把输入框还回来。
      */}
      {!pass || err ? (
        <Section
          index={0}
          title="需要口令"
          lede="健康数据在公开 CDN 上是 AES-GCM 密文，要口令才能解开。"
          compact
        >
          <View className="card chc__unlock">
            <Text className="card__label">
              口令只留在这台设备的浏览器里，不发往任何服务器。
            </Text>
            <View className="chc__unlock-row">
              <Input
                className="chc__unlock-input"
                password
                value={typed}
                placeholder="输入口令"
                confirmType="done"
                onInput={(e) => setTyped(String((e.detail as { value?: string }).value ?? ''))}
                onConfirm={submitPass}
              />
              <View
                className={`chc__unlock-btn${busy ? ' chc__unlock-btn--busy' : ''}`}
                onClick={submitPass}
              >
                <Text>{busy ? '解开中…' : '解锁'}</Text>
              </View>
            </View>
            {unlockErr || err ? (
              <Text className="chc__unlock-err">
                ⚠️ {unlockErr ?? '存着的口令已经解不开了，换一个。'}
              </Text>
            ) : null}
          </View>
        </Section>
      ) : null}

      {/*
        ⚠️ 没解开就**不要**渲染这三屏。
        它们会全部渲染成空壳（没有数字、没有曲线），跟在一张「需要口令」的
        卡片后面 —— 那正是「完全没有数据和展示」的观感来源：
        读者看到的是几屏空白，而不是一句「还没解锁」。
      */}
      {pass && !err ? (
        <>
          {/*
            ⚠️ `count` 必须和真实的 Section 数量一致，而且**中间不能再夹别的东西**。
            这里原来把「正在 MyWhoosh 骑车」那个徽标作为兄弟节点直接放在
            `<PageStack>` 里面 —— 于是它变成了一屏。面板栈按
            `scrollTop / clientHeight` 算「我在第几屏」，多一个变高的兄弟节点
            就让**所有**面板和进度条对不上；而 `count={10}` 还写着 10。
            ⇒ 徽标挪进了第 0 屏里面。
          */}
          <PageStack count={3}>
            <Section
              index={0}
              title="今天"
              hero={<PageHero brand="CHEALTH" />}
              compact
              footnote={freshness}
              // ⚠️ 读者要「文字尽量缩减」。这一段原来三行，占了小半屏，
              //    而它说的是一件**装完就不用再想**的事。完整链路挪进了
              //    「数据来源」弹窗 —— 那里才是读者真的要查它的时候。
              // ⚠️ 这一屏原来有一句 lede：「手表 → 三星健康 → 手机 → 阿里云 →
              //    这里，每 15 分钟一次。」—— 读者 2026-09-29 让去掉。
              //    那是**这张图是怎么搭的**，不是「你的身体怎么样」，
              //    而读者打开这一页问的是后者。
              //    ⚠️ 管线本身没有丢：它在「数据来源」那个弹窗里，那才是它该在的地方。
              //    ⚠️ 是**删掉整个 `lede`**，不是传空串 —— 传空串会留下一个
              //      高度不为零的空容器，读者看不出来，版式上却多了一段空白。
            >
              {/*
                ⚠️「正在骑 MyWhoosh」——这个徽标**只在 true 时出现**，false 时什么都不显示。
                因为 `ridingNow: false` 的真实含义是「没检测到」，不是「确定没在骑」
                （用户没给「使用情况访问」权限时它永远是 false）。显示成「未骑行」就是
                把一个不知道的事说成一个知道的事 —— 这个项目已经栽过好几次。
              */}
              {index?.ridingNow ? (
                <View className="card chc__card chc__riding">
                  <View className="chc__badge chc__badge--dist"><Icon name="bike" /></View>
                  <Text className="chc__riding-t">正在 MyWhoosh 上骑车</Text>
                </View>
              ) : null}

              {/*
                ⚠️ 这里原来用 `stats={[...]}`，出来是**等分的 2×2 四宫格**。
                读者 2026-09-28 明确说「不要完全对得太齐」，并给了 Depo Studio 那套
                参考：**块与块大小不等**，而且有一个强烈的蓝色。

                ⚠️ 但不等大小是**为了表达层级**，不是为了花：
                今日步数最大（块最宽、字最大、蓝色实底），其余按重要性递减。
                四个块都做成不一样大就变成噪音了。
              */}
              {/*
                ⚠️⚠️ 读者 2026-09-29 点名要的：「每天的三个圆环或者心环，
                步数时间和消耗都要」。这是三星首页那张「每日活动量」卡片的主体 ——
                三个同心弧，外面步数、中间活动消耗、里面活动时间。

                ⚠️⚠️ 第三项「活动时间」传的 `pct` 是 `null`，**不是 0**。
                Health Connect 里**没有**「活动时长」这种记录类型（三星那个数是
                它自己从步数记录的时间区间里算的），所以这一项我们**根本没采集**。
                传 0 会画成一圈空轨道 + 读数 0 —— 那是把「我们没采」说成「他没动」，
                正是这个项目反复栽的那个坑（缺数据画成 0 / 占位符冒充真数据）。
                它现在写「未采集」，等手机端开始上报，这一行会自己变成一条真的弧。
              */}
              <View className="card chc__card">
                <Text className="chc__card-t">今天 · {today}</Text>
                <Rings
                  items={[
                    // ⚠️⚠️ 每一行**不带 `/目标`** —— 目标写在卡下面的说明里。
                    //
                    //    2026-09-29 实测：带上之后最长那行
                    //    「活动消耗 · 515 千卡 · / 400」要 ~195px，而左边那列
                    //    只有 ~174px。`white-space: nowrap` 不让折行，
                    //    于是文字**直接压在心上**（截图里 `/ 9,000` 的最后一个 0
                    //    叠在心形上）。
                    //
                    //    ⚠️ 溢出比折行难发现得多：折行看得出来，溢出的那截
                    //      只是安静地叠在别的元素上。
                    //    ⚠️ 三星那块砖的环卡上也**没有**逐行分母 —— 分母在环里。
                    {
                      label: '步数',
                      value: stepsToday === null ? undefined : Math.round(stepsToday).toLocaleString('en-US'),
                      unit: ' 步',
                      pct: stepsToday === null ? null : stepsToday / STEP_GOAL,
                      color: 'var(--m-steps)',
                    },
                    {
                      label: '活动消耗',
                      value: kcalToday === null ? undefined : String(Math.round(kcalToday)),
                      unit: ' 千卡',
                      pct: kcalToday === null ? null : kcalToday / ACTIVE_KCAL_GOAL,
                      color: 'var(--m-kcal)',
                    },
                    {
                      // ⚠️ 走路 + 运动会话的**并集**（读者：「不是单单的走路」）。
                      //    手机端还没开始上报时这里是 `null` ⇒ 渲染成「未采集」。
                      label: '活动时间',
                      value: activeMinToday === null ? undefined : String(Math.round(activeMinToday)),
                      unit: ' 分钟',
                      pct: activeMinToday === null ? null : activeMinToday / ACTIVE_MIN_GOAL,
                      color: 'var(--m-dist)',
                    },
                  ]}
                />
                {/*
                  ⚠️ 总消耗**单独一行**，而且用一条虚线和大字号把它和上面三行分开。
                  读者 2026-09-29：「总消耗每天要格外标记出来一下」。

                  ⚠️ 为什么它不该混进环里：总消耗含基础代谢（实测没活动的日子
                    恒为 1,662），那部分人控制不了 —— 混进去读者会以为
                    「今天烧了 1,953」是自己动出来的。
                */}
                <View className="chc__totalmark">
                  <Text className="chc__totalmark-l">
                    总消耗 <Text className="chc__em">含基础代谢</Text>
                  </Text>
                  <Text className="chc__totalmark-v">
                    {lastCalDay === null
                      ? '未采集'
                      : // ⚠️ 日期跟着数字一起给 —— 这是**最近一条有记录的那天**，
                        //    不是今天。只给数字会被读成今天的（见 `lastCalDay` 那段）。
                        `${Math.round(lastCalDay.calories as number).toLocaleString('en-US')} 千卡 · ${lastCalDay.date.slice(5)}`}
                  </Text>
                </View>
                {/* ⚠️ 强调一律用 `<Text className="chc__em">`，**不要写 Markdown 星号** ——
                    这条已经复发过一次（`73b8a6a` 修过、2026-09-29 又在弹窗里复发）。 */}
                <Text className="chc__note">
                  目标 {STEP_GOAL.toLocaleString('en-US')} 步 · {ACTIVE_KCAL_GOAL} 千卡活动消耗 ·{' '}
                  {ACTIVE_MIN_GOAL} 分钟活动。
                  {partial ? ' ⚠️ 截至现在，今天还没过完。' : ''}
                </Text>
              </View>

              <View className="chc__mosaic">
                {/*
                  ⚠️ 每块的结构是「**彩色圆底图标 + 标签**」在上、大数字在下 —— 这是
                  三星健康最有辨识度的一处排法，读者点名要「图标尽量一样」。
                  原来只有一行文字标签，没有任何图形，所以整页读起来像表格。
                */}
                <View
                  className="chc__tile chc__tile--wide chc__tile--blue"
                  // ⚠️ `--m` 挂在**整块砖**上，不是挂在圆底图标上 —— 标签的颜色
                  //    从它取（`.chc__mlabel { color: var(--m) }`），而标签是
                  //    圆底的**兄弟节点**，挂在圆底上它取不到。
                  style={{ ['--m' as string]: 'var(--m-steps)' } as CSSProperties}
                >
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
                  {/*
                    ⚠️⚠️ 达标进度条 —— 三星那一半辨识度就在这里。
                    原来只有一个裸数字「3,163」，读者要自己去想「这算多还是少」。
                    有了分母（目标 8,000）和一个可见的进度，同一个数字立刻有意义。

                    ⚠️ 条的长度只来自**这一个** ratio，不写死像素 ——
                       这个项目吃过亏：柱状图曾用 88/84/76/72 四个手写数字，
                       眼睛会把「长度差」读成「数据差」。
                  */}
                  {/*
                    ⚠️⚠️ 这块砖原来还有「发丝线 + `/ 8,000 步 · 121%` + 进度条」。
                    2026-09-29 加了上面那张**三环卡**之后，那三样全被删掉了 ——
                    因为环上已经写着 `9,686 / 9,000`，同一个数和同一个分母
                    **在同一个视口里出现了两次**。三星首页确实会把步数显示两处，
                    但它不会把**目标**也重复一遍；那是冗余，不是呼应。

                    ⚠️ 判据留给环那张卡（`.chc__rings-g`），砖上只留数字。
                  */}
                  {/* ⚠️ 「截至现在」必须说出来。不说的话，早上读到 3,123
                      而中位数接近 22,000，看起来像塌了。 */}
                  <Text className="chc__tile-note">{partial ? '截至现在 · 今天还没过完' : '至今'}</Text>
                </View>

                <View
                  className="chc__tile chc__tile--narrow"
                  style={{ ['--m' as string]: 'var(--m-sleep)' } as CSSProperties}
                >
                  <View className="chc__mhead">
                    <View className="chc__badge chc__badge--sleep">
                      <Icon name="moon" />
                    </View>
                    <Text className="chc__mlabel">最近一晚</Text>
                  </View>
                  {/*
                    ⚠️ 这块砖只有 53px 可用宽 —— 四块里最窄的一块。
                    「7h32m」要 3.2em（约 63px），**放不下**；而放不下的后果是
                    验证器会报 `scrollWidth > clientWidth`，也就是字被切掉。

                    ⇒ 砖上给**看得清的那个数**（7.5h，和旁边 kcal / km 一样
                      走「数值 + 小号单位」），精确到分钟的那个写在下面的说明里。
                      这不是把一个数写两遍 —— 是两块大小不同的地方各取所需。
                  */}
                  <Text className="chc__tile-v">
                    {lastSleep ? lastSleep.hours.toFixed(1) : '—'}
                    {lastSleep ? <Text className="chc__tile-u">h</Text> : null}
                  </Text>
                </View>

                <View
                  className="chc__tile chc__tile--half"
                  style={{ ['--m' as string]: 'var(--m-kcal)' } as CSSProperties}
                >
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

                <View
                  className="chc__tile chc__tile--half"
                  style={{ ['--m' as string]: 'var(--m-dist)' } as CSSProperties}
                >
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

                {/*
                  ⚠️ 这两块是 2026-09-29 补的：手机一直在同步它们、类型里也声明了，
                  但**页面上从来没渲染过**。补之前先用 `scripts/chealth-coverage.ts`
                  量了真实覆盖（平均速度 24/31 天、步频 14/31 天），
                  确认有数据才做 —— 见 `extra7d` 上面那段。
                  ⚠️ badge 类和颜色 token 都**复用现成的**（距离那块是 route/蓝，
                  步数那块是 steps/绿），所以这一处不需要动任何 CSS。
                */}
                <View
                  className="chc__tile chc__tile--half"
                  style={{ ['--m' as string]: 'var(--m-dist)' } as CSSProperties}
                >
                  <View className="chc__mhead">
                    <View className="chc__badge chc__badge--dist">
                      <Icon name="route" />
                    </View>
                    {/*
                      ⚠️⚠️ 标签是「运动均速」**不是**「平均速度」。
                      手机那边（SyncWorker.kt）算的是当天 `SpeedRecord` **所有采样点**
                      的平均值 —— 所以它反映的是**被记录到的那些活动**
                      （跑步、骑行会把平均数拉高），**不是日常走路的速度**。
                      实测就是证据：7 天均值 3.58 m/s ＝ 12.9 km/h，
                      那是跑步的速度；写成「平均速度」会让人以为自己在飞。
                      ⇒ **口径说不清的时候，把口径写进标签**，不是写个更响的数字。
                    */}
                    <Text className="chc__mlabel">运动均速</Text>
                  </View>
                  <Text className="chc__tile-v">
                    {extra7d.speedAvg ?? '—'}
                    <Text className="chc__tile-u">m/s</Text>
                  </Text>
                </View>

                <View
                  className="chc__tile chc__tile--half"
                  style={{ ['--m' as string]: 'var(--m-steps)' } as CSSProperties}
                >
                  <View className="chc__mhead">
                    <View className="chc__badge chc__badge--steps">
                      <Icon name="cadence" />
                    </View>
                    <Text className="chc__mlabel">步频</Text>
                  </View>
                  <Text className="chc__tile-v">
                    {extra7d.cadence ?? '—'}
                    <Text className="chc__tile-u">步/分</Text>
                  </Text>
                </View>
              </View>

              {/*
                ⚠️ 每块的口径写在一起**说一次**。放在每个块里会把窄块的标签挤成三行
                （实测：「7 天睡眠」折成「7/天/睡眠」）。

                ⚠️ 睡眠那格现在写的是「最近一晚」+ 日期 + 7 天均值 —— 三个数都在，
                   因为它们回答三个不同的问题：昨晚睡得怎么样、那是哪一晚、
                   这一周整体是不是都这样。
              */}
              <Text className="chc__tile-note">
                睡眠取最近一晚（{lastSleep ? `${lastSleep.date.slice(5)}，${hm(lastSleep.hours)}` : '没有记录'}）
                {avgSleep !== null ? `，14 晚均值 ${hm(avgSleep)}` : ''}。
                消耗 · 距离 是最近 7 天，步数是今天，目标 {STEP_GOAL.toLocaleString('en-US')} 步。
                {extra7d.speedAvg !== null || extra7d.cadence !== null
                  ? ' 运动均速 · 步频 是采样均值 —— 手机在记录到速度/步频的那些时刻取平均，'
                    + '所以它们说的是「被记录到的那些活动」，不是日常走路 —— '
                    + '跑步会明显拉高均速。没记录的那天不参与，不当作 0。'
                  : ''}
              </Text>

              {/*
                ⚠️ 图标格 = 「外面尽量是图标，文字尽量缩减和折叠」的落点。
                六个入口一眼全在，想看哪个点哪个 —— 而不是翻六屏。
              */}
              <IconGrid
                onPick={openSheet}
                items={[
                  {
                    key: 'zones',
                    icon: 'heart',
                    label: '心率区间',
                    tone: 'heart',
                    value: zoneMinutes > 0 ? `${Math.round(zoneMinutes)} 分` : undefined,
                  },
                  // ⚠️ **六个都要给 tone**。第一版只给了三个，另外三个走
                  //    `var(--m, #6b7280)` 的兜底灰 —— 于是网格里三个彩色、
                  //    三个灰，看起来像「这三个不能用」。
                  //    三星那边每个入口都是实色圆底，颜色本身就是识别方式。
                  { key: 'week', icon: 'up', label: '周对比', tone: 'dist' },
                  { key: 'power', icon: 'power', label: '功率', tone: 'kcal' },
                  {
                    key: 'streak',
                    icon: 'trophy',
                    label: '达标',
                    tone: 'steps',
                    value: streak > 0 ? `${streak} 天` : undefined,
                  },
                  { key: 'kinds', icon: 'bike', label: '类型分布', tone: 'sleep' },
                  { key: 'sources', icon: 'watch', label: '数据来源', tone: 'sync' },
                ]}
              />
            </Section>

            {/*
              ⚠️ 这一屏的 `lede` 删了（读者 2026-09-29）。
                原来是「天 / 周 / 月 三段，和三星那一屏一样。点一条看过程曲线。」
                —— 那是**给做这个页面的人看的**，不是给读者看的：
                三段控件长得就像三段控件，不需要一句话告诉他要怎么用。
                ⚠️ 而且它和下面那排胶囊**压在一起**（截图里能看见重叠）。

              ⚠️ 默认档是**周**，不是天 —— 见 `useState<SpanKey>('week')` 那段：
                我们 31 天只有 8 场运动，默认天的话大多数时候点进来是一屏「没有记录」。
            */}
            <Section index={1} title="运动" footnote={freshness}>
              {!index?.sessions?.length ? (
                <View className="card chc__card">
                  <Text className="chc__note">最近 30 天没有非走路的运动记录。</Text>
                  {/*
                    ⚠️ 说明为什么可能是空的，而不是让它看起来像坏了。
                    MyWhoosh 不支持 Health Connect，它必须先经 Strava 或三星健康过桥，
                    而 Health Sync 的后台同步**确实会漏掉整天**（实测 09-23 那次骑行
                    是手动「对特定日期重新同步」才捞回来的）。
                  */}
                  <Text className="chc__note">
                    提示：MyWhoosh 不支持 Health Connect，骑行要先过桥（三星健康 → Health Sync，或 Strava）。
                    如果刚骑完这里没有，在 Health Sync 里用「对特定日期重新同步」把那天捞一次。
                  </Text>
                </View>
              ) : (
                <>
                  {/* 天 / 周 / 月 —— 三星运动页顶上那个三段胶囊。 */}
                  <View className="chc__seg">
                    {SPANS.map((s) => (
                      <View
                        className={`chc__seg-i${span === s.k ? ' chc__seg-i--on' : ''}`}
                        key={s.k}
                        onClick={() => setSpan(s.k)}
                      >
                        {s.label}
                      </View>
                    ))}
                  </View>

                  {/*
                    ⚠️ 大字总时长 + 三个小计 —— 照三星那张「3:44:40 / 10 次 /
                    1,328 千卡」做的。它的价值在于**把一整段时间压成一个数**，
                    而列表本身只能一场一场地读。
                  */}
                  <View className="card chc__card">
                    <Text className="chc__note">最近 {spanDef.days} 天（到 {dataTo}）</Text>
                    <Text className="chc__big">{hms(spanSum.minutes)}</Text>
                    <View className="chc__keys">
                      <Text className="chc__key">训练 <Text className="chc__num">{inSpan.length}</Text> 次</Text>
                      <Text className="chc__key">
                        消耗 <Text className="chc__num">{Math.round(spanSum.kcal).toLocaleString('en-US')}</Text> 千卡
                      </Text>
                      {spanSum.km > 0 ? (
                        <Text className="chc__key">
                          距离 <Text className="chc__num">{spanSum.km.toFixed(2)}</Text> 千米
                        </Text>
                      ) : null}
                    </View>
                  </View>

                  {/*
                    ⚠️ 只在周/月显示。天那一档的窗口只有一天，画出来就是一根柱子 ——
                    一张只有一个数据点的柱状图不承载任何信息，只是占地方。
                  */}
                  {span !== 'day' && spanDaysList.length > 1 ? (
                    <View className="card chc__card">
                      <Text className="chc__card-t">每天的运动时长（全部类型）</Text>
                      {/*
                        ⚠️ `pick` 返回 `undefined`（那天没运动）和返回 0 是两回事：
                        前者画成灰的「无柱」，后者是「零分钟」。这里没有运动的日子
                        是真的没有记录，走 undefined。
                      */}
                      <BarRow
                        days={spanDaysList}
                        pick={(d) => minutesByDate.get(d.date.slice(0, 10))}
                        today={today}
                        unit=" 分钟"
                        tone="dist"
                      />
                    </View>
                  ) : null}

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
                    <View className="card chc__card">
                      <Text className="chc__note">这个筛选下没有记录。</Text>
                    </View>
                  ) : null}

                  {/*
                    ⚠️⚠️ 卡片是**摘要**，细节在弹窗里。
                    这里原来一张卡展开就是四条曲线（心率 / 功率 / 踏频 / 速度），
                    实测这一屏内容 2868px 而面板只有 844px，要滚 2000px 才看得到
                    第二条运动。三星健康的列表也是先给摘要、点开才给细节。
                  */}
                  {shownGroups.map(([date, list]) => (
                    <View key={date}>
                      {/*
                        ⚠️ 日期头：左边日期，右边**那天的合计** —— 三星运动列表就是
                        这个形状。合计很重要：读者看的是「那天练了多少」，
                        而不是「那天有哪几场」；没有合计他就得自己加。
                      */}
                      <View className="chc__gh">
                        <Text>{date.slice(5)} 周{weekdayOf(date)}</Text>
                        <Text className="chc__gh-v">
                          {hms(list.reduce((a, s) => a + s.minutes, 0))} ·{' '}
                          {Math.round(list.reduce((a, s) => a + (s.activeCalories ?? 0), 0))} 千卡
                        </Text>
                      </View>
                      {list.map((sess: ChealthSession) => (
                    <View
                      className="card chc__card chc__sess"
                      key={sess.start}
                      onClick={() => {
                        setOpenSess(sess);
                        setSheet('session');
                      }}
                    >
                      <View className="chc__srow">
                        <View className="chc__badge chc__badge--plain">
                          <Icon name={typeIcon(sess.type)} />
                        </View>
                        {/*
                          ⚠️ 标题和副标题**分成两行**，各自 `min-width: 0`。
                          原来它们和图标、chevron 挤在一个 flex 行里，而标题是
                          「骑行 · 09-23 18:44 · 50 分钟」这么长一串 —— 390px 上
                          最后的「钟」被单独甩到第二行，读者看到的是「50 分/钟」，
                          而类型图标跟着一起错位。
                        */}
                        <View className="chc__smain">
                          <Text className="chc__st">{typeLabel(sess.type, sess.exerciseType)}</Text>
                          <Text className="chc__ss">
                            {sess.start.slice(5, 16).replace('T', ' ')} · {sess.minutes} 分钟
                          </Text>
                        </View>
                        <Icon name="chev" className="chc__sgo" />
                      </View>
                      {/* 关键数：一行，能折行。全部细节在弹窗里。 */}
                      <View className="chc__keys">
                        {sess.distanceM !== undefined ? (
                          <Text className="chc__key">
                            距离 <Text className="chc__num">{(sess.distanceM / 1000).toFixed(2)}</Text> km
                          </Text>
                        ) : null}
                        {sess.hrAvg !== undefined ? (
                          <Text className="chc__key">
                            心率 <Text className="chc__num">{sess.hrAvg}{sess.hrMax !== undefined ? `/${sess.hrMax}` : ''}</Text>
                          </Text>
                        ) : null}
                        {sess.powerAvg !== undefined ? (
                          <Text className="chc__key">
                            功率 <Text className="chc__num">{sess.powerAvg}</Text> W
                          </Text>
                        ) : null}
                        {sess.cadenceAvg !== undefined ? (
                          <Text className="chc__key">
                            踏频 <Text className="chc__num">{sess.cadenceAvg}</Text> rpm
                          </Text>
                        ) : null}
                        {sess.activeCalories !== undefined ? (
                          <Text className="chc__key">
                            消耗 <Text className="chc__num">{sess.activeCalories}</Text> kcal
                          </Text>
                        ) : null}
                      </View>
                      {/*
                        ⚠️⚠️ **过程就在这儿** —— 上面那一行全是汇总值，而汇总值
                        把「前 10 分钟 90、后 10 分钟 175」显示成同一个数。
                        读者 2026-09-30：「运动里面的过程那些数据都没有展示了」。

                        ⇒ 这一场有序列就**当场画出来**，不必点开弹窗。
                        ⚠️ 实测只有 4/30 场带心率序列（功率/踏频/速度 **0/30**），
                          所以绝大多数卡片这里什么都不加 —— 而「没有」这件事
                          在弹窗里有一段专门解释（见下面「这一场没有过程曲线」）。
                      */}
                      {sess.hrSeries && sess.hrSeries.length > 1 ? (
                        <View className="chc__trend">
                          <Text className="chc__note">
                            心率过程 · 这一场的 {sess.hrSeries.length} 个采样点
                          </Text>
                          <Spark
                            points={sess.hrSeries.map(([, v]) => v)}
                            labels={sess.hrSeries.map(([t2]) => `第 ${Math.round(t2)} 分钟`)}
                            name="心率"
                            unit=" bpm"
                          />
                        </View>
                      ) : null}
                    </View>
                      ))}
                    </View>
                  ))}

                  {/*
                    ⚠️ 折叠开关。**只在真的折掉了东西的时候出现** ——
                    一个月里只练了 2 天的话，「查看其余 0 天」是个笑话，
                    而且它会让读者以为下面还有内容。

                    ⚠️ 文案给的是**还剩多少天**，不是「查看全部」：读者要判断
                      值不值得点，靠的正是那个数。
                  */}
                  {grouped.length > FOLD_DAYS ? (
                    <View className="chc__fold" onClick={() => setShowAllDays((v) => !v)}>
                      <Text className="chc__fold-t">
                        {showAllDays ? '收起' : `查看其余 ${grouped.length - FOLD_DAYS} 天`}
                      </Text>
                    </View>
                  ) : null}
                </>
              )}
            </Section>

            {/*
              ⚠️ `lede` 删了（读者 2026-09-29：「以及其他的解释都删掉」）。
                原来是「柱状是每天的总量，最近 14 天。空白的那天是没记录，不是零。
                点一根柱子看那天的数。」—— 三句话里有两句在解释控件怎么用。

              ⚠️「空白的那天是没记录，不是零」这个区别**没有丢**：它靠的是画法本身
                （空的天根本不画柱子），而不是靠一句话。这里删的是**文案**。
            */}
            <Section
              index={2}
              title="趋势"
              footnote={freshness}
              showCue={false}
              // ⚠️ `wide` 解掉 900px 的宽度上限，桌面端两列才排得开。
              wide
            >
              {/* ⚠️ 宽屏两列（≥900px），窄屏单列。见 `.chc__grid2` 那段。 */}
              <View className="chc__grid2">
              <View className="card chc__card">
                <Text className="chc__card-t">步数</Text>
                {/* ⚠️ 目标线 + 达标进度。三星那一半辨识度来自「9,686 / 目标 10,000」。 */}
                <BarRow days={recent} pick={(d) => d.steps} today={today} unit=" 步" tone="steps" target={STEP_GOAL} />
              </View>

              <View className="card chc__card">
                <Text className="chc__card-t">睡眠</Text>
                <BarRow
                  days={recent}
                  pick={(d) => (d.sleepSeconds ? d.sleepSeconds / 3600 : undefined)}
                  today={today}
                  unit=" 小时"
                  tone="sleep"
                />
                {/* ⚠️ Said rather than silently tolerated. Sessions can overlap —
                    the watch and the phone both write, and a session crossing
                    midnight lands in two days — so a single day can exceed 24h.
                    Measured: 2026-09-08 reported 27.9 hours. */}
                {recent.some((d) => (d.sleepSeconds ?? 0) > 20 * 3600) ? (
                  <Text className="chc__note">
                    ⚠️ 有单日超过 20 小时 —— 睡眠会话在手表和手机之间重叠时会重复计入
                  </Text>
                ) : null}
              </View>

              <View className="card chc__card">
                <Text className="chc__card-t">活动消耗</Text>
                <BarRow days={recent} pick={(d) => d.activeCalories} today={today} unit=" kcal" tone="kcal" />
                {/*
                  ⚠️ 读者 2026-09-29：「这个去除掉，只写明白是总消耗还是活动消耗就可以」。

                  ⇒ 撤掉的是**解释**，留下的必须是**区分**：
                      这一格是「活动消耗」⇒ 它就写「活动消耗」。
                      总消耗那一行在环下面（`.chc__totalmark`），写着「含基础代谢」。
                    两个名字各自说清自己是什么，比一段对比散文更难读错 ——
                    原来那段还把 `calories7d`（总消耗的 7 天合计）混在一张
                    「活动消耗」的卡片里，那正是读者说的「要去掉」的东西。

                  ⚠️ 别把这一行也删掉。「活动消耗」和「总消耗」差着一个基础代谢，
                    读者会拿这里的数去对三星健康首页那个大数字 ——
                    对得上还是对不上，取决于他知道自己看的是哪一个。
                */}
                <Text className="chc__note">活动消耗（不含基础代谢）</Text>
              </View>
              </View>
            </Section>
          </PageStack>

          {/* ── 弹窗 ──────────────────────────────────────────────
              ⚠️ 全部在 `</PageStack>` 外面。见文件开头那段注释。 */}

          {/*
            ⚠️ 心率区间 + 日均心率 + 体征放在**同一个**弹窗里。
            它们回答的都是「我的心脏怎么样」，拆成两个入口等于让读者自己
            去猜「静息心率」该点哪个图标。
          */}
          <Sheet open={sheet === 'zones'} title="心率与体征" onClose={closeSheet}>
            {zoneMinutes > 0 ? (
              <View className="card chc__card">
                <Text className="chc__card-t">
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
                        {/* ⚠️ 「118 分」原来会被折成两行 —— 「分」单独掉下去。
                            实测原因是这一格只有 3.2em 宽，而「118 分」加上间距比它宽。
                            字宽不够就该缩字号或加宽，**不该丢一个换行**。 */}
                        <Text className="chc__zone-min">{Math.round(z.minutes)} 分</Text>
                      </View>
                    );
                  })}
                </View>
                {/* ⚠️⚠️ 这里原来是 `取的是**最近 30 天实测到的最高值**` ——
                    Markdown 的粗体标记**原样渲染**，读者看到的是两个星号。

                    ⚠️ 它在页面上挂了很久没人报，因为星号夹在中文里看着像排版符号，
                       不像错误 —— 这正是「看起来像那么回事」的错最难被发现的原因。

                    改成嵌套 `<Text>`：强调还在，而且不再依赖一个**永远不会发生**
                    的解析。⚠️ 别在 JSX 里写 Markdown。 */}
              </View>
            ) : null}

            {have('hrAvg') ? (
              <View className="card chc__card">
                <Text className="chc__card-t">日均心率 · 最近 14 天</Text>
                <Spark
                    points={recent.map((d) => d.hrAvg)}
                    // ⚠️ 日期和单位**必须给** —— 不给的话读数气泡上只有一个裸数字，
                    //    读者不知道那是哪一天、也不知道单位（读者：「不能什么数据都不体现」）。
                    labels={recent.map((d) => d.date.slice(5))}
                    name="日均心率"
                    unit=" bpm"
                  />
              </View>
            ) : null}

            <View className="card chc__card">
              <Text className="chc__card-t">各项指标（7 天）</Text>
              <View className="chc__grid">
                <View className="chc__cell"><Text>静息心率</Text><Text className="chc__cell-v">{t?.restingHr7d ?? '—'}</Text></View>
                <View className="chc__cell"><Text>血氧</Text><Text className="chc__cell-v">{t?.spo2_7d ?? '—'}%</Text></View>
                <View className="chc__cell"><Text>体重</Text><Text className="chc__cell-v">{t?.weightKgLatest ?? '—'} kg</Text></View>
                <View className="chc__cell"><Text>距离</Text><Text className="chc__cell-v">{t ? `${t.distance7dKm} km` : '—'}</Text></View>
                {/*
                  ⚠️ 运动次数用**次数**不是时长 —— 时长那一项在「每天的运动时长」
                  那张卡里已经有了，再写一遍就是同一个数出现两次。
                  这一格回答的是另一个问题：这一周**动了几次**。
                */}
                <View className="chc__cell"><Text>运动次数</Text><Text className="chc__cell-v">{extra7d.exercise7d ?? '—'}</Text></View>
              </View>
            </View>
          </Sheet>

          {/*
            ⚠️ THIS TABLE IS THE MOST USEFUL THING ON THE PAGE, and it exists
            because of a specific afternoon. Step counts read "latest 06:27" at
            15:00 and that looked like a dead watch. It was not: the handset
            sensor was still writing a minute earlier, while Health Sync and
            Google Fit had both stopped ~21 hours before. Three sources, two
            dead, one alive — invisible in every total, obvious here.
          */}
          <Sheet open={sheet === 'sources'} title="数据来源与同步" onClose={closeSheet}>
            <View className="card chc__card">
              <Text className="chc__card-t">谁在写、多久没写了</Text>
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
                          <Text>
                            {Number.isFinite(mins)
                              ? mins < 90 ? `${Math.round(mins)} 分钟前` : `${(mins / 60).toFixed(1)} 小时前`
                              : '—'}
                          </Text>
                          {/*
                            ⚠️⚠️ ⚠️ 要**独占一行**。
                            原来它和「21.4 小时前」是同一个文本节点里的相邻字符，
                            于是窄列里会折行成「21.4 小时/前 ⚠️」或者把 ⚠️ 挤到
                            第三行去 —— 而 ⚠️ 是这个表**唯一的重点标记**，
                            它一移位，「哪一行是坏的」就要读者自己去比对。
                            `<View>` 是块级，直接换行，不依赖折行时机。
                          */}
                          {stale ? <View className="chc__stalemark">⚠️ 已停写</View> : null}
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

            <View className="card chc__card">
              <Text className="chc__card-t">同步</Text>
              {/*
                ⚠️ Both stamps, because they answer different questions.
                `lastPushAt` ("手机来过了") comes from the ingest over an
                uncached connection and moves on EVERY push, including one that
                changed nothing. `updatedAt` ("数字变了") comes from the published
                file and obeys a 10-minute CDN cache. Showing only the second is
                how a working sync came to look broken for a week on CAPPERR.
              */}
              <View className="chc__grid">
                <View className="chc__cell">
                  <Text>手机上报</Text>
                  <Text className="chc__cell-v">{beat?.lastPushAt ? beat.lastPushAt.slice(5).replace('T', ' ') : '—'}</Text>
                </View>
                <View className="chc__cell">
                  <Text>数据更新</Text>
                  <Text className="chc__cell-v">{index?.updatedAt ? index.updatedAt.slice(5).replace('T', ' ') : '—'}</Text>
                </View>
                <View className="chc__cell">
                  <Text>累计天数</Text>
                  <Text className="chc__cell-v">{index?.dayCount ?? 0}</Text>
                </View>
                <View className="chc__cell">
                  <Text>手机端</Text>
                  <Text className="chc__cell-v">v{index?.appVersion ?? '—'}</Text>
                </View>
              </View>
              <Text className="chc__note">
                数据区间 {index?.from ?? '—'} → {index?.to ?? '—'}
              </Text>
              {/*
                ⚠️ The verdict, not another stamp. See `stallDays` above for why
                two timestamps in one sentence are not a warning.
              */}
              {stallDays >= 2 ? (
                <Text className="chc__note chc__stale">
                  ⚠️ 手机一直在推，数据却没动 —— 最新一天是 {index?.to}，比手机最后一次上报早 {stallDays} 天。
                  三星健康国行不写 Health Connect，Health Sync 是它唯一的入口，先去手机上确认它还在同步。
                </Text>
              ) : null}
              {!beat ? (
                <Text className="chc__note">
                  ⚠️ 读不到上报心跳 —— 阿里云那边可能没响应，数据本身仍是最新发布的那份
                </Text>
              ) : null}
            </View>
          </Sheet>

          <Sheet open={sheet === 'week'} title="周对比" onClose={closeSheet}>
            {/*
              ⚠️⚠️ 读者 2026-09-29：「尽量处理成带过程的数据，而不是单一的平均数据」。

              下面那张卡全是**数字**（7 天 vs 前 7 天，加一个百分比）——
              它答的是「变了多少」，答不了「是**怎么**变的」：
              一路爬上去然后掉下来，和一路掉下去然后弹回来，可以是同一个百分比。
              这两条折线给的正是那个形状。

              ⚠️⚠️ 它们原来放在主页**第一屏**，而那一屏的内容一直排到 y=988，
                面板底边是 900 ⇒ **整块在屏幕外，谁也看不见**。
                而当时「元素在不在 DOM 里、折线有没有画出来」的检查**全绿**
                （我确实查了路径长度 177/161 字符，非空）。
                ⇒ **一屏排不下时，正确的做法是换一屏，不是继续往下堆。**
                  而且「画出来了」和「看得见」是两件事，**要量的是后者**：
                  元素矩形有没有落在它所在面板的矩形里面。

              ⚠️ 缺的那天传 `undefined`，**不是 0** —— `Spark` 会跳过它、
                折线在那里断开。传 0 的话「那天没记录」会被画成「那天速度是 0」，
                一条俯冲到底的尖；而两端被拉到 0 时，**中间所有正常值看起来都像异常**。
            */}
            <View className="card chc__card">
              {recent.some((d) => typeof d.speedAvgMps === 'number') ? (
                <View className="chc__trend">
                  <Text className="chc__card-t">运动均速 · 最近 14 天</Text>
                  <Spark
                      points={recent.map((d) => d.speedAvgMps)}
                      labels={recent.map((d) => d.date.slice(5))}
                      name="运动均速"
                      unit=" m/s"
                    />
                </View>
              ) : null}

              {recent.some((d) => typeof d.stepsCadenceAvg === 'number') ? (
                <View className="chc__trend">
                  <Text className="chc__card-t">步频 · 最近 14 天</Text>
                  <Spark
                      points={recent.map((d) => d.stepsCadenceAvg)}
                      labels={recent.map((d) => d.date.slice(5))}
                      name="步频"
                      unit=" 步/分"
                    />
                </View>
              ) : null}
            </View>

            <View className="card chc__card">
              <Text className="chc__card-t">最近 7 天 vs 再往前 7 天</Text>
              {week.length ? (
                <>
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
                </>
              ) : (
                <Text className="chc__note">还没有足够两周的数据可以对比。</Text>
              )}
            </View>
          </Sheet>

          <Sheet open={sheet === 'power'} title="功率与个人记录" onClose={closeSheet}>
            {bests.length ? (
              <View className="card chc__card">
                <Text className="chc__card-t">
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

            {powered.length ? (
              powered.map(({ s, p }) => (
                <View className="card chc__card" key={`pw-${s.start}`}>
                  <View className="chc__sesshead">
                    <Icon name="power" className="chc__ico" />
                    <Text className="chc__card-t">
                      {typeLabel(s.type)} {s.start.slice(5, 16).replace('T', ' ')}
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
                  {/*
                    ⚠️⚠️ **这一屏原来一条曲线都没有。**
                    上面那四个格子全是汇总值（平均 / 峰值 / NP / 最佳 20 分钟），
                    而这一页其他地方（单场弹窗）早就在画功率**过程曲线**了。
                    读者 2026-09-30：「过程的这些全都没画出来曲线，
                    这些 CHEALTH 弹窗出来的功能少了太多，全部都补充好」。

                    ⚠️ 而 `powerSeries` 是**真的有**的（本地实测 25/25 场都有，
                       `HR_BANDS` 那条链路上同一个 schema 的三个序列字段）。
                      所以这不是「没数据不做」，是**数据在、图没画**。

                    ⚠️ 汇总值恰恰是读者点名不要的那种：「平均功率会把
                      『4 分钟 400W + 4 分钟 100W』和『全程 250W』
                      显示成同一个数字，而这两件事在训练上完全不同。」
                  */}
                  {s.powerSeries && s.powerSeries.length > 1 ? (
                    <View className="chc__trend">
                      <Text className="chc__card-t">功率曲线</Text>
                      <SeriesChart
                        series={s.powerSeries}
                        name="功率曲线"
                        unit=" W"
                        peakNote="（原始峰值见上）"
                      />
                    </View>
                  ) : (
                    <Text className="chc__note">
                      这一场只有汇总值（平均 / 峰值），没有逐分钟的过程序列 ——
                      过程序列是手机对这场运动的时间窗**单独读一次**得来的，那一次可能没读到。
                    </Text>
                  )}
                </View>
              ))
            ) : (
              <View className="card chc__card">
              </View>
            )}
          </Sheet>

          {/*
            ⚠️ 这一屏原来只有一句「连续 N 天」。现在补成三星那张「每日活动量」的样子：
            一个达标日历 + 本月汇总 + 连续天数。
            ⚠️ 三块的数据**全都有**（每天的步数 + 一个目标值），所以没有编造。
          */}
          <Sheet open={sheet === 'streak'} title="达标" onClose={closeSheet}>
            <View className="card chc__card" style={{ ['--m' as string]: 'var(--m-steps)' } as CSSProperties}>
              {/*
                ⚠️⚠️ 分母是**有记录的天数**，不是「这个月过了几天」。
                三星用的是后者 —— 但那个数会把「手机没同步的那几天」记成「没达标」，
                也就是**把「我们不知道」算成「他没做到」**。
                这个项目已经栽过好几次（缺数据画成 0、占位符冒充真数据）。
              */}
              <Text className="chc__card-t">
                <Icon name="trophy" className="chc__ico" />
                目标已实现 {monthStats.hit}/{monthStats.tracked} 天
              </Text>
              {/*
                ⚠️⚠️ 弧形仪表盘（三星「睡眠得分」那个形状），但这里画的是
                **达标率**，不是任何「得分」。

                ⚠️ 三星的「能量得分 / 睡眠得分」是它自己的专有算法，
                  我们**没有也不编**（读者定的规矩：拿不到数据的就不做）。
                  ⇒ 用它的**形状**，说我们**量得到**的那件事：
                    「这个月有记录的那些天里，达标了多少天」。
                    长得像三星，说的是真话。
              */}
              {/*
                ⚠️ 两个仪表盘并排 —— 三星首页也是几个「得分」并排放的。
                步数用步数色、睡眠用睡眠色，两种比例各自有分母。
                ⚠️ 每个下面的小字写清**分母是什么** —— 没有它，「83%」是一个
                  没有依据的数；有了它，读者能自己判断这个比例算得对不对。
              */}
              <View className="chc__gauges">
                <View className="chc__gaugebox">
                  <Gauge
                    pct={monthStats.tracked > 0 ? monthStats.hit / monthStats.tracked : 0}
                    value={`${monthStats.tracked > 0 ? Math.round((monthStats.hit / monthStats.tracked) * 100) : 0}%`}
                    label="步数达标率"
                    color="var(--m-steps)"
                  />
                  <Text className="chc__gaugecap">{monthStats.hit}/{monthStats.tracked} 天</Text>
                </View>
                <View className="chc__gaugebox">
                  <Gauge
                    pct={sleepStats.tracked > 0 ? sleepStats.hit / sleepStats.tracked : 0}
                    value={`${sleepStats.tracked > 0 ? Math.round((sleepStats.hit / sleepStats.tracked) * 100) : 0}%`}
                    label="睡眠达标率"
                    color="var(--m-sleep)"
                  />
                  <Text className="chc__gaugecap">
                    {sleepStats.hit}/{sleepStats.tracked} 晚 ≥ {SLEEP_GOAL_H}h
                  </Text>
                </View>
                {/*
                  ⚠️ 后两个得分是 2026-09-29 补的（读者：「能展示的内容能展示出来
                  什么吗得分」）。分母和上面两个同源：有记录的天数 + 自己定的目标。
                  ⚠️ 它们的 `tracked` 明显小于步数那个 —— `activeMinutes` 是
                  9-29 才开始的字段。所以下面那行「N/M 天」不是装饰，是这一格
                  有没有意义的前提。
                */}
                <View className="chc__gaugebox">
                  <Gauge
                    pct={activeMinStats.tracked > 0 ? activeMinStats.hit / activeMinStats.tracked : 0}
                    value={`${activeMinStats.tracked > 0 ? Math.round((activeMinStats.hit / activeMinStats.tracked) * 100) : 0}%`}
                    label="活动时间达标率"
                    color="var(--m-dist)"
                  />
                  <Text className="chc__gaugecap">
                    {activeMinStats.hit}/{activeMinStats.tracked} 天 ≥ {ACTIVE_MIN_GOAL} 分钟
                  </Text>
                </View>
                <View className="chc__gaugebox">
                  <Gauge
                    pct={activeKcalStats.tracked > 0 ? activeKcalStats.hit / activeKcalStats.tracked : 0}
                    value={`${activeKcalStats.tracked > 0 ? Math.round((activeKcalStats.hit / activeKcalStats.tracked) * 100) : 0}%`}
                    label="活动消耗达标率"
                    color="var(--m-kcal)"
                  />
                  <Text className="chc__gaugecap">
                    {activeKcalStats.hit}/{activeKcalStats.tracked} 天 ≥ {ACTIVE_KCAL_GOAL} 千卡
                  </Text>
                </View>
              </View>

              {/*
                ⚠️ 读者 2026-09-29：「学习三星把能量得分和睡眠得分的那两个部分的
                柱状图和弧形图……很好看，要想办法用上，而且要模仿的完全一样」。

                ⇒ 弧形图就是他上面看到的这两个 `Gauge`（240° + 末端圆点，本来就
                  是照三星那个形状做的）；**柱状图**是这里新加的七日点条
                  （三星「能量得分」右边那一排竖圆条 + 彩点）。

                ⚠️⚠️ 但分数**不是**三星的分数 —— 那个 0–100 是它自己的专有算法
                  （睡眠阶段、心率变异性、血氧、呼吸…），我们**没有、也不编**。
                  这里画的是**我们量得到的那件事**：每天走到目标的比例。
                  所以下面那行小字必须写清「这根条是什么」，否则读者会把它
                  当成三星那个分数，然后对不上。
              */}
              {scoreDays.some((d) => d.score !== null) ? (
                <View className="card chc__card">
                  <Text className="chc__card-t">最近 7 天的步数进度</Text>
                  <View className="chc__sbars-wrap" style={{ ['--m' as string]: 'var(--m-steps)' } as CSSProperties}>
                    <ScoreBars days={scoreDays} />
                  </View>
                  <Text className="chc__gaugecap">点的高度 = 当天步数 ÷ 目标 {STEP_GOAL.toLocaleString('en-US')} 步</Text>
                </View>
              ) : null}
              {/*
                ⚠️⚠️ 这里第一版写的是 `分母是**这个月有记录的天数**` ——
                Markdown 的粗体标记**原样渲染**，读者看到的是四个星号。

                ⚠️ 这是**复发**：commit `73b8a6a` 专门修过同一件事，当时全站 5 处
                都在这一页。所以这不是「又犯了个小错」，是**同一类错没有防住** ——
                规矩是「别在 JSX 里写 Markdown」，而我写新文案时没想起它。
                ⇒ 强调一律用嵌套 `<Text className="chc__em">`。
              */}
              <Text className="chc__note">
                {monthStats.month} · 每天 {STEP_GOAL.toLocaleString('en-US')} 步算达标。
                分母是<Text className="chc__em">这个月有记录的天数</Text>，不是「过了几天」——
                没同步的那几天我们不知道他走没走，不替他算成没做到。
              </Text>
              <GoalCalendar days={days} month={monthStats.month} goal={STEP_GOAL} />
              <View className="chc__keys">
                <Text className="chc__key">
                  本月步数 <Text className="chc__num">{monthStats.steps.toLocaleString('en-US')}</Text>
                </Text>
                {monthStats.km > 0 ? (
                  <Text className="chc__key">
                    距离 <Text className="chc__num">{monthStats.km.toFixed(1)}</Text> 千米
                  </Text>
                ) : null}
                {monthStats.kcal > 0 ? (
                  <Text className="chc__key">
                    总消耗 <Text className="chc__num">{Math.round(monthStats.kcal).toLocaleString('en-US')}</Text> 千卡
                  </Text>
                ) : null}
              </View>
              <Text className="chc__note">
                ⚠️ 总消耗含基础代谢（躺着也在烧），所以它比「活动消耗」大得多。
              </Text>
            </View>

            {/*
              ⚠️⚠️ 读者 2026-09-29 的原话：「我这个月基本上全部做到啦你要检查一下，
              为什么前面的 9 月 1 日到 13 日的数据好像有一点奇怪」。

              查完的结论：**不是这条管道漏了，是 Health Connect 里那几天压根没有步数记录。**
              逐日摊开（`bun scripts/chealth-coverage.ts`）看得清清楚楚：
                08-29 ~ 09-05  每天**只有** `calories = 1662`（基础代谢那个常数），
                               步数、睡眠、活动消耗全是空的
                09-06 ~ 09-07  只有 `fitness`（Google Fit）在写步数
                09-08 起       `healthsync`（三星健康过桥）才开始写

              ⚠️ 所以日历上那几天是**空心的「没记录」**，而不是「没达标」——
                这正是日历要画三种形状的原因。要是把没记录画成没达标，
                读者会以为自己那几天没走，而实际上是我们没收到。

              ⚠️ 这件事**是可以去补的**，所以必须写在页面上，不能只写在我的回话里：
                Health Sync 有「对特定日期重新同步」，把 08-29 ~ 09-05 捞一次。
            */}
            {missingDays.length ? (
              <View className="card chc__card">
                <Text className="chc__card-t">
                  ⚠️ {missingDays.length} 天没有步数记录
                </Text>
                <Text className="chc__note">{missingDays.join('、')}</Text>
                <Text className="chc__note">
                  这<Text className="chc__em">不是</Text>「那天没走」——
                  那几天在 Health Connect 里<Text className="chc__em">只有一条基础代谢记录</Text>
                  （固定 1,662 千卡），连一条步数记录都没有，睡眠和活动消耗也是空的。
                  实测三星健康的过桥（Health Sync）到 9 月 8 日才开始写。
                </Text>
              </View>
            ) : null}

            <View className="card chc__card">
              <Text className="chc__card-t">
                <Icon name="steps" className="chc__ico" />
                连续 {streak} 天
              </Text>
            </View>
          </Sheet>

          <Sheet open={sheet === 'kinds'} title="类型分布" onClose={closeSheet}>
            {kinds.length ? (
              <View className="card chc__card">
                <Text className="chc__card-t">
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
                        <Text className="chc__zone-min">{Math.round(k.minutes)} 分</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : (
              <View className="card chc__card">
                <Text className="chc__note">最近 30 天没有走路以外的活动记录。</Text>
              </View>
            )}
          </Sheet>

          {/*
            ⚠️ 单场运动的弹窗 —— 四条过程曲线住在这里，不再住在列表卡片里。
            心率曲线是读者点名要的：**平均值画不出来**，手机端才发的序列。
          */}
          <Sheet
            open={sheet === 'session'}
            title={
              openSess
                ? `${typeLabel(openSess.type, openSess.exerciseType)} · ${openSess.start.slice(5, 16).replace('T', ' ')}`
                : '运动详情'
            }
            onClose={closeSheet}
          >
            {openSess ? (
              <>
                <View className="card chc__card">
                  <Text className="chc__card-t">{openSess.minutes} 分钟</Text>
                  {/*
                    ⚠️ 全部指标摆出来，**没有的就不写**。写成 0 或者「—」会让
                    读者以为「测出来是零」，而真相是这个来源根本没有这项。
                  */}
                  <View className="chc__keys">
                    {openSess.distanceM !== undefined ? (
                      <Text className="chc__key">距离 <Text className="chc__num">{(openSess.distanceM / 1000).toFixed(2)}</Text> km</Text>
                    ) : null}
                    {openSess.hrAvg !== undefined ? (
                      <Text className="chc__key">
                        心率 <Text className="chc__num">{openSess.hrAvg}</Text> 均 / <Text className="chc__num">{openSess.hrMax ?? '—'}</Text> 峰
                      </Text>
                    ) : null}
                    {openSess.powerAvg !== undefined ? (
                      <Text className="chc__key">平均功率 <Text className="chc__num">{openSess.powerAvg}</Text> W</Text>
                    ) : null}
                    {openSess.powerMax !== undefined ? (
                      <Text className="chc__key">峰值功率 <Text className="chc__num">{openSess.powerMax}</Text> W</Text>
                    ) : null}
                    {openSess.cadenceAvg !== undefined ? (
                      <Text className="chc__key">踏频 <Text className="chc__num">{openSess.cadenceAvg}</Text> rpm</Text>
                    ) : null}
                    {openSess.speedMaxMps !== undefined ? (
                      <Text className="chc__key">最高速度 <Text className="chc__num">{(openSess.speedMaxMps * 3.6).toFixed(1)}</Text> km/h</Text>
                    ) : null}
                    {openSess.activeCalories !== undefined ? (
                      <Text className="chc__key">活动消耗 <Text className="chc__num">{openSess.activeCalories}</Text> kcal</Text>
                    ) : null}
                  </View>
                </View>

                {/*
                  ⚠️⚠️ THE HEART-RATE CURVE — the reader asked for this by name.
                  An average cannot be drawn, so the phone sends the series.
                */}
                {openSess.hrSeries && openSess.hrSeries.length > 1 ? (
                  <View className="card chc__card">
                    <Text className="chc__card-t">心率曲线</Text>
                    {/*
                      ⚠️ 传 `refMax` + `HR_BANDS` ⇒ 曲线**按区间变色**（三星运动详情
                      那屏就是这样：灰→蓝→绿→黄→红）。区间边界和 `hrZones`
                      算时长用的是同一份定义，不是抄来的第二份。
                    */}
                    <HeartChart series={openSess.hrSeries} refMax={refMaxHr} bands={HR_BANDS} />
                  </View>
                ) : null}

                {/*
                  ⚠️ 功率 / 踏频 / 速度的**过程曲线**，不只是平均值。
                  读者要的是「经历过程中」的变化：平均功率会把
                  「4 分钟 400W + 4 分钟 100W」和「全程 250W」显示成同一个数字，
                  而这两件事在训练上完全不同。
                  ⚠️ 四张图共用 SeriesChart —— 各写一遍必然漂移。
                */}
                {openSess.powerSeries && openSess.powerSeries.length > 1 ? (
                  <View className="card chc__card">
                    <Text className="chc__card-t">功率曲线</Text>
                    <SeriesChart series={openSess.powerSeries} name="功率曲线" unit=" W" peakNote="（原始峰值见上）" />
                  </View>
                ) : null}

                {openSess.cadenceSeries && openSess.cadenceSeries.length > 1 ? (
                  <View className="card chc__card">
                    <Text className="chc__card-t">踏频曲线</Text>
                    <SeriesChart series={openSess.cadenceSeries} name="踏频曲线" unit=" rpm" />
                  </View>
                ) : null}

                {/*
                  ⚠️ 速度存的是 m/s（Health Connect 的单位），**在渲染时换成 km/h** ——
                  页面别的地方、以及读者的常识，用的都是 km/h。换算只在这一处做。
                */}
                {openSess.speedSeries && openSess.speedSeries.length > 1 ? (
                  <View className="card chc__card">
                    <Text className="chc__card-t">速度曲线</Text>
                    <SeriesChart
                      series={openSess.speedSeries.map(([t2, v]) => [t2, Math.round(v * 36) / 10] as [number, number])}
                      name="速度曲线"
                      unit=" km/h"
                    />
                  </View>
                ) : null}

                {/*
                  ⚠️⚠️ 一条过程曲线都没有的时候**必须说出来**，不能什么都不显示。

                  读者 2026-09-30：「运动里面的过程那些数据都没有展示了」——
                  而屏幕上「一片空白」和「这一场本来就没有序列」长得**一模一样**。
                  这一页的规矩是「失败不可怕，不可见才可怕」。

                  ⚠️ 而且要把**量出来的覆盖率**写进去：不写数字，读者会以为
                    是页面坏了；写了数字，他才看得出来这是**手机只抓到了一部分**，
                    是数据的事，不是页面的事。（口径写进标签，见 index.tsx 抬头。）
                */}
                {!(openSess.hrSeries && openSess.hrSeries.length > 1) &&
                !(openSess.powerSeries && openSess.powerSeries.length > 1) &&
                !(openSess.cadenceSeries && openSess.cadenceSeries.length > 1) &&
                !(openSess.speedSeries && openSess.speedSeries.length > 1) ? (
                  <View className="card chc__card">
                    <Text className="chc__card-t">这一场没有过程曲线</Text>
                    <Text className="chc__note">
                      上面那些是汇总值（时长、均心率…），不是过程。过程要的是手机在运动
                      中间逐分钟记下来的序列，而最近 {sessions.length} 场里只有{' '}
                      {sessions.filter((s2) => s2.hrSeries && s2.hrSeries.length > 1).length} 场带心率序列
                      —— 功率、踏频、速度的序列一场都没有。
                    </Text>
                    <Text className="chc__note">
                      所以这不是页面坏了。想让以后多留一点：运动时把三星健康的心率测量开着，
                      练完在 Health Sync 里确认那天的记录同步上来了。
                    </Text>
                  </View>
                ) : null}

                {/*
                  ⚠️ 来源要写清楚，而且**一场骑行常常是两个来源**。
                  手表测心率（三星健康），MyWhoosh 测功率踏频，谁也测不全 ——
                  手机把它们合成一条。不写出来，读者会困惑为什么一条骑行
                  既有手表的心率又有功率；写出来，这就是一个完整的解释。
                */}
                <View className="card chc__card">
                  <Text className="chc__card-t">记录来源</Text>
                  <Text className="chc__note">
                    {(openSess.sources ?? [openSess.source]).map((x: string) => x.split('.').pop()).join(' + ')}
                    {openSess.powerAvg === undefined ? '（这次没有功率/踏频数据）' : ''}
                    {openSess.hrSource ? ` · 心率取自 ${openSess.hrSource.split('.').pop()}` : ''}
                  </Text>
                </View>
              </>
            ) : null}
          </Sheet>
        </>
      ) : null}

      {err ? (
        <View className="card">
          <Text className="card__label">读不到健康数据：{err}</Text>
        </View>
      ) : null}
    </View>
  );
}
