#!/usr/bin/env bun
/**
 * CE-PaperR pipeline — the KOReader export → `data/paperr/index.json`.
 *
 *   bun run pipeline/src/cli/sync-paperr.ts
 *   bun run pipeline/src/cli/sync-paperr.ts --dry-run
 *
 * A separate entry point rather than another branch of `sync.ts`. `sync.ts`
 * exits 1 for any source but `coof`, CNSR already has its own driver
 * (`scripts/cnsr-sync.mjs`), and folding a third source into one file is how the
 * "`--only learn` 删光了 shopping 的图" class of bug happens.
 *
 * ⚠️ There is NO network call here. The raw payload is already in the repo —
 * either committed by the ingest server (`services/ingest`, the automatic path)
 * or copied in by hand (the USB fallback). That is deliberate: a converter bug
 * is then always fixable by re-running this over data already on disk, instead
 * of asking the reader to go find WiFi again.
 */

import { join } from 'node:path';

import { PaperrRawSchema, SyncMetaSchema, type PerSourceStatus } from '@cevtuo/schema';
import { DATA_PATHS, LOCAL_PATHS } from '@cevtuo/schema/paths';
import {
  contentHash,
  isoInstant,
  nextScheduledAt,
  readJson,
  repoPath,
  scrubError,
  stableJson,
  writeIfChanged,
} from '@cevtuo/pipeline-core';

import { buildPaperrIndex } from '../sources/paperr/normalize';

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = repoPath('data');
const RAW_PATH = repoPath(LOCAL_PATHS.paperrRaw);
const INDEX_PATH = repoPath(DATA_PATHS.paperrIndex);
const META_PATH = join(DATA_DIR, 'sync-meta.json');

/** Mirrors the coof cadence so `nextScheduledAt` means the same thing app-wide. */
const CADENCE_HOURS = 5;

/**
 * ⚠️ A week, not the 15 hours coof uses. Reading stats arrive whenever the
 * device happens to be on WiFi — treating "no sync for 15 hours" as stale would
 * paint the diagnostics panel red every night. A week of silence is a real
 * signal that the plugin stopped working.
 */
const STALE_AFTER_HOURS = 24 * 7;

/** Which path the payload arrived by. The USB fallback is recorded as such. */
function ingestPath(): 'koreader-push' | 'koreader-sftp' {
  return process.argv.includes('--from-sftp') ? 'koreader-sftp' : 'koreader-push';
}

const started = Date.now();
const now = new Date();

console.log(`\n═══ CE-PAPERR 同步 ═══`);
console.log(`  来源: ${LOCAL_PATHS.paperrRaw}`);
console.log(`  模式: ${DRY_RUN ? 'DRY RUN (不写文件)' : '写入'}\n`);

const raw = await readJson(RAW_PATH);
if (raw == null) {
  console.error(`✗ 找不到原始导出: ${LOCAL_PATHS.paperrRaw}`);
  console.error('  插件把文件写在 Kindle 的 /mnt/us/cevtuo-capperr.json，');
  console.error('  自动同步由 services/ingest 提交，手动路径是复制进仓库。');
  process.exit(1);
}

let index;
try {
  const parsed = PaperrRawSchema.parse(raw);
  index = buildPaperrIndex(parsed, { ingestPath: ingestPath() });
} catch (error) {
  const e = scrubError(error);
  console.error(`✗ 原始导出不符合 PaperrRawSchema: ${e.code} ${e.message}`);
  process.exit(1);
}

const won = index.books.filter((b) => b.estFinishedAt != null).length;
console.log(`  ▸ ${index.books.length} 本书，每日 ${index.daily.length} 天`);
console.log(`  ▸ 进度可算 ${index.books.filter((b) => b.progressPct != null).length} 本`);
console.log(`  ▸ 可预测读完时间 ${won} 本`);
console.log(`  ▸ 当前在读: ${index.current ? index.current.title : '(无)'}`);

// ── Write ────────────────────────────────────────────────────
//
// ⚠️ ONE file, and `current` is in it. This was briefly split so that "which
// book is open right now" stayed private while everything else went public; the
// reader decided the whole reading dashboard is fine to publish, so the split is
// gone and there is no second file to keep in step.
//
// ⚠️ `dataVersion` still hashes the body WITHOUT `current`. Switching books
// changes it, and hashing it would produce a commit for something no chart
// shows — the exact no-op-commit failure the rest of this pipeline is built to
// avoid.
const body = {
  schemaVersion: 1 as const,
  current: index.current,
  books: index.books,
  totals: index.totals,
  daily: index.daily,
  hourly: index.hourly,
  monthly: index.monthly,
  lastIngestPath: index.lastIngestPath,
};
const publicIndex = { ...body, dataVersion: contentHash({ ...body, current: null }) };

let written = 0;
let unchanged = 0;

if (DRY_RUN) {
  console.log('\n  · dry-run：不写文件');
} else {
  const outcome = await writeIfChanged(INDEX_PATH, stableJson(publicIndex));
  if (outcome === 'written') {
    written++;
    console.log(`\n  ✓ 写入 ${DATA_PATHS.paperrIndex} (dataVersion ${publicIndex.dataVersion})`);
  } else {
    unchanged++;
    console.log(`\n  · ${DATA_PATHS.paperrIndex} 无变化，跳过`);
  }
}

// ── sync-meta ────────────────────────────────────────────────
//
// ⚠️⚠️ MERGE, never replace. `sync.ts` builds its meta with
// `sources: status` — the sources THAT RUN wrote — and writes the whole file.
// Copying that shape here would erase the `notion-coof` entry every time the
// Kindle synced, and the diagnostics panel would report a healthy COOF pipeline
// as missing. This project has already lost data once to cleanup logic that only
// looked at the current run; merging is the fix, not a nicety.
const status: PerSourceStatus = {
  id: 'koreader-push',
  status: 'ok',
  lastAttemptAt: isoInstant(now),
  lastSuccessAt: isoInstant(now),
  itemsIn: index.books.length,
  changed: written > 0,
  latencyMs: Date.now() - started,
  staleAfterHours: STALE_AFTER_HOURS,
};

if (!DRY_RUN) {
  const existing = await readJson(META_PATH).catch(() => null);
  const parsedMeta = existing ? SyncMetaSchema.safeParse(existing) : null;

  if (!parsedMeta?.success) {
    // ⚠️ No meta yet (or it does not validate). Writing one now would be the
    // very replacement this comment warns about — it would claim paperr is the
    // only source in the project. Leave it to the coof run, which owns the file.
    console.log('  · sync-meta.json 不存在或不合格，跳过（由 coof 那一轮负责创建）');
  } else {
    const prior = parsedMeta.data;
    const merged = {
      ...prior,
      generatedAt: isoInstant(now),
      nextScheduledAt: nextScheduledAt(now, CADENCE_HOURS),
      // Keep only this run's entry for koreader-push; every other source stays.
      sources: [...prior.sources.filter((s) => s.id !== 'koreader-push'), status],
    };
    SyncMetaSchema.parse(merged);

    // ⚠️ Still only written when the DATA changed. sync-meta carries
    // `generatedAt`, so it differs on every run by construction — writing it
    // unconditionally is the commit storm the whole design exists to prevent.
    if (written > 0) {
      const outcome = await writeIfChanged(META_PATH, stableJson(merged));
      if (outcome === 'written') written++;
      else unchanged++;
    } else {
      console.log('  · sync-meta.json 未写 (本次无数据变更)');
    }
  }
}

console.log(`\n完成：写入 ${written}，未变 ${unchanged}\n`);
