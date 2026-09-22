#!/usr/bin/env bun
/**
 * Pipeline entry point.
 *
 *   bun run pipeline sync --source coof
 *   bun run pipeline sync --source coof --collection COOF2026
 *   bun run pipeline sync --source coof --dry-run
 *
 * `--dry-run` computes everything and reports what WOULD change, without writing.
 * That is the fastest way to answer "will this run produce a commit?" — which is
 * the question that matters, because a scheduled run that commits every time
 * drowns real changes and burns GitHub Pages' 10-builds-per-hour budget.
 */

import { join } from 'node:path';

import {
  CALENDAR_COLLECTIONS,
  CoofIndexSchema,
  CoofLibrarySchema,
  PRIMARY_COLLECTION,
  SyncMetaSchema,
  type CoofIndex,
  type CoofTitle,
  type PerSourceStatus,
} from '@cevtuo/schema';
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

import { queryDatabaseAll } from '../notion';
import { normalizeAll } from '../sources/coof/normalize';
import { rehostPosters } from '../sources/coof/posters';

const CADENCE_HOURS = 5;
const RECENT_LIMIT = 20;

// ─────────────────────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const SOURCE = arg('source') ?? 'coof';
const ONLY = arg('collection');
const DRY_RUN = has('dry-run');
const DATA_DIR = repoPath('data');

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const started = Date.now();

if (SOURCE !== 'coof') {
  console.error(`未知数据源: ${SOURCE} (目前只实现了 coof)`);
  process.exit(1);
}

const targets = ONLY
  ? CALENDAR_COLLECTIONS.filter((c) => c.key.toUpperCase() === ONLY.toUpperCase())
  : CALENDAR_COLLECTIONS;

if (!targets.length) {
  console.error(`找不到集合: ${ONLY}`);
  process.exit(1);
}

console.log(`\n═══ COOF 同步 ═══`);
console.log(`  集合: ${targets.map((t) => t.key).join(', ')}`);
console.log(`  模式: ${DRY_RUN ? 'DRY RUN (不写文件)' : '写入'}`);
console.log(`  输出: ${DATA_DIR}\n`);

const status: PerSourceStatus[] = [];
let written = 0;
let unchanged = 0;
/** Per-collection hashes; rolled up into one `coof` brand entry below. */
const partVersions: Record<string, string> = {};

/** Newest watchedAt across a set of titles — drives switcher ordering. */
function latestOf(titles: CoofTitle[]): string | null {
  let latest: string | null = null;
  for (const t of titles) {
    if (t.watchedAt && (!latest || t.watchedAt > latest)) latest = t.watchedAt;
  }
  return latest;
}

// Pass 1 — fetch and normalise everything, so the switcher can list every
// collection's count/latestAt in each collection's own index.
interface Loaded {
  key: string;
  titles: CoofTitle[];
  posterUrls: Map<string, string>;
}
const loaded: Loaded[] = [];
let posterMap = new Map<string, string | null>();

for (const col of targets) {
  const t0 = Date.now();
  try {
    process.stdout.write(`  ▸ ${col.key} … `);
    const rows = await queryDatabaseAll(col.databaseId);
    const normalized = normalizeAll(rows, col.key);

    const posterUrls = new Map<string, string>();
    for (const n of normalized) {
      if (n.posterUrl) posterUrls.set(n.title.id, n.posterUrl);
    }

    loaded.push({ key: col.key, titles: normalized.map((n) => n.title), posterUrls });
    console.log(`${rows.length} 条 (${Date.now() - t0}ms)`);
  } catch (error) {
    const e = scrubError(error);
    console.log(`✗ ${e.message}`);
    status.push({
      id: 'notion-coof',
      status: 'error',
      lastAttemptAt: isoInstant(new Date()),
      lastSuccessAt: null,
      itemsIn: 0,
      changed: false,
      latencyMs: Date.now() - t0,
      staleAfterHours: CADENCE_HOURS * 3,
      error: e,
    });
  }
}

if (!loaded.length) {
  console.error('\n✗ 没有任何集合成功同步，中止。');
  process.exit(1);
}

// Pass 2 — re-host every poster across all loaded collections in one batch, so
// concurrency is shared instead of restarting per collection.
const allPosters: Array<{ id: string; url: string | null }> = [];
for (const l of loaded) {
  for (const [id, url] of l.posterUrls) allPosters.push({ id, url });
}
if (!DRY_RUN) {
  console.log(`\n  ▸ 下载海报 (${allPosters.length} 张) …`);
  posterMap = await rehostPosters(allPosters, DATA_DIR);
} else {
  console.log(`\n  ▸ 海报 ${allPosters.length} 张 — DRY RUN 跳过下载`);
  posterMap = new Map(allPosters.map((p) => [p.id, p.url ? `data/coof/posters/${p.id}.jpg` : null]));
}

// Collection summaries — shared by every index file so the switcher needs no
// extra request.
const summaries = loaded.map((l) => ({
  name: l.key,
  count: l.titles.length,
  latestAt: latestOf(l.titles),
  path: `data/coof/${l.key}/index.json`,
}));

// Pass 3 — write.
console.log('');
for (const l of loaded) {
  const titles = l.titles.map((t) => ({ ...t, poster: posterMap.get(t.id) ?? null }));
  const recent = titles.slice(0, RECENT_LIMIT);

  const genreCounts = new Map<string, number>();
  for (const t of titles) for (const g of t.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);

  const index: CoofIndex = {
    schemaVersion: 1,
    dataVersion: contentHash({ titles, recent: recent.map((t) => t.id) }),
    counts: {
      total: titles.length,
      rated: titles.filter((t) => t.rating !== null).length,
    },
    collections: summaries,
    collection: l.key,
    hero: recent[0] ?? null,
    recent,
    genres: [...genreCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };

  const library = {
    schemaVersion: 1 as const,
    dataVersion: contentHash({ collection: l.key, ids: titles.map((t) => t.id) }),
    collection: l.key,
    titles,
  };

  // Validate before writing. A malformed payload must fail here rather than
  // reach the app as a runtime crash on someone's phone.
  CoofIndexSchema.parse(index);
  CoofLibrarySchema.parse(library);

  partVersions[l.key] = index.dataVersion;

  if (DRY_RUN) {
    console.log(`  · ${l.key}: ${titles.length} 条, 其中 ${recent.length} 条进首页 (dry-run 未写)`);
    continue;
  }

  const a = await writeIfChanged(join(DATA_DIR, 'coof', l.key, 'index.json'), stableJson(index));
  const b = await writeIfChanged(join(DATA_DIR, 'coof', l.key, 'library.json'), stableJson(library));
  written += [a, b].filter((x) => x === 'written').length;
  unchanged += [a, b].filter((x) => x === 'unchanged').length;
  console.log(`  ${a === 'written' || b === 'written' ? '✎' : '='} ${l.key}: ${titles.length} 条`);
}

// ── sync-meta ────────────────────────────────────────────────
const now = new Date();
status.push({
  id: 'notion-coof',
  status: 'ok',
  lastAttemptAt: isoInstant(now),
  lastSuccessAt: isoInstant(now),
  itemsIn: loaded.reduce((n, l) => n + l.titles.length, 0),
  changed: written > 0,
  latencyMs: Date.now() - started,
  staleAfterHours: CADENCE_HOURS * 3,
});

const meta = {
  schemaVersion: 1 as const,
  generatedAt: isoInstant(now),
  nextScheduledAt: nextScheduledAt(now, CADENCE_HOURS),
  cadence: `PT${CADENCE_HOURS}H`,
  trigger: process.env.GITHUB_ACTIONS ? ('schedule' as const) : ('local' as const),
  runId: process.env.GITHUB_RUN_ID,
  sources: status,
  brands: {
    coof: {
      // One hash over every part, so a change in any calendar moves the brand.
      dataVersion: contentHash(partVersions),
      changedAt: isoInstant(now),
      parts: partVersions,
    },
  },
};
SyncMetaSchema.parse(meta);

// ⚠️ sync-meta is written ONLY when something else actually changed.
//
// It carries `generatedAt` / `lastAttemptAt`, so it is different on every run by
// construction. Committing it unconditionally means every scheduled run produces
// a commit — which is precisely the commit storm the whole design exists to
// prevent, and it would burn GitHub Pages' 10-builds-per-hour budget too.
//
// The app still gets fresh timing: `GET /api/status` on the Worker reads the
// GitHub Actions runs API directly, so it is MORE current than a committed file
// could ever be. The committed meta is a fallback for when the Worker is down,
// and for that purpose "the last run that changed something" is the right value.
const metaPath = join(DATA_DIR, 'sync-meta.json');
if (!DRY_RUN) {
  if (written > 0 || has('force-meta') || !(await readJson(metaPath))) {
    const m = await writeIfChanged(metaPath, stableJson(meta));
    if (m === 'written') written++;
    else unchanged++;
  } else {
    console.log('  · sync-meta.json 未写 (本次无数据变更；状态以 Worker /api/status 为准)');
  }
}

const elapsed = Date.now() - started;
console.log(`\n${'─'.repeat(44)}`);
console.log(`  写入 ${written} 个文件, 未变 ${unchanged} 个`);
console.log(`  耗时 ${elapsed}ms`);
if (written === 0) {
  console.log(`  ⇒ 无变更，本次不会产生提交 (这正是预期行为)`);
}
console.log(`${'─'.repeat(44)}\n`);
