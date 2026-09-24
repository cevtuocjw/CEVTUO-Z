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
  /**
   * The device's own export, exactly as the KOReader plugin wrote it.
   *
   * Kept verbatim in the repo rather than converted on the ingest server: the
   * conversion is the pipeline's job, and storing the raw file means a converter
   * bug is always fixable by re-running the pipeline over data already on disk,
   * instead of asking the reader to sync again.
   *
   * ⚠️ This is the one file in `data/paperr/` written by a machine that is not
   * this pipeline — see NOTE below on why it is excluded from `dataVersion`.
   */
  paperrRaw: 'data/paperr/raw-koreader.json',
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
