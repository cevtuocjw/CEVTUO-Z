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
 * ⚠️⚠️ Chealth is deliberately absent, AND THE GUARD IS STILL ON.
 *
 * `paths.contract.ts` asserts at typecheck time that no `chealth*` key exists
 * here, so a future change cannot quietly publish health data by adding one
 * line. That assertion is correct and was left in place.
 *
 * ⚠️ What it caught, on 2026-09-24: the phone-side ingest publishes
 * `data/chealth/index.json` to `gh-pages`, and the repo is public — so step
 * counts, heart rate, sleep and blood oxygen for one identifiable person were
 * readable by anyone with the URL. The guard is what turned that from a
 * silent design drift into a build failure. Whether health data should be
 * public is the reader's call, not a side effect of wiring up a pipeline.
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
  cnsrNotesPage: (pageNo: number) => `data/cnsr/notes/page-${pageNo}.json`,

  paperrIndex: 'data/paperr/index.json',
  paperrHeatmap: 'data/paperr/heatmap.json',

  /**
   * ⚠️ The health index — CIPHERTEXT at a public URL, and that is the whole
   * reason it is allowed here at all.
   *
   * The guard in `paths.contract.ts` used to forbid any `chealth*` key
   * outright, on the premise that anything at a `data/` path is world-readable
   * and the health payload therefore must not go there. The premise is still
   * true. What changed is the payload: the server seals the index with
   * AES-GCM before publishing (see `buildSealedIndexFromStore`), so what sits
   * at this path is noise without the passphrase.
   *
   * ⚠️ The guard was NOT deleted, it was narrowed — it now permits exactly this
   * one key and still rejects any other, so a second, unsealed health path
   * cannot be added without someone editing that assertion on purpose.
   */
  chealthSealed: 'data/chealth/index.json',
} as const;

/** Where re-hosted Notion posters live. Notion's own S3 URLs expire in ~1h. */
export const posterPath = (movieId: string) => `data/coof/posters/${movieId}.jpg`;

export const CNSR_NOTES_PER_PAGE = 50;
