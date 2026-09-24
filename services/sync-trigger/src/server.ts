/**
 * Local HTTP adapter — runs the same handlers as the Worker, on the Mac.
 *
 * Start:  bun run services/sync-trigger/src/server.ts
 * Config: .env (see services/sync-trigger/README.md)
 *
 * ⚠️ Binds 127.0.0.1 by default. This service holds a GitHub token; putting it
 * on 0.0.0.0 exposes that token's blast radius to every device on the network.
 * Set CEVTUO_BIND=0.0.0.0 only deliberately.
 */

import { scrubError } from '@cevtuo/pipeline-core';
import { envFrom, githubApi, handleStatus, handleSync, isAuthorized } from './core';

const env = envFrom(process.env);
const api = githubApi(env);

const PORT = Number(process.env.CEVTUO_PORT ?? 8788);
const BIND = process.env.CEVTUO_BIND ?? '127.0.0.1';

/**
 * The H5/Android build is served from a different origin than this service, so
 * the browser needs CORS. Kept to the deployed site + local dev rather than `*`,
 * because this endpoint spends real Actions minutes.
 */
const ALLOWED_ORIGINS = new Set(
  // ⚠️ `http://apps.cevtuogrnd.com` — see the long note in
  // services/ingest/src/server.ts. The site is served over plain HTTP because no
  // certificate could be issued for the custom domain, and `z.cevtuogrnd.com`
  // has no DNS record at all.
  (process.env.CEVTUO_ALLOWED_ORIGINS ??
    'http://apps.cevtuogrnd.com,https://cevtuocjw.github.io,http://cevtuocjw.github.io,http://localhost:10086')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

const started = Date.now();

const server = Bun.serve({
  port: PORT,
  hostname: BIND,

  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Unauthenticated: a liveness probe must not need a credential, or a
    // monitoring script has to hold one just to ask "are you up".
    if (url.pathname === '/health') {
      return json({ ok: true, uptimeSeconds: Math.floor((Date.now() - started) / 1000) }, 200, origin);
    }

    if (url.pathname === '/api/sync' || url.pathname === '/api/status') {
      if (!isAuthorized(env, req.headers.get('authorization'))) {
        return json({ error: 'unauthorized' }, 401, origin);
      }

      try {
        if (url.pathname === '/api/sync') {
          if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
          const result = await handleSync(env, api);
          // 202 = queued, 409 = a run is already active. Both are honest answers;
          // returning 200 for a refused trigger would make the button lie.
          return json(result, result.accepted ? 202 : 409, origin);
        }
        return json(await handleStatus(env, api), 200, origin);
      } catch (e) {
        // Scrub before it can reach a log line or a response body.
        const msg = scrubError(e).message;
        console.error(`[sync-trigger] ${url.pathname} 出错: ${msg}`);
        return json({ error: msg }, 500, origin);
      }
    }

    return json({ error: 'not found' }, 404, origin);
  },
});

console.log(`[sync-trigger] 监听 http://${BIND}:${server.port}`);
console.log(`[sync-trigger] 目标仓库 ${env.owner}/${env.repo} · 工作流 ${env.workflowFile}`);
console.log(`[sync-trigger] 防抖 ${env.debounceSeconds}s · 允许来源 ${[...ALLOWED_ORIGINS].join(', ')}`);
