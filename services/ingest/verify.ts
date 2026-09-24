#!/usr/bin/env bun
/**
 * Verification for the ingest service.
 *
 *   bun run services/ingest/verify.ts
 *
 * Drives the REAL `handleIngest` against an in-memory Store, using a REAL export
 * off the Kindle as the fixture, and — in the last block — the REAL converter.
 *
 * The two cases that matter most:
 *   · #6, "same reading, later export" — the plugin pushes on every WiFi
 *     connect and re-stamps `exportedAt` each time, so this is the NORMAL case
 *     and it must change nothing.
 *   · #8, a broken converter must not cost the reader their data.
 */

import { readFileSync } from 'node:fs';

import { IngestResponseSchema, PaperrIndexSchema } from '@cevtuo/schema';
import { repoPath } from '@cevtuo/pipeline-core';

import { repoConverter } from './src/converter';
import {
  envFrom,
  handleAdminStatus,
  handleIngest,
  isAdminAuthorized,
  isAuthorized,
  signatureOf,
  type Converter,
  type Env,
  type Store,
} from './src/core';

const passes: string[] = [];
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passes.push(label);
  else failures.push(`${label}${extra !== undefined ? `   <got: ${JSON.stringify(extra)}>` : ''}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, actual === expected ? undefined : actual);
}

// ── Fixture: a real device export ────────────────────────────
const RAW_TEXT = readFileSync(repoPath('data/paperr/raw-koreader.json'), 'utf8');
const RAW = JSON.parse(RAW_TEXT) as Record<string, unknown>;

const ENV: Env = envFrom({
  CEVTUO_DEVICE_TOKEN: 'device-token-aaaaaaaaaaaaaaaa',
  CEVTUO_ADMIN_PASSWORD: 'pw-for-tests',
  CEVTUO_MAX_BYTES: '1048576',
});
const AUTH = `Bearer ${ENV.deviceToken}`;
const BASIC = `Basic ${Buffer.from('x:pw-for-tests').toString('base64')}`;

/** In-memory Store, counting writes so "did anything change?" is answerable. */
function memStore(initial: { raw?: string; heartbeat?: string } = {}) {
  let raw = initial.raw ?? null;
  let heartbeat: string | null = initial.heartbeat ?? null;
  const writes: string[] = [];
  const store: Store = {
    async readRaw() {
      return raw;
    },
    async writeRaw(t) {
      writes.push('raw');
      raw = t;
    },
    async readHeartbeat() {
      return heartbeat;
    },
    async writeHeartbeat(t) {
      writes.push('heartbeat');
      heartbeat = t;
    },
  };
  return {
    store,
    writes: () => writes,
    raw: () => raw,
    heartbeat: () => heartbeat,
  };
}

/**
 * A stand-in for the real pipeline converter.
 *
 * ⚠️ What is under test in most of this file is the ingest's DECISION-MAKING —
 * when to write, when to stay quiet, what to do when conversion fails — and none
 * of that depends on the shape of the index. The converter's own correctness is
 * covered by the last block, which runs the real one.
 */
function fakeConverter(behaviour: 'ok' | 'fail' = 'ok'): Converter {
  return {
    async convert() {
      if (behaviour === 'fail') return { error: '转换器炸了' };
      // ⚠️ Nothing to return: the CLI writes both output files itself. What is
      // under test here is the ingest's DECISION-MAKING — when to write, when to
      // stay quiet, what to do when conversion fails.
      return { ok: true };
    },
  };
}
const CONV = fakeConverter();

/** A copy of the export with `exportedAt` moved forward and nothing else. */
const reExportedAt = (stamp: string) => ({ ...RAW, exportedAt: stamp });

async function main(): Promise<void> {
  console.log('\n═══ services/ingest 验证 ═══\n');

  // ── Auth ───────────────────────────────────────────────────
  check(isAuthorized(ENV, AUTH), 'auth: correct bearer accepted');
  check(!isAuthorized(ENV, null), 'auth: missing header rejected');
  check(!isAuthorized(ENV, 'device-token-aaaaaaaaaaaaaaaa'), 'auth: header without "Bearer " rejected');
  check(!isAuthorized(ENV, `Bearer ${ENV.deviceToken}x`), 'auth: length guard rejects a longer token');
  check(isAdminAuthorized(ENV, BASIC), 'auth: correct Basic password accepted');
  check(!isAdminAuthorized(ENV, 'Basic ' + Buffer.from('x:wrong').toString('base64')), 'auth: wrong password rejected');
  check(!isAdminAuthorized({ ...ENV, adminPassword: null }, BASIC), 'auth: unset password disables the surface');

  {
    const { store } = memStore();
    const r = await handleIngest(ENV, store, CONV, 'Bearer nope', RAW_TEXT);
    eq(r.status, 401, 'auth: 401 on bad device token');
    eq(r.body.status, 'rejected', 'auth: body says rejected');
  }

  // ── Size ───────────────────────────────────────────────────
  {
    const { store } = memStore();
    const top: Env = { ...ENV, maxBytes: 1000 };
    // Measured in BYTES. A CJK character is 3 bytes in UTF-8 and 1 in UTF-16 —
    // a character-counting cap would let this through at 3× the limit.
    const r = await handleIngest(top, store, CONV, AUTH, '中'.repeat(400));
    eq(r.status, 413, 'size: CJK body measured in bytes, 413 over the cap');
  }

  // ── Malformed input ────────────────────────────────────────
  for (const [label, body] of [
    ['not JSON', 'not json at all'],
    ['JSON but the wrong shape', JSON.stringify({ hello: 'world' })],
    ['books missing', JSON.stringify({ ...RAW, books: undefined })],
    ['books empty', JSON.stringify({ ...RAW, books: [] })],
    ['a bad day key', JSON.stringify({ ...RAW, daily: [{ d: '2026/09/24', s: 1, p: 1 }] })],
  ] as const) {
    const { store, writes } = memStore();
    const r = await handleIngest(ENV, store, CONV, AUTH, body);
    eq(r.status, 400, `input: 400 for ${label}`);
    eq(writes(), [], `input: nothing written for ${label}`);
  }

  // ── The signature rule ─────────────────────────────────────
  check(
    signatureOf(reExportedAt('2099-01-01T00:00') as never) === signatureOf(reExportedAt('2020-01-01T00:00') as never),
    'signature: ignores exportedAt',
  );
  check(
    signatureOf({ ...RAW, totals: { ...(RAW.totals as object), readSeconds: 1 } } as never) !== signatureOf(RAW as never),
    'signature: sensitive to actual reading changes',
  );

  // ── The outcomes that matter ───────────────────────────────
  {
    const { store, writes, raw } = memStore();
    const r = await handleIngest(ENV, store, CONV, AUTH, RAW_TEXT);
    eq(r.status, 202, 'first push: 202');
    eq(r.body.books, 41, 'first push: reports 41 books');
    eq(writes(), ['raw', 'heartbeat'], 'first push: the export and the heartbeat are written');
    eq(JSON.parse(raw() ?? 'null')?.books?.length, 41, 'first push: the raw export is stored verbatim');
    eq(JSON.parse(raw() ?? 'null')?.exportedAt, RAW.exportedAt, 'first push: including its exportedAt');
    // ⚠️ VERBATIM, and this assertion has to compare the TEXT — the previous
    // version compared a parsed field, which passes just as happily for a
    // re-serialised, schema-normalised copy. That is what it was.
    eq(raw(), RAW_TEXT.endsWith('\n') ? RAW_TEXT : `${RAW_TEXT}\n`,
       'first push: the export is stored byte for byte, not re-serialised');
    // ⚠️ And the consequence: a field the schema has never heard of must still
    // survive. This is what makes a future plugin upgrade diagnosable.
    {
      const { store: s2, raw: r2 } = memStore();
      const extra = JSON.stringify({ ...RAW, somethingFromAFuturePlugin: { a: 1 } });
      await handleIngest(ENV, s2, CONV, AUTH, extra);
      check((r2() ?? '').includes('somethingFromAFuturePlugin'),
            'unknown fields survive storage — a newer plugin is not silently flattened');
    }
    IngestResponseSchema.parse(r.body);
  }

  {
    // ⚠️ THE case. Same reading, later export — what the device sends on every
    // single WiFi connect.
    const { store, writes, heartbeat } = memStore({ raw: RAW_TEXT });
    const r = await handleIngest(ENV, store, CONV, AUTH, JSON.stringify(reExportedAt('2026-09-24T18:00')));
    eq(r.status, 200, 'same reading, later export: 200');
    eq(r.body.status, 'unchanged', 'same reading, later export: unchanged');
    // ⚠️ The EXPORT is not rewritten — that is what stops an empty commit every
    // 30 minutes — but the heartbeat is. This is the assertion that would have
    // saved the reader a round of "同步没有生效" on 2026-09-24: two pushes
    // arrived, were correctly compared, and left no trace they could see.
    eq(writes(), ['heartbeat'], 'same reading, later export: only the heartbeat is stamped');
    check((heartbeat() ?? '').includes('lastPushAt'), 'same reading: the heartbeat records the push', heartbeat());
    check(!(heartbeat() ?? '').includes('lastChangeAt'), 'same reading: and does NOT claim the data changed', heartbeat());
    // ⚠️ The stamp must carry the SERVER's offset, not `Z`.
    //
    // The page formats these by slicing characters 0–16 rather than parsing —
    // parsing would re-read the instant in the VIEWER's timezone and shift the
    // time for anyone reading from abroad. So a UTC stamp renders eight hours
    // early here: a 13:27 push displays as "05:27", a wrong answer that looks
    // like a plausible one. `toISOString()` is the obvious way to write this and
    // it is the wrong one.
    const stamp = (JSON.parse(heartbeat() ?? '{}') as { lastPushAt?: string }).lastPushAt ?? '';
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(stamp),
          'heartbeat: stamped with a local offset, not a bare Z', stamp);
  }

  {
    // Key order shuffled — a different board, or a JSON library that sorts keys.
    const { store, writes } = memStore({ raw: RAW_TEXT });
    const shuffled = JSON.stringify(Object.fromEntries(Object.entries(reExportedAt('2026-09-24T19:00')).reverse()));
    const r = await handleIngest(ENV, store, CONV, AUTH, shuffled);
    eq(r.body.status, 'unchanged', 'key order shuffled: still unchanged');
    eq(writes(), ['heartbeat'], 'key order shuffled: only the heartbeat is stamped');
  }

  {
    const { store, writes } = memStore({ raw: RAW_TEXT });
    const read = { ...reExportedAt('2026-09-24T20:00'), totals: { booksStarted: 41, booksFinished: 4, readSeconds: 56600, pagesTurned: 2490 } };
    const r = await handleIngest(ENV, store, CONV, AUTH, JSON.stringify(read));
    eq(r.status, 202, 'reading advanced: 202');
    eq(writes(), ['raw', 'heartbeat'], 'reading advanced: the export is rewritten');
  }

  {
    // A corrupt stored file must be overwritten, not compared against.
    const { store, writes } = memStore({ raw: '{ this is not json' });
    const r = await handleIngest(ENV, store, CONV, AUTH, RAW_TEXT);
    eq(r.status, 202, 'corrupt stored export: 202, overwritten');
    eq(writes(), ['raw', 'heartbeat'], 'corrupt stored export: rewritten');
  }

  // ── A broken converter must not cost the reader their data ─
  //
  // ⚠️ The raw export is the half that cannot be reconstructed from anything
  // else on this machine. A converter failure must (a) still save it, (b) not
  // leave a half-written index, and (c) SAY so where the operator will see it.
  {
    const { store, writes } = memStore();
    const r = await handleIngest(ENV, store, fakeConverter('fail'), AUTH, RAW_TEXT);
    eq(r.status, 202, 'converter failure: still 202, not an error');
    eq(writes(), ['raw', 'heartbeat'], 'converter failure: the export is still saved');
    check(r.body.message.includes('重新生成失败'), 'converter failure: the message says so', r.body.message);
  }

  // ⚠️ The `/api/paperr/current.json` block was here: five assertions driving a
  // password-gated endpoint whose file nothing ever wrote. They passed because
  // the store was hand-built for them. **A test that exercises dead code is
  // worse than no test** — it makes a route look alive.
  //
  // The same book is in `index.current`, publicly, and the page renders it.

  // ── Admin status ───────────────────────────────────────────
  {
    const { store } = memStore({ raw: RAW_TEXT });
    const r = await handleAdminStatus(ENV, store);
    eq(r.body.books, 41, 'admin status: book count');
    eq(r.body.lastExportAt, RAW.exportedAt, 'admin status: last export time');
    eq(r.body.canRebuild, true, 'admin status: rebuild is available');
    // ⚠️ Provenance matters more here than anywhere else on the page: the
    // reader must be able to tell "the device talked to us" from "the numbers
    // moved".
    eq(r.body.lastChangeAt, null, 'admin status: no heartbeat yet reads as null, not as an error');
    eq(r.body.lastPushAt, null, 'admin status: both heartbeat fields default to null');
  }

  // ── The real converter, end to end ─────────────────────────
  //
  // ⚠️ Everything above runs against a FAKE converter. This block runs the
  // actual pipeline binary over the actual device export and validates what
  // comes back against the schema the page consumes. It matters because the
  // whole reason the ingest converts locally is that this call has to work.
  {
    const { store } = memStore();
    let real: Converter;
    try {
      real = repoConverter();
      const r = await handleIngest(ENV, store, real, AUTH, RAW_TEXT);
      eq(r.status, 202, 'real converter: 202');
      check(!r.body.message.includes('重新生成失败'), 'real converter: conversion succeeded', r.body.message);

      // ⚠️ Read from DISK, not from anything the ingest handed back — the whole
      // point of the current design is that the CLI owns both output files.
      const parsed = PaperrIndexSchema.safeParse(JSON.parse(readFileSync(repoPath('data/paperr/index.json'), 'utf8')));
      check(parsed.success, 'real converter: output satisfies PaperrIndexSchema',
            parsed.success ? '' : String(parsed.error.issues[0]?.message));
      if (parsed.success) {
        const d = parsed.data;
        eq(d.books.length, 36, 'real converter: 36 visible rows');
        // ⚠️ `current` is IN the public index. It was briefly pulled out into a
        // separate private file; the reader decided the whole dashboard is
        // publishable, so the split went away and these assertions went stale.
        check(d.current !== null, 'real converter: the index carries the current book');
        check(d.current?.estFinishedAt != null, 'real converter: with a finish projection',
              d.current?.estFinishedAt);
        check(d.books.some((b) => b.id === d.current?.id),
              'real converter: the current book is also in the shelf', d.current?.id);
        // ⚠️ 24 slots even though the export on disk predates the plugin change
        // that produces real ones — the chart depends on the gaps being there.
        eq(d.hourly.length, 24, 'real converter: hourly is filled to 24 slots');
        eq(d.totals.booksStarted, d.books.length, 'real converter: totals agree with the rows shown');
        check(d.books.every((b) => !/koreader/i.test(b.title)), 'real converter: no KOReader documents survive');
        // ⚠️ Derived from the rows themselves, not from `books.length - 1`.
        // That constant was written when exactly one row survived unrelabelled;
        // normalizing the feed authors then moved two RSS articles out of the
        // `unknown` bucket and the assertion started failing on a correct index.
        const relabelled = d.books.filter((b) => b.originalTitle != null);
        const labelled = relabelled.filter((b) => /^(news|unknown)\d+ \(.+\)$/.test(b.title));
        eq(labelled.length, relabelled.length, 'real converter: every relabelled row carries its original');
        eq(d.books.length - relabelled.length, 3,
           'real converter: exactly three rows are real titles, not generated labels');
      }
    } catch (e) {
      check(false, 'real converter: could not run', String(e).slice(0, 120));
    }
  }

  // ── Every field the page reads must exist in the payload ───
  //
  // ⚠️ This is the data-side twin of "功能写完但没接线". The page reads fields
  // off the index; the pipeline writes them. Nothing was checking that the two
  // lists agree, and the failure mode is silent — a field the page reads that
  // the index does not carry arrives as `undefined`, renders as an empty chart
  // or a NaN, and looks like a styling bug.
  //
  // ⚠️ And the reverse is how the reader got a lede promising 划线: a field can
  // sit in the schema and the payload for months while NOTHING reads it. That
  // direction is not an error, but it is worth knowing about — it is where a
  // promise with no data behind it hides.
  {
    const idx = JSON.parse(readFileSync(repoPath('data/paperr/index.json'), 'utf8')) as Record<string, unknown>;
    const books = (idx.books ?? []) as Array<Record<string, unknown>>;

    // The book fields `pages/paperr` and `pages/home` actually render.
    const READ_BY_PAGE = [
      'id', 'title', 'originalTitle', 'authors', 'series', 'pages',
      'totalReadTime', 'totalReadPages', 'lastOpen', 'progressPct', 'estFinishedAt',
    ];
    const missing = READ_BY_PAGE.filter((f) => books.length > 0 && !(f in (books[0] ?? {})));
    eq(missing, [], 'index: every book field the page reads is present');

    const topLevel = ['books', 'daily', 'hourly', 'monthly', 'totals', 'dataVersion'];
    eq(topLevel.filter((k) => !(k in idx)), [], 'index: every top-level key the page reads is present');

    // ⚠️ Reported, not asserted: a field nothing reads is not a bug, and
    // failing here would block a deploy over a harmless extra.
    const CARRIED_NOT_READ = ['highlights', 'notes'];
    const orphans = CARRIED_NOT_READ.filter((f) => books.length > 0 && f in (books[0] ?? {}));
    if (orphans.length) {
      console.log(`  · 载入但无人读取的字段：${orphans.join(', ')}（不是错，但别再拿它写文案）`);
    }
  }

  console.log(`PASS ${passes.length}, FAIL ${failures.length}`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
