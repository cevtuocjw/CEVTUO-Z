#!/usr/bin/env bun
/**
 * One-off poster backfill from Douban.
 *
 *   bun run pipeline/src/cli/enrich-posters.ts --limit 20            # 试跑，不写
 *   bun run pipeline/src/cli/enrich-posters.ts --limit 20 --write    # 真的写
 *   bun run pipeline/src/cli/enrich-posters.ts --write               # 全量
 *
 * What it does, per title that has no poster:
 *   1. search Douban, pick the best match
 *   2. download the cover and re-host it under data/coof/posters/
 *   3. (with --write) attach the public URL to the Notion row's POSTER property
 *
 * ⚠️ Writing to Notion is opt-in. It modifies the user's own database, and a
 * wrong match would silently attach the wrong film's cover — so the default is a
 * dry run that shows exactly what it would do.
 *
 * ⚠️ The Notion property is set as an EXTERNAL file pointing at our own CDN URL,
 * not as an uploaded Notion file. Two reasons: uploading ~870 images would run
 * into Notion's per-file upload flow and rate limits, and an external URL keeps
 * the value meaningful outside Notion.
 *
 * Resumable: the Douban cache and the skip-if-poster-exists check mean an
 * interrupted run continues where it stopped rather than starting over.
 */

import { join } from 'node:path';

import { CALENDAR_COLLECTIONS, COOF_PROPERTIES, type CoofTitle } from '@cevtuo/schema';
import { PermanentError, readJson, repoPath, scrubError, withRetry } from '@cevtuo/pipeline-core';

import { DoubanClient } from '../douban';
import { queryDatabaseAll } from '../notion';
import { rehostPoster } from '../sources/coof/posters';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const WRITE = has('write');
const LIMIT = Number(arg('limit') ?? '0') || 0;
const DATA_DIR = repoPath('data');
const CACHE_DIR = repoPath('.cache');
const SITE_BASE = process.env.TARO_APP_DATA_BASE ?? 'https://apps.cevtuogrnd.com';

const token = process.env.NOTION_TOKEN?.trim();

interface Pending {
  pageId: string;
  title: CoofTitle;
  collection: string;
}

// ─────────────────────────────────────────────────────────────
// Collect what needs a poster
// ─────────────────────────────────────────────────────────────

console.log(`\n═══ 豆瓣海报补全 ═══`);
console.log(`  模式: ${WRITE ? '⚠️  写入 Notion' : '试跑 (不写 Notion)'}`);
console.log(`  上限: ${LIMIT || '不限'}\n`);

const pending: Pending[] = [];

for (const col of CALENDAR_COLLECTIONS) {
  const lib = await readJson<{ titles: CoofTitle[] }>(join(DATA_DIR, 'coof', col.key, 'library.json'));
  if (!lib) {
    console.log(`  · ${col.key}: 还没同步过，跳过`);
    continue;
  }
  const missing = lib.titles.filter((t) => !t.poster);
  console.log(`  · ${col.key}: ${lib.titles.length} 条, 缺海报 ${missing.length}`);
  for (const t of missing) pending.push({ pageId: t.id, title: t, collection: col.key });
}

if (!pending.length) {
  console.log('\n  没有缺海报的条目，收工。\n');
  process.exit(0);
}

const queue = LIMIT ? pending.slice(0, LIMIT) : pending;
console.log(`\n  本次处理 ${queue.length} 条 (待补共 ${pending.length} 条)\n`);

// ─────────────────────────────────────────────────────────────
// Look up + download + (optionally) write
// ─────────────────────────────────────────────────────────────

const client = new DoubanClient(CACHE_DIR);
await client.load();

let found = 0;
let hosted = 0;
let written = 0;
let unmatched = 0;
const failures: string[] = [];

for (const [i, item] of queue.entries()) {
  const idx = `[${String(i + 1).padStart(4)}/${queue.length}]`;
  const label = `${item.title.title}${item.title.year ? ` (${item.title.year})` : ''}`;

  const match = await client.lookup(item.title.title, item.title.year);
  if (!match?.posterUrl) {
    unmatched++;
    console.log(`${idx} ✗ 无匹配  ${label}`);
    continue;
  }
  found++;

  const path = await rehostPoster(item.pageId, match.posterUrl, DATA_DIR);
  if (!path.path) {
    failures.push(label);
    console.log(`${idx} ✗ 下载失败 ${label}  ${match.posterUrl.slice(0, 60)}`);
    continue;
  }
  hosted++;

  if (!WRITE) {
    console.log(`${idx} ✓ ${label}  → 豆瓣《${match.title}》${match.year ? ` ${match.year}` : ''}`);
    continue;
  }

  if (!token) {
    console.error('\n  ✗ --write 需要 NOTION_TOKEN');
    process.exit(1);
  }

  const publicUrl = `${SITE_BASE}/${path.path}`;
  try {
    await withRetry(
      async () => {
        const res = await fetch(`https://api.notion.com/v1/pages/${item.pageId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            properties: {
              [COOF_PROPERTIES.poster]: {
                files: [{ type: 'external', name: 'poster.jpg', external: { url: publicUrl } }],
              },
            },
          }),
        });
        if (res.status === 429) throw new Error('rate limited (429)');
        if (!res.ok) {
          const body = (await res.text()).slice(0, 160);
          // ⚠️ A 400 saying the property does not exist is PERMANENT. 856 rows
          // predate the POSTER field entirely, so every one of them would
          // otherwise burn four backoff attempts (~9s each) to reach the same
          // conclusion. Tag it and move on.
          if (res.status === 400 && /does not exist|validation_error/.test(body)) {
            throw new PermanentError(`该集合没有 POSTER 属性，跳过 (${body.slice(0, 80)})`);
          }
          throw new Error(`HTTP ${res.status}: ${body}`);
        }
      },
      { attempts: 4, baseDelayMs: 1200, jitterMs: 800, label: `notion patch ${item.pageId.slice(0, 8)}` },
    );
    written++;
    console.log(`${idx} ✓ 已写入 ${label}`);
  } catch (error) {
    const e = scrubError(error);
    failures.push(`${label}: ${e.message}`);
    console.log(`${idx} ✗ Notion 写入失败 ${label} — ${e.message}`);
  }

  // Notion allows ~3 requests/second averaged; 350ms keeps us comfortably under.
  await new Promise((r) => setTimeout(r, 350));
}

await client.save();

// ─────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  豆瓣命中   ${found}`);
console.log(`  海报入库   ${hosted}`);
console.log(`  写入 Notion ${written}${WRITE ? '' : '  (试跑，未写)'}`);
console.log(`  无匹配     ${unmatched}`);
if (failures.length) {
  console.log(`  失败       ${failures.length}`);
  for (const f of failures.slice(0, 5)) console.log(`      · ${f}`);
}
console.log(`  缓存命中 ${client.stats.cached} / 新查询 ${client.stats.fetched}`);
console.log(`${'─'.repeat(52)}\n`);

if (!WRITE) {
  console.log('  这是试跑。确认上面的匹配没问题后，加 --write 真正写入。\n');
}
