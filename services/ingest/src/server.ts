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
 * What makes binding 0.0.0.0 acceptable here:
 *   · The device credential can do exactly one thing — POST a reading export.
 *     It cannot read the data back and it holds no repository access.
 *   · Reading the data requires `CEVTUO_ADMIN_PASSWORD`.
 *   · A wrong credential costs a length check and an XOR loop, nothing else.
 *
 * The real control is the cloud provider's security group: expose ONE port.
 */

import { resolve } from 'node:path';

import { scrubError } from '@cevtuo/pipeline-core';
import { defaultRepoRoot, repoConverter } from './converter';
import {
  envFrom,
  handleAdminStatus,
  handleCurrent,
  handleIngest,
  handleRebuild,
  isAdminAuthorized,
  renderAdminPage,
} from './core';
import { fsStore } from './store';

const env = envFrom(process.env);
const REPO_ROOT = process.env.CEVTUO_REPO_DIR ? resolve(process.env.CEVTUO_REPO_DIR) : defaultRepoRoot();
const store = fsStore(REPO_ROOT);
const converter = repoConverter(REPO_ROOT);

const PORT = Number(process.env.CEVTUO_PORT ?? 8789);
const BIND = process.env.CEVTUO_BIND ?? '0.0.0.0';

/**
 * Origins allowed to read the data from a browser.
 *
 * ⚠️ A list, not `*`. The data endpoint is authenticated, and `*` would let any
 * page on the internet ask a logged-in browser for it. The site is public, so
 * this is not paranoia — it is the difference between "my dashboard can read it"
 * and "any page I happen to visit can".
 */
const ALLOWED_ORIGINS = new Set(
  (
    process.env.CEVTUO_ALLOWED_ORIGINS ??
    [
      // ⚠️ `http://`, not `https://`.
      //
      // The site is served over plain HTTP: `apps.cevtuogrnd.com` is a GitHub
      // Pages custom domain whose certificate could not be issued (the Pages
      // settings say "Enforce HTTPS — Unavailable for your site because your
      // domain is not properly configured"). A browser at that site sends
      // `Origin: http://apps.cevtuogrnd.com`, and an https entry here matches
      // NOTHING — the fetch is refused by CORS and the 在读 panel silently shows
      // its lock, on a deployment that is working perfectly.
      //
      // ⚠️ `z.cevtuogrnd.com` used to be listed here. It has no DNS record at
      // all, so it could never have matched anything.
      'http://apps.cevtuogrnd.com',
      'https://cevtuocjw.github.io',
      'http://cevtuocjw.github.io',
      'http://127.0.0.1:8096',
      'http://localhost:10086',
    ].join(',')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function cors(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // ⚠️ `Authorization` must be listed or the browser's preflight fails and the
    // fetch never happens — with no error the page can act on, only a console
    // message the reader will never look at.
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/**
 * Per-IP token bucket.
 *
 * ⚠️ Not anti-abuse and not a substitute for the bearer check — it exists so a
 * single misbehaving client (a device stuck in a connect loop, or a scanner)
 * cannot make this process spend all its time parsing bodies it will reject.
 * 30/min is far above what one Kindle needs: the plugin debounces to one push
 * per 30 minutes.
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

const started = Date.now();

const server = Bun.serve({
  port: PORT,
  hostname: BIND,
  maxRequestBodySize: env.maxBytes,

  async fetch(req) {
    const url = new URL(req.url);
    const now = Date.now();
    const origin = req.headers.get('origin');
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
      });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    // Unauthenticated by design: a liveness probe must not need a credential, or
    // the monitoring script has to hold one just to ask "are you up".
    if (url.pathname === '/health') {
      return json({ ok: true, uptimeSeconds: Math.floor((now - started) / 1000) }, 200);
    }

    // ── The device ─────────────────────────────────────────────
    if (url.pathname === '/api/paperr') {
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || server.requestIP(req)?.address
        || 'unknown';
      if (buckets.size > 1000) for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
      if (rateLimited(ip, now)) return json({ error: 'too many requests' }, 429);

      let rawBody: string;
      try {
        rawBody = await req.text();
      } catch {
        return json({ error: 'body too large' }, 413); // Bun throws past maxRequestBodySize
      }

      try {
        const { status, body } = await handleIngest(env, store, converter, req.headers.get('authorization'), rawBody);
        // ⚠️ The outcome, never the body: the payload is the reader's entire
        // library, and server logs are the easiest thing in the world to leak.
        console.log(`[ingest] ${ip} ${status} ${body.status} ${body.message}`);
        return json(body, status);
      } catch (e) {
        const msg = scrubError(e).message;
        console.error(`[ingest] ${ip} 500 ${msg}`);
        return json({ error: msg }, 500);
      }
    }

    // ── The page's private bit (browser, Basic auth, CORS) ─────
    //
    // ⚠️ Only the CURRENT book. The history, the charts and the shelf are public
    // and come from `data/paperr/index.json` on the site — routing them through
    // here as well would put the reader's whole library behind a password that
    // nobody asked for, and make the site depend on this server to render at all.
    if (url.pathname === '/api/paperr/current.json') {
      const r = await handleCurrent(env, store, req.headers.get('authorization'));
      return json(r.body, r.status);
    }

    // ── Admin surface (browser, Basic auth) ────────────────────
    if (url.pathname === '/' || url.pathname === '/api/status' || url.pathname === '/api/rebuild') {
      if (!isAdminAuthorized(env, req.headers.get('authorization'))) {
        return new Response('需要登录', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="CEVTUO CAPPERR", charset="UTF-8"', ...cors(origin) },
        });
      }
      if (url.pathname === '/') {
        return new Response(renderAdminPage(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/api/status') {
        const r = await handleAdminStatus(env, store);
        return json(r.body, r.status);
      }
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const r = await handleRebuild(env, store, converter);
      return json(r.body, r.status);
    }

    return json({ error: 'not found' }, 404);
  },
});

console.log(`[ingest] 监听 http://${BIND}:${server.port}`);
console.log(`[ingest] 数据目录 ${REPO_ROOT}/data/paperr/`);
console.log(`[ingest] 体积上限 ${env.maxBytes} 字节 · 限速 ${RATE_LIMIT_PER_MINUTE}/分钟/IP`);
console.log(`[ingest] 允许来源 ${[...ALLOWED_ORIGINS].join(', ')}`);
