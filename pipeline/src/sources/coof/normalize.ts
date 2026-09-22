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

export function normalizeCoofRow(row: NotionPage, collection: string): NormalizeResult {
  const p = row.properties;
  const poster = propFile(p[COOF_PROPERTIES.poster]);

  const title: CoofTitle = {
    id: row.id,
    title: propText(p[COOF_PROPERTIES.title]) || '(无标题)',
    year: propIntFromText(p[COOF_PROPERTIES.year]),
    poster: null, // filled in after re-hosting
    collection,
    // Every row in these calendars is something already watched or being watched;
    // `FILM` distinguishes 影 (film) from 剧 (series), not watch state.
    status: 'watched',
    rating: propNumber(p['RATING']), // not in every calendar; null when absent
    watchedAt: propDate(p[COOF_PROPERTIES.watchedAt]),
    genres: propMultiSelect(p[COOF_PROPERTIES.genres]),
    runtimeMin: propIntFromText(p[COOF_PROPERTIES.runtime]),
    note: propText(p[COOF_PROPERTIES.note]) || null,
    director: propMultiSelect(p['DIRECTOR']),
    cast: propMultiSelect(p['CAST']),
    // Kept out of the published payload's required shape but useful downstream.
    country: propMultiSelect(p[COOF_PROPERTIES.country]),
    mediaType: propText(p[COOF_PROPERTIES.mediaType]) || null,
    order: propNumber(p[COOF_PROPERTIES.order]),
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
