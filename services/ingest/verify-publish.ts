#!/usr/bin/env bun
/**
 * Verification for the publish step.
 *
 *   bun run services/ingest/verify-publish.ts
 *
 * ⚠️ Drives the REAL `githubPublisher` over a REAL HTTP server that speaks the
 * shape of GitHub's contents API. Mocking `fetch` instead would test that the
 * code calls the function it wrote, not that the request it builds is one
 * GitHub would accept — and the mistakes available here (a missing User-Agent,
 * a `sha` sent on create, base64 with the wrong newline handling) are exactly
 * the ones a function-level mock cannot see.
 *
 * ⚠️ The case that matters most is #2. The device pushes on every WiFi connect,
 * so a publisher that writes unconditionally is an empty commit every 30
 * minutes — the same failure `handleIngest` already goes to some trouble to
 * avoid one layer up.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { githubPublisher, type PublisherConfig } from './src/publish';

const passes: string[] = [];
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passes.push(label);
  else failures.push(`${label}${extra !== undefined ? `   <got: ${JSON.stringify(extra)}>` : ''}`);
}

const INDEX = '{\n  "schemaVersion": 1,\n  "books": []\n}\n';

/** A stand-in for GitHub's `/repos/:owner/:repo/contents/:path`. */
function fakeGithub(initial: { content?: string; sha?: string; getStatus?: number; putStatus?: number }) {
  const calls: { method: string; url: string; auth: string | null; agent: string | null; body: unknown }[] = [];
  let stored = initial.content ?? null;
  let sha = initial.sha ?? 'sha-initial';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'PUT' ? await req.json() : null;
      calls.push({
        method: req.method,
        url: url.pathname + url.search,
        auth: req.headers.get('authorization'),
        agent: req.headers.get('user-agent'),
        body,
      });

      if (req.method === 'GET') {
        if (initial.getStatus && initial.getStatus !== 200) {
          return new Response('boom', { status: initial.getStatus });
        }
        if (stored === null) return new Response('{"message":"Not Found"}', { status: 404 });
        return Response.json({ sha, content: Buffer.from(stored, 'utf8').toString('base64') });
      }

      if (req.method === 'PUT') {
        if (initial.putStatus && initial.putStatus !== 200) {
          return new Response('{"message":"Bad credentials"}', { status: initial.putStatus });
        }
        const b = body as { content: string; sha?: string; branch: string };
        stored = Buffer.from(b.content, 'base64').toString('utf8');
        sha = 'sha-updated';
        return Response.json({ content: { sha } });
      }
      return new Response('nope', { status: 405 });
    },
  });

  return {
    calls,
    api: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}

async function withFile<T>(text: string, fn: (p: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cevtuo-pub-'));
  const p = join(dir, 'index.json');
  await writeFile(p, text, 'utf8');
  try {
    return await fn(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const cfg = (api: string, localPath: string, token: string | null): PublisherConfig => ({
  token,
  repo: 'cevtuo/CEVTUO-Z',
  branch: 'gh-pages',
  path: 'data/paperr/index.json',
  localPath,
  api,
});

async function main(): Promise<void> {
  console.log('\n═══ services/ingest 发布验证 ═══\n');

  // ── 1. No token is a supported state ──────────────────────
  {
    const g = fakeGithub({});
    const r = await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, null)).publish());
    check(r.ok && r.changed === false, 'no token: reports "nothing to do", not a failure', r);
    check(g.calls.length === 0, 'no token: does not touch the network at all', g.calls.length);
    g.close();
  }

  // ── 2. ⚠️ THE case: identical remote must not write ───────
  {
    const g = fakeGithub({ content: INDEX });
    const r = await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, 'tok')).publish());
    check(r.ok && r.changed === false, 'identical remote: reports unchanged', r);
    check(g.calls.filter((c) => c.method === 'PUT').length === 0,
          'identical remote: NOTHING written — this is the empty-commit guard',
          g.calls.map((c) => c.method));
    g.close();
  }

  // ── 3. A real change writes, with the sha ─────────────────
  {
    const g = fakeGithub({ content: '{"old":true}\n', sha: 'sha-abc' });
    const r = await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, 'tok')).publish());
    check(r.ok && r.changed === true, 'changed remote: reports written', r);
    const put = g.calls.find((c) => c.method === 'PUT');
    check(!!put, 'changed remote: issues a PUT');
    const b = put?.body as { sha?: string; content?: string; branch?: string } | undefined;
    check(b?.sha === 'sha-abc', 'changed remote: sends the sha it read', b?.sha);
    check(b?.branch === 'gh-pages', 'changed remote: targets the publishing branch', b?.branch);
    check(Buffer.from(b?.content ?? '', 'base64').toString('utf8') === INDEX,
          'changed remote: the body round-trips byte for byte');
    g.close();
  }

  // ── 4. First publish: 404, so no sha ──────────────────────
  {
    const g = fakeGithub({ content: undefined });
    const r = await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, 'tok')).publish());
    check(r.ok && r.changed === true, 'file absent: creates it', r);
    const b = g.calls.find((c) => c.method === 'PUT')?.body as { sha?: string } | undefined;
    check(b !== undefined && b.sha === undefined,
          'file absent: PUT carries NO sha — sending one is a 422', b);
    g.close();
  }

  // ── 5. ⚠️ Every request must be authenticated and identified ─
  {
    const g = fakeGithub({ content: INDEX });
    await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, 'tok-secret')).publish());
    check(g.calls.every((c) => c.auth === 'Bearer tok-secret'),
          'auth: every call carries the bearer token', g.calls.map((c) => c.auth));
    // ⚠️ GitHub 403s a request with no User-Agent, and the message reads like a
    // credentials problem — an hour lost to the wrong error.
    check(g.calls.every((c) => !!c.agent),
          'auth: every call carries a User-Agent (GitHub 403s without one)',
          g.calls.map((c) => c.agent));
    g.close();
  }

  // ── 6. A bad token is a failure, and says so ──────────────
  {
    const g = fakeGithub({ content: '{"old":1}', putStatus: 401 });
    const r = await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, 'bad')).publish());
    check(!r.ok, 'bad token: reported as a failure, not as "unchanged"', r);
    check(r.ok === false && r.error.includes('401'), 'bad token: the message carries the status', r);
    g.close();
  }

  // ── 7. A read failure must not be mistaken for "no file yet" ─
  //
  // ⚠️ Treating a 500 like a 404 would PUT without a sha, which GitHub rejects
  // with a 422 — so the publish dies either way, but with a message about the
  // wrong thing.
  {
    const g = fakeGithub({ content: INDEX, getStatus: 500 });
    const r = await withFile(INDEX, (p) => githubPublisher(cfg(g.api, p, 'tok')).publish());
    check(!r.ok, 'read 500: a failure, NOT treated as a first publish', r);
    check(g.calls.filter((c) => c.method === 'PUT').length === 0,
          'read 500: does not attempt the write');
    g.close();
  }

  // ── 8. A missing local file is reported, not thrown ───────
  {
    const g = fakeGithub({ content: INDEX });
    const r = await githubPublisher(cfg(g.api, '/nonexistent/index.json', 'tok')).publish();
    check(!r.ok && r.error.includes('转换器'), 'missing local index: explained in the operator\'s terms', r);
    g.close();
  }

  console.log(`PASS ${passes.length}, FAIL ${failures.length}`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
