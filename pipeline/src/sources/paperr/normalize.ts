/**
 * KOReader raw payload → PaperrIndex.
 *
 * Written against a REAL export off the device (41 books, 2026-09-24), not
 * against the plugin's source. The three mismatches below are all invisible if
 * you just spread the payload through — the first one rejects every book, the
 * other two produce a page that looks fine and is wrong:
 *
 *   · `lastOpen` is `"2026-09-24T09:14"`, with no UTC offset. KOReader writes
 *     local wall-clock time. `IsoInstantSchema` requires an offset, so the
 *     device's is attached here.
 *   · `series` is the literal string `"N/A"` when there is no series — a string,
 *     so `z.string().nullable()` accepts it and the page shows "N/A" instead of
 *     showing nothing.
 *   · `progressPct` is ABSENT, not null, for a book whose page count KOReader
 *     never learned.
 *
 * ── The one rule that keeps a no-op run from producing a commit ─────────
 *
 * `estFinishedAt` is projected from an anchor taken OUT OF THE DATA (the newest
 * day in `daily`), never from `new Date()`. Anchoring on today would make the
 * file differ every single day even when nobody read anything — which is exactly
 * the failure the pipeline's `stableJson` + `writeIfChanged` design exists to
 * prevent, and it would quietly burn GitHub Pages' build budget.
 */

import type { PaperrBook, PaperrIndex, PaperrRaw, PaperrRawBook } from '@cevtuo/schema';
// ⚠️ Paths and retention constants live behind the `./paths` subpath, not the
// package root — importing them from '@cevtuo/schema' fails at runtime with
// "Export named 'DATA_PATHS' not found", not at typecheck time, because the root
// export is a `export * from './index'` barrel that never re-exported paths.
import { DATA_PATHS, SERIES_DAYS } from '@cevtuo/schema/paths';
import { contentHash } from '@cevtuo/pipeline-core';

/**
 * ⚠️ Hard-coded to the device's offset rather than derived from the server's.
 * The Kindle writes local wall-clock time and does not tell us which zone it was
 * in; guessing from the pipeline host would be wrong the moment GitHub runs it
 * on a UTC runner. Asia/Shanghai is where this device is.
 */
const DEVICE_OFFSET = '+08:00';

/** Days of reading used for the finishing-pace projection. */
const PACE_WINDOW_DAYS = 14;

/**
 * ⚠️ Beyond this, the projection is noise rather than information: one page in
 * the last fortnight extrapolates to a finish date years away, and a date like
 * "2029-04-11" on a reading dashboard is worse than no date at all.
 */
const MAX_PROJECTION_DAYS = 365;

/** KOReader's own strings for "no series". Compared case-insensitively, trimmed. */
const NO_SERIES = new Set(['', 'n/a', 'na', 'none', '-', 'null', 'unknown', '未知']);

/**
 * Titles that mean "this is not a book".
 *
 * ⚠️ Written from the REAL export, where four of forty-one entries were
 * KOReader's own machinery rather than anything the reader chose to read: its
 * release notes twice ("v2026.07.2: KOReader 2026.07.2", "KOReader 2026.07
 * \"Sailing Walrus\""), the bare string "koreader", and two document UUIDs whose
 * metadata KOReader never managed to read.
 *
 * ⚠️ Deliberately CONSERVATIVE — it flags ARTIFACTS, not "content that is not a
 * novel". The reader's RSS digests (EpubPressX…, ART＆FASHION · …), the news
 * articles and the dictionary all stay exactly as they are. Those are things
 * they chose to open, and a rule that quietly relabelled them would be this
 * pipeline deciding what counts as reading.
 */
export const NON_BOOK_RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  // A bare UUID: KOReader could not read the document's metadata at all.
  { id: 'uuid', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  // "v2026.07.2: KOReader 2026.07.2" — the app's own release notes.
  { id: 'koreader-version', re: /^v?\d{4}\.\d{2}(?:\.\d+)?\s*:\s*koreader/i },
  // "koreader", "KOReader 快速开始向导", "KOReader 2026.07.1" — the app itself.
  { id: 'koreader', re: /^koreader\b/i },
  // The title KOReader substitutes when it extracts nothing usable.
  { id: 'untitled', re: /^e-?book$/i },
];

/** Which rule (if any) says this title is not a book. */
export function nonBookRule(title: string): string | null {
  const t = title.trim();
  for (const rule of NON_BOOK_RULES) if (rule.re.test(t)) return rule.id;
  return null;
}

/** How a flagged entry is displayed. The original is kept inside the parens. */
export function unknownLabel(n: number, original: string): string {
  return `unknown${n} (${original})`;
}

/** `"2026-09-24T09:14"` → `"2026-09-24T09:14+08:00"`. Already-offset values pass through. */
export function normalizeInstant(raw: string): string {
  const s = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return s;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (!m) throw new Error(`无法解析 lastOpen: ${JSON.stringify(raw)}`);
  return `${m[1]}${DEVICE_OFFSET}`;
}

export function normalizeSeries(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return NO_SERIES.has(s.toLowerCase()) ? null : s;
}

/**
 * Whether the book is finished — KOReader's rule, not ours.
 *
 * It counts a book finished at 99%+, and treats any reading at all as finished
 * when it never learned the page count. Reusing the device's rule keeps
 * `current` from disagreeing with the totals the device reported for the same
 * library.
 */
export function isFinished(b: Pick<PaperrRawBook, 'pages' | 'totalReadPages'>): boolean {
  const pages = b.pages ?? null;
  if (pages != null && pages > 0) return b.totalReadPages >= pages - 1;
  return b.totalReadPages > 0;
}

/** `"2026-09-24"` + 5 → `"2026-09-29"`. UTC arithmetic, so no DST surprises. */
export function addDays(day: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`不是 YYYY-MM-DD: ${JSON.stringify(day)}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface ProjectionInput {
  pages: number | null;
  totalReadPages: number;
  /** Pages turned per day across the whole library, over the recent window. */
  pagesPerDay: number;
  /** Newest day present in the data. NOT today. */
  anchorDay: string | null;
}

/** Projected finish day, or null when there is nothing to project from. */
export function projectFinishedAt({
  pages,
  totalReadPages,
  pagesPerDay,
  anchorDay,
}: ProjectionInput): string | null {
  if (anchorDay == null) return null;
  if (pages == null || pages <= 0) return null;
  const remaining = pages - totalReadPages;
  if (remaining <= 0) return null; // already finished
  if (!(pagesPerDay > 0)) return null; // no recent reading ⇒ no pace to project
  const days = Math.ceil(remaining / pagesPerDay);
  if (days > MAX_PROJECTION_DAYS) return null;
  return addDays(anchorDay, days);
}

export interface BuildOptions {
  /** Which path the payload arrived by. Surfaced in diagnostics. */
  ingestPath?: 'koreader-push' | 'koreader-sftp';
}

export function buildPaperrIndex(raw: PaperrRaw, opts: BuildOptions = {}): PaperrIndex {
  // ── Daily ──────────────────────────────────────────────────
  // Ascending by day, and trimmed to the retained window. The device exports
  // everything it has; the series is capped here so the payload stays small
  // enough for a cover-screen fetch.
  const daily = [...raw.daily]
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(-SERIES_DAYS)
    .map((d) => ({ d: d.d, s: Math.round(d.s), p: Math.round(d.p) }));

  const newest = daily.length ? daily[daily.length - 1] : undefined;
  const anchorDay = newest ? newest.d : null;

  // Global recent pace. ⚠️ `p` is KOReader's page-turn COUNT, which includes
  // re-reads of the same page — so this is a pace proxy, not a page count. It is
  // the only per-day figure the device sends, and a proxy is enough for "when
  // will this book be done".
  const windowStart = anchorDay ? addDays(anchorDay, -(PACE_WINDOW_DAYS - 1)) : null;
  const recent = windowStart ? daily.filter((d) => d.d >= windowStart) : [];
  const pagesPerDay = recent.reduce((n, d) => n + d.p, 0) / PACE_WINDOW_DAYS;

  // ── Books ──────────────────────────────────────────────────
  const books: PaperrBook[] = [...raw.books]
    .sort((a, b) => normalizeInstant(b.lastOpen).localeCompare(normalizeInstant(a.lastOpen)))
    .map((b) => ({
      id: b.id,
      title: b.title,
      authors: b.authors ?? '',
      series: normalizeSeries(b.series),
      pages: b.pages ?? null,
      totalReadPages: b.totalReadPages,
      totalReadTime: b.totalReadTime,
      lastOpen: normalizeInstant(b.lastOpen),
      // ⚠️ Kept as a float — the schema allows 0..100 and rounding here would
      // lose the difference between 53.7% and 54%. The page formats it.
      progressPct: b.progressPct ?? null,
      highlights: b.highlights,
      notes: b.notes,
      estFinishedAt: projectFinishedAt({
        pages: b.pages ?? null,
        totalReadPages: b.totalReadPages,
        pagesPerDay,
        anchorDay,
      }),
    }));

  // ── Not-a-book entries ─────────────────────────────────────
  //
  // ⚠️ Numbered by FIRST OPENED (ascending `lastOpen`), NOT by list position.
  // Position-based numbering would renumber everything whenever a book was added
  // or removed, so "unknown2" would point at a different document every sync —
  // worthless in a reading log. Chronological numbering keeps a label bound to
  // the entry that earned it.
  //
  // ⚠️ Nothing is dropped. The entry keeps its id, its page count and its
  // reading time; only the DISPLAYED title changes, the original is preserved
  // inside the parentheses, and the untouched original also remains in
  // raw-koreader.json. A mis-flagged entry is therefore always recoverable.
  const flagged = books
    .filter((b) => nonBookRule(b.title) != null)
    .sort((a, b) => a.lastOpen.localeCompare(b.lastOpen) || a.title.localeCompare(b.title));
  const renamed = new Map(flagged.map((b, i) => [b.id, unknownLabel(i + 1, b.title)]));
  const labelled: PaperrBook[] = books.map((b) => {
    const next = renamed.get(b.id);
    return next ? { ...b, title: next } : b;
  });

  // ── Current ────────────────────────────────────────────────
  // The book being read right now: most recently opened, and not finished.
  // Deliberately NOT "the top of the list" — the top entry is often a book that
  // was finished minutes ago, and a dashboard that says "currently reading" about
  // a book you just finished is the kind of wrong that gets noticed immediately.
  const current =
    labelled.find((b) => !isFinished({ pages: b.pages, totalReadPages: b.totalReadPages })) ?? null;

  const body = {
    schemaVersion: 1 as const,
    current,
    books: labelled,
    totals: raw.totals,
    daily,
    lastIngestPath: opts.ingestPath ?? 'koreader-push',
  };

  // ⚠️ Hashed over the body WITHOUT `dataVersion` and WITHOUT `exportedAt` (which
  // is not in the body at all). Including either would change the hash on every
  // export and turn every sync into a commit.
  return { ...body, dataVersion: contentHash(body) };
}

/** Where the raw payload is read from. Re-exported so the CLI and tests agree. */
export const RAW_PATH = DATA_PATHS.paperrRaw;
