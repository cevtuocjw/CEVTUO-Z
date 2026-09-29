/**
 * 从 CHEALTH 索引里算出来的**分析** —— 纯函数，不碰 DOM、不碰网络。
 *
 * ⚠️ 为什么单独一个文件而不是写在页面里：
 *   · 这些是**有对错的算术**，不是排版。页面里没法单独验它们，页面组件只能
 *     靠「渲染出来看着对」。而这里每一个都能拿合成输入直接断言。
 *   · 页面那个文件已经 500 多行，再塞两百行分析就没人看得清了。
 *
 * ⚠️ 这里所有函数都**不做假设**：算不出来就返回 null / 空数组，绝不编一个
 *    看起来合理的数出来。这个项目最忌讳的形状就是「数字是编的，但样式和
 *    真数字一样」。
 */

import type { ChealthDay, ChealthSession } from './data';

// ── 心率区间 ─────────────────────────────────────────────────

export interface HrZone {
  key: string;
  label: string;
  /** 区间下界（含），相对于基准最高心率的百分比。 */
  fromPct: number;
  minutes: number;
  /** 这个区间在曲线上的颜色。 */
  color: string;
}

/**
 * 心率区间的边界与配色 —— **全程序只定义这一次**。
 *
 * ⚠️⚠️ 两处要用它：`hrZones` 拿它算每个区间待了多少分钟，
 *    心率曲线拿它给线上色（三星运动详情那屏的心率线就是**按区间变色**的：
 *    灰→蓝→绿→黄→红）。
 *
 * ⚠️ 各写一份必然漂移 —— 这个项目已经因为「同一件事两处定义」吃过两次亏
 *    （字数统计算出 127 和 109；柱状图色值曾有两份定义）。
 *    所以这里导出的是**边界**，两处都从它派生。
 *
 * ⚠️ 颜色是照三星截图取的语感：低区间冷、高区间暖，**不要用色相环上相邻的
 *    颜色**——相邻色在一条细线上分不出来。
 */
export const HR_BANDS: { key: string; label: string; fromPct: number; color: string }[] = [
  { key: 'z1', label: '恢复', fromPct: 0, color: '#8b93a7' },
  { key: 'z2', label: '燃脂', fromPct: 0.6, color: '#4aa3ff' },
  { key: 'z3', label: '有氧', fromPct: 0.7, color: '#3ecf8e' },
  { key: 'z4', label: '阈值', fromPct: 0.8, color: '#ffb020' },
  { key: 'z5', label: '最大', fromPct: 0.9, color: '#ff5a72' },
];

/**
 * ⚠️ 心率区间的百分比是相对**基准最高心率**算的，而基准从哪来必须说清楚。
 *
 * 这里用**最近 30 天实际观测到的最高心率**，不用 `220 − 年龄` —— 后者是
 * 人群公式，对具体一个人误差可以有 ±10~15 bpm，而它会把整个区间划分平移掉。
 * 用观测值至少是**这个人真的到过的心率**。
 *
 * ⚠️ 代价是它**偏低**（没尽全力就不会到真最大值），所以区间会整体偏严。
 *    页面必须把基准值写出来，否则读者会以为这是标准区间。
 */
export function hrZones(sessions: ChealthSession[], refMax: number): HrZone[] {
  const bands = HR_BANDS;
  const out = bands.map((b) => ({ ...b, minutes: 0 }));
  if (refMax <= 0) return out;

  for (const s of sessions) {
    if (!s.hrSeries || s.hrSeries.length < 2) continue;
    // ⚠️ 序列是**逐分钟**的，所以一个点 ≈ 一分钟。这是估算，不是精确值 ——
    //    降采样之后点数比分钟数少，所以用「相邻点的时间跨度」当权重，
    //    而不是每点算一分钟（那会把长运动算多）。
    for (let i = 0; i < s.hrSeries.length - 1; i += 1) {
      const p = s.hrSeries[i];
      const nx = s.hrSeries[i + 1];
      if (!p || !nx) continue;
      const span = Math.max(0, (nx[0] ?? 0) - (p[0] ?? 0));
      if (span === 0) continue;
      const pct = (p[1] ?? 0) / refMax;
      let idx = 0;
      for (let z = 0; z < bands.length; z += 1) if (pct >= (bands[z]?.fromPct ?? 0)) idx = z;
      const zone = out[idx];
      if (zone) zone.minutes += span;
    }
  }
  return out;
}

// ── 功率 ─────────────────────────────────────────────────────

export interface PowerStats {
  avg: number;
  max: number;
  /** 标准化功率 —— 见下面的说明。 */
  np: number;
  /** 最佳连续 20 分钟平均功率；序列不足 20 分钟时为 null。 */
  best20: number | null;
  minutes: number;
}

/**
 * 功率分析。
 *
 * ⚠️ **标准化功率 (NP)** 是骑行圈的标准做法，理由是「同样平均功率，
 *    间歇骑比匀速骑累得多」。算法是：先做 30 秒滚动平均，再对结果取
 *    四次方平均，最后开四次方。四次方让高功率段权重更大。
 *
 * ⚠️ 但**这里没有 30 秒数据** —— 手机端发来的序列已经逐分钟聚合过了
 *    (≤120 点)。所以这里用**逐分钟**代替 30 秒，得到的 NP **偏低**
 *    （滚动窗口越长，峰值被抹得越平）。这是取舍，不是 bug，页面要说明。
 *
 * ⚠️ 不计算 IF / TSS：那两个都要 **FTP**，而 FTP 需要一次专门的测试，
 *    我们没有。用「最佳 20 分钟 × 0.95」去估 FTP 再拿它算 TSS，
 *    会得到一个**看起来很专业但其实是我们编的**数字 —— 这正是要避免的。
 */
export function powerStats(series: [number, number][] | undefined, fallbackAvg?: number, fallbackMax?: number): PowerStats | null {
  if (!series || series.length < 2) {
    if (fallbackAvg === undefined && fallbackMax === undefined) return null;
    return {
      avg: Math.round(fallbackAvg ?? 0),
      max: Math.round(fallbackMax ?? 0),
      np: 0,
      best20: null,
      minutes: 0,
    };
  }
  const vals = series.map((p) => p[1] ?? 0);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const max = Math.max(...vals);

  // 四次方平均 → 开四次方
  const fourth = vals.reduce((a, b) => a + b ** 4, 0) / vals.length;
  const np = fourth ** 0.25;

  const tMax = series[series.length - 1]?.[0] ?? 0;
  let best20: number | null = null;
  if (tMax >= 20) {
    for (let start = 0; start + 20 <= tMax; start += 1) {
      // 取窗口内所有点，按时间跨度加权 —— 降采样后点不等于分钟。
      let sum = 0;
      let span = 0;
      for (let i = 0; i < series.length - 1; i += 1) {
        const p = series[i];
        const nx = series[i + 1];
        if (!p || !nx) continue;
        const t = p[0] ?? 0;
        if (t < start || t >= start + 20) continue;
        const w = Math.max(0, (nx[0] ?? 0) - t);
        sum += (p[1] ?? 0) * w;
        span += w;
      }
      if (span > 0) {
        const v = sum / span;
        if (best20 === null || v > best20) best20 = v;
      }
    }
  }
  return { avg: Math.round(avg), max: Math.round(max), np: Math.round(np), best20: best20 === null ? null : Math.round(best20), minutes: Math.round(tMax) };
}

// ── 周对比 ───────────────────────────────────────────────────

export interface WeekRow {
  label: string;
  unit: string;
  cur: number;
  prev: number;
  /** `null` = 上周没有可比数据（不是「零」）。 */
  deltaPct: number | null;
}

const sumRange = (days: ChealthDay[], from: string, to: string, pick: (d: ChealthDay) => number | undefined): number =>
  days
    .filter((d) => d.date >= from && d.date <= to)
    .reduce((a, d) => a + (pick(d) ?? 0), 0);

const shiftDay = (iso: string, days: number): string => {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/**
 * 最近 7 天 vs 再往前 7 天。
 *
 * ⚠️ `deltaPct` 在**上周为 0/缺失**时返回 null，不返回 100%。「上周没有记录」
 *    和「上周是零」是两件事，用同一个百分比表示会得到一个看起来很确定、
 *    实际没有依据的数。
 */
export function weekCompare(days: ChealthDay[], to: string): WeekRow[] {
  if (!to) return [];
  const curFrom = shiftDay(to, -6);
  const prevTo = shiftDay(to, -7);
  const prevFrom = shiftDay(to, -13);
  const defs: { label: string; unit: string; pick: (d: ChealthDay) => number | undefined; scale?: number }[] = [
    { label: '步数', unit: '', pick: (d) => d.steps },
    { label: '活动消耗', unit: 'kcal', pick: (d) => d.activeCalories },
    { label: '距离', unit: 'km', pick: (d) => (d.distanceM === undefined ? undefined : d.distanceM / 1000), scale: 10 },
    { label: '睡眠', unit: 'h', pick: (d) => (d.sleepSeconds === undefined ? undefined : d.sleepSeconds / 3600), scale: 10 },
  ];
  const round = (v: number, s?: number) => (s ? Math.round(v * s) / s : Math.round(v));

  // ⚠️⚠️ 「有数据」不等于「数据够」。两回事。
  //
  // 第一版只检查「上周有没有**任意一天**有数据」，实测立刻出了一个
  // **+1355%** —— 上周的活动消耗只有约 500 kcal，因为那一周基本没同步上，
  // 于是这个百分比算出来又大又确定，实际毫无依据。
  // **一个基于残缺基数的百分比，比「—」坏得多**：它看起来像个结论。
  //
  // 所以两个窗口都要求**至少 4/7 天**有数据才给百分比。
  // 4 是取舍：再严会把正常的「手机那两天没同步」也判成不可比，
  // 再松就允许 2 天的数据去代表一整周。
  const MIN_DAYS = 4;

  return defs.map((def) => {
    // ⚠️ 必须定义在 map 回调**里面** —— 它要用 `def`，写外面是 ReferenceError。
    const cover = (from: string, t: string) =>
      days.filter((d) => d.date >= from && d.date <= t && def.pick(d) !== undefined).length;
    const cur = sumRange(days, curFrom, to, def.pick);
    const prev = sumRange(days, prevFrom, prevTo, def.pick);
    const enough = cover(curFrom, to) >= MIN_DAYS && cover(prevFrom, prevTo) >= MIN_DAYS;
    return {
      label: def.label,
      unit: def.unit,
      cur: round(cur, def.scale),
      prev: round(prev, def.scale),
      deltaPct: enough && prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
    };
  });
}

/**
 * 静息心率的周对比**单独一个函数**，因为它是「**越低越好**」的指标 ——
 * 和其它几个放在一起用同一个「↑ 好 / ↓ 差」的箭头会上反。
 *
 * ⚠️ 而且是**平均值**不是合计：7 天的静息心率加起来没有任何意义。
 */
export function restingHrCompare(days: ChealthDay[], to: string): WeekRow | null {
  if (!to) return null;
  // ⚠️ 和 weekCompare 同一个门槛：**「有数据」不等于「数据够」**。
  //    一个基于残缺基数的百分比比「—」坏得多，因为它看起来像个结论。
  const MIN_DAYS = 4;
  const avg = (from: string, t: string) => {
    const vs = days.filter((d) => d.date >= from && d.date <= t && d.restingHr !== undefined).map((d) => d.restingHr ?? 0);
    if (vs.length < MIN_DAYS) return { v: 0, has: false };
    return { v: vs.reduce((a, b) => a + b, 0) / vs.length, has: true };
  };
  const cur = avg(shiftDay(to, -6), to);
  const prev = avg(shiftDay(to, -13), shiftDay(to, -7));
  if (!cur.has) return null;
  return {
    label: '静息心率',
    unit: 'bpm',
    cur: Math.round(cur.v * 10) / 10,
    prev: Math.round(prev.v * 10) / 10,
    deltaPct: prev.has && prev.v > 0 ? Math.round(((cur.v - prev.v) / prev.v) * 100) : null,
  };
}

// ── 个人记录 ─────────────────────────────────────────────────

export interface Best {
  icon: string;
  label: string;
  value: string;
  when: string;
}

/** 最近 30 天里各项最好的一次。算不出来的项直接不出现在列表里。 */
export function personalBests(sessions: ChealthSession[], days: ChealthDay[]): Best[] {
  const out: Best[] = [];
  const d = (iso: string) => iso.slice(5, 10);

  const rides = sessions.filter((s) => s.distanceM !== undefined && s.minutes > 0);
  const longest = rides.reduce<ChealthSession | null>((a, b) => (a === null || (b.distanceM ?? 0) > (a.distanceM ?? 0) ? b : a), null);
  if (longest) out.push({ icon: 'route', label: '最远一次', value: `${((longest.distanceM ?? 0) / 1000).toFixed(1)} km`, when: d(longest.start) });

  const fastest = sessions.filter((s) => s.speedMaxMps !== undefined).reduce<ChealthSession | null>((a, b) => (a === null || (b.speedMaxMps ?? 0) > (a.speedMaxMps ?? 0) ? b : a), null);
  if (fastest) out.push({ icon: 'bolt', label: '最高速度', value: `${((fastest.speedMaxMps ?? 0) * 3.6).toFixed(1)} km/h`, when: d(fastest.start) });

  const strongest = sessions.filter((s) => s.powerMax !== undefined).reduce<ChealthSession | null>((a, b) => (a === null || (b.powerMax ?? 0) > (a.powerMax ?? 0) ? b : a), null);
  if (strongest) out.push({ icon: 'flame', label: '峰值功率', value: `${strongest.powerMax} W`, when: d(strongest.start) });

  const longestSession = sessions.reduce<ChealthSession | null>((a, b) => (a === null || b.minutes > a.minutes ? b : a), null);
  if (longestSession) out.push({ icon: 'clock', label: '最长一次运动', value: `${longestSession.minutes} 分钟`, when: d(longestSession.start) });

  const sleepDays = days.filter((x) => x.sleepSeconds !== undefined && x.sleepSeconds > 0);
  const bestSleep = sleepDays.reduce<ChealthDay | null>((a, b) => (a === null || (b.sleepSeconds ?? 0) > (a.sleepSeconds ?? 0) ? b : a), null);
  if (bestSleep) out.push({ icon: 'moon', label: '最长睡眠', value: `${((bestSleep.sleepSeconds ?? 0) / 3600).toFixed(1)} h`, when: d(bestSleep.date) });

  const stepDays = days.filter((x) => x.steps !== undefined && x.steps > 0);
  const bestSteps = stepDays.reduce<ChealthDay | null>((a, b) => (a === null || (b.steps ?? 0) > (a.steps ?? 0) ? b : a), null);
  if (bestSteps) out.push({ icon: 'steps', label: '单日最多步数', value: (bestSteps.steps ?? 0).toLocaleString('en-US'), when: d(bestSteps.date) });

  return out;
}

// ── 连续达标 ─────────────────────────────────────────────────

/**
 * 以 `to` 为终点往回数，连续多少天达到 `target` 步。
 *
 * ⚠️ 从**最新一天往回**数，遇到第一个不达标就停 —— 中间断过就不算连续。
 * ⚠️ 缺数据的日子**算断**，不算跳过：那天可能确实没走，也可能手机没同步，
 *    但我们不知道，所以不替它猜。
 */
export function stepStreak(days: ChealthDay[], to: string, target = 8000): number {
  if (!to) return 0;
  const byDate = new Map(days.map((d) => [d.date, d]));
  let n = 0;
  for (let i = 0; i < 60; i += 1) {
    const day = byDate.get(shiftDay(to, -i));
    if (!day || (day.steps ?? 0) < target) break;
    n += 1;
  }
  return n;
}

// ── 运动类型分布 ─────────────────────────────────────────────

export interface TypeSlice {
  type: string;
  minutes: number;
  count: number;
}

export function typeBreakdown(sessions: ChealthSession[]): TypeSlice[] {
  const by = new Map<string, TypeSlice>();
  for (const s of sessions) {
    const cur = by.get(s.type) ?? { type: s.type, minutes: 0, count: 0 };
    cur.minutes += s.minutes;
    cur.count += 1;
    by.set(s.type, cur);
  }
  return [...by.values()].sort((a, b) => b.minutes - a.minutes);
}

// ── 运动类型的中文名 ─────────────────────────────────────────

/**
 * ⚠️ 未知类型**显示它的机器名**，不要写「未知」。
 *
 * 手机端发的是 Health Connect 的枚举名，`TYPE_0` 这种就是它没映射到的。
 * 显示 `TYPE_0` 至少能让人去查；显示「未知」是一条死路 ——
 * 既不知道是什么，也不知道该去哪里加映射。
 */
/**
 * Health Connect 的**完整**运动类型表。
 *
 * ⚠️⚠️ 这张表是**从 SDK 的类文件里读出来的**，不是凭记忆写的：
 *
 *     unzip -o connect-client-1.1.0.aar classes.jar
 *     javap -p -constants .../ExerciseSessionRecord.class
 *
 * 为什么较这个真：手机端只映射了 12 个类型，其余的走 `else -> "TYPE_$t"`，
 * 于是页面上出现过一行 **`TYPE_0`** —— 一个读者完全看不懂的机器名。
 * 而「0 是什么」如果靠猜，猜错的表现和猜对**长得一模一样**。
 * 实测 0 = `OTHER_WORKOUT`（其他运动）。
 *
 * ⚠️ 一张表同时供**按名查**和**按编号查**两种用法 —— 两份表必然漂移，
 *    这个项目因为「同一件事两处实现」吃过亏。
 */
const EXERCISE_TYPES: [number, string, string][] = [
  [0, 'OTHER_WORKOUT', '其他运动'],
  [2, 'BADMINTON', '羽毛球'],
  [4, 'BASEBALL', '棒球'],
  [5, 'BASKETBALL', '篮球'],
  [8, 'BIKING', '骑行'],
  [9, 'BIKING_STATIONARY', '室内骑行'],
  [10, 'BOOT_CAMP', '训练营'],
  [11, 'BOXING', '拳击'],
  [13, 'CALISTHENICS', '徒手健身'],
  [14, 'CRICKET', '板球'],
  [16, 'DANCING', '跳舞'],
  [25, 'ELLIPTICAL', '椭圆机'],
  [26, 'EXERCISE_CLASS', '团课'],
  [27, 'FENCING', '击剑'],
  [28, 'FOOTBALL_AMERICAN', '美式足球'],
  [29, 'FOOTBALL_AUSTRALIAN', '澳式足球'],
  [31, 'FRISBEE_DISC', '飞盘'],
  [32, 'GOLF', '高尔夫'],
  [33, 'GUIDED_BREATHING', '呼吸训练'],
  [34, 'GYMNASTICS', '体操'],
  [35, 'HANDBALL', '手球'],
  [36, 'HIGH_INTENSITY_INTERVAL_TRAINING', 'HIIT'],
  [37, 'HIKING', '徒步'],
  [38, 'ICE_HOCKEY', '冰球'],
  [39, 'ICE_SKATING', '滑冰'],
  [44, 'MARTIAL_ARTS', '武术'],
  [46, 'PADDLING', '划桨'],
  [47, 'PARAGLIDING', '滑翔伞'],
  [48, 'PILATES', '普拉提'],
  [50, 'RACQUETBALL', '壁球'],
  [51, 'ROCK_CLIMBING', '攀岩'],
  [52, 'ROLLER_HOCKEY', '轮滑球'],
  [53, 'ROWING', '划船'],
  [54, 'ROWING_MACHINE', '划船机'],
  [55, 'RUGBY', '橄榄球'],
  [56, 'RUNNING', '跑步'],
  [57, 'RUNNING_TREADMILL', '跑步机'],
  [58, 'SAILING', '帆船'],
  [59, 'SCUBA_DIVING', '潜水'],
  [60, 'SKATING', '轮滑'],
  [61, 'SKIING', '滑雪'],
  [62, 'SNOWBOARDING', '单板滑雪'],
  [63, 'SNOWSHOEING', '雪地徒步'],
  [64, 'SOCCER', '足球'],
  [65, 'SOFTBALL', '垒球'],
  [66, 'SQUASH', '壁球'],
  [68, 'STAIR_CLIMBING', '爬楼'],
  [69, 'STAIR_CLIMBING_MACHINE', '爬楼机'],
  [70, 'STRENGTH_TRAINING', '力量训练'],
  [71, 'STRETCHING', '拉伸'],
  [72, 'SURFING', '冲浪'],
  [73, 'SWIMMING_OPEN_WATER', '公开水域游泳'],
  [74, 'SWIMMING_POOL', '游泳'],
  [75, 'TABLE_TENNIS', '乒乓球'],
  [76, 'TENNIS', '网球'],
  [78, 'VOLLEYBALL', '排球'],
  [79, 'WALKING', '走路'],
  [80, 'WATER_POLO', '水球'],
  [81, 'WEIGHTLIFTING', '举重'],
  [82, 'WHEELCHAIR', '轮椅'],
  [83, 'YOGA', '瑜伽'],
];

const BY_NAME = new Map(EXERCISE_TYPES.map(([, name, cn]) => [name, cn]));
const BY_NUM = new Map(EXERCISE_TYPES.map(([num, , cn]) => [num, cn]));

/**
 * ⚠️ 三种输入都要能处理，因为三种都真实出现过：
 *   · 已知名（`BIKING`）—— 手机端映射过的 12 个
 *   · `TYPE_<n>` —— 手机端没映射的，字符串里带着编号
 *   · 其它未知字符串 —— 原样显示
 *
 * ⚠️ 全都映射不到时**显示原样**，不写「未知」：一个编号还能去查，
 *    「未知」是死路（这条注释在手机端也有一份，两边一致）。
 */
export const typeLabel = (name: string, num?: number): string => {
  const direct = BY_NAME.get(name);
  if (direct) return direct;
  const m = /^TYPE_(\d+)$/.exec(name);
  const n = m ? Number(m[1]) : num;
  if (n !== undefined && BY_NUM.has(n)) return BY_NUM.get(n) as string;
  if (n !== undefined) return `其他运动 #${n}`;
  return name;
};
