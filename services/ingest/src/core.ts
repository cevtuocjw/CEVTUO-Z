/**
 * Ingest — the device-facing receiver for KOReader reading statistics.
 *
 * ── Why this exists instead of "push to the Mac" ───────────────
 * The first design had the Kindle POST to a Bun server on the Mac, over the LAN.
 * It worked, and it was the wrong shape: it only functioned while the Mac was
 * awake and while the Kindle was on the same WiFi. Reading happens on trains.
 * This service runs on a VPS with a public address, so the device needs nothing
 * but an internet connection.
 *
 * ── Why the device never holds a useful credential ─────────────
 * Whatever the Kindle carries is readable: the plugin is plain-text Lua sitting
 * on a mounted USB partition. So the device holds `CEVTUO_DEVICE_TOKEN`, whose
 * entire authority is "may POST a reading-stats document". The GitHub token —
 * the one that can write to the repository — never leaves this process. That
 * asymmetry is the whole reason a server exists in the middle.
 *
 * ── Why it commits the RAW payload and converts nothing ────────
 * The conversion belongs to the pipeline. Storing the raw file means a converter
 * bug is fixed by re-running the pipeline over data already on disk, rather than
 * by asking someone to go find WiFi and sync again.
 *
 * ⚠️ And the one thing that is easy to get wrong: a commit must happen ONLY when
 * the reading actually changed. The plugin pushes on every WiFi connect, and the
 * device stamps `exportedAt` with the current local time — so the bytes differ on
 * every single push even when nobody has read a page. Comparing raw bytes would
 * produce a commit every 30 minutes forever, drowning real changes and burning
 * GitHub Pages' build budget. The comparison therefore ignores `exportedAt`.
 */

import {
  IngestResponseSchema,
  PaperrRawSchema,
  type IngestResponse,
  type PaperrRaw,
} from '@cevtuo/schema';
import { contentHash, scrubError } from '@cevtuo/pipeline-core';

/**
 * ⚠️ A real 41-book export is 10 KB. This is a ceiling on what one request can
 * make the server buffer, not a target — without it, a hostile or broken client
 * can make the process allocate without limit.
 */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Where the raw export is kept. Must match `DATA_PATHS.paperrRaw`. */
export const RAW_PATH = 'data/paperr/raw-koreader.json';

export interface Env {
  /** Bearer the Kindle presents. Grants exactly one thing: POSTing an export. */
  deviceToken: string;
  /** Fine-grained PAT, **Contents: read and write**, scoped to this one repo. */
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  maxBytes: number;
  /**
   * Password for the human-facing page, or null when the admin surface is off.
   *
   * ⚠️ Optional, and null by DEFAULT — an unset password disables `/` and
   * `/api/status` entirely. A deployment that forgets to set it ends up with no
   * admin page, rather than with a page publishing the reader's library.
   */
  adminPassword: string | null;
  workflowFile: string;
}

export function envFrom(source: Record<string, string | undefined>): Env {
  const need = (k: string): string => {
    const v = source[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    // Two DIFFERENT secrets on purpose. Reusing one would mean the token on the
    // Kindle is also the token that can write to the repository.
    deviceToken: need('CEVTUO_DEVICE_TOKEN'),
    githubToken: need('CEVTUO_GITHUB_TOKEN'),
    owner: source.CEVTUO_REPO_OWNER ?? 'cevtuocjw',
    repo: source.CEVTUO_REPO_NAME ?? 'CEVTUO-Z',
    branch: source.CEVTUO_BRANCH ?? 'main',
    path: source.CEVTUO_RAW_PATH ?? RAW_PATH,
    maxBytes: Number(source.CEVTUO_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    adminPassword: source.CEVTUO_ADMIN_PASSWORD ?? null,
    workflowFile: source.CEVTUO_WORKFLOW_FILE ?? 'paperr.yml',
  };
}

/**
 * The slice of the GitHub Contents API this service depends on.
 *
 * Typed as an interface, not called directly, so `verify.ts` can drive the whole
 * handler against an in-memory fake — including the "second identical push
 * produces no commit" case, which is the one that decides whether this service
 * floods the repository.
 */
export interface GithubFileApi {
  /** Returns the file's blob sha and decoded text, or null when absent. */
  getFile(path: string): Promise<{ sha: string; text: string } | null>;
  putFile(
    path: string,
    text: string,
    sha: string | null,
    message: string,
  ): Promise<{ commitSha: string }>;
  /**
   * Optional: only the admin rebuild needs it, so the verify fakes can omit it.
   * Requires **Actions: write** on the PAT, on top of Contents — both scoped to
   * this one repository.
   */
  dispatch?(): Promise<void>;
}

const GH = 'https://api.github.com';

export function githubApi(env: Env, doFetch: typeof fetch = fetch): GithubFileApi {
  const headers = {
    Authorization: `Bearer ${env.githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cevtuo-ingest',
  };
  const url = (path: string) =>
    `${GH}/repos/${env.owner}/${env.repo}/contents/${path}`;

  return {
    async getFile(path) {
      const res = await doFetch(`${url(path)}?ref=${encodeURIComponent(env.branch)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await safeText(res)}`);
      const body = (await res.json()) as { sha?: string; content?: string; encoding?: string };
      if (!body.sha) return null;
      // ⚠️ GitHub wraps base64 at 60 chars, so the payload arrives with newlines
      // embedded. Decoding it without stripping them yields a corrupt string
      // that compares unequal to everything — i.e. a commit on every push,
      // which is the exact failure this whole comparison exists to prevent.
      const text =
        body.encoding === 'base64' && body.content
          ? fromBase64(body.content.replace(/\n/g, ''))
          : '';
      return { sha: body.sha, text };
    },

    async putFile(path, text, sha, message) {
      const res = await doFetch(url(path), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: toBase64(text),
          branch: env.branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await safeText(res)}`);
      const body = (await res.json()) as { commit?: { sha?: string } };
      return { commitSha: body.commit?.sha ?? '' };
    },

    async dispatch() {
      const res = await doFetch(`${GH}/repos/${env.owner}/${env.repo}/actions/workflows/${env.workflowFile}/dispatches`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: env.branch }),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await safeText(res)}`);
    },
  };
}

function toBase64(text: string): string {
  return typeof Buffer !== 'undefined'
    ? Buffer.from(text, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(text)));
}

function fromBase64(b64: string): string {
  return typeof Buffer !== 'undefined'
    ? Buffer.from(b64, 'base64').toString('utf8')
    : decodeURIComponent(escape(atob(b64)));
}

async function safeText(res: Response): Promise<string> {
  try {
    // scrubError, not a local regex — GitHub echoes the Authorization header
    // back on some 401s, and pipeline-core's pattern list is the audited one.
    return scrubError(new Error((await res.text()).slice(0, 200))).message;
  } catch {
    return '<unreadable>';
  }
}

export function isAuthorized(env: Env, authHeader: string | null): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const presented = authHeader.slice(7);
  // Length check first so the XOR loop never runs against a different length.
  if (presented.length !== env.deviceToken.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ env.deviceToken.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * A content signature that IGNORES `exportedAt`.
 *
 * This single line is what keeps "sync on every WiFi connect" from becoming
 * "commit on every WiFi connect". The device stamps `exportedAt` with the time
 * of the export, so two pushes describing the same reading session differ in
 * exactly that field — and in nothing else.
 */
export function signatureOf(payload: PaperrRaw): string {
  return contentHash({ ...payload, exportedAt: null });
}

function reject(message: string, status = 400): { status: number; body: IngestResponse } {
  return {
    status,
    body: IngestResponseSchema.parse({ ok: false, status: 'rejected', message }),
  };
}

/**
 * Validate, then commit only if the reading state actually moved.
 *
 * Never throws: every failure path returns a status the device can ignore and
 * the operator can read.
 */
export async function handleIngest(
  env: Env,
  api: GithubFileApi,
  authHeader: string | null,
  rawBody: string,
  now = new Date(),
): Promise<{ status: number; body: IngestResponse }> {
  if (!isAuthorized(env, authHeader)) {
    return reject('凭据不对', 401);
  }

  // Measured in BYTES, not characters. A 1 MB cap that counts UTF-16 code units
  // lets a CJK payload through at up to 3× the intended size.
  const bytes = new TextEncoder().encode(rawBody).length;
  if (bytes > env.maxBytes) {
    return reject(`导出过大: ${bytes} > ${env.maxBytes} 字节`, 413);
  }

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

  // Book count is a cheap sanity signal. A valid-looking empty export is the
  // shape a half-broken plugin produces, and it must not reach the repository
  // and blank the page.
  if (payload.books.length === 0) {
    return reject('导出里一本书都没有，拒绝覆盖已有数据');
  }

  let current: Awaited<ReturnType<GithubFileApi['getFile']>>;
  try {
    current = await api.getFile(env.path);
  } catch (e) {
    return { status: 502, body: IngestResponseSchema.parse({
      ok: false, status: 'rejected', message: `读取仓库失败: ${scrubError(e).message}`,
    }) };
  }

  if (current) {
    const stored = PaperrRawSchema.safeParse(safeJsonParse(current.text));
    if (stored.success && signatureOf(stored.data) === signatureOf(payload)) {
      // The reading has not moved. Deliberately no commit — see the file header.
      return {
        status: 200,
        body: IngestResponseSchema.parse({
          ok: true,
          status: 'unchanged',
          message: '阅读数据没有变化，未提交',
          books: payload.books.length,
        }),
      };
    }
  }

  // ⚠️ `exportedAt` is kept in the committed file (it is genuinely useful when
  // diagnosing a device), even though it is excluded from the comparison above.
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  let commitSha: string;
  try {
    ({ commitSha } = await api.putFile(
      env.path,
      text,
      current?.sha ?? null,
      `data(paperr): KOReader 导出 ${payload.exportedAt}（${payload.books.length} 本）`,
    ));
  } catch (e) {
    return { status: 502, body: IngestResponseSchema.parse({
      ok: false, status: 'rejected', message: `写入仓库失败: ${scrubError(e).message}`,
    }) };
  }

  return {
    status: 202,
    body: IngestResponseSchema.parse({
      ok: true,
      status: 'committed',
      message: '已提交',
      books: payload.books.length,
      commitSha,
    }),
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Admin — the human-facing side
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️ "Sync" from this side CANNOT mean "fetch from the Kindle".
 *
 * The device has no inbound address, sleeps most of the day, and sits behind
 * whatever NAT it happens to be on. There is no pull. What this button can
 * honestly do is re-run the CONVERSION over the raw export already committed —
 * which is exactly what you want after fixing a converter bug, and needs nothing
 * from the device.
 */
export interface AdminStatus {
  ok: boolean;
  /** `exportedAt` from the stored raw export — when the device last produced it. */
  lastExportAt: string | null;
  books: number;
  readingDays: number;
  rawBytes: number;
  rawPath: string;
  canRebuild: boolean;
  message?: string;
}

export async function handleAdminStatus(
  env: Env,
  api: GithubFileApi,
): Promise<{ status: number; body: AdminStatus }> {
  const base: AdminStatus = {
    ok: true,
    lastExportAt: null,
    books: 0,
    readingDays: 0,
    rawBytes: 0,
    rawPath: env.path,
    canRebuild: typeof api.dispatch === 'function',
  };
  let current: Awaited<ReturnType<GithubFileApi['getFile']>>;
  try {
    current = await api.getFile(env.path);
  } catch (e) {
    return { status: 502, body: { ...base, ok: false, message: scrubError(e).message } };
  }
  if (!current) {
    return { status: 200, body: { ...base, message: '仓库里还没有原始导出' } };
  }
  const parsed = PaperrRawSchema.safeParse(safeJsonParse(current.text));
  if (!parsed.success) {
    return { status: 200, body: { ...base, ok: false, message: '已存的原始导出不符合 schema' } };
  }
  return {
    status: 200,
    body: {
      ...base,
      lastExportAt: parsed.data.exportedAt,
      books: parsed.data.books.length,
      readingDays: parsed.data.daily.length,
      rawBytes: current.text.length,
    },
  };
}

export async function handleRebuild(
  env: Env,
  api: GithubFileApi,
): Promise<{ status: number; body: { ok: boolean; message: string } }> {
  if (typeof api.dispatch !== 'function') {
    return { status: 501, body: { ok: false, message: 'PAT 没有 Actions: write，无法触发' } };
  }
  try {
    await api.dispatch();
    return { status: 202, body: { ok: true, message: `已触发 ${env.workflowFile}` } };
  } catch (e) {
    return { status: 502, body: { ok: false, message: scrubError(e).message } };
  }
}

/**
 * Browser auth for the admin surface.
 *
 * ⚠️ Basic, not Bearer. A page load cannot set an Authorization header, so a
 * bearer-only design would need the token in a query string — which lands in
 * browser history, in the server's own logs, and in any proxy in between.
 *
 * ⚠️ Plain HTTP means this password crosses the network in the clear, same as
 * the device token. It is accepted here because the worst outcome is somebody
 * reading your book list — it grants no repository access and no ability to
 * change anything but the rebuild trigger.
 */
export function isAdminAuthorized(env: Env, authHeader: string | null): boolean {
  if (!env.adminPassword) return false; // unset ⇒ admin surface disabled
  if (!authHeader?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = fromBase64(authHeader.slice(6));
  } catch {
    return false;
  }
  const presented = decoded.slice(decoded.indexOf(':') + 1);
  if (presented.length !== env.adminPassword.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ env.adminPassword.charCodeAt(i);
  }
  return diff === 0;
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
<h1>CE-PAPERR 同步</h1>
<p class="sub">Kindle 的数据存在仓库里。这里只做两件事：看它有多新，以及重新生成一次页面。</p>
<table id="t"><tr><td>读取中…</td><td></td></tr></table>
<button id="b" disabled>重新生成页面</button>
<div id="msg"></div>
<script>
const $ = (s) => document.querySelector(s);
const rows = [
  ['设备最后导出', (d) => d.lastExportAt || '—'],
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
  $('#b').disabled = true; $('#msg').textContent = '触发中…';
  const r = await fetch('/api/rebuild', { method: 'POST' });
  const d = await r.json();
  $('#msg').textContent = d.message + (r.ok ? '（大约 1 分钟后生效）' : '');
  setTimeout(() => { $('#b').disabled = false; load(); }, 4000);
};
load().catch(() => { $('#msg').textContent = '读取失败'; });
</script>
</html>`;
}
