/**
 * The index page's panel order, in one place.
 *
 * ⚠️ Every brand page's back control names the panel it should return to
 * (`/pages/home/index?panel=2`). Those numbers are positions in the home page's
 * panel list, so if the two ever disagree, pressing back from CAPPERR lands the
 * reader on COOF — which is precisely the bug this file exists to prevent
 * recurring.
 *
 * ⚠️ The numbers are POSITIONS, not identifiers. Inserting a brand in the middle
 * shifts everything below it, so this map and `PANELS` in `pages/home/index.tsx`
 * have to be edited together. `verify-back.mjs` drives a real back press from
 * every brand and would catch a drift.
 */
export const PANEL_INDEX = {
  coof: 0,
  cnsr: 1,
  paperr: 2,
  chealth: 3,
} as const;

/** `/pages/home/index?panel=2` — where "back" goes with no page to pop. */
export const homePanelUrl = (key: keyof typeof PANEL_INDEX): string =>
  `/pages/home/index?panel=${PANEL_INDEX[key]}`;
