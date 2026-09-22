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

import Taro from '@tarojs/taro';

// App-local copy of the shared path contract — see ./paths.ts for why it is
// not imported, and ./paths.contract.ts for the guard that keeps them in sync.
import { DATA_PATHS } from './paths';


/** Deployed origin for the H5/Android build. */
const PROD_ORIGIN = 'https://apps.cevtuogrnd.com';

/**
 * Dev origin. The H5 dev server does not serve `data/`, so point at whatever is
 * serving the repo root (a static server, or the filed domain once it is up).
 */
const DEV_ORIGIN = 'http://127.0.0.1:8080';

function origin(): string {
  // `process.env.NODE_ENV` is inlined by the Taro/webpack build.
  if (process.env.NODE_ENV === 'production') return PROD_ORIGIN;
  return DEV_ORIGIN;
}

/**
 * Join an origin-relative path onto the active origin.
 *
 * Posters come out of the pipeline as `data/coof/posters/x.jpg` with no leading
 * slash, so this must not assume one.
 */
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
  const res = await Taro.request<T>({ url, method: 'GET' });
  if (res.statusCode !== 200) {
    throw new Error(`加载失败 ${res.statusCode}: ${path}`);
  }
  return res.data;
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
