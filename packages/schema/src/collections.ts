/**
 * The COO collection registry.
 *
 * Verified against the live Notion API on 2026-09-22 by walking the `COO` parent
 * database (`a35c1efc-771a-4bd4-bb19-1d78d057c309`) and resolving each collection
 * page's child database.
 *
 * ⚠️ These are DATABASE ids. A collection's PAGE id is a different id — e.g.
 * COOF2026 the page is `2da09462-a4af-80d5-8323-d2862ebae06f` while the database
 * it displays is `2da09462-a4af-8040-a7dc-fb733cb776c5`. Querying the page id as
 * a database returns 404 and looks like a permissions failure, which is a
 * genuinely confusing way to lose an hour. Use the ids below.
 *
 * ⚠️ `fields` is the count observed at discovery time, kept here so the pipeline
 * can log when a collection's shape drifts. The COOF calendars share a schema and
 * can use one mapper; COOS and COOB5 plainly do not, and must not be forced
 * through it.
 */

export interface CooCollection {
  /** Stable key, also the switcher label. */
  key: string;
  /** Notion database id — NOT the page id. */
  databaseId: string;
  /** Property count observed at discovery. */
  fields: number;
  /**
   * `calendar` — the COOF year lists. Share one schema; safe to map together.
   * `other`    — structurally different (3–15 fields). Needs its own mapper or
   *              an explicit exclusion; do not assume COOF's shape.
   */
  shape: 'calendar' | 'other';
  /** Open the COOF page on this collection. */
  primary?: boolean;
}

export const COO_COLLECTIONS: CooCollection[] = [
  { key: 'COOF2026', databaseId: '2da09462-a4af-8040-a7dc-fb733cb776c5', fields: 10, shape: 'calendar', primary: true },
  { key: 'COOF2025', databaseId: '16909462-a4af-81c7-aa98-ddd5cb52b114', fields: 10, shape: 'calendar' },
  { key: 'COOF2024', databaseId: '0d293551-3e02-428f-93ce-0a76d63ab3b1', fields: 9, shape: 'calendar' },
  { key: 'COOF2023', databaseId: 'b1c4c467-e914-476a-8ffa-35f5f3b59e00', fields: 9, shape: 'calendar' },
  { key: 'COOF2022', databaseId: '375ccfda-72db-4704-b8ab-8d70c1768aad', fields: 9, shape: 'calendar' },
  { key: 'COOF2021', databaseId: 'd361e5c0-4619-4a76-9246-7d5c6ecfc653', fields: 8, shape: 'calendar' },
  { key: 'COOF2020', databaseId: '48bb6f6e-c953-4ac5-84e8-b089f5481e78', fields: 7, shape: 'calendar' },

  // Not year calendars — different schemas, kept out of the switcher's default set.
  { key: 'COOM', databaseId: '18909462-a4af-80bb-b5ec-f25a7190332f', fields: 8, shape: 'other' },
  { key: 'COOS', databaseId: '18909462-a4af-8079-9860-ea2ce0d54da6', fields: 3, shape: 'other' },
  { key: 'COOB5', databaseId: '17209462-a4af-805a-bcce-f388b698af94', fields: 15, shape: 'other' },
  // No child database — 100 raw blocks, so it needs a block walker, not a query.
  { key: 'COO TL:DR HAVE READ', databaseId: '', fields: 0, shape: 'other' },
];

export const PRIMARY_COLLECTION = COO_COLLECTIONS.find((c) => c.primary)?.key ?? 'COOF2026';

/** The year calendars, newest first — this is what the switcher shows. */
export const CALENDAR_COLLECTIONS = COO_COLLECTIONS.filter((c) => c.shape === 'calendar');

export function collectionByKey(key: string): CooCollection | undefined {
  return COO_COLLECTIONS.find((c) => c.key === key);
}

/**
 * The COOF property map, confirmed against COOF2026 and COOF2025 (identical).
 *
 * ⚠️ `time` is a rich_text holding the runtime in minutes ("86"), not a number
 * property — parse it. `YEAR` is likewise rich_text, not a number.
 * ⚠️ Older calendars have fewer properties (2020 has 7), so every field except
 * NAME must be treated as optional by the mapper.
 */
export const COOF_PROPERTIES = {
  title: 'NAME',
  order: 'NUM',
  watchedAt: 'Date',
  year: 'YEAR',
  mediaType: 'FILM', // "影" | "剧"
  runtime: 'time',
  country: 'COUNTRY',
  genres: 'KIND',
  poster: 'POSTER',
  note: 'OTHER',
} as const;
