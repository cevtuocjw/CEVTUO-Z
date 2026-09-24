#!/usr/bin/env bun
/**
 * Verification for the ingest service.
 *
 *   bun run services/ingest/verify.ts
 *
 * Drives the REAL `handleIngest` against an in-memory fake of the GitHub
 * Contents API, using a REAL export off the Kindle as the fixture.
 *
 * The case that matters most is #8: the plugin pushes on every WiFi connect and
 * re-stamps `exportedAt` each time, so "same reading, later export" is the
 * NORMAL case — and it must not produce a commit. Get that wrong and the
 * repository gains forty-eight commits a day that say nothing.
 */

import { readFileSync } from 'node:fs';

import { IngestResponseSchema } from '@cevtuo/schema';
import { repoPath } from '@cevtuo/pipeline-core';

import { envFrom, handleIngest, isAuthorized, signatureOf, type Env, type GithubFileApi } from './src/core';

const passes: string[] = [];
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passes.push(label);
  else failures.push(`${label}${extra !== undefined ? `   <got: ${JSON.stringify(extra)}>` : ''}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    actual === expected ? undefined : actual,
  );
}

// ── Fixture: a real device export ────────────────────────────
const RAW_PATH = repoPath('data/paperr/raw-koreader.json');
const RAW_TEXT = readFileSync(RAW_PATH, 'utf8');
const RAW = JSON.parse(RAW_TEXT) as Record<string, unknown>;

const ENV: Env = envFrom({
  CEVTUO_DEVICE_TOKEN: 'device-token-aaaaaaaaaaaaaaaa',
  CEVTUO_GITHUB_TOKEN: 'ghp_not_a_real_token',
  CEVTUO_MAX_BYTES: '1048576',
});

const AUTH = `Bearer ${ENV.deviceToken}`;

/** A PAT-shaped string: `ghp_` + 36 alphanumerics, as a real one is. */
const FAKE_GH = `ghp_${'abcdefghijklmnopqrstuvwxyz0123456789'}`;

/** In-memory stand-in for the Contents API, counting writes. */
function fakeApi(initial: string | null = null) {
  let file: { sha: string; text: string } | null = initial == null ? null : { sha: 'sha-1', text: initial };
  let puts = 0;
  let rev = 1;
  const api: GithubFileApi = {
    async getFile() {
      return file;
    },
    async putFile(_path, text) {
      puts += 1;
      rev += 1;
      file = { sha: `sha-${rev}`, text };
      return { commitSha: `commit-${rev}` };
    },
  };
  return { api, puts: () => puts, stored: () => file?.text ?? null };
}

/** A copy of the export with `exportedAt` moved forward and nothing else. */
function reExportedAt(stamp: string): Record<string, unknown> {
  return { ...RAW, exportedAt: stamp };
}

async function main(): Promise<void> {
  console.log('\n═══ services/ingest 验证 ═══\n');

  // ── Auth ───────────────────────────────────────────────────
  check(isAuthorized(ENV, AUTH), 'auth: correct bearer accepted');
  check(!isAuthorized(ENV, null), 'auth: missing header rejected');
  check(!isAuthorized(ENV, 'device-token-aaaaaaaaaaaaaaaa'), 'auth: header without "Bearer " rejected');
  check(!isAuthorized(ENV, 'Bearer wrong'), 'auth: wrong token rejected');
  check(
    !isAuthorized(ENV, `Bearer ${ENV.deviceToken}x`),
    'auth: correct-prefix-plus-more rejected (length guard)',
  );

  {
    const { api } = fakeApi();
    const r = await handleIngest(ENV, api, 'Bearer nope', RAW_TEXT);
    eq(r.status, 401, 'auth: 401 on bad token');
    eq(r.body.status, 'rejected', 'auth: body says rejected');
  }

  // ── Size ───────────────────────────────────────────────────
  {
    const { api } = fakeApi();
    // Measured in BYTES. A CJK character is 3 bytes in UTF-8 but 1 in UTF-16 —
    // a character-counting cap would let this through at 3× the limit.
    const big = '中'.repeat(400);
    const tight: Env = { ...ENV, maxBytes: 1000 };
    const r = await handleIngest(tight, api, AUTH, big);
    eq(r.status, 413, 'size: CJK body measured in bytes, 413 over the cap');
  }

  // ── Malformed input ────────────────────────────────────────
  for (const [label, body] of [
    ['not JSON', 'not json at all'],
    ['JSON but not the right shape', JSON.stringify({ hello: 'world' })],
    ['books missing', JSON.stringify({ ...RAW, books: undefined })],
    ['books empty', JSON.stringify({ ...RAW, books: [] })],
    ['daily entry with a bad day key', JSON.stringify({ ...RAW, daily: [{ d: '2026/09/24', s: 1, p: 1 }] })],
  ] as const) {
    const { api, puts } = fakeApi();
    const r = await handleIngest(ENV, api, AUTH, body);
    eq(r.status, 400, `input: 400 for ${label}`);
    eq(puts(), 0, `input: no commit for ${label}`);
  }

  // ── The signature rule ─────────────────────────────────────
  check(
    signatureOf(reExportedAt('2099-01-01T00:00') as never) ===
      signatureOf(reExportedAt('2020-01-01T00:00') as never),
    'signature: ignores exportedAt',
  );
  check(
    signatureOf({ ...RAW, totals: { ...(RAW.totals as object), readSeconds: 1 } } as never) !==
      signatureOf(RAW as never),
    'signature: sensitive to actual reading changes',
  );

  // ── The three outcomes that matter ─────────────────────────
  {
    const { api, puts, stored } = fakeApi();
    const r = await handleIngest(ENV, api, AUTH, RAW_TEXT);
    eq(r.status, 202, 'first push: 202 committed');
    eq(r.body.status, 'committed', 'first push: body says committed');
    eq(r.body.books, 41, 'first push: reports 41 books');
    eq(puts(), 1, 'first push: exactly one write');
    check(
      JSON.parse(stored() ?? 'null') !== null,
      'first push: stored file is valid JSON',
    );
    IngestResponseSchema.parse(r.body);
  }

  {
    const { api, puts } = fakeApi(RAW_TEXT);
    // ⚠️ THE case. Same reading, later export — the device does this on every
    // single WiFi connect.
    const r = await handleIngest(ENV, api, AUTH, JSON.stringify(reExportedAt('2026-09-24T18:00')));
    eq(r.status, 200, 'same reading later export: 200');
    eq(r.body.status, 'unchanged', 'same reading later export: unchanged');
    eq(puts(), 0, 'same reading later export: ZERO commits');
  }

  {
    // Key order shuffled — a different board, or a JSON library that sorts keys.
    const { api, puts } = fakeApi(RAW_TEXT);
    const shuffled = JSON.stringify(
      Object.fromEntries(Object.entries(reExportedAt('2026-09-24T19:00')).reverse()),
    );
    const r = await handleIngest(ENV, api, AUTH, shuffled);
    eq(r.body.status, 'unchanged', 'key order shuffled: still unchanged');
    eq(puts(), 0, 'key order shuffled: no commit');
  }

  {
    const { api, puts } = fakeApi(RAW_TEXT);
    const read = {
      ...reExportedAt('2026-09-24T20:00'),
      totals: { booksStarted: 41, booksFinished: 4, readSeconds: 56600, pagesTurned: 2490 },
    };
    const r = await handleIngest(ENV, api, AUTH, JSON.stringify(read));
    eq(r.status, 202, 'reading advanced: 202 committed');
    eq(puts(), 1, 'reading advanced: one commit');
  }

  {
    // A stale/corrupt file on the branch must be overwritten, not compared against.
    const { api, puts } = fakeApi('{ this is not json');
    const r = await handleIngest(ENV, api, AUTH, RAW_TEXT);
    eq(r.status, 202, 'corrupt stored file: 202, overwritten');
    eq(puts(), 1, 'corrupt stored file: one commit');
  }

  {
    // A perfectly good export that happens to be a strict subset still wins if
    // the stored file is a DIFFERENT valid export — guarded here so the earlier
    // "unchanged" wins are not an artefact of never reaching putFile.
    const other = JSON.stringify({ ...reExportedAt('2026-09-01T00:00'), books: [] });
    const { api, puts } = fakeApi(other);
    const r = await handleIngest(ENV, api, AUTH, RAW_TEXT);
    eq(r.status, 202, 'different valid stored export: 202');
    eq(puts(), 1, 'different valid stored export: one commit');
  }

  // ── GitHub failures must not look like success ─────────────
  {
    const api: GithubFileApi = {
      async getFile() {
        // ⚠️ Must be a REALISTIC length. pipeline-core matches
        // /\bgh[pousr]_[A-Za-z0-9]{16,}/ — a short fake like "ghp_secret"
        // sails straight through the scrubber and makes this assertion fail for
        // the wrong reason. (It did.)
        throw new Error(`GitHub 401: bad credentials ${FAKE_GH}`);
      },
      async putFile() {
        throw new Error('unreachable');
      },
    };
    const r = await handleIngest(ENV, api, AUTH, RAW_TEXT);
    eq(r.status, 502, 'github read failure: 502');
    check(!r.body.message.includes(FAKE_GH), 'github read failure: token scrubbed from message', r.body.message);
  }

  {
    const api: GithubFileApi = {
      async getFile() {
        return null;
      },
      async putFile() {
        throw new Error('GitHub 422: sha mismatch');
      },
    };
    const r = await handleIngest(ENV, api, AUTH, RAW_TEXT);
    eq(r.status, 502, 'github write failure: 502');
  }

  // ── Report ─────────────────────────────────────────────────
  console.log(`PASS ${passes.length}, FAIL ${failures.length}`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
