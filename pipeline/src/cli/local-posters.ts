#!/usr/bin/env bun
/**
 * Fill in missing posters from Douban — locally, not via Notion.
 *
 *   bun run pipeline/src/cli/local-posters.ts --limit 20      # 试跑，不下载
 *   bun run pipeline/src/cli/local-posters.ts --limit 20 --write
 *   bun run pipeline/src/cli/local-posters.ts --write          # 全量
 *
 * ⚠️ Why this exists separately from enrich-posters.ts. That tool attaches the
 * DOUBAN IMAGE URL to the Notion row, which does not work: Douban serves those
 * images behind a Referer check and answers a bare request with HTTP 418, so the
 * app cannot render them — and the Notion property only ever holds a URL that
 * expires or gets blocked. The poster has to be downloaded here and re-hosted
 * next to the rest of the data, which is what this does.
 *
 * ⚠️ Two writers must agree, or this work is undone within five hours:
 *   · this tool writes `data/coof/posters/<id>.jpg` and the `poster` field
 *   · sync.ts rebuilds that field from Notion on every run
 * `rehostPoster` already skips any file that is on disk and valid, so a
 * backfilled image survives a sync — but sync must also be told to re-adopt it
 * for rows whose Notion POSTER property is empty. See the note there.
 *
 * ⚠️ Douban lookups are throttled deliberately. This is a one-off backfill of
 * ~870 titles against a third-party site that will block us if we hammer it; the
 * cache in .cache/ means a re-run costs nothing.
 */

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { CALENDAR_COLLECTIONS, CoofLibrarySchema, type CoofTitle } from '@cevtuo/schema';
import { stableJson } from '@cevtuo/pipeline-core';

import { DoubanClient, normalisePosterUrl } from '../douban';
import { rehostPoster } from '../sources/coof/posters';
import { coofLibraryVersion } from '../sources/coof/version';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DATA_DIR = join(ROOT, 'data');
const CACHE_DIR = join(ROOT, '.cache');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(argv[limitArg + 1]) : Infinity;

/** Rows whose NAME was never filled in — there is nothing to look up. */
const UNTITLED = /^\(?无标题\)?$/;

/** Sequential with a pause — Douban rate-limits aggressively. */
const DELAY_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Job {
  collection: string;
  id: string;
  title: string;
  year: number | null;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

// ── Collect every title with no poster ───────────────────────

const jobs: Job[] = [];
const libraries = new Map<string, { dataVersion: string; titles: CoofTitle[] }>();

for (const col of CALENDAR_COLLECTIONS) {
  const path = join(DATA_DIR, 'coof', col.key, 'library.json');
  const lib = await readJson<{ dataVersion: string; titles: CoofTitle[] }>(path).catch(() => null);
  if (!lib) continue;
  libraries.set(col.key, lib);
  for (const t of lib.titles) {
    if (t.poster) continue;
    // ⚠️ Skip the untitled placeholders — they have nothing to search for, and
    // feeding them through would spend the request budget on guaranteed misses
    // and make the failure count look like the lookup is broken.
    //
    // The figure that used to be here ("721 of the 867 rows with no poster")
    // was measured before the 2020–2023 name-column bug was fixed, when most of
    // those rows had no title at all. Re-measured 2026-09-23: of 483 rows still
    // without a poster, just 18 are placeholders. The skip is still correct; it
    // is now a rounding error rather than 83% of the queue.
    if (UNTITLED.test(t.title.trim())) continue;
    jobs.push({ collection: col.key, id: t.id, title: t.title, year: t.year });
  }
}

console.log(`\n  缺海报: ${jobs.length} 条 (共 ${[...libraries.values()].reduce((n, l) => n + l.titles.length, 0)})`);
if (jobs.length === 0) {
  console.log('  没有需要补的。\n');
  process.exit(0);
}

const queue = jobs.slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`  本次处理: ${queue.length} 条${WRITE ? '' : '  (试跑，不下载不写盘)'}\n`);

// ── Look up + download ───────────────────────────────────────

const client = new DoubanClient(CACHE_DIR);
await client.load();

/** id → relative poster path, for the titles we resolved this run. */
const found = new Map<string, string>();
const failures: { title: string; why: string }[] = [];
let hits = 0;

for (const [i, job] of queue.entries()) {
  const n = `[${i + 1}/${queue.length}]`;
  try {
    const match = await client.lookup(job.title, job.year);
    if (!match?.posterUrl) {
      failures.push({ title: job.title, why: '豆瓣无匹配或无海报' });
      continue;
    }

    const url = normalisePosterUrl(match.posterUrl);

    if (!WRITE) {
      console.log(`  ${n} ${job.title}\n        → ${match.title} (${match.year ?? '?'})`);
      continue;
    }

    // ⚠️ Goes through the same re-host path as the Notion-sourced posters, so
    // the Referer/UA headers and the JPEG magic-number check are shared rather
    // than reimplemented. A bytes-identical second implementation is exactly how
    // the 418s came back the first time.
    const res = await rehostPoster(job.id, url, DATA_DIR);
    if (!res.path) {
      failures.push({ title: job.title, why: '下载或转码失败' });
      continue;
    }

    found.set(job.id, res.path);
    hits++;
    if (hits % 25 === 0) console.log(`  … 已补 ${hits} 张`);
  } catch (e) {
    failures.push({ title: job.title, why: (e as Error).message.slice(0, 60) });
  }

  await sleep(DELAY_MS);
}

await client.save();

// ── Write back ───────────────────────────────────────────────

if (WRITE && found.size > 0) {
  let touched = 0;
  for (const [key, lib] of libraries) {
    let changed = false;
    const titles = lib.titles.map((t) => {
      const p = found.get(t.id);
      if (!p) return t;
      changed = true;
      return { ...t, poster: p };
    });
    if (!changed) continue;

    // ⚠️ `dataVersion` MUST be recomputed here, with the same function sync
    // uses. This used to be skipped on the reasoning that the version hashed
    // title ids only, so posters were outside it — but that made the version a
    // lie about the payload's content, and `coofLibraryVersion` now hashes the
    // whole thing. Writing posters under an unchanged version would leave the
    // stale value in place and the next sync would rewrite the file purely to
    // correct it: a spurious commit from a no-op, which is the exact failure
    // this design exists to prevent.
    const next = { ...lib, dataVersion: coofLibraryVersion(key, titles), titles };
    CoofLibrarySchema.parse({ ...next, schemaVersion: 1, collection: key });
    await writeFile(join(DATA_DIR, 'coof', key, 'library.json'), stableJson(next), 'utf8');
    touched++;
  }
  console.log(`\n  已更新 ${touched} 个 library.json，新增 ${found.size} 张海报`);
}

// ── Report ───────────────────────────────────────────────────

console.log(`\n  结果: 命中 ${found.size}${WRITE ? ' (已写入)' : ' (试跑)'}, 失败 ${failures.length}`);
for (const f of failures.slice(0, 8)) console.log(`      · ${f.title} — ${f.why}`);
if (failures.length > 8) console.log(`      … 另有 ${failures.length - 8} 条`);

if (!WRITE) {
  console.log('\n  这是试跑。确认匹配没问题后，加 --write 真正下载并写入。\n');
} else if (found.size > 0) {
  console.log('\n  ⚠️ 别忘了 data/coof/*/index.json 的 hero/recent 也可能引用这些条目。\n');
}
