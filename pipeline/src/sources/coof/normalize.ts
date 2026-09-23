/**
 * COOF row → CoofTitle.
 *
 * Verified against the live COOF2026 and COOF2025 databases. Two things about
 * this data that are easy to get wrong:
 *
 *   · `time` (runtime) and `YEAR` are rich_text, not number properties. They hold
 *     "86" and "2025". Reading `.number` returns undefined and the values vanish
 *     with no error — hence propIntFromText.
 *   · Older calendars have fewer columns (COOF2020 has 7, COOF2026 has 10), so
 *     every property except NAME is optional here.
 */

import { COOF_PROPERTIES, type CoofTitle } from '@cevtuo/schema';

import {
  propDate,
  propFile,
  propIntFromText,
  propMultiSelect,
  propNumber,
  propText,
  type NotionPage,
  type NotionProperty,
} from '../../notion';

/**
 * Notion's `NUM` runs newest-largest (148, 147, 146 …). Sorting by it descending
 * gives the date order the COOF page wants without depending on `Date` being
 * filled in, which early rows sometimes aren't.
 */
export function sortKey(t: CoofTitle): [number, string, string] {
  return [t.order ?? -1, t.watchedAt ?? '', t.title];
}

export interface NormalizeResult {
  title: CoofTitle;
  /** Poster URL still pointing at Notion; the caller re-hosts it. */
  posterUrl: string | null;
}

// ─────────────────────────────────────────────────────────────
// Property resolution
//
// ⚠️ The calendars USED TO disagree about almost every column name and type:
//
//   calendar   title prop    order prop            date prop   year prop
//   COOF2026   NAME [title]  NUM  [number]         Date [date] YEAR [rich_text]
//   COOF2025   NAME [title]  NUM  [number]         Date [date] YEAR [rich_text]
//   COOF2024   NAME [title]  NUMBER [number]       Date [date] YEAR [rich_text]
//   COOF2023   name [text]   "num " [title]        TIME [date] year [rich_text]
//   COOF2022   name [text]   num  [number]         date [date] year [NUMBER]
//   COOF2021   name [text]   cou  [number]         time [date] year [rich_text]
//   COOF2020   "cou." [title] "n+A2:H161um." [num] time [text] year [rich_text]
//
// Missing that cost four years of titles: 704 rows came out as "(无标题)"
// because `NAME` is absent there and the columns are lowercase `name`. Worse,
// the title-typed column in those calendars held a SEQUENCE NUMBER ("145") or a
// genre string ("剧情/英国"), so trusting the Notion title type published
// non-titles that looked like real data.
//
// ⚠️ That divergence is now GONE. `cli/migrate-calendars.ts` renamed, retyped
// and moved every calendar onto COOF2026's exact schema, and the superseded
// columns were dropped. Every lookup below therefore reads one canonical name
// with no fallback chain — and the chains are deliberately not kept "just in
// case": a stale fallback is not inert, it re-binds to whatever column later
// occupies that name. `mediaType`'s old `'other'` fallback did exactly that and
// started reporting the source (Netflix, Douban) as the media type.
//
// `normKey` and the `first*` helpers stay: names still need case/whitespace
// tolerance, and columns still hold different value types (a date column beside
// a rich_text one), so the readers must accept whatever type they find.
// ─────────────────────────────────────────────────────────────

/** Normalise a column name for comparison: lowercase, no spaces, no punctuation. */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[\s._]+/g, '');
}

/** Every property whose named candidate matches, in the declared order. */
export function findProps(p: Record<string, NotionProperty>, ...names: string[]): NotionProperty[] {
  const byNorm = new Map<string, NotionProperty>();
  for (const [k, v] of Object.entries(p)) {
    const nk = normKey(k);
    if (!byNorm.has(nk)) byNorm.set(nk, v); // first wins on a collision
  }
  const out: NotionProperty[] = [];
  for (const n of names) {
    const hit = byNorm.get(normKey(n));
    if (hit) out.push(hit);
  }
  return out;
}

/** First candidate that yields a non-empty string. */
export function firstText(p: Record<string, NotionProperty>, ...names: string[]): string {
  for (const prop of findProps(p, ...names)) {
    const t = propText(prop);
    if (t) return t;
  }
  return '';
}

/** First candidate that yields a positive integer. Handles text, number, select. */
export function firstInt(p: Record<string, NotionProperty>, ...names: string[]): number | null {
  for (const prop of findProps(p, ...names)) {
    const n = propIntFromText(prop) ?? propNumber(prop);
    if (n !== null) return n;
  }
  return null;
}

/**
 * First candidate that yields a day key.
 *
 * ⚠️ `COOF2020.time` is rich_text holding a date STRING, not a `date` property —
 * `propDate` only reads `.date.start`, so those rows would lose their watch date
 * entirely. The text form is parsed back into a day key here.
 */
export function firstDate(p: Record<string, NotionProperty>, ...names: string[]): string | null {
  for (const prop of findProps(p, ...names)) {
    const d = propDate(prop);
    if (d) return d;

    const raw = propText(prop);
    // ISO, as written in the newer calendars.
    const iso = raw.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];

    // ⚠️ COOF2020 writes its dates as "2020.5.4" / "20.1.26" in a rich_text
    // column, so neither `propDate` (a date property, which it is not) nor the
    // ISO pattern matches and every one of those 216 rows lost its watch date.
    // ⚠️ The two-digit year is 2000-based — the calendar spans 2020 onward, and
    // "20.1.26" is 2020-01-26, not 1920.
    const dotted = raw.match(/^(\d{2,4})[.\/](\d{1,2})[.\/](\d{1,2})$/);
    if (dotted) {
      // ⚠️ Destructured with explicit defaults: `noUncheckedIndexedAccess` makes
      // every capture group `string | undefined`, and the guard below is what
      // turns that into a usable value rather than an assertion.
      const y = dotted[1] ?? '';
      const mo = dotted[2] ?? '';
      const d2 = dotted[3] ?? '';
      if (!y || !mo || !d2) return null;
      const year = y.length === 2 ? 2000 + Number(y) : Number(y);
      return `${year}-${mo.padStart(2, '0')}-${d2.padStart(2, '0')}`;
    }
    // Some cells hold a stray time ("12:00:00 AM") instead of a date; those rows
    // genuinely have no date, and null is the honest answer.
  }
  return null;
}

/**
 * First candidate that yields a list. `multi_select` is preferred, but several
 * calendars store the same field as `select` or as a slash-separated
 * rich_text ("罗马尼亚 / 塞尔维亚 / 瑞典"), so those are split too.
 */
export function firstList(p: Record<string, NotionProperty>, ...names: string[]): string[] {
  for (const prop of findProps(p, ...names)) {
    const sel = propMultiSelect(prop);
    if (sel.length) return sel;
    const single = prop.select?.name;
    if (single) return [single];
    const text = propText(prop);
    if (text) {
      return text
        .split(/[/、,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function normalizeCoofRow(row: NotionPage, collection: string): NormalizeResult {
  const p = row.properties;
  const poster = propFile(p[COOF_PROPERTIES.poster]);

  const title: CoofTitle = {
    id: row.id,
    // ⚠️ `film` is COOF2020's title column, and it is checked BEFORE the Notion
    // title-type one. In that calendar `cou.` is the title-typed property but
    // holds "剧情/英国" — genre and country jammed together — while the actual
    // movie name sits in the plain `film` column. Trusting the title type there
    // publishes a genre string as a film name, which is worse than "(无标题)"
    // because it looks like real data.
    title: firstText(p, COOF_PROPERTIES.title) || '(无标题)',
    year: firstInt(p, COOF_PROPERTIES.year),
    poster: null, // filled in after re-hosting
    collection,
    // Every row in these calendars is something already watched or being watched;
    // `FILM` distinguishes 影 (film) from 剧 (series), not watch state.
    status: 'watched',
    // `RATING` is absent from most calendars; when present it is a number.
    rating: propNumber(findProps(p, 'RATING')[0]),
    watchedAt: firstDate(p, COOF_PROPERTIES.watchedAt),
    genres: firstList(p, COOF_PROPERTIES.genres),
    runtimeMin: firstInt(p, COOF_PROPERTIES.runtime),
    note: firstText(p, COOF_PROPERTIES.note) || null,
    director: firstList(p, 'DIRECTOR'),
    cast: firstList(p, 'CAST'),
    // Kept out of the published payload's required shape but useful downstream.
    country: firstList(p, COOF_PROPERTIES.country),
    // ⚠️ No `other` fallback. It used to be there because COOF2023 kept 影/剧 in
    // its rich_text `other` column — but now that every calendar shares one
    // schema, "other" resolves to OTHER, which holds the SOURCE (Netflix,
    // Douban, BBC). Measured before removal: COOF2020 read "Douban", COOF2022
    // "Amazon Prime", COOF2023 "BBC" as the media type. The value belongs to
    // FILM; there is nothing to fall back to.
    mediaType: firstText(p, COOF_PROPERTIES.mediaType) || null,
    order: firstInt(p, COOF_PROPERTIES.order),
  };

  return { title, posterUrl: poster?.url ?? null };
}

export function normalizeAll(rows: NotionPage[], collection: string): NormalizeResult[] {
  return rows
    .map((row) => normalizeCoofRow(row, collection))
    .sort((a, b) => {
      const [ao, ad, at] = sortKey(a.title);
      const [bo, bd, bt] = sortKey(b.title);
      if (ao !== bo) return bo - ao; // NUM descending — newest first
      if (ad !== bd) return bd.localeCompare(ad);
      return at.localeCompare(bt);
    });
}
