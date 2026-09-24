/**
 * Cloudflare Worker adapter — the original target for this service.
 *
 * Not deployed: there is no Cloudflare account. It exists so that adopting one
 * later is `wrangler deploy`, not a rewrite — the logic in `core.ts` is shared
 * verbatim with the local server, and this file is only the binding glue.
 *
 * Secrets (wrangler secret put):
 *   CEVTUO_GITHUB_TOKEN   fine-grained PAT, Actions: write only
 *   CEVTUO_CLIENT_TOKEN   bearer the app presents
 */

import { scrubError } from '@cevtuo/pipeline-core';
import { envFrom, githubApi, handleStatus, handleSync, isAuthorized, type Env } from './core';

export interface WorkerEnv {
  CEVTUO_GITHUB_TOKEN: string;
  CEVTUO_CLIENT_TOKEN: string;
  CEVTUO_REPO_OWNER?: string;
  CEVTUO_REPO_NAME?: string;
  CEVTUO_WORKFLOW_FILE?: string;
  CEVTUO_DEBOUNCE_SECONDS?: string;
}

export default {
  async fetch(req: Request, raw: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    const env: Env = envFrom(raw as unknown as Record<string, string | undefined>);

    const cors = {
      // ⚠️ http, for the same reason as the server adapter — no certificate
      // could be issued for this custom domain.
      'Access-Control-Allow-Origin': 'http://apps.cevtuogrnd.com',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    };
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
      });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200);
    if (url.pathname !== '/api/sync' && url.pathname !== '/api/status') {
      return json({ error: 'not found' }, 404);
    }

    if (!isAuthorized(env, req.headers.get('authorization'))) {
      return json({ error: 'unauthorized' }, 401);
    }

    const api = githubApi(env);
    try {
      if (url.pathname === '/api/status') return json(await handleStatus(env, api), 200);
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const result = await handleSync(env, api);
      return json(result, result.accepted ? 202 : 409);
    } catch (e) {
      return json({ error: scrubError(e).message }, 500);
    }
  },
};
