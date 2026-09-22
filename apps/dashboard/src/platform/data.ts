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
function origin(): string {
  // ⚠️ There is deliberately NO `process.env.TARO_APP_DATA_ORIGIN` override here.
  //
  // Webpack does not define `process` in this build. Reading `process.env.X`
  // throws `process is not defined` at RUNTIME — not at build time, so the
  // compiler and the bundler both stay quiet and the page just dies. A staging
  // override would have to be threaded through Taro's `defineConstants`; until
  // something actually needs it, an override that only ever breaks is worse
  // than no override.

  // 1. H5 / Android WebView: same-origin whenever the app is served next to
  //    `data/`, which is how both the Pages deploy and the local test layout
  //    work. Deriving it means the H5 build is correct on any host without a
  //    per-host rebuild.
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
  if (typeof location !== 'undefined' && location.origin) return location.origin;

  // 3. Mini-program: no DOM, so no location. Pages is unusable there anyway
  //    (WeChat requires ICP-filed request domains) — see docs/HOSTING.md.
  return PROD_ORIGIN;
}

export const assetUrl = (relPath: string): string =>
  `${origin()}/${relPath.replace(/^\/+/, '')}`;

export interface CoofTitle {
  id: string;
  collection: string;
  title: string;
  year: number | null;
  mediaType: string | null;
  status: 'watched' | 'wishlist' | 'unknown' | string;
  watchedAt: string | null;
  rating: number | null;
  runtimeMin: number | null;
  note: string | null;
  poster: string | null;
  genres: string[];
  country: string[];
  director: string[];
  cast: string[];
  order: number | null;
}

export interface CoofIndex {
  schemaVersion: number;
  collection: string;
  collections: string[];
  dataVersion: string;
  counts: { total: number; rated: number };
  genres: string[];
  hero: CoofTitle | null;
  recent: CoofTitle[];
}

export interface CoofLibrary {
  schemaVersion: number;
  collection: string;
  dataVersion: string;
  titles: CoofTitle[];
}

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

export const fetchCoofIndex = (collection: string): Promise<CoofIndex> =>
  getJson<CoofIndex>(DATA_PATHS.coofIndex(collection));

export const fetchCoofLibrary = (collection: string): Promise<CoofLibrary> =>
  getJson<CoofLibrary>(DATA_PATHS.coofLibrary(collection));

/** Which calendars exist, newest first — the switcher's options. */
export function calendarKeys(index: CoofIndex): string[] {
  // `collections` is the authoritative list; sorting by the trailing year keeps
  // the switcher newest-first without hardcoding the naming scheme.
  return [...index.collections].sort((a, b) => b.localeCompare(a));
}

export function formatRuntime(min: number | null): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}小时${m > 0 ? `${m}分` : ''}` : `${m}分钟`;
}
