#!/usr/bin/env bun
/**
 * Re-link posters that already exist on disk, with NO network access.
 *
 *   bun run pipeline/src/cli/relink-posters.ts --write
 *
 * ⚠️ Why this is separate from local-posters.ts. That tool searches Douban for
 * missing images and takes ~1.2s per title by design (rate limiting). This one
 * only asks "is there already a valid JPEG for this id?" and is therefore
 * instant — which matters, because the case it exists for is a sync run having
 * just nulled every poster field while the image files sat untouched on disk.
 * Repairing that should never require re-querying a third party.
 *
 * ⚠️ Disk is authoritative here. The image files are the durable artifact; the
 * `poster` column is only a pointer to them, and Notion is the *least* reliable
 * source of all three (its URLs expire hourly, and four calendars have no
 * poster column at all).
 */

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { CALENDAR_COLLECTIONS, CoofLibrarySchema, type CoofTitle } from '@cevtuo/schema';
import { stableJson } from '@cevtuo/pipeline-core';

import { existingPosterPath } from '../sources/coof/posters';
import { coofLibraryVersion } from '../sources/coof/version';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DATA_DIR = join(ROOT, 'data');
const WRITE = process.argv.includes('--write');

let linked = 0;
let stillMissing = 0;

for (const col of CALENDAR_COLLECTIONS) {
  const path = join(DATA_DIR, 'coof', col.key, 'library.json');
  const lib = JSON.parse(await readFile(path, 'utf8')) as {
    dataVersion: string;
    titles: CoofTitle[];
  };

  let changed = false;
  const titles: CoofTitle[] = [];
  for (const t of lib.titles) {
    if (t.poster) {
      titles.push(t);
      continue;
    }
    const path = await existingPosterPath(t.id, DATA_DIR);
    if (!path) {
      stillMissing++;
      titles.push(t);
      continue;
    }
    changed = true;
    linked++;
    titles.push({ ...t, poster: path });
  }

  if (changed && WRITE) {
    // Same rule as the other two writers: the version hashes the whole payload,
    // so a repair run must move it. Leaving it stale here would have the next
    // sync rewrite the file purely to fix the version.
    const next = { ...lib, dataVersion: coofLibraryVersion(col.key, titles), titles };
    CoofLibrarySchema.parse({ ...next, schemaVersion: 1, collection: col.key });
    await writeFile(path, stableJson(next), 'utf8');
    console.log(`  ✎ ${col.key}: ${titles.filter((t) => t.poster).length}/${titles.length}`);
  } else if (changed) {
    console.log(`  · ${col.key}: 可补 ${titles.filter((t) => t.poster).length}/${titles.length} (dry-run)`);
  }
}

console.log(`\n  已链接 ${linked} 张${WRITE ? '' : ' (dry-run 未写)'}, 仍缺 ${stillMissing} 张`);
// ⚠️ This line used to read "仍缺的条目大多是没有片名的占位行 —— 它们本来就无图可补",
// which was wrong by an order of magnitude and dangerous: it tells the reader the
// remaining gap is unfixable, so nobody looks. Measured 2026-09-23 — of 483
// posters missing after a repair run, only 18 were `(无标题)` placeholders. The
// other 465 are real, named films that simply have not been backfilled yet.
console.log('  仍缺的绝大多数**有片名**，只是还没从豆瓣回填 —— 跑 local-posters.ts。');
console.log('  只有极少数是无片名占位行，那些确实无图可补。\n');
