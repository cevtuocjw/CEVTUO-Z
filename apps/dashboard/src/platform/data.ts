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
import { DATA_PATHS } from './paths';

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
  PaperrIndex,
  SyncMeta,
} from '../../../../packages/schema/src/index';

/** Deployed origin, used by the mini-program and as the last-resort fallback. */
const PROD_ORIGIN = 'https://apps.cevtuogrnd.com';

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
  if (typeof location !== 'undefined' && location.origin) {
    // `/z/index.html` -> `/z`, `/` -> '' — then the caller's leading slash
    // supplies the separator, so there is never a doubled or missing one.
    return (location.pathname || '/').replace(/\/[^/]*$/, '');
  }

  // 3. Mini-program: no DOM, so no location. This origin is still wrong — pages
  //    is unusable there anyway (WeChat requires ICP-filed request domains) —
  //    see docs/HOSTING.md.
  return PROD_ORIGIN;
}

export const assetUrl = (relPath: string): string =>
  `${base()}/${relPath.replace(/^\/+/, '')}`;

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
  PaperrIndex,
  SyncMeta,
};

async function getJson<T>(path: string): Promise<T> {
  const url = assetUrl(path);

  // ⚠️ `Taro.request` is deliberately NOT used here.
  //
  // On H5 it resolves through Taro's request adapter, which requires the global
  // `Taro` to be present on `window`; in this build it is not, so every call
  // throws `Cannot read properties of undefined (reading 'request')` and the page
  // renders "加载失败: Failed to fetch" while the network shows a clean 200.
  //
  // `fetch` is implemented natively on both targets we ship to (mini-program
  // base library ≥2.18 and every WebView we support), so it is the smaller
  // surface. If a target ever lacks it, add the adapter there rather than
  // reintroducing the global dependency here.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`加载失败 HTTP ${res.status}：${path}`);
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
 * ⚠️ Almost all of it is PUBLIC and comes from `data/paperr/index.json` like
 * every other brand. The history, the charts and the shelf are things this
 * dashboard exists to show.
 *
 * ⚠️ The ONE exception is which book is open right now, and it is a separate
 * fetch on purpose. The pipeline writes it to its own file which is never
 * committed, and the page reads it from the sync server with a password. See
 * `fetchPaperrCurrent`.
 */
export const fetchPaperrIndex = (): Promise<PaperrIndex> =>
  getJson<PaperrIndex>(DATA_PATHS.paperrIndex);

/** The slice of the index that is not public. */
export interface PaperrCurrent {
  current: PaperrBook | null;
}

/**
 * The book being read right now.
 *
 * ⚠️ Overridable via `window.__CEVTUO_PAPERR_API__`, and that hook is not a
 * convenience — it is the only way `scripts/verify-paperr-ui.mjs` can drive this
 * against a local server. Without it the verification would have to talk to the
 * real host, which means depending on a deployment that may not exist yet.
 */
function paperrApi(): string {
  const override = (globalThis as { __CEVTUO_PAPERR_API__?: string }).__CEVTUO_PAPERR_API__;
  return override || 'http://120.77.27.128:8789';
}

const PAPERR_PW_KEY = 'cevtuo.paperr.pw';

/** Thrown when there is no password yet, or the one stored is wrong. */
export const NEED_PASSWORD = 'NEED_PASSWORD';

/** ⚠️ Guarded: the mini-program has no `localStorage`, and an exception here
 *  would take the whole page down rather than just losing the convenience. */
export function paperrPassword(): string | null {
  try {
    return window.localStorage.getItem(PAPERR_PW_KEY);
  } catch {
    return null;
  }
}

export function setPaperrPassword(pw: string): void {
  try {
    window.localStorage.setItem(PAPERR_PW_KEY, pw);
  } catch {
    // Not fatal — the page will simply ask again next time.
  }
}

export function clearPaperrPassword(): void {
  try {
    window.localStorage.removeItem(PAPERR_PW_KEY);
  } catch {
    // ditto
  }
}

/**
 * ⚠️ `btoa` is latin1-only and throws on any code point above 0xFF. The
 * username is a fixed ASCII placeholder, but the PASSWORD is whatever the reader
 * typed — a Chinese or emoji password would throw here rather than fail an auth
 * check, which reads as a broken page instead of a wrong password.
 */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let latin = '';
  for (const b of bytes) latin += String.fromCharCode(b);
  return window.btoa(latin);
}

export async function fetchPaperrCurrent(): Promise<PaperrCurrent> {
  const pw = paperrPassword();
  if (!pw) throw new Error(NEED_PASSWORD);

  const res = await fetch(`${paperrApi()}/api/paperr/current.json`, {
    headers: { Authorization: `Basic ${b64(`x:${pw}`)}` },
  });
  // A wrong password and no password are the same thing to the reader: ask again.
  if (res.status === 401) throw new Error(NEED_PASSWORD);
  if (res.status === 404) return { current: null };
  if (!res.ok) throw new Error(`同步服务器返回 HTTP ${res.status}`);
  return (await res.json()) as PaperrCurrent;
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
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
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

export function formatRuntime(min: number | null): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}小时${m > 0 ? `${m}分` : ''}` : `${m}分钟`;
}
