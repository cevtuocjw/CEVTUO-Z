/**
 * Ingest — the device-facing receiver for KOReader reading statistics.
 *
 * ── Why a server sits in the middle at all ─────────────────────
 *
 * Two reasons, and the second one arrived later.
 *
 * 1. **The device must not hold a real credential.** Whatever the Kindle
 *    carries is readable — the plugin is plain-text Lua on a mounted USB
 *    partition. So it carries `CEVTUO_DEVICE_TOKEN`, whose entire authority is
 *    "may POST a reading-stats document".
 *
 * 2. ⚠️ **A reading history cannot live in the repository.** `cevtuocjw/CEVTUO-Z`
 *    is public, `data/` is committed to `main`, and the Pages site is
 *    world-readable. The first design committed the export there and it was
 *    public within the hour. It now lives HERE, on the server, and reaches the
 *    page through an authenticated `GET /api/paperr/index.json`.
 *
 * ⚠️ This also removes the GitHub token entirely. Nothing is committed any more,
 * so there is no PAT to create, scope, rotate or leak — and the repository needs
 * no workflow file either.
 *
 * ⚠️ The device is the backup. KOReader keeps the full history in
 * `statistics.sqlite3` and the plugin exports all of it every time, so a lost
 * server is restored by the next sync. That is why holding the only copy here is
 * acceptable rather than reckless.
 */

import {
  IngestResponseSchema,
  PaperrRawSchema,
  type IngestResponse,
  type PaperrRaw,
} from '@cevtuo/schema';
import { LOCAL_PATHS } from '@cevtuo/schema/paths';
import { contentHash, scrubError } from '@cevtuo/pipeline-core';

/**
 * ⚠️ A real 41-book export is 10 KB. This is a ceiling on what one request can
 * make the server buffer, not a target — without it, a hostile or broken client
 * can make the process allocate without limit.
 */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * ⚠️ Both are LOCAL paths — neither is a published payload.
 *
 * `raw-koreader.json` is the device's verbatim export. Everything else the page
 * shows comes from `data/paperr/index.json`, which IS public and is fetched
 * straight from the site. See `packages/schema/src/paths.ts`.
 */
export const RAW_PATH = LOCAL_PATHS.paperrRaw;
/**
 * When the device last REACHED us — server-local, never published.
 *
 * ⚠️ Not in `LOCAL_PATHS` with the other two: this file is not data the
 * pipeline or the page has any use for, it exists purely so the operator can
 * ask "is the Kindle still talking to us?" without reading the journal.
 */
export const HEARTBEAT_PATH = 'data/paperr/heartbeat.json';

/**
 * `YYYY-MM-DDTHH:mm+08:00` in the SERVER's own timezone.
 *
 * ⚠️ NOT `toISOString()`, which is UTC. The page formats these by SLICING
 * characters 0–16 — `formatUpdatedAt` never parses them, because parsing would
 * re-interpret the instant in the VIEWER's timezone and shift the time for
 * anyone reading from abroad. So a UTC stamp renders eight hours early here:
 * a 13:27 push showed as "05:27", which is a wrong answer that looks like a
 * plausible one.
 *
 * Same shape `normalizeInstant` produces on the pipeline side.
 */
function localStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export interface Env {
  /** Bearer the Kindle presents. Grants exactly one thing: POSTing an export. */
  deviceToken: string;
  /**
   * Password for the human-facing surface — the admin page, and the data the
   * page reads. Null disables both.
   *
   * ⚠️ Null by DEFAULT. A deployment that forgets to set it ends up with no
   * admin page and no readable data, rather than with a page publishing the
   * reader's library.
   */
  adminPassword: string | null;
  maxBytes: number;
}

export function envFrom(source: Record<string, string | undefined>): Env {
  const need = (k: string): string => {
    const v = source[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    deviceToken: need('CEVTUO_DEVICE_TOKEN'),
    adminPassword: source.CEVTUO_ADMIN_PASSWORD ?? null,
    maxBytes: Number(source.CEVTUO_MAX_BYTES ?? DEFAULT_MAX_BYTES),
  };
}

/**
 * Where the two files live.
 *
 * An interface rather than direct `fs` calls so `verify.ts` can drive the whole
 * handler against an in-memory store — including the case that decides whether
 * this service is worth having: a second identical push must change nothing.
 */
export interface Store {
  readRaw(): Promise<string | null>;
  writeRaw(text: string): Promise<void>;
  /**
   * When the device last REACHED us — which is not when the data last changed.
   *
   * ⚠️⚠️ This is the whole point of the file. `readRaw`/`writeRaw` only move on
   * a real change, because an `unchanged` push deliberately does not rewrite the
   * export (that is what stops an empty commit every 30 minutes). So the raw
   * file's mtime answers "when did the numbers last move", and the reader who
   * tapped 导出 and saw nothing happen had no way to ask the other question:
   * "did my tap arrive at all?".
   *
   * On 2026-09-24 that cost a round of "同步没有生效" for two pushes that had in
   * fact both arrived and been correctly compared.
   */
  readHeartbeat(): Promise<string | null>;
  writeHeartbeat(text: string): Promise<void>;
}

/**
 * Turns the raw export into the index the page reads.
 *
 * ⚠️ Runs HERE, not in GitHub Actions. The first design committed the raw file
 * and let a workflow convert it, which required a `workflow`-scoped token to
 * push and an `Actions`-scoped token on this server. Running the pipeline
 * locally needs neither.
 *
 * ⚠️ `convert()` takes no argument: the caller has already written the raw
 * export through the Store, and the converter reads it from the same working
 * directory. The ordering is the contract.
 */
export interface Converter {
  /**
   * Runs the pipeline. Returns `{ ok: true }` or an error string; never throws.
   *
   * ⚠️ It hands nothing back on purpose. The CLI reads the raw export and writes
   * BOTH outputs itself — the public index and the private current file. Two
   * writers for one derivation is how they end up disagreeing.
   */
  convert(): Promise<{ ok: true } | { error: string }>;
}

// ─────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
  // Length check first so the XOR loop never runs against a different length.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorized(env: Env, authHeader: string | null): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  return constantTimeEqual(authHeader.slice(7), env.deviceToken);
}

/**
 * Browser auth for the page and the admin surface.
 *
 * ⚠️ Basic, not Bearer. A page load cannot set an Authorization header, so a
 * bearer-only design would need the token in a query string — which lands in
 * browser history, in this server's logs, and in any proxy in between.
 *
 * ⚠️ Plain HTTP means this password crosses the network in the clear. Accepted
 * here because the alternative is worse: the data was PUBLIC before this.
 */
export function isAdminAuthorized(env: Env, authHeader: string | null): boolean {
  if (!env.adminPassword) return false; // unset ⇒ the whole surface is off
  if (!authHeader?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    return constantTimeEqual(decoded.slice(decoded.indexOf(':') + 1), env.adminPassword);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────

/**
 * A content signature that IGNORES `exportedAt`.
 *
 * ⚠️ This single line is what keeps "sync on every WiFi connect" from becoming
 * "write on every WiFi connect". The device stamps `exportedAt` with the time of
 * the export, so two pushes describing the same reading session differ in that
 * one field and nothing else.
 */
export function signatureOf(payload: PaperrRaw): string {
  return contentHash({ ...payload, exportedAt: null });
}

function reject(message: string, status = 400): { status: number; body: IngestResponse } {
  return { status, body: IngestResponseSchema.parse({ ok: false, status: 'rejected', message }) };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Validate, then write only if the reading state actually moved.
 *
 * Never throws: every failure path returns a status the device can ignore and
 * the operator can read.
 */
export async function handleIngest(
  env: Env,
  store: Store,
  converter: Converter,
  authHeader: string | null,
  rawBody: string,
): Promise<{ status: number; body: IngestResponse }> {
  if (!isAuthorized(env, authHeader)) return reject('凭据不对', 401);

  // Measured in BYTES, not characters. A cap that counts UTF-16 code units
  // lets a CJK payload through at up to 3× the intended size.
  const bytes = new TextEncoder().encode(rawBody).length;
  if (bytes > env.maxBytes) return reject(`导出过大: ${bytes} > ${env.maxBytes} 字节`, 413);

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return reject('不是合法 JSON');
  }

  const parsed = PaperrRawSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return reject(`不符合 PaperrRawSchema: ${first?.path.join('.')} ${first?.message}`);
  }
  const payload = parsed.data;

  // ⚠️ An export with no books is the shape a half-broken plugin produces. It
  // must not be allowed to overwrite a good one with nothing.
  if (payload.books.length === 0) return reject('导出里一本书都没有，拒绝覆盖已有数据');

  // ⚠️ Recorded BEFORE the comparison, so an `unchanged` push leaves a trace.
  // That is the entire point: it is the case the reader cannot otherwise see.
  const notePush = async (changed: boolean): Promise<void> => {
    try {
      const now = localStamp();
      await store.writeHeartbeat(
        `${JSON.stringify(
          { lastPushAt: now, lastChangeAt: changed ? now : undefined, pluginVersion: payload.pluginVersion ?? null, books: payload.books.length },
          null,
          2,
        )}\n`,
      );
    } catch {
      // A heartbeat that cannot be written must never cost the reader their
      // export. It is diagnostics, not data.
    }
  };

  const existing = await store.readRaw();
  if (existing) {
    const stored = PaperrRawSchema.safeParse(safeJsonParse(existing));
    if (stored.success && signatureOf(stored.data) === signatureOf(payload)) {
      // The reading has not moved. Deliberately no write, no conversion —
      // but the heartbeat is still stamped, because the device DID reach us.
      await notePush(false);
      return {
        status: 200,
        body: IngestResponseSchema.parse({
          ok: true,
          status: 'unchanged',
          message: '阅读数据没有变化',
          books: payload.books.length,
        }),
      };
    }
  }

  // ⚠️ `exportedAt` is kept in the stored file (genuinely useful when diagnosing
  // a device) even though it is excluded from the comparison above.
  // ⚠️⚠️ The DEVICE'S BYTES, not a re-serialisation of the parsed object.
  //
  // This used to be `JSON.stringify(payload)`, which reads as harmless and is
  // not: zod fills in every `.default()` and drops every key the schema does
  // not declare. So the stored file stopped being a record of what the device
  // sent and became a record of what THIS VERSION of the schema understands.
  //
  // The cost showed up immediately. `hourly` and `monthly` are `.default([])`,
  // so an export from a plugin that predates those fields came back with both
  // present and empty — and "the reader has no hourly data yet" became
  // indistinguishable from "this device runs a plugin that cannot produce it".
  // Answering that took a round of guessing and a wrong conclusion.
  //
  // The raw export is the only copy of what the device knows, and it is the
  // thing every future diagnosis reads. Store it as it arrived.
  await store.writeRaw(rawBody.endsWith('\n') ? rawBody : `${rawBody}\n`);
  await notePush(true);

  // ⚠️ Conversion runs AFTER the raw write and its failure is never fatal. The
  // raw export is the half that cannot be reconstructed; the index is derivable
  // from it at any time, by this function or by hand from the admin page.
  const conv = await converter.convert();
  if ('error' in conv) {
    return {
      status: 202,
      body: IngestResponseSchema.parse({
        ok: true,
        status: 'committed',
        message: `已保存原始导出；重新生成失败：${conv.error}`,
        books: payload.books.length,
      }),
    };
  }

  return {
    status: 202,
    body: IngestResponseSchema.parse({
      ok: true,
      status: 'committed',
      message: '已保存并重新生成',
      books: payload.books.length,
    }),
  };
}

// ─────────────────────────────────────────────────────────────
// The page's data endpoint
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// ⚠️ `handleCurrent` used to live here — a password-gated endpoint returning
// the one book being read right now.
//
// ⚠️ Nothing ever wrote its file. The pipeline stopped producing
// `current.json` when the reader decided the whole reading dashboard is
// public, so the route could only ever answer 404 — while carrying five
// passing assertions that drove it with a hand-built store. **Tests that
// exercise dead code are worse than no tests: they make a route look alive.**
//
// `index.current` carries the same book, publicly, and the page renders it.
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────

export interface AdminStatus {
  ok: boolean;
  lastExportAt: string | null;
  books: number;
  readingDays: number;
  rawBytes: number;
  canRebuild: boolean;
  message?: string;
  /**
   * What the device said about itself, straight out of the stored export.
   *
   * ⚠️ Null when absent, which is itself the answer: every plugin before 1.1.0
   * omits it, so `null` means "this device predates the field" and a version
   * string means "this device can produce hourly data". Without this the only
   * way to tell was to read the stored JSON and know which fields are zod
   * defaults — and that cost a wrong conclusion once already.
   */
  pluginVersion: string | null;
  /**
   * When the device last reached us — ANY successful push, changed or not.
   *
   * ⚠️ Deliberately separate from `lastExportAt`, which is what the DEVICE says
   * its export time was and only moves when the numbers move. The reader tapped
   * 导出, saw `lastExportAt` stay at 13:05, and concluded the sync was broken.
   * It was not: both pushes had arrived and been compared. `lastPushAt` is the
   * question they were actually asking.
   */
  lastPushAt: string | null;
  /** Same file, but when the reading last actually changed. */
  lastChangeAt: string | null;
}

export async function handleAdminStatus(
  env: Env,
  store: Store,
): Promise<{ status: number; body: AdminStatus }> {
  const base: AdminStatus = {
    ok: true,
    lastExportAt: null,
    books: 0,
    readingDays: 0,
    rawBytes: 0,
    canRebuild: true,
    pluginVersion: null,
    lastPushAt: null,
    lastChangeAt: null,
  };
  let raw: string | null;
  try {
    raw = await store.readRaw();
  } catch (e) {
    return { status: 500, body: { ...base, ok: false, message: scrubError(e).message, pluginVersion: null } };
  }
  if (!raw) return { status: 200, body: { ...base, message: '还没有数据，先让设备同步一次', pluginVersion: null } };

  const parsed = PaperrRawSchema.safeParse(safeJsonParse(raw));
  if (!parsed.success) {
    return { status: 200, body: { ...base, ok: false, message: '已存的原始导出不符合 schema', pluginVersion: null } };
  }
  // ⚠️ Read separately and tolerantly: an older deployment, or a first run
  // before any push has happened, has no heartbeat file. That is "unknown", not
  // an error, and it must not take down the whole status response.
  let hb: { lastPushAt?: string; lastChangeAt?: string } = {};
  try {
    hb = JSON.parse((await store.readHeartbeat()) ?? '{}') as typeof hb;
  } catch {
    hb = {};
  }

  return {
    status: 200,
    body: {
      ...base,
      lastExportAt: parsed.data.exportedAt,
      books: parsed.data.books.length,
      readingDays: parsed.data.daily.length,
      rawBytes: raw.length,
      // ⚠️ Read from the STORED EXPORT, so it can only be as truthful as what
      // was stored — which is why `handleIngest` now keeps the device's bytes
      // instead of a re-serialisation of them.
      pluginVersion: parsed.data.pluginVersion ?? null,
      lastPushAt: hb.lastPushAt ?? null,
      lastChangeAt: hb.lastChangeAt ?? null,
    },
  };
}

/**
 * Re-run the conversion over the export already on disk.
 *
 * ⚠️ "Sync" from this side CANNOT mean "fetch from the Kindle". The device has
 * no inbound address, sleeps most of the day, and sits behind whatever NAT it
 * happens to be on. There is no pull. What this can honestly do is re-run the
 * converter — which is exactly right after fixing a converter bug, and needs
 * nothing from the device.
 */
export async function handleRebuild(
  env: Env,
  store: Store,
  converter: Converter,
): Promise<{ status: number; body: { ok: boolean; message: string } }> {
  const raw = await store.readRaw();
  if (!raw) return { status: 404, body: { ok: false, message: '还没有数据，先让设备同步一次' } };

  const conv = await converter.convert();
  if ('error' in conv) return { status: 500, body: { ok: false, message: `重新生成失败：${conv.error}` } };

  return { status: 202, body: { ok: true, message: '已重新生成' } };
}

/** The whole admin page. Inline — no build step, no dependency, one file to read. */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CEVTUO CAPPERR — 同步</title>
<style>
 :root{--bg:#111;--fg:#eee;--mut:#888;--line:#333}
 @media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#111;--mut:#666;--line:#ddd}}
 body{margin:0;padding:6vw;background:var(--bg);color:var(--fg);
      font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
 h1{font-size:1.3rem;margin:0 0 .2em} p.sub{color:var(--mut);margin:0 0 2em}
 table{border-collapse:collapse;margin:0 0 2em;width:100%;max-width:32em}
 td{padding:.5em 0;border-bottom:1px solid var(--line)} td:first-child{color:var(--mut);width:9em}
 button{font:inherit;padding:.7em 1.3em;border:1px solid var(--line);border-radius:10px;
        background:transparent;color:var(--fg);cursor:pointer}
 button:disabled{opacity:.4;cursor:default}
 #msg{margin-top:1.2em;color:var(--mut);min-height:1.6em}
</style>
<h1>CAPPERR 同步</h1>
<p class="sub">Kindle 的阅读数据存在这台服务器上。这里只做两件事：看它有多新，以及重新生成一次。</p>
<table id="t"><tr><td>读取中…</td><td></td></tr></table>
<button id="b" disabled>重新生成</button>
<div id="msg"></div>
<script>
const $ = (s) => document.querySelector(s);
const rows = [
  // ⚠️ The ORDER is the point. The reader's question is "is it still syncing",
  // and the answer is lastPushAt. lastExportAt is what the DEVICE says its
  // numbers are from — it sits still for days when nobody reads, and reading it
  // as "last sync" is what made a perfectly working sync look broken.
  // ⚠️ No backticks anywhere in this block: the whole admin page is one template
  // literal, and a backtick in a comment ends the string.
  ['最后同步（收到设备）', (d) => d.lastPushAt || '— 还没有收到过推送'],
  ['数据最后变化', (d) => d.lastChangeAt || '—'],
  ['设备导出的时间戳', (d) => d.lastExportAt || '—'],
  // ⚠️ "—" is a real answer here, not a gap. Every plugin before 1.1.0 omits
  // the field, so a dash means "this device cannot produce hourly data yet" —
  // which is exactly the question someone asking why 时段 is empty has.
  ['设备插件版本', (d) => d.pluginVersion || '— （1.1.0 以前的插件不报版本）'],
  ['书的数量', (d) => d.books],
  ['有阅读记录的天数', (d) => d.readingDays],
  ['原始文件大小', (d) => (d.rawBytes / 1024).toFixed(1) + ' KB'],
];
async function load() {
  const r = await fetch('/api/status');
  const d = await r.json();
  $('#t').innerHTML = rows
    .map(([k, f]) => '<tr><td>' + k + '</td><td>' + f(d) + '</td></tr>').join('');
  if (d.message) $('#msg').textContent = d.message;
  $('#b').disabled = !d.canRebuild;
}
$('#b').onclick = async () => {
  $('#b').disabled = true; $('#msg').textContent = '生成中…';
  const r = await fetch('/api/rebuild', { method: 'POST' });
  const d = await r.json();
  $('#msg').textContent = d.message;
  setTimeout(() => { $('#b').disabled = false; load(); }, 2000);
};
load().catch(() => { $('#msg').textContent = '读取失败'; });
</script>
</html>`;
}
