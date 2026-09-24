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
import { LOCAL_PATHS, SERIES_DAYS } from '@cevtuo/schema/paths';
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
 * Three-way triage of titles, taken from the REAL export.
 *
 * ⚠️ Order is load-bearing: HIDDEN first, then NEWS, then UNKNOWN. An entry must
 * never reach a later stage once an earlier one has claimed it, or a KOReader
 * document ends up both hidden and numbered.
 *
 * ⚠️ All numbering is CHRONOLOGICAL (ascending `lastOpen`), never positional.
 * Position-based numbers renumber every entry whenever a book is added or
 * removed, so "news3" would point at a different document on every sync — which
 * is worse than no label at all in a reading log.
 *
 * ⚠️ And deliberately CONSERVATIVE throughout. These rules flag ARTIFACTS and
 * GENERATED DIGESTS, not "content that is not a novel". Articles the reader
 * opened by name ("Samsung brings seamless updates to…", "Beef production in
 * Brazil…") keep their real headlines — relabelling those would be this pipeline
 * deciding what counts as reading.
 */

/** KOReader's own documents. Dropped from the payload entirely. */
const HIDDEN_RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  // "v2026.07.2: KOReader 2026.07.2" — the app's release notes.
  { id: 'koreader-version', re: /^v?\d{4}\.\d{2}(?:\.\d+)?\s*:\s*koreader/i },
  // "koreader", "KOReader 快速开始向导", "KOReader 2026.07.1", "KOReader 2026.07 "Sailing Walrus"".
  { id: 'koreader', re: /^koreader\b/i },
];

/**
 * Generated news digests. Renamed to `newsN`.
 *
 * Two shapes, both machine-made: the EpubPressX dated edition, and the
 * "<section> · <date>" digest (ART＆FASHION, COUNTRY, FINANCE, 未分类,
 * HACKER NEWSROOM, hack…). Everything else keeps its title.
 */
const NEWS_RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'epubpressx', re: /^EpubPressX\s+\d{4}-\d{1,2}-\d{1,2}/i },
  { id: 'digest', re: /^.+ · \d{4}-\d{2}-\d{2}$/ },
];

/**
 * Authors that are not authors.
 *
 * ⚠️ This set is what separates a FEED from a BOOK, and it is more reliable than
 * the title: the four bare headlines in the real export ("Samsung brings
 * seamless updates…", "Beef production in Brazil…") carry the same `N/A` or
 * `EpubPressX` author as the digests they were opened from.
 */
const NOT_AN_AUTHOR = new Set([
  '', 'n/a', 'na', 'none', 'unknown', 'epubpressx', 'rss daily digest',
]);

export function hasRealAuthor(authors: string | undefined): boolean {
  return !NOT_AN_AUTHOR.has((authors ?? '').trim().toLowerCase());
}

/**
 * A headline rather than a title.
 *
 * ⚠️ A length test, which is a heuristic and is treated as one: 40 characters
 * is comfortably above every real title in the export (the longest is the
 * 17-character dictionary) and comfortably below every headline (51–115). The
 * author check rides along so that a genuine book with a long title and a real
 * author is NOT swept up — and if one ever is, the original stays in the
 * parentheses and the raw export is untouched, so it is a one-line fix.
 */
const HEADLINE_MIN_LENGTH = 40;

/**
 * Entries with no usable title. Renamed to `unknownN (原名)`.
 *
 * ⚠️ `eBook` lands here and it is NOT the same species as the hidden ones: those
 * are real books whose title KOReader failed to extract — one had 44 minutes of
 * reading against it. The original is kept in the parentheses precisely so that
 * stays visible.
 */
const UNKNOWN_RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'uuid', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  { id: 'untitled', re: /^e-?book$/i },
];

function matchRule(rules: ReadonlyArray<{ id: string; re: RegExp }>, title: string): string | null {
  const t = title.trim();
  for (const rule of rules) if (rule.re.test(t)) return rule.id;
  return null;
}

export const hiddenRule = (title: string): string | null => matchRule(HIDDEN_RULES, title);
export const newsRule = (b: { title: string; authors?: string }): string | null => {
  const byTitle = matchRule(NEWS_RULES, b.title);
  if (byTitle) return byTitle;
  if (b.title.trim().length >= HEADLINE_MIN_LENGTH && !hasRealAuthor(b.authors)) return 'headline';
  return null;
};
export const unknownRule = (title: string): string | null => matchRule(UNKNOWN_RULES, title);

export const newsLabel = (n: number, original: string): string => `news${n} (${original})`;
/** How an untitled entry is displayed. The original is kept inside the parens. */
export const unknownLabel = (n: number, original: string): string => `unknown${n} (${original})`;

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
      originalTitle: null, // set below, only when the title is rewritten
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

  // ── Triage ─────────────────────────────────────────────────
  //
  // ⚠️ Nothing is destroyed at the source: the untouched original stays in
  // raw-koreader.json, and the renamed forms keep their full ids, page counts
  // and reading time. Re-running this after a rule change is enough to undo
  // anything — which is exactly why the rules live here and not in the plugin.
  const visible = books.filter((b) => hiddenRule(b.title) == null);

  const renamed = new Map<string, string>();
  const rename = (
    rule: (b: PaperrBook) => string | null,
    label: (n: number, b: PaperrBook) => string,
  ): void => {
    visible
      .filter((b) => rule(b) != null)
      .sort((a, b) => a.lastOpen.localeCompare(b.lastOpen) || a.title.localeCompare(b.title))
      .forEach((b, i) => renamed.set(b.id, label(i + 1, b)));
  };
  // Disjoint rule sets, so the order between these two does not matter — only
  // the order relative to HIDDEN above does.
  rename((b) => newsRule(b), (n, b) => newsLabel(n, b.title));
  rename((b) => unknownRule(b.title), (n, b) => unknownLabel(n, b.title));

  const labelled: PaperrBook[] = visible.map((b) => {
    const next = renamed.get(b.id);
    // `originalTitle` is set ONLY when the display title was rewritten, so
    // "was this relabelled?" is answerable from the data alone.
    return next ? { ...b, title: next, originalTitle: b.title } : b;
  });

  // ⚠️ Recomputed over the VISIBLE set rather than passed through from the
  // device. Passing the device's numbers through would print "41 本" above a
  // list of 36 rows, and the five that went missing are KOReader's own release
  // notes. The device's own totals are still in raw-koreader.json.
  const totals = {
    booksStarted: labelled.length,
    booksFinished: labelled.filter((b) =>
      isFinished({ pages: b.pages, totalReadPages: b.totalReadPages }),
    ).length,
    readSeconds: labelled.reduce((n, b) => n + b.totalReadTime, 0),
    pagesTurned: labelled.reduce((n, b) => n + b.totalReadPages, 0),
  };

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
    totals,
    daily,
    lastIngestPath: opts.ingestPath ?? 'koreader-push',
  };

  // ⚠️ Hashed over the body WITHOUT `dataVersion` and WITHOUT `exportedAt` (which
  // is not in the body at all). Including either would change the hash on every
  // export and turn every sync into a commit.
  return { ...body, dataVersion: contentHash(body) };
}

/**
 * Where the raw payload is read from. Re-exported so the CLI and the tests agree.
 *
 * ⚠️ `LOCAL_PATHS`, not `DATA_PATHS`: this file is not a published payload, it
 * is the server's working copy of the device's export.
 */
export const RAW_PATH = LOCAL_PATHS.paperrRaw;
