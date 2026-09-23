/**
 * The `dataVersion` of a COOF library payload.
 *
 * ⚠️ One definition, two writers. `sync.ts` rebuilds `library.json` from Notion
 * and `cli/local-posters.ts` patches posters into it afterwards. If they compute
 * the version differently, whichever runs second sees a value it did not
 * produce, rewrites the file, and the no-commit-storm guarantee is gone. So
 * neither is allowed to inline this — both call this function.
 *
 * ⚠️ It hashes the WHOLE payload, not a summary of it. The previous version
 * hashed `{collection, ids}`, which violated the rule stated in
 * `packages/schema` — "a brand payload carries `dataVersion`, a hash of its own
 * content". The failure was silent and real: 704 rows in the 2020–2023
 * calendars went from `(无标题)` to their actual film titles, every one of those
 * titles is rendered by the app, and the version did not move by a single
 * character. Any consumer caching on it would have served the placeholder names
 * indefinitely. Poster paths are included for the same reason — the backfill
 * changes what the app displays.
 */
import { contentHash } from '@cevtuo/pipeline-core';
import type { CoofTitle } from '@cevtuo/schema';

export function coofLibraryVersion(collection: string, titles: CoofTitle[]): string {
  return contentHash({ collection, titles });
}
