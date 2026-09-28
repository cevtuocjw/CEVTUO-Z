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

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { scrubError } from '@cevtuo/pipeline-core';
import { defaultRepoRoot, repoConverter } from './converter';
import {
  envFrom,
  handleAdminStatus,
  handleIngest,
  handleRebuild,
  isAdminAuthorized,
  renderAdminPage,
} from './core';
import {
  HealthRawSchema,
  buildSealedIndexFromStore,
  handleHealthIngest,
  type HealthEnv,
} from './chealth';
import { healthPublisherFromEnv, publisherFromEnv } from './publish';
import { fsHealthStore, fsStore } from './store';

const env = envFrom(process.env);
const REPO_ROOT = process.env.CEVTUO_REPO_DIR ? resolve(process.env.CEVTUO_REPO_DIR) : defaultRepoRoot();
const store = fsStore(REPO_ROOT);
const converter = repoConverter(REPO_ROOT);
const publisher = publisherFromEnv(REPO_ROOT);
const healthPublisher = healthPublisherFromEnv(REPO_ROOT);
const healthStore = fsHealthStore(REPO_ROOT);

/**
 * ⚠️ A SEPARATE token from `CEVTUO_DEVICE_TOKEN`, and it is allowed to be
 * absent so the CAPPERR deployment keeps working untouched.
 *
 * Both devices are equally readable (plain Lua on a USB partition; an APK that
 * anyone can unzip). What separation buys is blast radius, not secrecy: a leaked
 * Kindle token cannot invent a step count, and a leaked health token cannot
 * rewrite the library.
 */
const healthToken = process.env.CEVTUO_HEALTH_TOKEN || '';
/**
 * ⚠️ Absent means nothing is published — never means publish in the clear.
 * The published file is the reader's step count, heart rate and sleep at a
 * public URL until this is set.
 */
const healthPassphrase = process.env.CEVTUO_HEALTH_PASSPHRASE || null;
const healthEnv: HealthEnv | null = healthToken
  ? { healthToken, maxBytes: Number(process.env.CEVTUO_HEALTH_MAX_BYTES ?? 512 * 1024) }
  : null;

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
      // ⚠️ BOTH schemes, and dropping either one breaks a real state of the
      // world. `Origin` is matched as an exact string, so `http://…` and
      // `https://…` are two different entries — not a prefix pair.
      //
      // `apps.cevtuogrnd.com` is a GitHub Pages custom domain. Until
      // 2026-09-28 it had never had a certificate issued at all (the Pages
      // settings read "Enforce HTTPS — Unavailable for your site because your
      // domain is not properly configured"), so the site could only be loaded
      // over plain HTTP and that was the only Origin it ever sent.
      //
      // ⚠️ The transition is the reason both are here, and it is not a tidy
      // one: Pages serves HTTP and HTTPS *simultaneously* after the certificate
      // is issued, and only starts redirecting once "Enforce HTTPS" is ticked
      // in the settings — two separate switches, minutes to hours apart. A
      // reader who loaded the site in between sends the http Origin. Remove
      // that entry and the 在读 panel shows its lock, silently, on a deployment
      // that is working perfectly.
      //
      // ⚠️ The https entry is the load-bearing one going forward: an HTTPS page
      // fetching `http://120.77.27.128:8789` is killed by mixed-content
      // blocking before CORS is ever consulted (measured, see the TLS block at
      // the bottom of this file), which is why the two heartbeat URLs in
      // `apps/dashboard/src/platform/data.ts` moved to `https://…:8443` in the
      // same change. Allowlisting https here without moving those would have
      // changed nothing at all.
      //
      // ⚠️ `z.cevtuogrnd.com` used to be listed here. It has no DNS record at
      // all, so it could never have matched anything.
      'http://apps.cevtuogrnd.com',
      'https://apps.cevtuogrnd.com',
      // ⚠️ 仪表盘从 2026-09-28 起有了自己的域名。项目站一旦声明自定义域名，
      // GitHub 就把它服务在**该域名根路径**上，不再是 `/CEVTUO-Z/`。
      //
      // ⚠️ 少了这两条，HTTPS 页面上的心跳会被 CORS 拒绝 —— 而两个 fetch 都是
      // `catch { return null }`，症状只有页面上两个「—」和零报错。
      'https://z.cevtuogrnd.com',
      'http://z.cevtuogrnd.com',
      'https://cevtuocjw.github.io',
      'http://cevtuocjw.github.io',
      // ⚠️ The local verification port. `scripts/verify-paperr-ui.mjs` serves a
      // real build on 8098 and drives a real browser against it; without this
      // entry the page's heartbeat fetch is CORS-blocked, the browser logs a
      // console error, and the suite's "no console/page errors" assertion fails
      // on a page that is perfectly correct. A test that has to ignore an error
      // is a test that stops noticing the next one.
      'http://127.0.0.1:8098',
      'http://localhost:8098',
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

        // ⚠️ Only on a real change. A publish is two GitHub calls; running them
        // for an `unchanged` push would make every WiFi connect cost four
        // requests to publish a file that is already correct.
        //
        // ⚠️ A publish failure does NOT fail the push. The export is on disk and
        // the index is regenerated either way — the same reasoning as the
        // converter itself. The reader gets a 202 and the message says what did
        // not make it.
        let message = body.message;
        if (status === 202 && publisher) {
          const pub = await publisher.publish();
          if (!pub.ok) {
            message = `${message}；但发布到网站失败：${pub.error}`;
            console.error(`[publish] ${pub.error}`);
          } else {
            console.log(`[publish] ${pub.changed ? '已更新网站' : '网站已是最新'}`);
          }
        }

        // ⚠️ The outcome, never the body: the payload is the reader's entire
        // library, and server logs are the easiest thing in the world to leak.
        console.log(`[ingest] ${ip} ${status} ${body.status} ${message}`);
        return json({ ...body, message }, status);
      } catch (e) {
        const msg = scrubError(e).message;
        console.error(`[ingest] ${ip} 500 ${msg}`);
        return json({ error: msg }, 500);
      }
    }

    // ── Heartbeat (public, no auth) ────────────────────────────
    //
    // ⚠️ Public on purpose. The page reads this to answer "is the Kindle still
    // syncing?", and putting it behind the admin password would mean the only
    // person who can see it is the one who already knows how to check. It
    // carries no titles and no per-book data — only when a push last arrived.
    //
    // ⚠️⚠️ This route was DELETED BY ACCIDENT, by an edit that removed the
    // route above it. Both blocks were adjacent and the removal was done by
    // slicing between two indices — the same mistake as the duplicated
    // `ProgressBands` earlier. What it cost: the page's heartbeat fetch 404'd
    // on every load, silently, because a failed diagnostic is designed to be
    // silent. The only thing that caught it was a generic "Failed to load
    // resource: 404" in the UI suite's console-error assertion.
    //
    // ⚠️ `/api/paperr/current.json` used to sit here too — the password-gated
    // "what am I reading" endpoint. Nothing wrote its file, so it could only
    // 404. See the note in `core.ts`.
    if (url.pathname === '/api/paperr/heartbeat.json') {
      const r = await handleAdminStatus(env, store);
      const b = r.body as {
        lastPushAt?: string | null;
        lastChangeAt?: string | null;
        pluginVersion?: string | null;
        books?: number;
      };
      return json(
        {
          lastPushAt: b.lastPushAt ?? null,
          lastChangeAt: b.lastChangeAt ?? null,
          pluginVersion: b.pluginVersion ?? null,
          books: b.books ?? 0,
        },
        200,
      );
    }

    // ── The phone ──────────────────────────────────────────────
    //
    // ⚠️ 202 Accepted on a real change, 200 on `unchanged` — same contract as
    // `/api/paperr`, and for the same reason: the device pushes every 15
    // minutes, so "I heard you" and "the numbers moved" have to be different
    // answers or the operator learns to ignore both.
    if (url.pathname === '/api/chealth') {
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!healthEnv) return json({ error: 'CEVTUO_HEALTH_TOKEN 未设置，健康接口关闭' }, 503);

      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || server.requestIP(req)?.address
        || 'unknown';
      if (buckets.size > 1000) for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
      if (rateLimited(ip, now)) return json({ error: 'too many requests' }, 429);

      let rawBody: string;
      try {
        rawBody = await req.text();
      } catch {
        return json({ error: 'body too large' }, 413);
      }

      try {
        const { status, body } = await handleHealthIngest(
          healthEnv, healthStore, req.headers.get('authorization'), rawBody,
        );

        let message = body.message;
        if (status === 202) {
          // ⚠️ The index is written from the MERGED store, never from the
          // request body. The request is a 30-day window; the index is the
          // accumulated series. Writing the window would make the site quietly
          // forget everything older every time the phone synced — the exact
          // failure this module exists to prevent, reintroduced one layer up.
          const sealed = await buildSealedIndexFromStore(healthStore, healthPassphrase);
          const indexText = 'sealed' in sealed ? sealed.sealed : null;
          if (!indexText) {
            message = `${message}；未发布（${'skipped' in sealed ? sealed.skipped : '无数据'}）`;
          } else {
            await healthStore.writeIndex(indexText);
            if (healthPublisher) {
              const pub = await healthPublisher.publish();
              // ⚠️ Logged on success too. Without that line there is no way to
              // tell "published and found nothing to do" from "never ran".
              if (!pub.ok) {
                message = `${message}；但发布到网站失败：${pub.error}`;
                console.error(`[publish:health] ${pub.error}`);
              } else {
                console.log(`[publish:health] ${pub.changed ? '已更新网站' : '网站已是最新'}`);
              }
            }
          }
        }

        // ⚠️ Outcome only. The body is 30 days of the reader's heart rate.
        console.log(`[chealth] ${ip} ${status} ${body.status} ${message}`);
        return json({ ...body, message }, status);
      } catch (e) {
        const msg = scrubError(e).message;
        console.error(`[chealth] ${ip} 500 ${msg}`);
        return json({ error: msg }, 500);
      }
    }

    // ── Health heartbeat (public, no auth) ─────────────────────
    // ⚠️ Public for the same reason as the reading one: the page uses it to
    // answer "is the phone still reporting?", and a diagnostic behind a
    // password is only readable by someone who already knows the answer.
    if (url.pathname === '/api/chealth/heartbeat.json') {
      const beat = await healthStore.readHeartbeat();
      const mergedText = await healthStore.readMerged();
      let dayCount = 0; let to: string | null = null;
      try {
        const m = mergedText ? HealthRawSchema.safeParse(JSON.parse(mergedText)) : null;
        if (m?.success) {
          dayCount = m.data.days.length;
          to = m.data.days[m.data.days.length - 1]?.date ?? null;
        }
      } catch { /* heartbeat must not 500 over a corrupt store */ }
      return json({ lastPushAt: beat, dayCount, to }, 200);
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

      // ⚠️ Rebuild is the button you press after fixing a converter bug, so the
      // whole point of it is to see the correction on the site afterwards.
      let msg = (r.body as { message?: string }).message;
      // ⚠️ `ok`, NOT `status === 200`. `handleRebuild` answers 202 Accepted —
      // the work is done but the response is not a fresh representation — and
      // this read 200, so the whole publish block below never ran once. The
      // endpoint kept saying "已重新生成" while the site kept showing whatever
      // had been published last, which is the worst kind of wrong: the operator
      // gets a success message and the data does not move.
      if ((r.body as { ok?: boolean }).ok && publisher) {
        const pub = await publisher.publish();
        // ⚠️ Logged on every outcome, not only on failure. Without the success
        // case there is no way to tell "the publish ran and found nothing to do"
        // from "the publish never ran" — which is exactly the ambiguity that
        // cost a round of reverse-engineering the minified bundle.
        console.log(`[publish] rebuild → ${pub.ok ? (pub.changed ? '已更新' : '远端已是最新') : `失败: ${pub.error}`}`);
        if (!pub.ok) msg = `${msg}；但发布到网站失败：${pub.error}`;
        else if (pub.changed) msg = `${msg}；已更新网站`;
      }
      return json({ ...r.body, message: msg }, r.status);
    }

    return json({ error: 'not found' }, 404);
  },
});

/**
 * Optional TLS listener — a thin terminator in front of the HTTP one.
 *
 * ⚠️⚠️ Why this exists at all: the site is served over plain HTTP from GitHub
 * Pages, and the moment it moves to HTTPS the browser blocks every request to
 * this box. Measured with Playwright on 2026-09-28:
 *
 *     fetch('http://120.77.27.128:8789/...')  →  requestfailed: mixed-content
 *     "Mixed Content: ... has been blocked"
 *
 * ⚠️ And both heartbeats are written to swallow exactly that failure, so the
 * symptom would have been two dash marks and no error anywhere.
 *
 * ⚠️ Why a FORWARDER rather than `tls:` on the server above. The phone and the
 * Kindle POST plain HTTP to 8789 and must keep working; moving that listener to
 * TLS would break every deployed client in the field. This way 8789 is
 * untouched and 8443 speaks TLS to the same handler.
 *
 * ⚠️ Why 8443 and not 443. Aliyun only serves 80/443 for domains that carry an
 * ICP filing. `api.cevtuogrnd.com` has none yet, so 443 is not ours to use;
 * the certificate itself is fine on any port (it was issued over DNS-01, which
 * never touches the host). 443 is where this moves once the filing lands —
 * and that step is what the WeChat mini program actually needs.
 *
 * ⚠️ Degrades to nothing if the certs are absent. The service must never fail
 * to start because a certificate is missing — that would take the reading sync
 * down with it.
 */
const TLS_PORT = Number(process.env.CEVTUO_TLS_PORT ?? 8443);
const TLS_CERT = process.env.CEVTUO_TLS_CERT ?? '/opt/cevtuo-ingest/certs/fullchain.pem';
const TLS_KEY = process.env.CEVTUO_TLS_KEY ?? '/opt/cevtuo-ingest/certs/privkey.pem';

if (existsSync(TLS_CERT) && existsSync(TLS_KEY)) {
  try {
    const tlsServer = Bun.serve({
      port: TLS_PORT,
      hostname: BIND,
      tls: { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) },
      fetch: (req) => {
        // Forward to the loopback HTTP listener. `origin` is carried through
        // untouched, so the CORS decision above stays the single source of
        // truth about who may read this.
        const u = new URL(req.url);
        u.protocol = 'http:';
        u.host = `127.0.0.1:${PORT}`;
        return fetch(u, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: 'manual',
        });
      },
    });
    console.log(`[ingest] 监听 https://${BIND}:${tlsServer.port}（转发到 :${PORT}）`);
  } catch (e) {
    // ⚠️ Loud, but not fatal — same rule as the certs being absent.
    console.log(`[ingest] ⚠️ TLS 监听未启动：${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  console.log(`[ingest] 未找到证书（${TLS_CERT}），只跑 HTTP`);
}

console.log(`[ingest] 监听 http://${BIND}:${server.port}`);
console.log(`[ingest] 数据目录 ${REPO_ROOT}/data/paperr/`);
console.log(`[ingest] 体积上限 ${env.maxBytes} 字节 · 限速 ${RATE_LIMIT_PER_MINUTE}/分钟/IP`);
console.log(`[ingest] 允许来源 ${[...ALLOWED_ORIGINS].join(', ')}`);
