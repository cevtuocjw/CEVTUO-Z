/**
 * Health ingest — the phone-facing receiver for Samsung Health data.
 *
 * ```
 * Galaxy Watch / phone ──▶ Samsung Health ──▶ Health Connect
 *                                                  │
 *                                       CEVTUO Health (Android app)
 *                                                  │  POST
 *                                                  ▼
 *                                        this server ──▶ gh-pages ──▶ site
 * ```
 *
 * ── ⚠️⚠️ Why this is NOT a copy of the CAPPERR path
 *
 * `handleIngest` can treat the Kindle's export as a complete snapshot and store
 * it verbatim, because the plugin dumps the whole `statistics.sqlite3` history
 * every time. **A lost server is restored by the next push.**
 *
 * The phone cannot do that. Health Connect has no "give me everything" read
 * that is safe to run on a schedule — the app asks for the last 14 days, and
 * asking for years means paging tens of thousands of heart-rate samples on a
 * phone battery. So its payload is a **sliding window**.
 *
 * Storing a window verbatim is a data-loss bug with a two-week fuse: everything
 * works, and then one day the site has exactly 14 days of history and always
 * will. Nothing crashes, nothing logs. So this module **merges by date** into an
 * accumulating store instead, and the merge is the whole point of the file.
 *
 * Merge rules, and why each one:
 *
 * - **A date already on disk keeps existing.** Otherwise the 15-minute worker
 *   would erase yesterday by not mentioning it.
 * - **⚠️ An incoming date WINS over the stored one.** Today is incomplete until
 *   it is over — a 09:00 push has 3,000 steps and a 21:00 push has 12,000. If
 *   stored won, the dashboard would freeze each day at whatever the first push
 *   of the morning saw, which is the most plausible-looking wrong answer here.
 * - **A stored metric the incoming day omits is KEPT.** A metric can be missing
 *   for a transient reason (watch not worn, permission just granted, a read that
 *   threw). Deleting the day's sleep because this particular read missed it
 *   turns a blip into a permanent hole.
 */

import { z } from 'zod';

/** Server-local, never published. Same reasoning as the CAPPERR raw export. */
export const HEALTH_RAW_PATH = 'data/chealth/raw-health.json';
/** Published to `gh-pages`. This is what the page fetches. */
export const HEALTH_INDEX_PATH = 'data/chealth/index.json';
/** When the phone last REACHED us — see `notePush` in `core.ts`. */
export const HEALTH_HEARTBEAT_PATH = 'data/chealth/heartbeat.json';

/**
 * `YYYY-MM-DDTHH:mm+08:00`, not `toISOString()`.
 *
 * ⚠️ The page SLICES these strings, it does not parse them. A `Z` stamp would
 * render eight hours early — an error that looks like a real time.
 */
export function localStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * ⚠️ Every numeric field is `.optional()` and `.nullable()`.
 *
 * A day is not a fixed record with blanks in it. Which metrics exist depends on
 * which sensor was worn, which permission was granted when, and whether the
 * watch synced. Requiring all thirteen would reject the entire payload — and
 * therefore the entire day — over one missing weight reading.
 */
const DaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD'),
  steps: z.number().nonnegative().optional(),
  distanceM: z.number().nonnegative().optional(),
  calories: z.number().nonnegative().optional(),
  /**
   * ⚠️ NOT a subset of `calories` and NOT interchangeable with it.
   * `calories` is `TotalCaloriesBurnedRecord`, which INCLUDES basal metabolic
   * rate — a day with no activity still reports ~1662 kcal, flat. A chart of it
   * reads as a dead sensor. This is the moving half, and it is the number a
   * reader means by "消耗".
   */
  activeCalories: z.number().nonnegative().optional(),
  /**
   * ⚠️ Per-source step counts, because summing them is wrong.
   *
   * Three apps write step records into Health Connect at once — Samsung Health
   * (bridged by Health Sync), Google Fit, and the phone's own sensor — all
   * describing the same walking. Adding them counts every step up to three
   * times. Measured on this device 2026-09-24: 210 / 226 / 169 records over the
   * same 48 hours.
   */
  stepSources: z.record(z.string(), z.number().nonnegative()).optional(),
  floors: z.number().nonnegative().optional(),
  /**
   * ⚠️ Averages from a SAMPLE SERIES, not sums. StepsCadence and Speed arrive
   * as hundreds of timestamped samples a day; summing them produces a number
   * with no meaning at all (and one that grows with how often the sensor fired).
   */
  stepsCadenceAvg: z.number().optional(),
  speedAvgMps: z.number().optional(),
  speedMaxMps: z.number().optional(),
  sleepSeconds: z.number().nonnegative().optional(),
  /**
   * 当天**所有活动**加起来多少分钟 —— 走路 + 运动会话，**不只是走路**。
   *
   * ⚠️⚠️ 这个键必须**显式列在这里**。`z.object` 默认会**静默丢掉** schema 里
   *    没写的键，而手机端已经在发了（2026-09-29 加的）—— 症状会是
   *    「手机明明推了、服务器上就是没有」，**零报错**。
   *    ⚠️ 这个坑在本文件下面 `powerSeries` 那段已经记过一次，
   *      那次是 `hrSeries` / `powerSeries` / `cadenceSeries` 三个键被丢掉。
   *
   * ⚠️ 口径（手机端算的，不是 Health Connect 的字段 —— 那边没有这种记录类型）：
   *    `并集(有步数的步数记录的时间区间, 运动会话的时间区间)`，已排除 Google Fit
   *    那种**整天聚合**记录（不排的话会变成 1,440 分钟）。
   */
  activeMinutes: z.number().nonnegative().optional(),
  hrAvg: z.number().optional(),
  hrMax: z.number().optional(),
  restingHr: z.number().optional(),
  hrvMs: z.number().optional(),
  spo2Pct: z.number().optional(),
  respRate: z.number().optional(),
  weightKg: z.number().optional(),
  exerciseCount: z.number().int().nonnegative().optional(),
});

/**
 * ⚠️ An exercise session, with whatever the phone could attach to it.
 *
 * ⚠️ Every field past `source` is optional, and that is the honest shape: the
 * enrichment is a set of separate reads over the session's time window, each of
 * which can come back empty. Requiring them would throw away a real ride
 * because its heart rate happened not to be recorded.
 */
const SessionSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, '开始时间格式不对'),
  minutes: z.number().nonnegative(),
  /** Machine name, e.g. `BIKING`. The page keys off this. */
  type: z.string(),
  /** ⚠️ Kept alongside the name so a future reader can filter on the number
   *  without a name→number table that would drift from Health Connect's. */
  exerciseType: z.number().int(),
  title: z.string().optional(),
  source: z.string(),
  distanceM: z.number().nonnegative().optional(),
  activeCalories: z.number().nonnegative().optional(),
  hrAvg: z.number().optional(),
  hrMax: z.number().optional(),
  powerAvg: z.number().optional(),
  powerMax: z.number().optional(),
  speedMaxMps: z.number().optional(),
  cadenceAvg: z.number().optional(),
  /**
   * ⚠️ 过程序列 —— `[距开始第几分钟, 值]`，手机端已逐分钟聚合并降采样到 ≤120 点。
   *
   * ⚠️ 和 `hrSeries` 同一个理由：读者要的是「**经历过程中**的变化」，
   *    而一个平均值画不出曲线。
   *
   * ⚠️ 功率尤其如此 —— 一场间歇骑行的均值会把
   *    「4 分钟 400W + 4 分钟 100W」和「全程 250W」显示成同一个数字，
   *    而这两件事在训练上完全不同。
   *
   * ⚠️⚠️ 这三个字段必须**显式列在这里**。`z.object` 默认会**静默丢掉**
   *    schema 里没写的键，而手机端已经在发了 —— 症状是「手机明明推了、
   *    服务器上就是没有」，零报错。同一个坑这个项目记过一次
   *    （原始导出被 zod 解析后存下来，`.default()` 补上、不认识的键丢掉）。
   */
  powerSeries: z.array(z.tuple([z.number(), z.number()])).max(200).optional(),
  cadenceSeries: z.array(z.tuple([z.number(), z.number()])).max(200).optional(),
  speedSeries: z.array(z.tuple([z.number(), z.number()])).max(200).optional(),
  /**
   * ⚠️ WHICH app measured the heart rate, because a ride has two possible
   * sources and they disagree: the watch (Samsung Health, on the wrist) and
   * MyWhoosh (a chest strap or an estimate). Averaging them yields a number
   * neither device ever measured. The phone picks the watch and says so here.
   */
  hrSource: z.string().optional(),
  /**
   * ⚠️ THE HEART-RATE CURVE — `[minutesSinceStart, bpm]` pairs, downsampled on
   * the phone to at most ~120 points.
   *
   * ⚠️ Deliberately a series and not another average: the reader asked to see
   * the heart-rate graph for each session, and an average cannot be drawn.
   * ⚠️ The peak is force-included by the phone, because even sampling can step
   * straight over the one point a heart-rate chart exists to show.
   */
  hrSeries: z.array(z.tuple([z.number(), z.number()])).max(200).optional(),
  /**
   * ⚠️ Every app that recorded part of this session. A ride is routinely TWO
   * records — the watch has the heart rate and MyWhoosh has the power — and the
   * phone merges them. Without this the page cannot explain why one ride
   * carries metrics that no single device measures.
   */
  sources: z.array(z.string()).optional(),
});

export type HealthSession = z.infer<typeof SessionSchema>;

export const HealthRawSchema = z.object({
  schemaVersion: z.literal(1),
  device: z.string().min(1),
  exportedAt: z.string().min(1),
  appVersion: z.string().optional(),
  /**
   * ⚠️ When each app last wrote to Health Connect. This is what turns "步数最新
   * 06:27" from a mystery into a diagnosis — Health Sync stalling while the
   * phone's own sensor keeps writing is invisible in the totals and obvious
   * here.
   */
  origins: z.record(z.string(), z.object({
    count: z.number().int().nonnegative(),
    lastAt: z.string(),
  })).optional(),
  /** ⚠️ Walking is INCLUDED here on purpose — the reader said to keep fetching
   *  it and only hide it. The filter lives in `buildHealthIndex`, one layer up,
   *  so changing that decision later does not require the phone to re-send
   *  anything. */
  sessions: z.array(SessionSchema).max(2000).optional(),
  /**
   * ⚠️ Whether MyWhoosh is in the foreground right now. `false` means "not
   * detected", NOT "not riding" — it is `false` whenever the usage-access
   * permission has not been granted. The page must render that as an unknown,
   * never as certainty.
   */
  ridingNow: z.boolean().optional(),
  days: z.array(DaySchema).max(400),
});

export type HealthDay = z.infer<typeof DaySchema>;
export type HealthRaw = z.infer<typeof HealthRawSchema>;

/**
 * ⚠️ How long the accumulating store keeps anything, in days.
 *
 * ── Why prune at all
 *
 * The merged store only ever grows: the phone re-sends a 30-day window every 15
 * minutes and every date in it is unioned in. Nothing removes a day, so after a
 * year the file is a year of history — and the page shows the last 14 days of
 * it. Storage that grows without bound to serve a fixed-size view is a leak
 * with a long fuse.
 *
 * ── ⚠️⚠️ Measured from the NEWEST DATE IN THE DATA, not from `Date.now()`
 *
 * If it were wall-clock, a phone that stopped syncing for two months would come
 * back to find the server had deleted everything it had — the store would erode
 * itself while nobody was writing, which is the opposite of a backup. Keyed on
 * the data's own frontier, a stalled phone simply stops advancing the cutoff and
 * nothing is lost.
 *
 * ── ⚠️ Why 31 and not 30
 *
 * The phone's window is 30 days. Keeping exactly 30 means a single missed sync
 * retires a day the phone can no longer re-send — a permanent hole created by a
 * temporary problem. One extra day is the cheapest possible insurance, and it
 * still satisfies "delete anything over a month old".
 */
export const RETENTION_DAYS = Number(process.env.CEVTUO_HEALTH_RETENTION_DAYS ?? 31);

export interface HealthStore {
  readRaw(): Promise<string | null>;
  writeRaw(text: string): Promise<void>;
  readHeartbeat(): Promise<string | null>;
  writeHeartbeat(text: string): Promise<void>;
  /** The accumulating store. Distinct from `writeRaw` on purpose — see the header. */
  readMerged(): Promise<string | null>;
  writeMerged(text: string): Promise<void>;
  /** `data/chealth/index.json` — the file the publisher uploads. */
  writeIndex(text: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// The merge
// ─────────────────────────────────────────────────────────────

/**
 * Days that came in as `null`/absent mean "not measured", and must not
 * overwrite a number that was measured.
 *
 * ⚠️ `0` is NOT absent. Zero steps on a day the watch was worn is a fact, and
 * treating it as a gap would let a stale 8,000 survive forever. Only `undefined`
 * and `null` are holes.
 */
function mergeDay(stored: HealthDay | undefined, incoming: HealthDay): HealthDay {
  if (!stored) return { ...incoming };
  const out: Record<string, unknown> = { ...stored, date: incoming.date };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out as HealthDay;
}

/**
 * Key-order-independent serialization, for the `changed` comparison only.
 *
 * ⚠️ `JSON.stringify(a) !== JSON.stringify(b)` is order-SENSITIVE. Two objects
 * with the same pairs in a different order compare unequal, which here means
 * "something changed" — and the caller publishes on that. Every 15 minutes.
 *
 * Today this never fires, but only because the phone emits `day.put()` calls in
 * a fixed sequence; the day someone reorders two fields in `SyncWorker`, this
 * turns into an empty GitHub commit every 15 minutes that buries real changes
 * and burns Pages build minutes. That is precisely the failure `handleIngest`
 * already guards against for CAPPERR, arriving through a side door.
 */
/**
 * ⚠️ Order-independent comparison for the sessions array. Sessions arrive sorted
 * by start, but a merge can reorder them, and a reorder is NOT a change worth
 * publishing — while a changed `hrSeries` is. Comparing sorted-by-key keeps the
 * first from triggering commits and the second from being missed.
 */
function canonicalJson(v: unknown): string {
  return JSON.stringify(
    [...(v as HealthSession[])]
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      .map((s) => Object.keys(s).sort().map((k) => [k, (s as Record<string, unknown>)[k] ?? null])),
  );
}

function canonical(day: HealthDay): string {
  const o = day as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k] ?? null]));
}

/**
 * ⚠️⚠️ 会话**不是**按键合并的 —— 这一点 2026-09-28 才改对，而它藏了很久。
 *
 * 原来写的是「按 `start` 合并，incoming 覆盖同键的」，和 `mergeDays` 同一套。
 * 那对 days 是对的（一天一个键，重读同一天就是覆盖），**对会话是错的**：
 * 按键合并**只能新增和覆盖，永远删不掉**。
 *
 *   手机端：09-23 那次骑行在 Health Connect 里是两条 —— 18:44 的 healthsync
 *           和 18:45 的 fitness（类型名还不同，一个叫「骑行」一个叫
 *           「室内骑行」）。`SyncWorker` 按**时间重叠**把它们合并成一条，
 *           于是上报的 `sessions` 里只剩 18:44。
 *   服务端：18:45 那个键**再也没有人来覆盖它**，那条 fitness 会话就永远留着。
 *
 * 症状就是页面上同一场骑行两行。而「排除 Google Fit」+ 全量回填之后**它还在**
 * —— 因为回填改的是手机端，服务端这道并集把旧记录钉死了。查到这里才明白
 * 不是回填没用。
 *
 * ⚠️ 正确语义：`incoming` 是**整段窗口的完整列表**，不是增量 ——
 *    手机端 `collectSessions` 每次读的都是 `DAYS = 30` 的全天窗
 *    （`today.minusDays(DAYS - 1)` 到 `now`），和日期循环那个只重读
 *    `REFRESH_DAYS` 的增量完全不是一回事。所以窗口内以它为准。
 *
 * ⚠️ 代价说清楚：手机端的窗口是 30 天，而保留期是 31 天。整表替换之后，
 *    最老那一天如果已经滚出手机窗口，会**早一天**消失。它在
 *    `pruneOld` 里本来就活不过第二天，所以不值得为它把逻辑写复杂。
 *
 * ⚠️⚠️ `undefined` 和 `[]` **必须分开**，否则这个改动会变成删数据：
 *    手机端读会话失败时会走 catch 分支。原样发空数组的话，「这一轮没读到」
 *    会和「窗口内真的一场运动都没有」长得一模一样 —— 而这两者一个该保留旧值、
 *    一个该清空。**会撒谎的读数比会切一下的读数更糟。**
 *    这个项目在 CAPPERR 的 `handleRebuild` 上已经付过一次学费：那里返回 202
 *    被判成 200，于是**操作者收到成功回执、数据一个字没动**。
 *    所以：`undefined` ⇒ 原样返回；数组（哪怕是空的）⇒ 窗口内以它为准。
 */
export function mergeSessions(
  stored: HealthSession[],
  incoming: HealthSession[] | undefined,
): HealthSession[] {
  if (incoming === undefined) return stored;
  const byStart = new Map<string, HealthSession>();
  for (const s of incoming) byStart.set(s.start, s);
  return [...byStart.values()].sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
}

/**
 * Drop everything older than the retention window, measured from the newest
 * date present.
 *
 * ⚠️ Returns what it removed, and the caller LOGS it. A retention policy that
 * deletes silently is indistinguishable from a bug that loses data — and this
 * project has already paid once for a silent deletion (`paths.contract.ts`'s
 * heartbeat route, removed by an edit that took its neighbour with it).
 */
export function pruneOld(
  days: HealthDay[],
  sessions: HealthSession[],
  retentionDays: number = RETENTION_DAYS,
): { days: HealthDay[]; sessions: HealthSession[]; droppedDays: number; droppedSessions: number; cutoff: string | null } {
  const frontier = days.reduce<string | null>((max, d) => (max === null || d.date > max ? d.date : max), null);
  if (frontier === null) {
    return { days, sessions, droppedDays: 0, droppedSessions: 0, cutoff: null };
  }
  const cutoff = shiftDate(frontier, -(retentionDays - 1));
  const keptDays = days.filter((d) => d.date >= cutoff);
  const keptSessions = sessions.filter((s) => s.start.slice(0, 10) >= cutoff);
  return {
    days: keptDays,
    sessions: keptSessions,
    droppedDays: days.length - keptDays.length,
    droppedSessions: sessions.length - keptSessions.length,
    cutoff,
  };
}

export function mergeDays(
  stored: HealthDay[],
  incoming: HealthDay[],
): { days: HealthDay[]; changed: boolean } {
  const byDate = new Map<string, HealthDay>();
  for (const d of stored) byDate.set(d.date, d);

  let changed = false;
  for (const d of incoming) {
    const before = byDate.get(d.date);
    const after = mergeDay(before, d);
    byDate.set(d.date, after);
    if (!before || canonical(before) !== canonical(after)) changed = true;
  }

  // Ascending by date. The page plots this straight through, and a series that
  // is sorted only because of the order it happened to arrive in breaks the
  // moment a day is backfilled.
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { days, changed };
}

// ─────────────────────────────────────────────────────────────
// The public view
// ─────────────────────────────────────────────────────────────

/** Sum over the last `n` days ending at `end` (inclusive), ignoring holes. */
function windowSum(days: HealthDay[], end: string, n: number, key: keyof HealthDay): number {
  const cutoff = shiftDate(end, -(n - 1));
  return days
    .filter((d) => d.date >= cutoff && d.date <= end)
    .reduce((acc, d) => acc + (typeof d[key] === 'number' ? (d[key] as number) : 0), 0);
}

function shiftDate(date: string, deltaDays: number): string {
  // ⚠️ Explicit indices, not destructuring. Under `noUncheckedIndexedAccess`
  // `const [y, m, d] = ...` types every element as `number | undefined`, and
  // the arithmetic then fails to compile — which is the good outcome. The bad
  // one it prevents is a silent NaN date that sorts to the front of the series.
  const parts = date.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`日期格式不对: ${date}`);
  }
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * ⚠️ `today`/`week`/`month` are computed HERE, not in the page.
 *
 * Both `pages/home` and `pages/chealth` need them. Defining "this week" twice is
 * how the same number ends up different on two screens — and the CAPPERR pages
 * already paid for that lesson once, when the home page and the CAPPERR page
 * rendered the same charts from two different stylesheets.
 */
export function buildHealthIndex(
  days: HealthDay[],
  device: string,
  appVersion?: string,
  origins?: Record<string, { count: number; lastAt: string }>,
  sessions: HealthSession[] = [],
  ridingNow = false,
) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = sorted[sorted.length - 1];
  const end = latest?.date ?? localStamp().slice(0, 10);

  // ⚠️ The 7- and 30-day windows are rolling, not calendar. A calendar week on
  // a Monday morning reads as "zero this week", which looks broken.
  const avg = (key: keyof HealthDay, n: number): number | null => {
    const vals = sorted
      .filter((d) => d.date >= shiftDate(end, -(n - 1)) && d.date <= end)
      .map((d) => d[key])
      .filter((v): v is number => typeof v === 'number');
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  };

  return {
    schemaVersion: 1,
    updatedAt: localStamp(),
    device,
    appVersion: appVersion ?? null,
    from: sorted[0]?.date ?? null,
    to: latest?.date ?? null,
    dayCount: sorted.length,
    days: sorted,
    /**
     * ⚠️ Which apps are feeding Health Connect and how stale each is.
     *
     * On 2026-09-24 Health Sync and Google Fit had both stopped ~21 hours
     * earlier while the handset sensor kept writing. The daily totals looked
     * merely quiet; this block is the difference between "quiet" and "one of
     * three sources died".
     */
    origins: origins ?? {},
    /**
     * ⚠️ WALKING IS FILTERED OUT HERE, and only here.
     *
     * The reader's rule: keep collecting walking, do not put it on the site.
     * Putting the filter at the publish step rather than on the phone means the
     * raw store still holds every walk — so the decision is one line to reverse
     * instead of a re-sync from a device that may not have the history any more.
     */
    sessions: sessions.filter((s) => s.type !== 'WALKING'),
    ridingNow,
    totals: {
      stepsToday: latest?.steps ?? null,
      steps7d: windowSum(sorted, end, 7, 'steps'),
      steps30d: windowSum(sorted, end, 30, 'steps'),
      calories7d: Math.round(windowSum(sorted, end, 7, 'calories')),
      // ⚠️ Reported next to `calories7d`, never instead of it. The two differ by
      // roughly the basal rate, and a reader comparing them against Samsung
      // Health will find one of them "wrong" unless both are named.
      activeCalories7d: Math.round(windowSum(sorted, end, 7, 'activeCalories')),
      distance7dKm: Math.round(windowSum(sorted, end, 7, 'distanceM') / 100) / 10,
      sleep7dHours: Math.round((windowSum(sorted, end, 7, 'sleepSeconds') / 3600) * 10) / 10,
      // ⚠️ Averages over DAYS THAT HAVE THE METRIC, not over all days. Dividing
      // resting heart rate by 30 when only 4 days recorded it produces a number
      // that is both wrong and unremarkable-looking.
      restingHr7d: avg('restingHr', 7),
      hrv7d: avg('hrvMs', 7),
      spo2_7d: avg('spo2Pct', 7),
      weightKgLatest: (() => {
        for (let i = sorted.length - 1; i >= 0; i -= 1) {
          const w = sorted[i]?.weightKg;
          if (typeof w === 'number') return w;
        }
        return null;
      })(),
    },
  };
}

export type HealthIndex = ReturnType<typeof buildHealthIndex>;

// ─────────────────────────────────────────────────────────────
// Encryption, so the published file is not readable
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️ Why the index is encrypted before it is published.
 *
 * `cevtuocjw/CEVTUO-Z` is a PUBLIC repository and `gh-pages` is therefore
 * world-readable. That is fine for a reading history by the reader's own
 * decision, and it was fine for health data right up until it was not: on
 * 2026-09-24 an unencrypted `data/chealth/index.json` — steps, heart rate,
 * sleep, blood oxygen, weight, for one identifiable person — sat at a public
 * URL. `paths.contract.ts` refused to compile the page that would have read it,
 * which is the only reason it was noticed within the hour rather than never.
 *
 * ── Why not behind the server, which already has a password
 *
 * The obvious fix is to stop publishing and serve the index from the Aliyun box
 * instead. It is worse, for a reason that has nothing to do with passwords:
 * **that box has no HTTPS.** Binding a domain there needs an ICP filing the
 * account holder has to submit in person, so it serves plain HTTP on a bare IP
 * (see `README.md`). Health data behind a password over plain HTTP is readable
 * by anyone on the path — a café network, an ISP — *and so is the password*.
 * GitHub Pages, for all its publicity, is HTTPS.
 *
 * ── So: keep the public, encrypted transport, and put the secrecy in the file
 *
 * AES-GCM under a key derived from a passphrase. The ciphertext goes to the
 * public CDN. Anyone who finds the URL gets noise. The passphrase lives in the
 * server's `.env` and in the reader's browser, and never travels in a URL.
 *
 * ⚠️ What this does NOT protect against, stated plainly so it is not mistaken
 * for more than it is:
 *
 *   · Anyone with root on the Aliyun box — they hold the passphrase and the
 *     plaintext merged file. They already did; this changes nothing there.
 *   · Anyone on the network path between the phone and that box — the POST is
 *     plain HTTP. Unchanged, and unchanged by design.
 *
 * ⚠️ And the honest reason it is worth doing anyway: it removes the failure
 * mode that actually happened. Nothing about today's leak involved an attacker
 * with root anywhere. It involved a file at a public URL.
 */
export interface SealedIndex {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/**
 * ⚠️ 200k iterations, and the number is written INTO the file rather than
 * assumed. A future build that raises it must stay able to read what older
 * builds wrote, and the reader's browser has to derive the same key from the
 * same inputs.
 */
const PBKDF2_ITERATIONS = 200_000;

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function sealIndex(plaintext: string, passphrase: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // ⚠️ A fresh IV every time. Reusing an IV under the same key is the one
  // mistake AES-GCM does not survive.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const sealed: SealedIndex = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
  return JSON.stringify(sealed, null, 2);
}

/**
 * The index as it should be PUBLISHED — sealed, or `null` when there is
 * nothing worth publishing.
 *
 * ⚠️ Returns `null` rather than plaintext when no passphrase is configured.
 * A deployment that forgets the variable must end up with nothing published,
 * never with an unencrypted index. Same shape as `CEVTUO_ADMIN_PASSWORD`:
 * forgetting to set a secret should fail closed.
 */
export async function buildSealedIndexFromStore(
  store: HealthStore,
  passphrase: string | null,
): Promise<{ sealed: string } | { skipped: string }> {
  if (!passphrase) return { skipped: '没有 CEVTUO_HEALTH_PASSPHRASE，不发布（明文绝不发布）' };
  const plain = await buildIndexFromStore(store);
  if (!plain) return { skipped: '还没有可发布的数据' };
  return { sealed: await sealIndex(plain, passphrase) };
}

/**
 * The published index, built from the MERGED store.
 *
 * ⚠️⚠️ Takes only the store — no payload argument, and that signature is the
 * point. The temptation is to build the index from the request body, which is
 * right there and already parsed. It is also a 30-day window: doing that makes
 * the site forget everything older on every sync, which is the exact failure
 * the merge exists to prevent, reintroduced one layer up where it is much
 * harder to see. A function that cannot be handed the window cannot make that
 * mistake.
 *
 * Returns `null` when there is nothing to publish, which the caller must treat
 * as "leave the site alone" rather than "publish an empty index".
 */
export async function buildIndexFromStore(store: HealthStore): Promise<string | null> {
  const text = await store.readMerged();
  if (!text) return null;
  try {
    const p = HealthRawSchema.safeParse(JSON.parse(text));
    if (!p.success) return null;
    // ⚠️⚠️ 参数要和 `server.ts` 里那一处**一模一样**。2026-09-24 我加了
    //    sessions/ridingNow 之后只改了 server.ts 那一处，忘了这里 ——
    //    结果手机明明发了 58 条会话（56 走路 + 1 跑步 + 1 骑行），
    //    发布出去的 index 里 `sessions` 是空的，而**没有任何报错**：
    //    两个调用点都是合法的，只是其中一个少传了两个可选参数。
    //    这就是「构建通过什么都说明不了」的又一个实例 —— 类型检查不会
    //    抱怨「你少传了一个有默认值的参数」。
    return JSON.stringify(
      buildHealthIndex(
        p.data.days, p.data.device, p.data.appVersion, p.data.origins,
        p.data.sessions ?? [], p.data.ridingNow ?? false,
      ),
      null,
      2,
    );
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────

export interface HealthEnv {
  /**
   * ⚠️ A SEPARATE token from `CEVTUO_DEVICE_TOKEN`.
   *
   * Both devices are equally readable — the plugin is plain Lua on a mounted
   * partition, the APK is a zip anyone can unzip. What separation buys is that
   * neither device can write the other's data: a leaked Kindle token cannot
   * invent a step count, and a leaked health token cannot rewrite the library.
   * Blast radius, not secrecy.
   */
  healthToken: string;
  maxBytes: number;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isHealthAuthorized(env: HealthEnv, authHeader: string | null): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  return constantTimeEqual(authHeader.slice(7), env.healthToken);
}

export interface HealthIngestResult {
  status: number;
  body: {
    ok: boolean;
    status: 'committed' | 'unchanged' | 'rejected';
    message: string;
    /** Days now on the server, after the merge. Lets the phone show real state. */
    totalDays?: number;
    changedDates?: number;
  };
}

export async function handleHealthIngest(
  env: HealthEnv,
  store: HealthStore,
  authHeader: string | null,
  rawBody: string,
): Promise<HealthIngestResult> {
  const reject = (message: string, status = 400): HealthIngestResult => ({
    status,
    body: { ok: false, status: 'rejected', message },
  });

  if (!isHealthAuthorized(env, authHeader)) return reject('凭据不对', 401);

  // ⚠️ Bytes, not characters. A 400-day payload is ASCII today, but the moment
  // one device name carries a CJK character the two stop agreeing and a limit
  // "in characters" stops matching what the socket actually received.
  if (Buffer.byteLength(rawBody, 'utf8') > env.maxBytes) return reject('数据太大', 413);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return reject('不是合法 JSON');
  }

  const parsed = HealthRawSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return reject(`格式不对：${first?.path.join('.')} ${first?.message ?? ''}`.trim());
  }
  const payload = parsed.data;

  let storedSessions: HealthSession[] = [];
  const storedText = await store.readMerged();
  let storedDays: HealthDay[] = [];
  if (storedText) {
    try {
      const s = HealthRawSchema.safeParse(JSON.parse(storedText));
      // ⚠️ A corrupted store must not block the push. The phone is holding 14
      // days of real data and this is the only moment it is on the wire; losing
      // it to protect a file we cannot read is the wrong trade.
      if (s.success) { storedDays = s.data.days; storedSessions = s.data.sessions ?? []; }
    } catch {
      storedDays = [];
    }
  }

  // ⚠️ 解构成 `changed: daysChanged` —— mergeDays 返回的字段名是 changed。
  //    写成 `{ days, daysChanged }` 会静默拿到 undefined（编译期才报），
  //    而线上它会让每一次推送都被判成 unchanged。
  const { days, changed: daysChanged } = mergeDays(storedDays, payload.days);

  // ⚠️⚠️ 运动明细也要参与「变没变」的判断，而且这一条是 2026-09-24 补的 ——
  //    在那之前 `changed` **只看 days**，于是：
  //
  //      · 骑行明细从 0 条变成 3 条        → 服务端回 200「数据没有变化」
  //      · 心率曲线加上去了                → 同上
  //      · 服务端因此什么都不写，raw 文件停在旧版本
  //
  //    ⚠️ 而且它**没有任何症状**：手机收到 200（一个成功码），日志写
  //    "unchanged"（一个正常状态），页面上就是少了那些字段。查了半天
  //    才发现线上 `appVersion` 还是旧的。
  //
  //    这类「回执是成功、数据没动」的错，和 CAPPERR 那次
  //    `handleRebuild` 返回 202 而被判成 200 是同一个形状。
  // ⚠️ 传 `payload.sessions` 本身，**不要** `?? []` —— 见 mergeSessions 的注释：
  //    在这一层把 undefined 折成空数组，就再也分不出「没读到」和「真的没有」了。
  const sessionsMerged = mergeSessions(storedSessions, payload.sessions);

  // ⚠️ 保留期在**合并之后**执行，所以刚收到的那一天永远不会被它自己删掉。
  const pruned = pruneOld(days, sessionsMerged);
  const sessions = pruned.sessions;
  const sessionsChanged = canonicalJson(sessions) !== canonicalJson(storedSessions);

  // ⚠️ 顺序也参与 —— 数组顺序变了就是变了，即使内容集合相同。
  const daysPruned = pruned.droppedDays > 0 || (pruned.days.length !== days.length);
  const finalDays = pruned.days;
  const changed = daysChanged || sessionsChanged || daysPruned;

  // ⚠️ 删了什么必须喊出来。见 pruneOld 的注释。
  if (pruned.droppedDays > 0 || pruned.droppedSessions > 0) {
    console.log(
      `[chealth:prune] 保留 ${RETENTION_DAYS} 天（截至 ${pruned.cutoff}）：` +
      `删 ${pruned.droppedDays} 天 / ${pruned.droppedSessions} 条运动`,
    );
  }

  const merged: HealthRaw = {
    schemaVersion: 1,
    device: payload.device,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    // ⚠️ Taken wholesale from the newest payload, never merged across pushes.
    // It describes the phone's CURRENT sources; a union of old and new would
    // report a source that was uninstalled months ago as still writing.
    origins: payload.origins,
    ridingNow: payload.ridingNow,
    // ⚠️ Keyed by `start`, incoming wins. A session's enrichment is computed
    // once but a re-push may add fields that were missing the first time (the
    // watch synced later). Replacing wholesale keeps the newest, most complete
    // version; unioning field-by-field would resurrect values the phone has
    // since corrected.
    sessions,
    days: finalDays,
  };

  // ⚠️ The heartbeat moves even when the data did not — same rule as CAPPERR,
  // and for the same reason: "the phone reached us" and "the numbers moved" are
  // two different questions, and the reader can only see the second one in the
  // data. Without this, a working sync looks exactly like a broken one.
  await store.writeHeartbeat(localStamp());

  if (!changed) {
    return {
      status: 200,
      body: {
        ok: true,
        status: 'unchanged',
        message: '已收到，数据没有变化',
        totalDays: days.length,
        changedDates: 0,
      },
    };
  }

  await store.writeMerged(JSON.stringify(merged, null, 2));
  await store.writeRaw(rawBody);

  return {
    status: 202,
    body: {
      ok: true,
      status: 'committed',
      message: `已合并 ${payload.days.length} 天，累计 ${days.length} 天`,
      totalDays: days.length,
      changedDates: payload.days.length,
    },
  };
}
