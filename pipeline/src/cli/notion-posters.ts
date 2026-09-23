#!/usr/bin/env bun
/**
 * Upload the locally re-hosted posters into Notion itself.
 *
 *   bun run pipeline/src/cli/notion-posters.ts --limit 3            # 试跑
 *   bun run pipeline/src/cli/notion-posters.ts --limit 3 --write    # 真的传
 *   bun run pipeline/src/cli/notion-posters.ts --write              # 全量
 *   ... --collection COOF2023                                       # 只做一个年历
 *   ... --ensure-property                                           # 顺带补 POSTER 列
 *
 * ⚠️ Why this uploads bytes instead of writing a URL.
 *
 * `enrich-posters.ts` writes an EXTERNAL file pointing at
 * `${SITE_BASE}/data/coof/posters/<id>.jpg`. Measured 2026-09-23: that URL is
 * only reachable over plain HTTP. The project's Pages site is fine, but the
 * user site (`cevtuocjw.github.io`) holds the custom domain
 * `apps.cevtuogrnd.com`, so every project URL 301s there — and that domain
 * serves a `CN=*.github.io` certificate with `https_certificate: null`, i.e. no
 * certificate was ever issued for it. A Notion page is HTTPS, so an HTTP image
 * is blocked as mixed content and renders broken.
 *
 * Uploading the bytes removes the dependency on our hosting entirely. The poster
 * lives inside the user's workspace and keeps working whatever happens to DNS,
 * certificates, or GitHub Pages.
 *
 * ⚠️ Scope: a row is touched when its POSTER is EMPTY **or holds an `external`
 * entry**. An external entry is a URL, not an image Notion holds — and the ones
 * this project wrote point at a host whose certificate does not match its
 * domain, so they render broken while still counting as "has a poster". Measured
 * before the fix: COOF2025 had 191 such rows and 3 real ones.
 *
 * A row whose POSTER already holds a Notion-hosted `file` is left ALONE —
 * those were uploaded by Notion itself, and overwriting one would swap a good
 * image for our 400px re-encode.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CALENDAR_COLLECTIONS, COOF_PROPERTIES } from '@cevtuo/schema';
import { PermanentError, readJson, repoPath, scrubError, withRetry } from '@cevtuo/pipeline-core';

import { queryDatabaseAll } from '../notion';

const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const WRITE = has('write');
const ENSURE_PROPERTY = has('ensure-property');
const LIMIT = Number(arg('limit') ?? '0') || 0;
const ONLY = arg('collection');
const DATA_DIR = repoPath('data');

const token = process.env.NOTION_TOKEN?.trim();
if (!token) {
  console.error('✗ 需要 NOTION_TOKEN');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

interface Pending {
  pageId: string;
  collection: string;
  title: string;
  absPath: string;
  relPath: string;
}

/** Properties of a database, by name. */
async function databaseProperties(databaseId: string): Promise<Record<string, { type: string }>> {
  const res = await fetch(`${API}/databases/${databaseId}`, { headers });
  if (!res.ok) throw new Error(`读取数据库失败 HTTP ${res.status}`);
  const j = (await res.json()) as { properties: Record<string, { type: string }> };
  return j.properties;
}

/**
 * Add a `POSTER` files property if the database has none.
 *
 * ⚠️ Purely additive. Renaming or retyping an existing property is a different
 * and destructive operation (the API cannot change a property's type, so it
 * means create-copy-delete, and the delete takes the values with it) — that is
 * deliberately NOT done here.
 */
async function ensurePosterProperty(databaseId: string, key: string): Promise<'present' | 'created'> {
  const props = await databaseProperties(databaseId);
  if (props[COOF_PROPERTIES.poster]) return 'present';

  // A `files`-type property under another name already serves the purpose;
  // adding a second one would split the posters across two columns.
  const existingFiles = Object.entries(props).find(([, p]) => p.type === 'files');
  if (existingFiles) {
    console.log(`    (${key} 已有 files 属性「${existingFiles[0]}」，沿用)`);
    return 'present';
  }

  if (!WRITE) return 'created';

  const res = await fetch(`${API}/databases/${databaseId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      properties: { [COOF_PROPERTIES.poster]: { files: {} } },
    }),
  });
  if (!res.ok) {
    throw new Error(`新建 POSTER 列失败 HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return 'created';
}

/** Create an upload slot, send the bytes, return the file_upload id. */
async function uploadFile(absPath: string, filename: string): Promise<string> {
  const bytes = await readFile(absPath);

  const created = await fetch(`${API}/file_uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ filename, content_type: 'image/jpeg' }),
  });
  if (!created.ok) {
    throw new Error(`创建上传失败 HTTP ${created.status}: ${(await created.text()).slice(0, 160)}`);
  }
  const { id, upload_url } = (await created.json()) as { id: string; upload_url: string };

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
  const sent = await fetch(upload_url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
    body: form,
  });
  if (!sent.ok) {
    throw new Error(`上传字节失败 HTTP ${sent.status}: ${(await sent.text()).slice(0, 160)}`);
  }
  return id;
}

async function attach(pageId: string, fileUploadId: string, filename: string): Promise<void> {
  const res = await fetch(`${API}/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      properties: {
        [COOF_PROPERTIES.poster]: {
          files: [{ type: 'file_upload', file_upload: { id: fileUploadId }, name: filename }],
        },
      },
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    if (res.status === 400 && /does not exist|validation_error/.test(body)) {
      throw new PermanentError(`POSTER 属性不存在: ${body.slice(0, 80)}`);
    }
    throw new Error(`挂载失败 HTTP ${res.status}: ${body}`);
  }
}

// ─────────────────────────────────────────────────────────────

console.log(`\n═══ 海报上传进 Notion ═══`);
console.log(`  模式: ${WRITE ? '⚠️  写入 Notion' : '试跑 (不写)'}`);
if (ENSURE_PROPERTY) console.log(`  补列: 开${WRITE ? '' : ' (试跑不建)'}`);
console.log('');

const targets = ONLY
  ? CALENDAR_COLLECTIONS.filter((c) => c.key.toUpperCase() === ONLY.toUpperCase())
  : CALENDAR_COLLECTIONS;

const pending: Pending[] = [];

for (const col of targets) {
  const lib = await readJson<{ titles: Array<{ id: string; title: string; poster: string | null }> }>(
    join(DATA_DIR, 'coof', col.key, 'library.json'),
  );
  if (!lib) {
    console.log(`  · ${col.key}: 没同步过，跳过`);
    continue;
  }

  if (ENSURE_PROPERTY) {
    const outcome = await ensurePosterProperty(col.databaseId, col.key);
    if (outcome === 'created') console.log(`  ✎ ${col.key}: ${WRITE ? '已新建' : '将新建'} POSTER 列`);
  }

  // Ask Notion which rows are actually missing a poster. library.json records
  // what WE have locally, not what the row holds — a row can have a Notion-hosted
  // poster we never downloaded, and overwriting that would be a downgrade.
  const rows = await queryDatabaseAll(col.databaseId);
  const missing = new Set<string>();
  for (const row of rows) {
    const files = (row.properties?.[COOF_PROPERTIES.poster]?.files ?? []) as Array<{ type: string }>;
    // ⚠️ An `external` file is a URL someone wrote, NOT an image Notion stores.
    // The rows this app's own earlier tool filled point at
    // `https://apps.cevtuogrnd.com/data/coof/posters/<id>.jpg`, a host whose TLS
    // certificate is `CN=*.github.io` — measured, not assumed — so every one of
    // them renders as a broken image while still counting as "has a poster".
    // Treating external entries as present is what let 191 of them sit in
    // COOF2025 unnoticed. They are replaced here.
    const usable = files.length > 0 && files.every((f) => f.type === 'file');
    if (!usable) missing.add(row.id);
  }

  let queued = 0;
  for (const t of lib.titles) {
    if (!t.poster) continue;
    if (!missing.has(t.id)) continue;
    pending.push({
      pageId: t.id,
      collection: col.key,
      title: t.title,
      relPath: t.poster,
      absPath: join(repoPath('.'), t.poster),
    });
    queued++;
  }
  console.log(`  · ${col.key}: ${rows.length} 行, Notion 缺海报 ${missing.size}, 本地有图可补 ${queued}`);
}

if (!pending.length) {
  console.log('\n  没有需要上传的。\n');
  process.exit(0);
}

const queue = LIMIT ? pending.slice(0, LIMIT) : pending;
console.log(`\n  本次处理 ${queue.length} 条 (待传共 ${pending.length})\n`);

if (!WRITE) {
  for (const p of queue.slice(0, 10)) console.log(`  ✓ ${p.collection}  ${p.title}\n      ${p.relPath}`);
  if (queue.length > 10) console.log(`  … 另有 ${queue.length - 10} 条`);
  console.log('\n  这是试跑。加 --write 真正上传。\n');
  process.exit(0);
}

let done = 0;
const failures: string[] = [];

for (const [i, item] of queue.entries()) {
  const idx = `[${String(i + 1).padStart(4)}/${queue.length}]`;
  try {
    const filename = `${item.pageId}.jpg`;
    const uploadId = await withRetry(() => uploadFile(item.absPath, filename), {
      attempts: 3,
      baseDelayMs: 1000,
      jitterMs: 500,
      label: `upload ${item.pageId.slice(0, 8)}`,
    });
    await withRetry(() => attach(item.pageId, uploadId, filename), {
      attempts: 3,
      baseDelayMs: 1000,
      jitterMs: 500,
      label: `attach ${item.pageId.slice(0, 8)}`,
    });
    done++;
    if (done % 20 === 0) console.log(`  … 已传 ${done}`);
  } catch (error) {
    const e = scrubError(error);
    failures.push(`${item.title}: ${e.message}`);
    console.log(`${idx} ✗ ${item.title} — ${e.message}`);
  }
  // Notion averages ~3 requests/second. An upload is two calls plus the patch,
  // so this is a floor, not padding.
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`  已上传并写入 ${done}`);
if (failures.length) {
  console.log(`  失败 ${failures.length}`);
  for (const f of failures.slice(0, 8)) console.log(`      · ${f}`);
}
console.log(`${'─'.repeat(52)}\n`);
