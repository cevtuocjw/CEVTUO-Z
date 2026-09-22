/**
 * Drift guard for the duplicated paths module.
 *
 * `./paths.ts` is a copy of `packages/schema/src/paths.ts` (see the reasoning
 * there). A copy is only safe if something FAILS when it goes stale, so this
 * file does that at typecheck time.
 *
 * ⚠️ Everything here is `import type`, so nothing in this file reaches the
 * bundle. That is what makes it free.
 */

import type * as Canonical from '../../../../packages/schema/src/paths';

import type * as Local from './paths';

/** True only when two types are identical (invariant, not just assignable). */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

/**
 * If this line errors, the app's copy of DATA_PATHS has drifted from the
 * canonical one. Fix `./paths.ts`, do not delete the assertion.
 */
type _DataPathsInSync = Assert<Exact<typeof Local.DATA_PATHS, typeof Canonical.DATA_PATHS>>;

type _BrandInSync = Assert<Exact<typeof Local.BRAND, typeof Canonical.BRAND>>;

type _NotesPerPageInSync = Assert<
  Exact<typeof Local.CNSR_NOTES_PER_PAGE, typeof Canonical.CNSR_NOTES_PER_PAGE>
>;

/**
 * Chealth must stay OUT of the app's copy. If this ever stops being `never`,
 * someone has added a private path to the public bundle.
 */
type _ChealthStaysOut = Assert<
  Exact<Extract<keyof typeof Local.DATA_PATHS, `c${string}health${string}`>, never>
>;

export type { _DataPathsInSync, _BrandInSync, _NotesPerPageInSync, _ChealthStaysOut };
