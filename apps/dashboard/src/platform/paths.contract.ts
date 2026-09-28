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
 * ⚠️ ONLY the sealed health path may appear in the app's copy.
 *
 * This assertion used to be `Extract<..., never>` — no `chealth*` key at all —
 * on the premise that a `data/` path is world-readable and health data must
 * therefore never be published. **The premise held; the payload changed.** The
 * ingest now seals the index with AES-GCM before publishing, so what is at that
 * URL is ciphertext.
 *
 * ⚠️ Narrowed, not removed, and the distinction is load-bearing. It still fails
 * for any OTHER health path, so a second, plaintext one cannot be added by
 * accident — which is exactly the mistake this guard was written to catch, and
 * exactly the mistake it DID catch on 2026-09-24 when an unencrypted
 * `data/chealth/index.json` was briefly live.
 */
type _HealthPathsAreSealedOnly = Assert<
  Exact<Extract<keyof typeof Local.DATA_PATHS, `c${string}health${string}`>, 'chealthSealed'>
>;

export type { _DataPathsInSync, _BrandInSync, _NotesPerPageInSync, _HealthPathsAreSealedOnly };
