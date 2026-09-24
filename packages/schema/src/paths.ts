/**
 * Canonical data paths, relative to the data origin.
 *
 * Both sides import from here so a rename can never drift between the pipeline
 * that writes a file and the app that fetches it.
 *
 * ⚠️ Chealth is deliberately absent: it is NOT served from the static site.
 * GitHub Pages is world-readable even for a private repo, so health data lives
 * behind the Worker at `/api/chealth/*` with a bearer token.
 */

export const BRAND = {
  coof: 'coof',
  cnsr: 'cnsr',
  paperr: 'paperr',
  chealth: 'chealth',
} as const;

export type Brand = (typeof BRAND)[keyof typeof BRAND];

/** Static (public) payloads. */
export const DATA_PATHS = {
  syncMeta: 'data/sync-meta.json',
  manifest: 'data/manifest.json',

  /**
   * Each calendar gets its own directory. `key` is a collection name from
   * COO_COLLECTIONS (COOF2026, COOF2025, …). Both are origin-relative.
   */
  coofIndex: (key: string) => `data/coof/${key}/index.json`,
  coofLibrary: (key: string) => `data/coof/${key}/library.json`,

  cnsrIndex: 'data/cnsr/index.json',
  /**
   * One file per CNSR source (shopping / learn / techlearn / techai).
   *
   * ⚠️ Split per source rather than one combined file, because the sources are
   * refreshed on a STAGGERED schedule — one per run, four runs to a cycle — and
   * each carries its own `updatedAt`. A single combined file would have to be
   * rewritten by every run, so its other three quarters would claim a freshness
   * they do not have.
   */
  cnsrSource: (key: string) => `data/cnsr/${key}.json`,
  cnsrHeatmap: 'data/cnsr/heatmap.json',
  /** pageNo is 1-based. */
  cnsrNotesPage: (pageNo: number) => `data/cnsr/notes/page-${pageNo}.json`,

  paperrIndex: 'data/paperr/index.json',
  paperrHeatmap: 'data/paperr/heatmap.json',
} as const;

/**
 * Files that live beside `data/` but are NOT payloads: never fetched over HTTP,
 * and never served by Pages.
 *
 * ⚠️ They are not in `DATA_PATHS` on purpose. `DATA_PATHS` is the contract
 * between the pipeline and the app — every entry is something the app fetches.
 * Putting a local scratch file there would promise it to the app.
 *
 * ⚠️ And they are gitignored. The repository is public, so anything committed is
 * published.
 */
export const LOCAL_PATHS = {
  /**
   * The device's own export, verbatim.
   *
   * Kept so a converter bug is fixed by re-running the pipeline over data
   * already on disk, instead of asking the reader to go find WiFi again.
   */
  paperrRaw: 'data/paperr/raw-koreader.json',
  // ⚠️ `paperrCurrent` was here: "the only part of this brand that is not
  // public". The reader decided the whole dashboard is publishable, so nothing
  // ever wrote it. It is gone rather than left as a comment describing a
  // boundary that no longer exists — see the note in `services/ingest/src/core.ts`.
} as const;

/** Authenticated payloads — served by the Worker, never by Pages. */
export const PRIVATE_PATHS = {
  chealthIndex: 'api/chealth/index.json',
  syncStatus: 'api/status',
  syncTrigger: 'api/sync',
} as const;

/** Where re-hosted Notion posters live. Notion's own S3 URLs expire in ~1h. */
export const posterPath = (movieId: string) => `data/coof/posters/${movieId}.jpg`;

/** Items per CNSR note page. Keep the payload small enough for a cover-screen fetch. */
export const CNSR_NOTES_PER_PAGE = 50;

/** Days retained in the 90-day daily series and the 365-day heatmaps. */
export const SERIES_DAYS = 90;
export const HEATMAP_DAYS = 365;
