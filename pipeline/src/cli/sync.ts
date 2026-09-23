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
import { existingPosterPath, rehostPosters } from '../sources/coof/posters';
import { coofLibraryVersion } from '../sources/coof/version';

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
/**
 * Whether this run also advances the CNSR stagger.
 *
 * ⚠️ Off only for CNSR itself, which `scripts/cnsr-sync.mjs` drives. Without
 * this guard, `--source cnsr` would recurse: the CNSR script shells out to the
 * extractor, and a sync that called the CNSR script while being called BY it
 * would never terminate.
 */
const RUN_CNSR = SOURCE === 'coof';
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

/**
 * Which calendars to read.
 *
 * ⚠️ Defaults to THE CURRENT YEAR ONLY, not to all seven.
 *
 * The older calendars are finished — the user confirmed they are fixed and will
 * not be edited again. Re-reading them every run spends the workspace's Notion
 * request budget (180/minute, ~3/s, on any plan below Business) on data that
 * cannot have changed: the 5-hourly job was paginating seven databases to find
 * nothing, which is the single largest avoidable cost in this pipeline.
 *
 * `--all` re-reads everything, for the occasional case where an old calendar
 * really was edited by hand.
 */
function defaultTargets() {
  const thisYear = `COOF${new Date().getFullYear()}`;
  const exact = CALENDAR_COLLECTIONS.filter((c) => c.key.toUpperCase() === thisYear);
  // ⚠️ Falls back to the NEWEST calendar, not to an empty list. Before this
  // year's calendar exists the exact match is empty, and `!targets.length`
  // below exits with "找不到集合" — which reads as a broken configuration
  // rather than as "there is no calendar for this year yet".
  return exact.length ? exact : CALENDAR_COLLECTIONS.slice(0, 1);
}

const targets = ONLY
  ? CALENDAR_COLLECTIONS.filter((c) => c.key.toUpperCase() === ONLY.toUpperCase())
  : has('all')
    ? CALENDAR_COLLECTIONS
    : defaultTargets();

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
//
// ⚠️ Built from `l.titles`, NOT from `l.posterUrls`. Iterating the URL map made
// `rehostPosters`' adopt-from-disk branch unreachable: a row with no Notion
// poster URL never entered this list, so it never entered the result map, and
// pass 3's `posterMap.get(id) ?? null` wrote null straight over the backfilled
// JPEG sitting on disk. Measured on a real run: COOF2024 145 → 0 posters and
// COOF2023 38 → 0, with every image file still present and untouched.
//
// The adopt branch was added for exactly this case and its own comment claims
// the list "used to" filter on `i.url` — that filter was here all along. Both
// halves have to agree, so the complete list is the one that gets passed.
const allPosters: Array<{ id: string; url: string | null }> = [];
for (const l of loaded) {
  for (const t of l.titles) allPosters.push({ id: t.id, url: l.posterUrls.get(t.id) ?? null });
}
if (!DRY_RUN) {
  console.log(`\n  ▸ 下载海报 (${allPosters.length} 张) …`);
  posterMap = await rehostPosters(allPosters, DATA_DIR);
} else {
  // Resolve from disk without downloading, so the dry run predicts the same
  // thing the real run would write. A row with a URL is kept unconditionally:
  // `rehostPoster` returns the existing path when the file is on disk and
  // otherwise reports what it would fetch — never null for a row that has one.
  console.log(`\n  ▸ 海报 ${allPosters.length} 张 — DRY RUN 跳过下载`);
  const adopted = await Promise.all(
    allPosters.map(async (p) => {
      if (p.url) return [p.id, `data/coof/posters/${p.id}.jpg`] as const;
      const path = await existingPosterPath(p.id, DATA_DIR);
      return [p.id, path] as const;
    }),
  );
  posterMap = new Map(adopted);
}

// Collection summaries — the CATALOGUE of every calendar, not only the ones
// this run happened to read.
//
// ⚠️⚠️ This must list all seven even though the sync now loads only the current
// year.
//
// Every index file carries this array so the year switcher needs no extra
// request — that is what the comment here has always said. Building it from
// `loaded` meant that scoping the READ to COOF2026 silently shrank the
// CATALOGUE to one entry, and the COOF page offers exactly this array as its
// set of years: it would have shown a single choice and read as broken.
// Measured the first time the scoped sync ran: 36 lines vanished from
// `data/coof/COOF2026/index.json`.
//
// Years not read this run carry their summary forward from the index already on
// disk. They cannot have changed — that is the entire premise of not reading
// them.
const loadedByKey = new Map(loaded.map((l) => [l.key, l]));
const summaries = await Promise.all(
  CALENDAR_COLLECTIONS.map(async (c) => {
    const l = loadedByKey.get(c.key);
    if (l) {
      return {
        name: l.key,
        count: l.titles.length,
        latestAt: latestOf(l.titles),
        path: `data/coof/${l.key}/index.json`,
      };
    }
    const prev = (await readJson(join(DATA_DIR, 'coof', c.key, 'index.json'))) as CoofIndex | null;
    // ⚠️ An unreadable neighbour still gets an entry, with its real name and
    // path. Dropping it would shrink the switcher silently — the same failure
    // this block exists to prevent, just triggered by a missing file instead of
    // by a scoped read.
    return (
      prev?.collections?.find((x) => x.name === c.key) ?? {
        name: c.key,
        count: 0,
        latestAt: null,
        path: `data/coof/${c.key}/index.json`,
      }
    );
  }),
);

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
    dataVersion: coofLibraryVersion(l.key, titles),
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

// ── CNSR — ONE source per run ────────────────────────────────
//
// ⚠️ Deliberately not four. Four sources refreshing in one burst is a single
// spike against a workspace-wide Notion budget, and the spike is what earns a
// 429; staggered, each run touches one source and each source comes round every
// two days. See `scripts/cnsr-sync.mjs` for why the slot comes from the clock
// rather than from "whichever is oldest".
//
// ⚠️ Runs BEFORE the sync-meta block on purpose. The workflow commits with
// `git add -A data/`, so anything written after that point in this process is
// still committed — but the elapsed-time figure below would be a lie about how
// long the run took if a two-minute CNSR pass happened after it was printed.
if (RUN_CNSR && !DRY_RUN) {
  console.log(`\n═══ CNSR 轮转同步 ═══`);
  const { spawnSync } = await import('node:child_process');
  const proc = spawnSync('bun', ['run', join(repoPath(), 'scripts', 'cnsr-sync.mjs')], {
    stdio: 'inherit',
    env: process.env,
  });
  // ⚠️ A CNSR failure must NOT fail the whole run. COOF's output is already
  // written and valid; aborting here would throw it away over a source that
  // will come round again in two days.
  if (proc.status !== 0) {
    console.error(`  ✗ CNSR 轮转失败（退出码 ${proc.status}）—— COOF 产物不受影响`);
  }
} else if (RUN_CNSR) {
  console.log(`\n  · dry-run：跳过 CNSR 轮转`);
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
