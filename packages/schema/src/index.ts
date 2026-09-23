/**
 * CEVTUO-Z payload schemas — the single source of truth.
 *
 * HOW TO USE THIS PACKAGE
 *   pipeline / worker : import the zod VALUES, validate before writing.
 *                       A bad payload fails CI instead of corrupting the app.
 *   apps/dashboard    : import TYPES ONLY (`import type { ... }`).
 *                       zod's runtime is ~60KB and the mini-program package
 *                       budget is 2MB — the validator must never ship.
 *
 * THREE RULES THAT ARE LOAD-BEARING (breaking one breaks the no-commit-storm design)
 *   1. Timestamps live ONLY in SyncMeta. No brand payload carries a time.
 *      Otherwise every 5h run dirties every file and we commit on every run.
 *   2. A brand payload carries `dataVersion` — a hash of its own content — and
 *      nothing that changes on its own. Same data ⇒ byte-identical file.
 *   3. `error.message` is short and scrubbed. It is rendered in the app's
 *      diagnostics panel, and (for the three static brands) `data/` is public.
 */

import { z } from 'zod';

export * from './collections';

// ─────────────────────────────────────────────────────────────
// Brand & source identity
// ─────────────────────────────────────────────────────────────

export const BrandSchema = z.enum(['coof', 'cnsr', 'paperr', 'chealth']);
export type Brand = z.infer<typeof BrandSchema>;

export const SourceIdSchema = z.enum([
  'notion-coof',
  'notion-cnsr',
  'koreader-push', // KOReader plugin POSTing aggregates from the device
  'koreader-sftp', // macOS LaunchAgent pulling the stats DB over SFTP
  'gdrive-healthsync', // Health Sync → Google Drive export
  'strava', // MyWhoosh indoor cycling (and outdoor rides)
]);
export type SourceId = z.infer<typeof SourceIdSchema>;

export const SourceStatusSchema = z.enum([
  'ok', // fresh, complete
  'partial', // arrived but some record types missing
  'stale', // succeeded previously, but older than staleAfterHours
  'error', // failed this run
  'skipped', // not attempted (e.g. source not configured yet)
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

// ─────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────

/** ISO-8601 date, `YYYY-MM-DD`. Day keys for all series and heatmaps. */
export const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * ISO-8601 instant WITH an explicit UTC offset, minute precision:
 *   "2026-09-22T14:05+08:00"
 *
 * Deliberately one field rather than a separate epoch + display string:
 *   - `new Date(value)` parses it in every JS engine
 *   - `.slice(11, 16)` renders "14:05" with no timezone maths and no `Intl`
 *     (mini-program `Intl` support is inconsistent, so we avoid it entirely)
 */
export const IsoInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/, 'expected ISO-8601 instant with offset');

/** ISO-8601 duration, e.g. "PT5H". Lets the app show a countdown while offline. */
export const IsoDurationSchema = z.string().regex(/^P/i, 'expected ISO-8601 duration');

/** Content hash of a payload — changes iff the payload's content changes. */
export const DataVersionSchema = z.string().min(1);

// ─────────────────────────────────────────────────────────────
// sync-meta.json — the ONLY file allowed to carry time
// ─────────────────────────────────────────────────────────────

export const ErrorInfoSchema = z.object({
  code: z.string().max(48),
  /** ≤200 chars, token-scrubbed. Rendered in the public diagnostics panel. */
  message: z.string().max(200),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

export const PerSourceStatusSchema = z.object({
  id: SourceIdSchema,
  status: SourceStatusSchema,
  lastAttemptAt: IsoInstantSchema,
  lastSuccessAt: IsoInstantSchema.nullable(),
  itemsIn: z.number().int().nonnegative(),
  changed: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  /** Hours after which this source should be considered stale. */
  staleAfterHours: z.number().positive(),
  error: ErrorInfoSchema.optional(),
});
export type PerSourceStatus = z.infer<typeof PerSourceStatusSchema>;

export const SyncMetaSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoInstantSchema,
  nextScheduledAt: IsoInstantSchema,
  cadence: IsoDurationSchema,
  trigger: z.enum(['schedule', 'manual', 'dispatch', 'local']),
  /** GitHub run id — the app deep-links to the Action log from the diagnostics panel. */
  runId: z.string().optional(),
  sources: z.array(PerSourceStatusSchema),
  /**
   * Keyed by BRAND ('coof'), not by collection ('COOF2026').
   *
   * A brand can span many collections — COOF has eleven — and keying by
   * collection would make this record's shape depend on which sub-collections a
   * given run happened to touch. `parts` carries the per-collection detail.
   */
  brands: z.record(
    BrandSchema,
    z.object({
      dataVersion: DataVersionSchema,
      /** When this brand's CONTENT last actually changed (not when we last checked). */
      changedAt: IsoInstantSchema,
      /** Per-collection content hashes, for brands that have sub-collections. */
      parts: z.record(z.string(), DataVersionSchema).optional(),
    }),
  ),
});
export type SyncMeta = z.infer<typeof SyncMetaSchema>;

// ─────────────────────────────────────────────────────────────
// manifest.json — tiny entry point the app fetches first
// ─────────────────────────────────────────────────────────────

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  brands: z.array(
    z.object({
      brand: BrandSchema,
      /** Human label, e.g. "COOF". */
      label: z.string().max(24),
      /** One-line description shown on the home tile. */
      blurb: z.string().max(80),
      itemCount: z.number().int().nonnegative(),
      /** Payload to fetch for the tile preview. */
      indexPath: z.string(),
    }),
  ),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ─────────────────────────────────────────────────────────────
// COOF — Notion movie records
// ─────────────────────────────────────────────────────────────

export const MovieStatusSchema = z.enum(['watched', 'watching', 'watchlist', 'dropped']);
export type MovieStatus = z.infer<typeof MovieStatusSchema>;

export const CoofTitleSchema = z.object({
  id: z.string(),
  title: z.string(),
  year: z.number().int().nullable(),
  /**
   * Path relative to the data origin (e.g. "data/coof/posters/abc.webp") — NEVER a
   * Notion URL. Notion serves posters from signed S3 URLs that expire in ~1h, so the
   * pipeline downloads and re-hosts them. Null ⇒ render a placeholder.
   */
  poster: z.string().nullable(),
  /** Collection this record belongs to, e.g. "COOF2026". Drives the top-left switcher. */
  collection: z.string(),
  status: MovieStatusSchema,
  /** 0–10, or the Notion scale as recorded. Null when unrated. */
  rating: z.number().nullable(),
  /** Day the movie was watched/recorded. */
  watchedAt: DayKeySchema.nullable(),
  genres: z.array(z.string()),
  runtimeMin: z.number().int().positive().nullable(),
  /** Short personal note shown in the detail sheet. */
  note: z.string().max(2000).nullable(),
  director: z.array(z.string()),
  cast: z.array(z.string()),

  /**
   * Notion's `NUM`. Runs newest-largest (148, 147, 146 …), so it is the sort key
   * — more reliable than `Date`, which early rows sometimes leave empty.
   * Null when the property is absent, which it is in the older calendars.
   */
  order: z.number().nullable(),
  country: z.array(z.string()),
  /** `FILM` — "影" (film) or "剧" (series). Not a watch-state flag. */
  mediaType: z.string().nullable(),
});
export type CoofTitle = z.infer<typeof CoofTitleSchema>;

/**
 * One entry in the top-left switcher.
 *
 * `path` lets the app fetch a collection lazily — switching to COOF2023 should
 * not require having downloaded all eleven collections up front.
 */
export const CoofCollectionSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
  /** Newest watchedAt in this collection — drives the switcher's ordering. */
  latestAt: DayKeySchema.nullable(),
  /** Origin-relative index path, e.g. "data/coof/COOF2023/index.json". */
  path: z.string(),
});
export type CoofCollection = z.infer<typeof CoofCollectionSchema>;

export const CoofIndexSchema = z.object({
  schemaVersion: z.literal(1),
  dataVersion: DataVersionSchema,
  counts: z.object({
    total: z.number().int().nonnegative(),
    rated: z.number().int().nonnegative(),
  }),
  /**
   * Every calendar, newest first. Present in EVERY collection's index so the
   * switcher renders without an extra request — the cost is a few hundred bytes
   * duplicated per index file, which is cheaper than a round trip on the cover
   * screen.
   */
  collections: z.array(CoofCollectionSchema),
  /** Which collection this index describes. */
  collection: z.string(),
  /** Cover-screen hero — newest entry in this collection. */
  hero: CoofTitleSchema.nullable(),
  /** Newest-first, capped. Drives the primary list. */
  recent: z.array(CoofTitleSchema),
  genres: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
});
export type CoofIndex = z.infer<typeof CoofIndexSchema>;

export const CoofLibrarySchema = z.object({
  schemaVersion: z.literal(1),
  dataVersion: DataVersionSchema,
  collection: z.string(),
  /** Every title in this collection, newest-first. Fetched only on "All". */
  titles: z.array(CoofTitleSchema),
});
export type CoofLibrary = z.infer<typeof CoofLibrarySchema>;

// ─────────────────────────────────────────────────────────────
// CNSR — Notion notes (Learn / tech-learn / tech-ai / shopping)
// ─────────────────────────────────────────────────────────────

export const CnsrNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Plain-text preview, ≤180 chars — keeps the index payload small. */
  summary: z.string().max(180),
  /** Which source page it came from, e.g. "Learn" | "tech-ai". */
  source: z.string(),
  /** The "@date" marker the note is filed under. */
  entryDate: DayKeySchema,
  updatedAt: IsoInstantSchema,
  tags: z.array(z.string()),
  /** Notion page URL. */
  url: z.string(),
  /** True when the note carries more content than `summary` — i.e. worth opening. */
  hasMore: z.boolean(),
});
export type CnsrNote = z.infer<typeof CnsrNoteSchema>;

export const CnsrIndexSchema = z.object({
  schemaVersion: z.literal(1),
  dataVersion: DataVersionSchema,
  counts: z.object({
    notes: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
  }),
  /** Newest-first by entryDate. */
  recent: z.array(CnsrNoteSchema),
  tags: z.array(z.object({ tag: z.string(), count: z.number().int().nonnegative() })),
  sources: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
  /** Number of pages in data/cnsr/notes/page-{1..n}.json */
  notePages: z.number().int().nonnegative(),
});
export type CnsrIndex = z.infer<typeof CnsrIndexSchema>;

/** Short keys on purpose: 365 entries × ~30 bytes instead of ~60. */
export const HeatmapSchema = z.object({
  schemaVersion: z.literal(1),
  /** d = day, n = count. Sorted ascending. */
  days: z.array(z.object({ d: DayKeySchema, n: z.number().int().nonnegative() })),
});
export type Heatmap = z.infer<typeof HeatmapSchema>;

export const CnsrNotesPageSchema = z.object({
  schemaVersion: z.literal(1),
  pageNo: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  notes: z.array(CnsrNoteSchema),
});
export type CnsrNotesPage = z.infer<typeof CnsrNotesPageSchema>;

// ── Per-source timeline ──────────────────────────────────────
//
// ⚠️ A different shape from `CnsrNoteSchema`, deliberately, and not a
// replacement for it.
//
// `CnsrNote` is a one-line SUMMARY per note, built for an index you page
// through. What the CNSR modules actually render is the opposite: a day's full
// content, in place, inside a scrolling column. Summarising to 180 characters
// would throw away the thing being displayed, and the dates here are not
// per-note — they are SEGMENT MARKS in the source page (see the extractor).
//
// One file per source, because the four refresh on a staggered schedule and
// each carries its own `updatedAt` (see DATA_PATHS.cnsrSource).

export const CnsrLineSchema = z.object({
  /** Source block type — `paragraph`, `bulleted_list_item`, `heading_2`, … */
  k: z.string(),
  t: z.string(),
  /**
   * Link runs inside the line.
   *
   * ⚠️ Carried SEPARATELY from `t` rather than written into it as markdown or
   * as a bare URL. The requirement is that a link renders as a NAME the reader
   * can tap, never as `https://…` — and `t` already holds that name, so the UI
   * only has to find these runs inside it and wrap them.
   */
  links: z
    .array(
      z.object({
        /** What the reader sees and taps. */
        t: z.string(),
        href: z.string(),
        /**
         * The target page's own `<title>` and description, fetched at
         * extraction time.
         *
         * ⚠️ Optional, and absent whenever the fetch failed — a link must
         * render as a tappable name whether or not its preview came back.
         */
        title: z.string().optional(),
        desc: z.string().optional(),
      }),
    )
    .optional(),
});
export type CnsrLine = z.infer<typeof CnsrLineSchema>;

export const CnsrImageSchema = z.object({
  /**
   * Repo-relative path, e.g. `data/cnsr/img/<blockid>.jpg`.
   *
   * ⚠️ A LOCAL path, never Notion's own URL. Notion-hosted files come from S3
   * with `X-Amz-Expires=3600`, so a stored URL is a broken image an hour later
   * — the trap the COOF posters were re-hosted to avoid.
   */
  src: z.string(),
  caption: z.string(),
});
export type CnsrImage = z.infer<typeof CnsrImageSchema>;

export const CnsrEntrySchema = z.object({
  /** Notion block id of the `@date` marker that opens this segment. */
  id: z.string(),
  date: DayKeySchema,
  /** Text alongside the date on the marker itself. Usually empty. */
  title: z.string(),
  /** Everything between this marker and the next, in reading order. */
  lines: z.array(CnsrLineSchema),
  /**
   * Rows cut by the per-day cap.
   *
   * ⚠️ Reported, not hidden. A day silently showing 10 of 69 lines reads as a
   * day that had 10 lines; the UI has to be able to say there is more.
   */
  more: z.number().int().nonnegative(),
  /** Shopping only — every other source drops images at extraction time. */
  images: z.array(CnsrImageSchema),
  /** How many images the day held before the cap. */
  imagesSeen: z.number().int().nonnegative(),
});
export type CnsrEntry = z.infer<typeof CnsrEntrySchema>;

export const CnsrSourceSchema = z.object({
  source: z.string(),
  label: z.string(),
  notionId: z.string(),
  /** Human-readable description of the read window, e.g. "最近 10 个日期". */
  window: z.string(),
  updatedAt: IsoInstantSchema,
  counts: z.object({
    days: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    /** Lines cut by the per-day cap. */
    hidden: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    /** `before`/`old` subtrees skipped without being read. */
    skippedSubtrees: z.number().int().nonnegative(),
  }),
  /** Newest first — the order the source page reads from the bottom up. */
  entries: z.array(CnsrEntrySchema),
});
export type CnsrSource = z.infer<typeof CnsrSourceSchema>;

export const CnsrSourcesIndexSchema = z.object({
  generatedAt: IsoInstantSchema,
  sources: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      path: z.string(),
      window: z.string(),
      updatedAt: IsoInstantSchema,
      counts: CnsrSourceSchema.shape.counts,
    }),
  ),
});
export type CnsrSourcesIndex = z.infer<typeof CnsrSourcesIndexSchema>;

// ─────────────────────────────────────────────────────────────
// CE-PaperR — KOReader reading statistics
// ─────────────────────────────────────────────────────────────

export const PaperrBookSchema = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.string(),
  series: z.string().nullable(),
  pages: z.number().int().nullable(),
  totalReadPages: z.number().int().nonnegative(),
  /** Seconds. */
  totalReadTime: z.number().int().nonnegative(),
  lastOpen: IsoInstantSchema,
  progressPct: z.number().min(0).max(100).nullable(),
  highlights: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  /**
   * Projected finish date from the last 14 days' pace. This is the one field that
   * makes the page worth opening daily — computed in the pipeline, never on device.
   * Null when the pace is zero (can't project from no reading).
   */
  estFinishedAt: DayKeySchema.nullable(),
});
export type PaperrBook = z.infer<typeof PaperrBookSchema>;

export const PaperrIndexSchema = z.object({
  schemaVersion: z.literal(1),
  dataVersion: DataVersionSchema,
  current: PaperrBookSchema.nullable(),
  books: z.array(PaperrBookSchema),
  totals: z.object({
    booksStarted: z.number().int().nonnegative(),
    booksFinished: z.number().int().nonnegative(),
    readSeconds: z.number().int().nonnegative(),
    pagesTurned: z.number().int().nonnegative(),
  }),
  /** d = day, s = seconds read, p = pages turned. */
  daily: z.array(z.object({ d: DayKeySchema, s: z.number().int().nonnegative(), p: z.number().int().nonnegative() })),
  /** Set when the two ingest paths disagree — surfaced in diagnostics. */
  lastIngestPath: z.enum(['koreader-push', 'koreader-sftp']).nullable(),
});
export type PaperrIndex = z.infer<typeof PaperrIndexSchema>;

// ─────────────────────────────────────────────────────────────
// Chealth — authenticated, served by the Worker only
// ─────────────────────────────────────────────────────────────

export const DailyPointSchema = z.object({
  d: DayKeySchema,
  v: z.number().nullable(),
});
export type DailyPoint = z.infer<typeof DailyPointSchema>;

export const WorkoutSchema = z.object({
  id: z.string(),
  kind: z.enum(['cycling', 'jumprope', 'abwheel', 'walk', 'run', 'other']),
  startedAt: IsoInstantSchema,
  durationSec: z.number().int().nonnegative().nullable(),
  distanceM: z.number().nonnegative().nullable(),
  kcal: z.number().nonnegative().nullable(),
  avgHr: z.number().int().positive().nullable(),
  /** Device label, e.g. "Westinghouse WB07D" for the MyWhoosh bike. */
  device: z.string().nullable(),
  source: SourceIdSchema,
});
export type Workout = z.infer<typeof WorkoutSchema>;

export const ChealthIndexSchema = z.object({
  schemaVersion: z.literal(1),
  dataVersion: DataVersionSchema,

  /** Null means "no data for that metric today" — the UI must show a gap, not a zero. */
  today: z.object({
    steps: z.number().int().nonnegative().nullable(),
    activeKcal: z.number().nonnegative().nullable(),
    activeMinutes: z.number().int().nonnegative().nullable(),
    sleepMinutes: z.number().int().nonnegative().nullable(),
    restingHr: z.number().int().positive().nullable(),
    weightKg: z.number().positive().nullable(),
  }),

  /** Samsung-Health-style daily rings (steps / active time / active calories). */
  rings: z.object({
    steps: z.object({ value: z.number().nonnegative(), goal: z.number().positive() }),
    activeMinutes: z.object({ value: z.number().nonnegative(), goal: z.number().positive() }),
    activeKcal: z.object({ value: z.number().nonnegative(), goal: z.number().positive() }),
  }),

  /** 90-day daily series, ascending by day. */
  series: z.object({
    steps: z.array(DailyPointSchema),
    activeKcal: z.array(DailyPointSchema),
    sleepMinutes: z.array(DailyPointSchema),
    restingHr: z.array(DailyPointSchema),
    weightKg: z.array(DailyPointSchema),
  }),

  workouts: z.array(WorkoutSchema),

  /**
   * Not decoration. Samsung Health writes steps to Health Connect as ONE DAILY
   * AGGREGATE with no intraday timestamps, and does not write a jump-rope type at
   * all. Without this panel that limitation renders as an inexplicable flat line —
   * i.e. it looks like a bug in our chart rather than a limit of the source.
   */
  coverage: z.array(
    z.object({
      source: SourceIdSchema,
      types: z.array(z.string()),
      granularity: z.enum(['intraday', 'daily', 'unknown']),
      lastSeenAt: IsoInstantSchema.nullable(),
      /** Human-readable caveat, e.g. "no intraday timestamps from Samsung Health". */
      caveat: z.string().max(160).optional(),
    }),
  ),
});
export type ChealthIndex = z.infer<typeof ChealthIndexSchema>;

// ─────────────────────────────────────────────────────────────
// Worker-only: sync status & trigger responses
// ─────────────────────────────────────────────────────────────

export const SyncStatusSchema = z.object({
  runningNow: z.boolean(),
  lastRunAt: IsoInstantSchema.nullable(),
  lastRunStatus: z.enum(['success', 'failure', 'cancelled', 'in_progress', 'queued', 'unknown']).nullable(),
  nextScheduledAt: IsoInstantSchema,
  /** Present for ~a minute after a manual trigger, so the UI can follow the run. */
  runId: z.string().nullable(),
  runUrl: z.string().nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const SyncTriggerResponseSchema = z.object({
  accepted: z.boolean(),
  runId: z.string().nullable(),
  message: z.string().max(200),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type SyncTriggerResponse = z.infer<typeof SyncTriggerResponseSchema>;

// ─────────────────────────────────────────────────────────────
// Kind ingest envelope (KOReader plugin → Worker → Actions)
// ─────────────────────────────────────────────────────────────

export const KindleIngestSchema = z.object({
  schemaVersion: z.literal(1),
  /** Aggregate only — the stats DB itself never leaves the Kindle (WAL safety). */
  device: z.string().max(64),
  koreaderVersion: z.string().max(32).nullable(),
  /** Schema version of the KOReader statistics DB this was read from. */
  dbSchemaVersion: z.number().int().nullable(),
  books: z.array(PaperrBookSchema),
  daily: z.array(z.object({ d: DayKeySchema, s: z.number().int().nonnegative(), p: z.number().int().nonnegative() })),
});
export type KindleIngest = z.infer<typeof KindleIngestSchema>;
