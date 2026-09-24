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

import { IngestResponseSchema, PaperrIndexSchema } from '@cevtuo/schema';
import { repoPath } from '@cevtuo/pipeline-core';

import { repoConverter } from './src/converter';
import {
  envFrom,
  handleIngest,
  isAuthorized,
  signatureOf,
  type Converter,
  type Env,
  type GithubFileApi,
} from './src/core';

/**
 * A stand-in for the real pipeline converter.
 *
 * ⚠️ It returns a body the test can recognise, NOT a real index. What is under
 * test here is the ingest's decision-making — when to commit, when to stay
 * quiet, what to do when the converter fails — and none of that depends on the
 * shape of the index. The converter's own correctness is covered by the page
 * verification, which reads the real `data/paperr/index.json` off a real
 * device export.
 */
function fakeConverter(behaviour: 'ok' | 'fail' = 'ok'): Converter {
  return {
    async run() {
      if (behaviour === 'fail') return { error: '转换器炸了' };
      return { indexText: `${JSON.stringify({ schemaVersion: 1, converted: true }, null, 2)}\n` };
    },
  };
}
const CONV = fakeConverter();

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
  // ⚠️ Which files were written, not just how many. "Exactly one write" stopped
  // being the right question the moment the ingest began committing the index
  // as well as the raw export — the interesting assertion is now the ORDER and
  // the NAMES, because a converter failure must leave raw committed and index
  // untouched.
  const written: string[] = [];
  // ⚠️ Keyed by path, not "the last thing written". The ingest writes TWO files
  // now, so a single `stored()` returns whichever landed last — an assertion
  // written against it silently starts checking the index instead of the raw
  // export the moment the order changes.
  const store = new Map<string, string>();
  const api: GithubFileApi = {
    async getFile() {
      return file;
    },
    async putFile(path, text) {
      puts += 1;
      rev += 1;
      written.push(path);
      store.set(path, text);
      file = { sha: `sha-${rev}`, text };
      return { commitSha: `commit-${rev}` };
    },
  };
  return {
    api,
    puts: () => puts,
    written: () => written,
    storedOf: (path: string) => store.get(path) ?? null,
  };
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
    const r = await handleIngest(ENV, api, CONV, 'Bearer nope', RAW_TEXT);
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
    const r = await handleIngest(tight, api, CONV, AUTH, big);
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
    const r = await handleIngest(ENV, api, CONV, AUTH, body);
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
    const { api, puts, written, storedOf } = fakeApi();
    const r = await handleIngest(ENV, api, CONV, AUTH, RAW_TEXT);
    eq(r.status, 202, 'first push: 202 committed');
    eq(r.body.status, 'committed', 'first push: body says committed');
    eq(r.body.books, 41, 'first push: reports 41 books');
    eq(puts(), 2, 'first push: commits the raw export AND the index');
    eq(written(), ['data/paperr/raw-koreader.json', 'data/paperr/index.json'],
       'first push: raw is committed BEFORE the index');
    // The RAW file must be the device's export verbatim — that is the whole
    // point of storing it rather than only the converted result.
    const rawStored = JSON.parse(storedOf('data/paperr/raw-koreader.json') ?? 'null');
    eq(rawStored?.books?.length, 41, 'first push: the raw export is stored verbatim');
    eq(rawStored?.exportedAt, RAW.exportedAt, 'first push: including its exportedAt');
    const idxStored = JSON.parse(storedOf('data/paperr/index.json') ?? 'null');
    eq(idxStored?.converted, true, 'first push: the index came from the converter');
    IngestResponseSchema.parse(r.body);
  }

  {
    const { api, puts } = fakeApi(RAW_TEXT);
    // ⚠️ THE case. Same reading, later export — the device does this on every
    // single WiFi connect.
    const r = await handleIngest(ENV, api, CONV, AUTH, JSON.stringify(reExportedAt('2026-09-24T18:00')));
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
    const r = await handleIngest(ENV, api, CONV, AUTH, shuffled);
    eq(r.body.status, 'unchanged', 'key order shuffled: still unchanged');
    eq(puts(), 0, 'key order shuffled: no commit');
  }

  {
    const { api, puts } = fakeApi(RAW_TEXT);
    const read = {
      ...reExportedAt('2026-09-24T20:00'),
      totals: { booksStarted: 41, booksFinished: 4, readSeconds: 56600, pagesTurned: 2490 },
    };
    const r = await handleIngest(ENV, api, CONV, AUTH, JSON.stringify(read));
    eq(r.status, 202, 'reading advanced: 202 committed');
    eq(puts(), 2, 'reading advanced: raw + index');
  }

  {
    // A stale/corrupt file on the branch must be overwritten, not compared against.
    const { api, puts } = fakeApi('{ this is not json');
    const r = await handleIngest(ENV, api, CONV, AUTH, RAW_TEXT);
    eq(r.status, 202, 'corrupt stored file: 202, overwritten');
    eq(puts(), 2, 'corrupt stored file: raw + index');
  }

  {
    // A perfectly good export that happens to be a strict subset still wins if
    // the stored file is a DIFFERENT valid export — guarded here so the earlier
    // "unchanged" wins are not an artefact of never reaching putFile.
    const other = JSON.stringify({ ...reExportedAt('2026-09-01T00:00'), books: [] });
    const { api, puts } = fakeApi(other);
    const r = await handleIngest(ENV, api, CONV, AUTH, RAW_TEXT);
    eq(r.status, 202, 'different valid stored export: 202');
    eq(puts(), 2, 'different valid stored export: raw + index');
  }

  // ── A broken converter must not cost the reader their data ─
  //
  // ⚠️ The raw export is the irreplaceable half: it is the only copy of what the
  // device knows, and the device may not sync again for days. The index is
  // derivable from it at any time. So conversion failure must (a) still commit
  // raw, (b) not commit a half-written index, and (c) SAY so.
  {
    const { api, written } = fakeApi();
    const r = await handleIngest(ENV, api, fakeConverter('fail'), AUTH, RAW_TEXT);
    eq(r.status, 202, 'converter failure: still 202, not an error');
    eq(written(), ['data/paperr/raw-koreader.json'], 'converter failure: raw committed, index NOT');
    check(r.body.message.includes('重新生成失败'), 'converter failure: the message says so', r.body.message);
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
    const r = await handleIngest(ENV, api, CONV, AUTH, RAW_TEXT);
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
    const r = await handleIngest(ENV, api, CONV, AUTH, RAW_TEXT);
    eq(r.status, 502, 'github write failure: 502');
  }

  // ── Report ─────────────────────────────────────────────────
  // ── The real converter, end to end ─────────────────────────
  //
  // ⚠️ Everything above runs against a FAKE converter. This block runs the
  // actual pipeline binary over the actual device export and validates what
  // comes back against the schema the page consumes.
  //
  // It matters because the whole reason the ingest converts locally — rather
  // than committing and letting a workflow do it — is that this call has to
  // work. A fake cannot tell us whether it does.
  {
    const { api, written, storedOf } = fakeApi();
    const r = await handleIngest(ENV, api, repoConverter(), AUTH, RAW_TEXT);
    eq(r.status, 202, 'real converter: 202');
    check(!r.body.message.includes('重新生成失败'), 'real converter: conversion succeeded', r.body.message);
    eq(written(), ['data/paperr/raw-koreader.json', 'data/paperr/index.json'],
       'real converter: both files committed');

    const idxText = storedOf('data/paperr/index.json');
    let idx: unknown = null;
    try {
      idx = JSON.parse(idxText ?? 'null');
    } catch {
      idx = null;
    }
    const parsed = PaperrIndexSchema.safeParse(idx);
    check(parsed.success, 'real converter: output satisfies PaperrIndexSchema',
          parsed.success ? '' : String(parsed.error.issues[0]?.message));

    if (parsed.success) {
      const d = parsed.data;
      check(d.books.length === 36, 'real converter: 36 visible rows', d.books.length);
      check(d.totals.booksStarted === d.books.length,
            'real converter: totals agree with the rows shown',
            `${d.totals.booksStarted} vs ${d.books.length}`);
      check(d.books.every((b) => !/koreader/i.test(b.title)),
            'real converter: no KOReader documents survive');
      const labelled = d.books.filter((b) => /^(news|unknown)\d+ \(.+\)$/.test(b.title));
      check(labelled.length === d.books.length - 1,
            'real converter: every relabelled row carries its original',
            `${labelled.length} of ${d.books.length}`);
      check(d.current !== null && d.current.estFinishedAt !== null,
            'real converter: a current book with a finish projection');
    }
  }

  console.log(`PASS ${passes.length}, FAIL ${failures.length}`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
