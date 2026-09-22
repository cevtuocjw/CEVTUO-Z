/**
 * Data paths — the app's copy of the origin-relative contract.
 *
 * ── Why this is duplicated instead of imported ────────────────
 * `packages/schema/src/paths.ts` is the canonical source, but the app cannot
 * runtime-import it:
 *
 *   · Taro's babel loader only covers the app directory, so anything pulled from
 *     `packages/` arrives untranspiled and webpack dies on the first `as const`.
 *   · The same file reached via the `@cevtuo/schema` alias resolves to
 *     `index.ts`, which drags in zod — ~60KB that must never enter the
 *     mini-program bundle (see HANDOFF).
 *   · Taro 4 rejects `compiler.include`, the documented-looking escape hatch.
 *
 * So the app keeps its own copy, and `paths.contract.ts` fails the typecheck if
 * the two ever drift. That is a compile-time guarantee rather than a comment
 * asking people to remember.
 *
 * ⚠️ Deliberately absent: Chealth. It is NOT served from the static site —
 * GitHub Pages is world-readable even for a private repo, so health data lives
 * behind the authenticated service. Adding it here would publish it.
 */

export const BRAND = {
  coof: 'coof',
  cnsr: 'cnsr',
  paperr: 'paperr',
  chealth: 'chealth',
} as const;

export type Brand = (typeof BRAND)[keyof typeof BRAND];

export const DATA_PATHS = {
  syncMeta: 'data/sync-meta.json',
  manifest: 'data/manifest.json',

  /** Each calendar gets its own directory. Key is a collection, e.g. COOF2026. */
  coofIndex: (key: string) => `data/coof/${key}/index.json`,
  coofLibrary: (key: string) => `data/coof/${key}/library.json`,

  cnsrIndex: 'data/cnsr/index.json',
  cnsrHeatmap: 'data/cnsr/heatmap.json',
  cnsrNotesPage: (pageNo: number) => `data/cnsr/notes/page-${pageNo}.json`,

  paperrIndex: 'data/paperr/index.json',
  paperrHeatmap: 'data/paperr/heatmap.json',
} as const;

/** Where re-hosted Notion posters live. Notion's own S3 URLs expire in ~1h. */
export const posterPath = (movieId: string) => `data/coof/posters/${movieId}.jpg`;

export const CNSR_NOTES_PER_PAGE = 50;
