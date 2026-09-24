/**
 * Ingest HTTP adapter — runs the handlers in `core.ts`.
 *
 * Start:  bun run services/ingest/src/server.ts
 * Config: .env (see services/ingest/README.md)
 *
 * ⚠️ Unlike `services/sync-trigger`, this one is SUPPOSED to be reachable from
 * the internet — that is the entire reason it exists. The Kindle is on whatever
 * WiFi it finds; it cannot reach a loopback address.
 *
 * What makes binding 0.0.0.0 acceptable here, and what did NOT make it
 * acceptable for sync-trigger:
 *
 *   · The credential on the wire is `CEVTUO_DEVICE_TOKEN`, which can do exactly
 *     one thing — POST a reading-stats document. It cannot read the repo or
 *     trigger Actions.
 *   · `CEVTUO_GITHUB_TOKEN` lives only in this process's environment.
 *   · A wrong token costs a length check and an XOR loop, nothing else.
 *
 * The real control is the cloud provider's security group: expose ONE port, and
 * only that port. Do not put this behind a shared reverse proxy that also
 * fronts anything else.
 */

import { resolve } from 'node:path';

import { scrubError } from '@cevtuo/pipeline-core';
import { defaultRepoRoot, repoConverter } from './converter';
import {
  envFrom,
  githubApi,
  handleAdminStatus,
  handleIngest,
  handleRebuild,
  isAdminAuthorized,
  renderAdminPage,
  type Converter,
} from './core';

const env = envFrom(process.env);
const api = githubApi(env);

/**
 * Where the repository lives on this machine.
 *
 * `src/` → `services/ingest/` → `services/` → repo root, hence three levels.
 * Overridable so the service can be moved without editing code.
 */
const REPO_ROOT = process.env.CEVTUO_REPO_DIR
  ? resolve(process.env.CEVTUO_REPO_DIR)
  : defaultRepoRoot();

const converter = repoConverter(REPO_ROOT);


const PORT = Number(process.env.CEVTUO_PORT ?? 8789);
const BIND = process.env.CEVTUO_BIND ?? '0.0.0.0';

/**
 * Per-IP token bucket.
 *
 * ⚠️ Not an anti-abuse feature and not a substitute for the bearer check — it
 * exists so that a single misbehaving client (a device stuck in a connect loop,
 * or a scanner) cannot make this process spend all its time parsing JSON bodies
 * it is going to reject. 30/min is far above what one Kindle needs: the plugin
 * debounces itself to one push per 30 minutes.
 */
const RATE_LIMIT_PER_MINUTE = Number(process.env.CEVTUO_RATE_LIMIT ?? 30);
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string, now: number): boolean {
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT_PER_MINUTE;
}

/** Keeps the map from growing without bound on a long-lived process. */
function sweep(now: number): void {
  if (buckets.size < 1000) return;
  for (const [ip, b] of buckets) if (now >= b.resetAt) buckets.delete(ip);
}

function json(body: unknown, status: number): Response {
  // No CORS headers: the only client is a Kindle running Lua, not a browser.
  // Omitting them is not an oversight — an Access-Control-Allow-Origin here
  // would only ever help a web page someone else controls.
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const started = Date.now();

const server = Bun.serve({
  port: PORT,
  hostname: BIND,
  // A body larger than this is refused before it is buffered.
  maxRequestBodySize: env.maxBytes,

  async fetch(req) {
    const url = new URL(req.url);
    const now = Date.now();

    // Unauthenticated by design: a liveness probe must not need a credential,
    // or the monitoring script has to hold the device token.
    if (url.pathname === '/health') {
      return json({ ok: true, uptimeSeconds: Math.floor((now - started) / 1000) }, 200);
    }

    // ── Admin surface (a browser, Basic auth) ──────────────────
    // ⚠️ Basic, because a page load cannot set an Authorization header. Without
    // the password configured, isAdminAuthorized returns false and all three
    // routes 401 — a forgotten env var must not publish the reader's library.
    if (url.pathname === '/' || url.pathname === '/api/status' || url.pathname === '/api/rebuild') {
      if (!isAdminAuthorized(env, req.headers.get('authorization'))) {
        return new Response('需要登录', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="CEVTUO CAPPERR", charset="UTF-8"' },
        });
      }
      if (url.pathname === '/') {
        return new Response(renderAdminPage(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/api/status') {
        const r = await handleAdminStatus(env, api);
        return json(r.body, r.status);
      }
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const r = await handleRebuild(env, api, converter);
      return json(r.body, r.status);
    }

    if (url.pathname !== '/api/paperr') {
      return json({ error: 'not found' }, 404);
    }
    if (req.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || server.requestIP(req)?.address
      || 'unknown';
    sweep(now);
    if (rateLimited(ip, now)) {
      return json({ error: 'too many requests' }, 429);
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      // Bun throws here when the body exceeds maxRequestBodySize.
      return json({ error: 'body too large' }, 413);
    }

    try {
      const { status, body } = await handleIngest(env, api, converter, req.headers.get('authorization'), rawBody);
      // ⚠️ Log the outcome, never the body: the export contains the reader's
      // entire library, and server logs are the easiest thing to leak.
      console.log(`[ingest] ${ip} ${status} ${body.status} ${body.message}`);
      return json(body, status);
    } catch (e) {
      // Scrub before it can reach a log line or a response body.
      const msg = scrubError(e).message;
      console.error(`[ingest] ${ip} 500 ${msg}`);
      return json({ error: msg }, 500);
    }
  },
});

console.log(`[ingest] 监听 http://${BIND}:${server.port}`);
console.log(`[ingest] 目标仓库 ${env.owner}/${env.repo}@${env.branch} · ${env.path}`);
console.log(`[ingest] 体积上限 ${env.maxBytes} 字节 · 限速 ${RATE_LIMIT_PER_MINUTE}/分钟/IP`);
console.log(`[ingest] 仓库检出 ${REPO_ROOT}`);
