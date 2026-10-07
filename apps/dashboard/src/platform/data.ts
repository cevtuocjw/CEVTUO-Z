/**
 * Data client — where payloads come from, per platform.
 *
 * ⚠️ The pipeline writes **origin-relative** paths on purpose
 * (`data/coof/posters/<id>.jpg`, see `packages/schema/src/paths.ts`). The origin
 * is a deployment decision, not a data decision, so it is resolved HERE and
 * nowhere else. Changing hosts means changing one constant.
 *
 * ⚠️ The mini-program cannot fetch from GitHub Pages — WeChat requires every
 * request domain to be ICP-filed, and Pages is not. Until the mainland server is
 * filed and serving, the mini-program must read from that server's domain.
 */

// App-local copy of the shared path contract — see ./paths.ts for why it is
// not imported, and ./paths.contract.ts for the guard that keeps them in sync.
import { tv } from '../platform/prefs';
import { cdnImage } from './cdn';
import { DATA_PATHS } from './paths';
import { openSealed } from './health-crypto';

// ⚠️ `import type` is load-bearing: it is erased at compile time, so zod's
// ~60KB runtime never reaches the bundle. Only the inferred TYPES come across.
// (The schema package documents this as the app's intended usage.)
import type {
  CoofCollection,
  CoofIndex,
  CoofLibrary,
  CoofTitle,
  CnsrEntry,
  CnsrLine,
  CnsrSource,
  CnsrSourcesIndex,
  PaperrBook,
  PaperrIndex,
  SyncMeta,
} from '../../../../packages/schema/src/index';

/**
 * Deployed origin — the mini-program's request base and the last-resort fallback.
 *
 * ⚠️ `z.cevtuogrnd.com` as of 2026-09-28: the dashboard moved off
 * `apps.cevtuogrnd.com/CEVTUO-Z/` onto a short domain of its own. A project
 * site that declares a custom domain is served at that domain's ROOT — the
 * `/CEVTUO-Z/` path is gone (a redirect stub is parked at the old address).
 * Before that it was `apps.cevtuogrnd.com` — see the CNAME note further down.
 *
 * ⚠️ `https://` as of 2026-09-28. It was `http://` before that, on the stated
 * grounds that `apps.cevtuogrnd.com` had no certificate and "the HTTPS URL does
 * not serve this site at all".
 *
 * **That premise is gone.** The certificate was issued that day — the blocker
 * turned out to be a CNAME file in this repo's gh-pages competing with the user
 * site for the same domain, not the domain being misconfigured — and the site
 * now 301s every http request to https. Left at `http://`, this fallback would
 * send a request to a plain-HTTP URL from a page that is itself https, which the
 * browser kills as mixed content before it reaches the network.
 *
 * ⚠️ `z.cevtuogrnd.com` was the name in the project docs. It has no DNS record.
 *
 * ⚠️ The mini-program still cannot use this: WeChat requires an ICP-filed
 * request domain, and Pages never is. But https is a precondition for that
 * anyway, so this is the value to have in place rather than `http://`.
 */
const PROD_ORIGIN = 'https://z.cevtuogrnd.com';

/**
 * Data origin.
 *
 * ⚠️ Resolved per platform, NOT hardcoded, because the same bundle runs in four
 * places with four different answers. Hardcoding production here is what made
 * the first local build fetch `apps.cevtuogrnd.com` and fail with a bare
 * "Failed to fetch" while the network log showed a perfectly good 200 for the
 * same data on localhost.
 *
 * ⚠️ The mini-program branch is still unresolved: WeChat requires request
 * domains to be ICP-filed, and Pages never is. Until the filed mainland server
 * is serving, the mini-program has no valid origin — see docs/HOSTING.md.
 */
function base(): string {
  // ⚠️ There is deliberately NO `process.env.TARO_APP_DATA_ORIGIN` override here.
  //
  // Webpack does not define `process` in this build. Reading `process.env.X`
  // throws `process is not defined` at RUNTIME — not at build time, so the
  // compiler and the bundler both stay quiet and the page just dies. A staging
  // override would have to be threaded through Taro's `defineConstants`; until
  // something actually needs it, an override that only ever breaks is worse
  // than no override.

  // 1. H5 / Android WebView: the mount directory, because `data/` is deployed as
  //    a SIBLING of the app bundle, not at the origin root.
  //
  //    ⚠️ The mount directory, NOT `location.origin`. The build uses a relative
  //    `publicPath` so it can be served from any subdirectory (see
  //    config/index.ts). `origin` alone produced `http://host/data/...`, which
  //    404s whenever the app is not at the root — the error state rendered and
  //    the network tab showed a clean 404 for a path that visibly exists one
  //    directory down. Taking the pathname's own directory keeps the two
  //    consistent: whatever depth the HTML loaded from is the depth `data/` is
  //    at.
  //
  //    The H5 router is hash-based, so the pathname never changes between
  //    routes and this stays stable mid-navigation.
  //
  // ⚠️ This check MUST come before the mini-program check, and must not be
  //    written as `process.env.TARO_ENV === 'weapp'`.
  //
  //    Webpack does not define `process.env` in this build — reading it threw
  //    `process is undefined` at runtime — so the env comparison never matched,
  //    fell through, and returned PROD_ORIGIN. The resulting silent failure was
  //    a page that fetched the production host from localhost and rendered
  //    "加载失败: Failed to fetch" while the local server logged a clean 200 for
  //    the identical URL. Feature-detecting the runtime is both simpler and
  //    immune to whatever the bundler chooses to inline.
  /*
   * ⚠️⚠️ **"这是不是网页"的判据，只能拿实测出来的那个差别（2026-10-07）。**
   *
   * 试过两个都**不行**的判据：
   *   · `typeof location !== 'undefined'` —— 小程序里 Taro 垫了一个 `location`（带 origin）；
   *   · `typeof document !== 'undefined'` —— 小程序里 Taro 也实现了自己的 DOM。
   *   两个都会把小程序误判成网页 ⇒ 返回 `''` ⇒ `assetUrl` 给出**相对路径**
   *   `/data/paperr/index.json` ⇒ `wx.request` 只收绝对 URL，直接回
   *       request:fail invalid url "/data/paperr/index.json"
   *   ⇒ **小程序上所有数据静默为空**（页面照样渲染，只是每块都停在「读取中…」）。
   *
   * ✅ 探针在真模拟器里量到的差别只有一个：**`fetch` 存在与否**。
   *    所以判据就是它 —— 网页有 `fetch`，小程序只有 `wx.request`。
   *    ⚠️ 这条和上面 `httpGet` 选路用的是**同一个事实**，改一处要改两处。
   */
  const isMini = typeof fetch !== 'function';
  if (!isMini && typeof location !== 'undefined' && location.origin) {
    /*
     * ⚠️⚠️ **`''`（根），不再是"按 pathname 去掉最后一段"。**
     *
     * 原来那行 `/z/index.html` → `/z`、`/` → `''` 在 **hash 路由**下是对的：
     * pathname 永远停在挂载点（`/z/index.html`），路由住在 `#` 里。
     *
     * 但 2026-10-07 路由改成了 browser ⇒ **pathname 就是路由本身** ⇒
     * 在 `/pages/home/index` 上它算出 `/pages/home`，于是
     * `assetUrl('static/fonts/…')` 变成 `/pages/home/static/fonts/…` ⇒ **404**。
     * 实测到的症状：字标回落成系统字体、画廊图全裂，而**页面看上去正常**。
     *
     * 现在 `publicPath` 是 `/`（见 `config/index.ts` 那段），站点**根挂载** ——
     * 三处生产入口（`z.cevtuo.com` / `z.cevtuogrnd.com` / 国内镜像 `ROOT`）
     * 本来也都是根。所以基准就是 `''`，调用方那个前导斜杠负责分隔符。
     */
    return '';
  }

  // 3. Mini-program: no DOM, so no location. This origin is still wrong — pages
  //    is unusable there anyway (WeChat requires ICP-filed request domains) —
  //    see docs/HOSTING.md.
  return PROD_ORIGIN;
}

export const assetUrl = (relPath: string): string =>
  `${base()}/${relPath.replace(/^\/+/, '')}`;

/**
 * 图片专用：能走国内镜像就走（判据在 `platform/cdn.ts`，**只有那一份**）。
 * ⚠️ 这个文件里的 `assetUrl` 和 `platform/background.ts` 里那份是**两份实现**，
 *    所以判据必须是共用的 —— 复制进两份就一定会改一处漏一处。
 */
export const imageUrl = (relPath: string): string =>
  cdnImage(relPath) ?? assetUrl(relPath);

/**
 * Payload shapes are **re-exported from the schema**, not re-declared.
 *
 * ⚠️ These used to be hand-written `interface`s here, and they drifted: this
 * file declared `collections: string[]` while the pipeline writes an array of
 * `{ name, count, latestAt, path }` objects. TypeScript was happy, the build was
 * happy, and the COOF page died at runtime with
 * `TypeError: t.localeCompare is not a function` inside `calendarKeys` — a
 * blank screen with no build error to explain it.
 *
 * Deriving them means the app cannot describe a payload differently from the
 * code that produces it. `import type` keeps zod out of the bundle.
 */
export type {
  CoofCollection,
  CoofIndex,
  CoofLibrary,
  CoofTitle,
  CnsrEntry,
  CnsrLine,
  CnsrSource,
  CnsrSourcesIndex,
  PaperrBook,
  PaperrIndex,
  SyncMeta,
};

/**
 * ── ⚠️⚠️ **小程序里没有 `fetch`（2026-10-07 实测）** ─────────────────
 *
 * 探针实测（在真模拟器里弹 modal 读出来的）：`fetch = undefined`、
 * `wx.request = function`。
 *
 * 本文件原来断言「`fetch` 在小程序基础库 ≥2.18 上是原生的」——**那条是错的**。
 * 它的后果**不是报错**，而是每个数据块**静默地**停在「读取中…」/「—」：
 * 列表空着、UO 面板永远读取中、CHEALTH 解不开 —— 而页面**看上去完全正常**
 * （骨架、分区标题、导航条都在）。
 *
 * ⚠️ 为什么不直接换成 `Taro.request`：下面 `getJson` 那段注释记着，
 *    H5 上它要求 window 上有全局 `Taro`，而本构建没有 ⇒ 每次调用都抛。
 * ⇒ 所以是**按能力选路**，不是二选一。
 */
type MiniRequest = (o: {
  url: string;
  method?: string;
  header?: Record<string, string>;
  success?: (r: { statusCode: number; data: unknown }) => void;
  fail?: (e: { errMsg?: string }) => void;
}) => void;

/** `fetch` 的响应里我们真正用到的那一小块。 */
interface Reply {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

async function httpGet(url: string, init?: RequestInit): Promise<Reply> {
  if (typeof fetch === 'function') {
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() };
  }

  const wx = (globalThis as unknown as { wx?: { request?: MiniRequest } }).wx;
  if (!wx?.request) throw new Error('no fetch and no wx.request in this runtime');

  return new Promise<Reply>((resolve, reject) => {
    wx.request!({
      url,
      method: 'GET',
      success: (r) => {
        resolve({
          ok: r.statusCode >= 200 && r.statusCode < 300,
          status: r.statusCode,
          json: async () => r.data,
          // ⚠️ `wx.request` 会**自动**把 JSON 解析成对象 ⇒ `text()` 得能反着
          //    序列化回去（CHEALTH 那条走 `text()` 再解密）。
          text: async () => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)),
        });
      },
      fail: (e) => reject(new Error(e.errMsg || 'wx.request failed')),
    });
  });
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = assetUrl(path);

  // ⚠️ `Taro.request` is deliberately NOT used here.
  //
  // On H5 it resolves through Taro's request adapter, which requires the global
  // `Taro` to be present on `window`; in this build it is not, so every call
  // throws `Cannot read properties of undefined (reading 'request')` and the page
  // renders "加载失败: Failed to fetch" while the network shows a clean 200.
  //
  // ⚠️⚠️ **下面这句原来的断言是错的**（2026-10-07 在真模拟器里实测推翻）：
  //    原文写「`fetch` 在小程序基础库 ≥2.18 上是原生的」——
  //    实测 `fetch = undefined`、`wx.request = function`。
  //    ⇒ 走 `httpGet`（按能力选路，见上面那个函数）。
  const res = await httpGet(url, init);
  if (!res.ok) {
    throw new Error(tv(`加载失败 HTTP ${res.status}：${path}`, `Load failed HTTP ${res.status}: ${path}`));
  }
  return (await res.json()) as T;
}

/**
 * When the data was last regenerated.
 *
 * ⚠️ `sync-meta.json` is written ONLY on a run that actually changed something
 * (see sync.ts), so this is the last time the data MOVED, not the last time a
 * sync was attempted. That is exactly what "更新于" should mean — a nightly job
 * that changes nothing must not make the page claim it was updated.
 *
 * Optional at every call site: the page is fully usable without it, so a failure
 * leaves the line off rather than showing an error on a page that works.
 */
export const fetchSyncMeta = (): Promise<SyncMeta> => getJson<SyncMeta>(DATA_PATHS.syncMeta);

/**
 * "2026-09-23T10:44+08:00" → "2026-09-23 10:44".
 *
 * ⚠️ Sliced, not `new Date(...).toLocaleString()`. The stamp already carries the
 * project's timezone offset (+08:00); re-parsing and re-formatting would render
 * it in whatever zone the device happens to be in, so a reader in London would
 * see a different "updated at" than the one the pipeline wrote.
 */
export function formatUpdatedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : null;
}

export const fetchCoofIndex = (collection: string): Promise<CoofIndex> =>
  getJson<CoofIndex>(DATA_PATHS.coofIndex(collection));

export const fetchCoofLibrary = (collection: string): Promise<CoofLibrary> =>
  getJson<CoofLibrary>(DATA_PATHS.coofLibrary(collection));

/**
 * The four CNSR sources' freshness record.
 *
 * ⚠️ Small and cheap on purpose — it is fetched first, on its own, because it
 * is what tells the page WHICH sources exist and WHEN each was last synced.
 * The per-source payloads behind it are large (Learn alone is ~4900 lines), so
 * nothing should be fetched until this says there is something to fetch.
 */
/**
 * CE-CAPPERR — the Kindle's reading statistics.
 *
 * ⚠️ One public payload, like every other brand. It was briefly split so that
 * "which book is open right now" stayed behind a password; the reader decided
 * the whole reading dashboard is fine to publish, so the split — and the
 * authenticated second fetch that went with it — is gone.
 */
/**
 * ⚠️⚠️ Fetched with `cache: 'no-store'`, and the first attempt at this was wrong.
 *
 * GitHub Pages serves `data/paperr/index.json` with `Cache-Control: max-age=600`
 * — measured, not assumed. The ingest publishes to that file the moment the
 * Kindle syncs, so a browser that loaded the page recently can sit TEN MINUTES
 * behind a push whose timestamp it is already displaying.
 *
 * ⚠️ And that combination is worse than plain staleness: the freshness line
 * ("设备同步 13:35") comes from the ingest over a connection with no cache
 * headers at all. It updates instantly while the numbers beside it do not. The
 * reader sees "it synced" and "nothing changed" in the same glance, which reads
 * exactly like a broken sync — the thing this whole week has been about.
 *
 * ⚠️ I first added a `?v=<minute>` cache-buster. **GitHub Pages' CDN ignores the
 * query string**: three requests with three different random params all came
 * back `X-Cache: HIT` with the same `Age`. A 404 on a made-up path came back
 * `MISS`, so the headers were real. The param only changed the BROWSER's cache
 * key — which `no-store` does directly, and does not depend on how any CDN
 * happens to be configured.
 *
 * ⚠️ The CDN layer itself is fine: a commit to `gh-pages` — which is exactly
 * what the ingest makes — triggers a build and purges it. Measured at ~45s from
 * publish to a fresh edge copy. The browser was the stale layer.
 */
export const fetchPaperrIndex = (): Promise<PaperrIndex> =>
  getJson<PaperrIndex>(DATA_PATHS.paperrIndex, { cache: 'no-store' });

/**
 * CHEALTH — Samsung Health / Galaxy Watch, via Health Connect on the phone.
 *
 * ⚠️ `cache: 'no-store'` for the same measured reason as the reading index.
 * GitHub Pages serves these at `max-age=600`, and this file is rewritten by the
 * phone's 15-minute worker — so a cached copy would routinely be ten minutes
 * behind a freshness line sitting right next to it.
 */
export interface ChealthOrigin {
  count: number;
  lastAt: string;
}

/**
 * ⚠️ One exercise session. Walking is filtered OUT before it reaches here —
 * see `buildHealthIndex`. When this list is populated, everything in it is
 * something the reader asked to see.
 */
export interface ChealthSession {
  start: string;
  minutes: number;
  /** `BIKING`, `RUNNING`, … Machine name. */
  type: string;
  exerciseType: number;
  title?: string;
  source: string;
  distanceM?: number;
  activeCalories?: number;
  hrAvg?: number;
  hrMax?: number;
  /** ⚠️ Cycling metrics, present only on a ride and only if it came through a
   *  bridge that carried them (Samsung Health does; Strava does not). */
  powerAvg?: number;
  powerMax?: number;
  speedMaxMps?: number;
  cadenceAvg?: number;
  /** ⚠️ `[minutesSinceStart, W]`, ≤120 points. The shape of the ride — an
   *  average cannot distinguish 4 min at 400W + 4 min at 100W from a steady
   *  250W, and those are different workouts. */
  powerSeries?: [number, number][];
  /** ⚠️ `[minutesSinceStart, rpm]`, ≤120 points. */
  cadenceSeries?: [number, number][];
  /** ⚠️ `[minutesSinceStart, m/s]`, ≤120 points. */
  speedSeries?: [number, number][];
  /**
   * ⚠️⚠️ 跳绳的**个数** / 健腹轮的**次数**（读者 2026-09-30 点名要的）。
   *
   *    这是**只有小米有**的一项 —— 三星健康那边根本没有这个字段，
   *    所以它和 `hrAvg` 正好相反：**心率用三星的，个数只能用小米的**。
   *
   *    ⚠️ 它没有单位歧义（就是个计数），但有**口径**问题：
   *      一次「跳绳」小米可能记的是**总次数**也可能只是**最长一组**，
   *      接进来看见明显偏小的值要怀疑这个，而不是怀疑解析。
   */
  count?: number;
  /**
   * ⚠️ **每分钟多少次**。
   *
   *    ⚠️⚠️ 页面上的标签写「平均频率」，因为**这个数常常是我们自己算的**
   *      （`count / minutes`），而设备直接给的那种是**整场的峰值频率**。
   *      两者不是一个东西，混着叫「频率」会让读者以为自己在看同一个量
   *      —— 这个项目为「口径说不清」栽过一次（`speedAvgMps` 被叫成「平均速度」）。
   */
  rateAvg?: number;
  /** ⚠️ 设备直接给的峰值频率（次/分）。没有就不显示，**不要拿 rateAvg 顶上**。 */
  rateMax?: number;
  /** ⚠️ `[minutesSinceStart, 次/分]`，≤120 点。有它才画得出过程曲线。 */
  rateSeries?: [number, number][];
  /** ⚠️ Which app measured the HR — the watch and MyWhoosh disagree, and the
   *  phone deliberately does not average them. */
  hrSource?: string;
  /** ⚠️ `[minutesSinceStart, bpm]`, ≤120 points, peak force-included. */
  hrSeries?: [number, number][];
  /** ⚠️ Every app that recorded part of this session — a ride is routinely two
   *  records merged into one. */
  sources?: string[];
}

export interface ChealthDay {
  date: string;
  steps?: number;
  stepSources?: Record<string, number>;
  distanceM?: number;
  stepsCadenceAvg?: number;
  speedAvgMps?: number;
  speedMaxMps?: number;
  calories?: number;
  activeCalories?: number;
  floors?: number;
  sleepSeconds?: number;
  /**
   * 当天**所有活动**加起来多少分钟 —— 走路 + 运动会话，**不只是走路**。
   *
   * ⚠️ 读者 2026-09-29 明确要求：「活动时间应该是所有的活动时间加起来，
   *    而不是单单的走路」。所以手机端算的是
   *    `并集(有步数的步数记录的时间区间, 运动会话的时间区间)`。
   *
   * ⚠️ 这不是 Health Connect 里的一个字段 —— 那边**没有**「活动时长」这种
   *    记录类型，三星那个数是它自己算的。所以这一项是手机端派生的，
   *    历史数据要等手机端补上之后才会出现。
   */
  activeMinutes?: number;
  hrAvg?: number;
  hrMax?: number;
  restingHr?: number;
  hrvMs?: number;
  spo2Pct?: number;
  respRate?: number;
  weightKg?: number;
  exerciseCount?: number;
  /**
   * ⚠️ 2026-10-02 接上三星 SDK 之后新增的一批。
   *    ⚠️ 服务端 `DaySchema` 是**唯一**的准绳 —— `z.object` 会静默丢掉
   *      没列在那里的键，所以这里少写一个，症状是「手机推了、页面上是 undefined」，
   *      两边都不报错。
   */
  bodyFatPct?: number;
  skeletalMuscleKg?: number;
  bmi?: number;
  basalKcal?: number;
  energyScore?: number;
  skinTempC?: number;
  /** ⚠️ 体温（不是 `skinTempC` 皮肤温度）—— 先量覆盖，0 天就不做界面。 */
  bodyTempC?: number;
  /**
   * **睡眠分期** —— `[[距入睡第几分钟, 持续几分钟, 'AWAKE'|'LIGHT'|'DEEP'|'REM'|'UNDEFINED'], …]`。
   *
   * ⚠️ 三星睡眠页的主角。我们此前只有 `sleepSeconds` 一个总数，
   *    而「一夜之间深浅几轮」是另一个东西，只能从分段画出来。
   * ⚠️ 相对分钟不是时间戳：跨午夜的一夜用绝对时间画，横轴会从 23:12 跳回 00:05。
   */
  sleepStages?: [number, number, string][];
  sleepStart?: string;
  sleepEnd?: string;
  sleepScore?: number;
  /** 各段之和（分钟）。和 `sleepSeconds` 对不上就说明有段没读全。 */
  sleepStageCoveredMin?: number;
  /**
   * ⚠️ **读者自己在三星健康里设的目标**，不是我们定的。
   *    手机端把「当前设定」挂在**最新那一天**上（见 `SamsungDaily.dailyTotals`）。
   *    读的时候要取「最后一个有它的那天」，不是取今天 —— 今天可能还没同步。
   */
  stepsGoal?: number;
  activeKcalGoal?: number;
  activeMinutesGoal?: number;
  waterGoalL?: number;
  /** `"23:30"` 这种，不带秒。 */
  bedTime?: string;
  wakeTime?: string;
}

export interface ChealthIndex {
  schemaVersion: number;
  updatedAt: string;
  device: string;
  appVersion: string | null;
  from: string | null;
  to: string | null;
  dayCount: number;
  days: ChealthDay[];
  /** ⚠️ Non-walking only, already deduplicated and overlap-merged on the phone. */
  sessions: ChealthSession[];
  /** ⚠️ `false` means "not detected", never "definitely not riding" — it is
   *  `false` whenever the usage-access permission is missing. Render accordingly. */
  ridingNow: boolean;
  /**
   * ⚠️ **手机自己的状态**（电量/充电/网络）+ 它上报的时刻。
   *    来自手机端 `SyncWorker.deviceStatus()` —— **不走 Health Connect**。
   *    ⚠️ 老索引里没有这个键（2026-10-05 才加）⇒ 一律按可选处理，
   *      读不到就显示「—」，**不要编一个数**。
   */
  deviceStatus?: {
    batteryPct?: number;
    charging?: boolean;
    net?: string;
    at?: string;
    /**
     * ⚠️ 手表电量 —— 三星的健康 SDK **不提供**（`javap` 读过 aar，`Device` 里
     *    没有 battery 字段）。手机端改走 `BluetoothDevice.getBatteryLevel()`
     *    （手机跟手表是配对的蓝牙设备）。拿不到就是 `undefined`，
     *    界面写「—」——**不编一个数**。
     */
    watchBatteryPct?: number;
  } | null;
  origins: Record<string, ChealthOrigin>;
  totals: {
    stepsToday: number | null;
    steps7d: number;
    steps30d: number;
    calories7d: number;
    /**
     * ⚠️ Shown beside `calories7d`, never merged into it. `calories7d` includes
     * basal metabolic rate (~1662/day, constant, even on days with no data), so
     * on its own it is a flat line that reads as a broken sensor.
     */
    activeCalories7d: number;
    distance7dKm: number;
    sleep7dHours: number;
    restingHr7d: number | null;
    hrv7d: number | null;
    spo2_7d: number | null;
    weightKgLatest: number | null;
    /**
     * ⚠️ 2026-10-02 接上 **Samsung Health Data SDK** 之后新增的三项。
     *
     *    ⚠️ 它们**不是「换了个来源」**，是 Health Connect 那条路上**取不到**的量：
     *      `floors`（楼层）在 HC 里 0/31 天、皮温同样 0/31，
     *      而「活力分数」是三星自己的算法（掺了睡眠阶段、HRV、血氧、呼吸），
     *      HC 里根本没有这个概念。实测接入后有数了：2 / 2 / 1 天。
     *
     * ⚠️ 天数很少是**真的少**（读者很少量皮温、也不天天看活力分数），
     *    所以页面上经常是 `—` —— 那是诚实，别拿别的量去填。
     *    ⚠️ `floors7d` 是**合计**，另两个是**均值**：楼层是计数，加总才有意义。
     */
    floors7d: number;
    skinTemp7d: number | null;
    energy7d: number | null;
  };
}

/**
 * ⚠️⚠️ NOT WIRED, ON PURPOSE. Read this before connecting it.
 *
 * The obvious implementation is `getJson(DATA_PATHS.chealthIndex)` against
 * `gh-pages`, matching how the other three brands work. That is what was tried
 * on 2026-09-24, and `paths.contract.ts` refused to compile — which is the
 * guard doing its job. `packages/schema/src/paths.ts` has always declared this
 * path as `api/chealth/index.json`, i.e. behind the service, not the CDN.
 *
 * ⚠️ The reason is concrete and recorded in the page's own history: GitHub
 * Pages is world-readable even for a private repository, so step counts, heart
 * rate and sleep for one identifiable person would be readable by anyone with
 * the URL. That is a decision with an owner, and it is not a side effect a
 * pipeline gets to make on the way past.
 *
 * ⚠️ Which leaves the real design question, and it has no free answer: an
 * authenticated fetch from a browser bundle needs the credential IN the bundle,
 * and the bundle is plain JavaScript. The options are (a) publish, accepted
 * knowingly, (b) a token in the bundle, which is a lock with the key taped to
 * it, or (c) serve the page itself behind Basic auth like the admin screen.
 */
/**
 * ⚠️ Fetched from the PUBLIC CDN, because the file there is ciphertext. The
 * plaintext never touches a network this code controls.
 */
export async function fetchChealthIndex(passphrase: string): Promise<ChealthIndex> {
  // ⚠️⚠️ `cache: 'no-store'` —— 而且这条是**补的**，2026-09-24 踩了同一个坑第二次。
  //
  // 第一版写的是 `fetch(url + '?t=' + Date.now())`，一个「破除缓存」的查询串。
  // **GitHub Pages 的 CDN 忽略查询串** —— 这一点在 paperr 那边早就量过并写进了
  // `fetchPaperrIndex` 的注释，而我没有把它带过来。结果：页面一直读着十分钟前的
  // 旧索引，运动明细那一块显示「最近 30 天没有非走路的运动记录」——
  // 一个**看起来完全正常的空状态**，而服务器上三条骑行好好躺着。
  //
  // 教训不是「记得加 no-store」，是**同一个项目里已经付过学费的结论要跟着新代码走**。
  /*
   * ⚠️⚠️ **必须过 `assetUrl`，不能直接把那个相对路径丢给 `fetch`。**
   *
   * 2026-10-07 路由从 hash 改成 browser 之后实测到的：相对 URL 解析的基准是
   * **文档地址**，而在 `/pages/home/index` 上 `'data/chealth/index.json'`
   * 变成了 `/pages/home/data/chealth/index.json` ⇒ **404**。
   *
   * 它在 hash 时代一直是对的，因为那时 `location.pathname` 永远停在挂载点
   * （`/` 或 `/z/index.html`）—— 也就是说这条 bug **一直都在**，只是被
   * "pathname 不会变"这个前提盖住了。
   *
   * ⚠️ 用 `assetUrl`（**不是** `imageUrl`）：`data/` 必须走本地、绝不改写到 CDN，
   *    判据在 `platform/cdn.ts` 那三条里写着，新鲜度靠这个。
   */
  const res = await httpGet(assetUrl(DATA_PATHS.chealthSealed), { cache: 'no-store' });
  if (!res.ok) throw new Error(tv(`读不到加密索引 HTTP ${res.status}`, `Cannot read sealed index HTTP ${res.status}`));
  // ⚠️ openSealed 现在是**同步**的（纯 JS，不用 WebCrypto）——
  //    见 health-crypto.ts 顶部那段：站点没有 HTTPS，crypto.subtle 是 undefined。
  const plain = openSealed(await res.text(), passphrase);
  return JSON.parse(plain) as ChealthIndex;
}

export interface ChealthHeartbeat {
  /** When the phone last reached the ingest server — not when data changed. */
  lastPushAt: string | null;
  dayCount: number;
  to: string | null;
}

/**
 * ⚠️⚠️ HTTPS, and on port 8443 — the host in one place on purpose.
 *
 * These were `http://120.77.27.128:8789` until 2026-09-28. That address still
 * answers, and it is still what the phone and the Kindle POST to, so it is
 * tempting to leave alone. It cannot be: an HTTPS page fetching a plain-HTTP
 * subresource is killed by **mixed-content blocking**, which happens in the
 * browser before CORS is ever consulted.
 *
 * Measured with Playwright on 2026-09-28, driving a real HTTPS page:
 *
 *     fetch('http://120.77.27.128:8789/…')  →  requestfailed: mixed-content
 *
 * ⚠️ And that failure is INVISIBLE here. Both `fetchChealthHeartbeat` and
 * `fetchPaperrHeartbeat` catch everything and return `null` — deliberately, so
 * that a diagnostic being down cannot break a page — so the symptom would have
 * been one dash mark, no console error the reader would ever see, and a
 * deployment that looks correct. Enabling HTTPS on the site without moving
 * these two lines first would have silently deleted both heartbeats.
 *
 * ⚠️ 8443 and not 443: Aliyun only serves 80/443 for domains that carry an ICP
 * filing, and `api.cevtuogrnd.com` has none yet. The certificate is valid on
 * any port. This moves to 443 the day the filing lands.
 *
 * ⚠️ The host lives in one constant because it drifted across four separate
 * literals once already — including a fifth copy inside
 * `scripts/verify-paperr-ui.mjs`, which is why that suite asserts against the
 * page's own network traffic rather than a URL typed out again.
 *
 * ⚠️⚠️ **2026-10-05：备案落地了，所以搬了 —— 见下面那段。**
 */
export const INGEST_ORIGIN = (() => {
  // ⚠️ 心跳现在**走备案域名 `z.cevtuo.com`**（备案 / 443 / 深圳）。
  //
  // 原来钉死在 `https://api.cevtuogrnd.com:8443`（一张没备案的证书 + 非标准端口）。
  // 小程序要求**所有请求域名都备案 + 443**，接口留在旧域名上将来一定会被微信拒。
  //
  // ⭐ **按页面所在的主机选 base，优先同源**：
  //   · **镜像**（`z.cevtuo.com`，以及直接打 IP 的 8081/8082/443）**自己就把
  //     `/api/*` 反代到接入服务 8789**（见 `scripts/mirror-server.mjs`）⇒
  //     **同源 ⇒ 一次跨域都没有，也就压根不经过 `ALLOWED_ORIGINS` 那张表。**
  //     这是有代价才学到的：跨域那一跳的代理**必须转发 `Origin`**，漏了就是
  //     **静默**丢掉 CORS 头、页面上只显示一个「—」（通用纪律 14）。
  //   · **GitHub Pages**（`z.cevtuogrnd.com` / `*.github.io`）是别人的静态主机，
  //     **没有 `/api` 代理** ⇒ 退回 `https://z.cevtuo.com`；跨域那一跳由
  //     `ALLOWED_ORIGINS` 放行（两个域名都在表里）。
  //   · 小程序里没有 `location` ⇒ 直接给绝对域名（备案 + 443）。
  if (typeof location === 'undefined') return 'https://z.cevtuo.com';
  const host = location.hostname;
  if (host === 'z.cevtuo.com' || host === '120.77.27.128') return location.origin;
  return 'https://z.cevtuo.com';
})();

export const CHEALTH_HEARTBEAT_URL = `${INGEST_ORIGIN}/api/chealth/heartbeat.json`;

/** ⚠️ Never throws. A page that breaks because a diagnostic is unreachable is
 *  worse than one that shows a dash — same rule as the reading heartbeat. */
export async function fetchChealthHeartbeat(): Promise<ChealthHeartbeat | null> {
  try {
    const res = await httpGet(CHEALTH_HEARTBEAT_URL);
    if (!res.ok) return null;
    return (await res.json()) as ChealthHeartbeat;
  } catch {
    return null;
  }
}

/**
 * When the Kindle last reached the ingest server.
 *
 * ⚠️ This is the ONLY thing on the page that comes from the Aliyun box rather
 * than from the CDN, and it has to: "the device talked to us" is a fact only the
 * machine that received the push knows. The published index cannot carry it —
 * it changes on every push, which is a commit every 30 minutes.
 *
 * ⚠️ Failure is expected and must stay silent. The server being down is a real
 * possibility, and a page that breaks because a diagnostic is unavailable is
 * worse than one that shows a dash.
 */
export interface PaperrHeartbeat {
  lastPushAt: string | null;
  lastChangeAt: string | null;
  pluginVersion: string | null;
  books: number;
}

// ⚠️ Same host as the health one above, and for the same mixed-content reason.
export const PARRER_HEARTBEAT_URL = `${INGEST_ORIGIN}/api/paperr/heartbeat.json`;

export async function fetchPaperrHeartbeat(): Promise<PaperrHeartbeat | null> {
  try {
    const res = await httpGet(PARRER_HEARTBEAT_URL);
    if (!res.ok) return null;
    return (await res.json()) as PaperrHeartbeat;
  } catch {
    return null;
  }
}

/** Reading time, at the precision a dashboard actually needs. */
export function formatReadingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const hours = seconds / 3600;
  if (hours >= 100) return `${Math.round(hours)}h`;
  if (hours >= 10) return `${hours.toFixed(1)}h`;
  if (hours >= 1) return `${hours.toFixed(2)}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

/** `"2026-09-24T09:14+08:00"` → `"09-24"`. Sliced, never parsed: the offset is
 *  already the device's own, and `new Date()` would re-interpret it in the
 *  viewer's timezone and shift the day for anyone reading from abroad. */
export const formatDayMonth = (iso: string): string => iso.slice(5, 10);

/** How long ago, in the loosest useful unit. */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return tv("今天", "Today");
  if (days === 1) return tv("昨天", "Yesterday");
  if (days < 30) return tv(`${days} 天前`, `${days} days ago`);
  if (days < 365) return tv(`${Math.floor(days / 30)} 个月前`, `${Math.floor(days / 30)} months ago`);
  return tv(`${Math.floor(days / 365)} 年前`, `${Math.floor(days / 365)} years ago`);
}

export const fetchCnsrIndex = (): Promise<CnsrSourcesIndex> =>
  getJson<CnsrSourcesIndex>(DATA_PATHS.cnsrIndex);

export const fetchCnsrSource = (key: string): Promise<CnsrSource> =>
  getJson<CnsrSource>(DATA_PATHS.cnsrSource(key));

/** Which calendars exist, newest first — the switcher's options. */
export function calendarKeys(index: CoofIndex): string[] {
  // `collections` is the authoritative list.
  //
  // ⚠️ Sort by `latestAt` — the newest watched date — NOT by the name string.
  // The names are "COOF2020".."COOF2026" today, so a name sort happens to give
  // the right order, but that is a coincidence of the naming scheme rather than
  // a property of the data: a calendar named anything else would sort wrong.
  // `latestAt` is nullable (an empty calendar has no dates), so empty calendars
  // sink to the end rather than jumping to the front.
  return [...index.collections]
    .sort((a, b) => (b.latestAt ?? '').localeCompare(a.latestAt ?? ''))
    .map((c) => c.name);
}

/**
 * COOF 的**类型名**（剧情 / 科幻 / 动作 …）→ 英文。
 *
 * ⚠️ 它们是**数据**（来自 Notion 的词表，躺在 `data/coof/…/index.json` 里），
 *    但**同时也是标签** —— 和运动类型（`health-analysis.ts` 那张表）是同一类东西：
 *    **封闭词表，读者期望看到自己的语言**。
 *    ⇒ 所以不能靠"它在 data/ 里"就放过它，也不能去改数据（那是源，改了下次同步就回来了）。
 *    正解和运动类型一样：**在渲染那一刻换**。
 *
 * ⚠️ 查不到的原样返回 —— 项目规矩：「没映射到的**原样显示**，不要去猜」。
 */
const GENRE_EN: Record<string, string> = {
  剧情: 'Drama', 科幻: 'Sci-Fi', 动作: 'Action', 喜剧: 'Comedy', 恐怖: 'Horror',
  动画: 'Animation', 歌舞剧: 'Musical', 爱情: 'Romance', 冒险: 'Adventure',
  犯罪: 'Crime', 惊悚: 'Thriller', 传记: 'Biography', 纪录片: 'Documentary',
  悬疑: 'Mystery', 战争: 'War', 奇幻: 'Fantasy', 家庭: 'Family', 历史: 'History',
  音乐: 'Music', 运动: 'Sport', 西部: 'Western', 黑色电影: 'Film-Noir',
  短片: 'Short', 真人秀: 'Reality-TV', 脱口秀: 'Talk-Show', 新闻: 'News',
  儿童: 'Kids', 武侠: 'Martial arts', 情色: 'Erotic', 同性: 'LGBTQ',
  灾难: 'Disaster', 鬼怪: 'Supernatural', 惊栗: 'Suspense', 戏曲: 'Opera',
  犯罪片: 'Crime', 传记片: 'Biography', 歌舞: 'Musical', 纪实: 'Documentary',
};
export const genreLabel = (zh: string | undefined | null): string =>
  !zh ? '' : tv(zh, GENRE_EN[zh] ?? zh);

export function formatRuntime(min: number | null): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0
    ? tv(`${h}小时${m > 0 ? `${m}分` : ''}`, `${h}h${m > 0 ? ` ${m}m` : ''}`)
    : tv(`${m}分钟`, `${m} min`);
}
