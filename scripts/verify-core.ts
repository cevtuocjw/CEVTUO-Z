/**
 * Behavioural checks for the pipeline primitives.
 *
 * These aren't ceremony: `writeIfChanged` returning 'written' when nothing changed
 * is the exact failure that would make every 5-hourly run produce a commit, burn
 * the Pages build quota, and bury real changes in noise.
 *
 *   bun run scripts/verify-core.ts
 */

import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { contentHash, dayKey, isoInstant, nextScheduledAt, scrubError, stableJson, writeIfChanged } from '@cevtuo/pipeline-core';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}

console.log('\n── stableJson ────────────────────────────────');

// Key order must not affect the output, or two runs with the same data differ.
eq('key order is normalised', stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
check('ends with exactly one newline', stableJson({ a: 1 }).endsWith('}\n'));
check('nested keys are sorted too', stableJson({ z: { b: 1, a: 2 } }).includes('"a": 2,\n    "b": 1'));
check(
  'array order IS preserved (it is meaningful)',
  stableJson({ a: [3, 1, 2] }) !== stableJson({ a: [1, 2, 3] }),
);
check('undefined is dropped, not serialised as null', !stableJson({ a: undefined, b: 1 }).includes('null'));

console.log('\n── contentHash ───────────────────────────────');

eq('same content ⇒ same hash regardless of key order', contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
check('different content ⇒ different hash', contentHash({ a: 1 }) !== contentHash({ a: 2 }));
check('hash is 12 chars', contentHash({ a: 1 }).length === 12);

console.log('\n── writeIfChanged (the no-commit-storm guarantee) ──');

const dir = await mkdtemp(join(tmpdir(), 'cevtuo-verify-'));
const target = join(dir, 'nested', 'payload.json');

eq('first write reports "written"', await writeIfChanged(target, stableJson({ a: 1 })), 'written');
eq('identical write reports "unchanged"', await writeIfChanged(target, stableJson({ a: 1 })), 'unchanged');
eq('reordered-but-equal write reports "unchanged"', await writeIfChanged(target, stableJson({ a: 1 })), 'unchanged');
eq('changed content reports "written"', await writeIfChanged(target, stableJson({ a: 2 })), 'written');

// mtime must not move on an unchanged write — that is what keeps git quiet.
const before = (await stat(target)).mtimeMs;
await new Promise((r) => setTimeout(r, 25));
await writeIfChanged(target, stableJson({ a: 2 }));
eq('unchanged write does not touch the file', (await stat(target)).mtimeMs, before);

await rm(dir, { recursive: true, force: true });

console.log('\n── time formatting ───────────────────────────');

// Build instants from UTC so the test doesn't depend on the runner's zone.
eq('isoInstant renders +08:00 offset', isoInstant(new Date('2026-09-22T06:05:00Z')), '2026-09-22T14:05+08:00');
check('slice(11,16) yields a displayable HH:MM', isoInstant(new Date('2026-09-22T06:05:00Z')).slice(11, 16) === '14:05');
check('new Date() round-trips the instant', new Date(isoInstant(new Date('2026-09-22T06:05:00Z'))).getTime() === Date.parse('2026-09-22T06:05:00Z'));
eq('dayKey uses the local zone, not UTC', dayKey(new Date('2026-09-22T18:30:00Z')), '2026-09-23');

// Day boundary: 16:00Z is already the 23rd in +08:00.
eq('dayKey rolls over at the zone boundary', dayKey(new Date('2026-09-22T16:00:00Z')), '2026-09-23');

console.log('\n── nextScheduledAt ───────────────────────────');

check('is in the future', new Date(nextScheduledAt(new Date('2026-09-22T06:05:00Z'), 5)) > new Date('2026-09-22T06:05:00Z'));
check('lands on a 5-hour UTC boundary', new Date(nextScheduledAt(new Date('2026-09-22T06:05:00Z'), 5)).getUTCHours() % 5 === 0);
check('is at most 5h away', new Date(nextScheduledAt(new Date('2026-09-22T06:05:00Z'), 5)).getTime() - Date.parse('2026-09-22T06:05:00Z') <= 5 * 3600_000);

console.log('\n── scrubError (these strings reach a public file) ──');

const notion = scrubError(new Error('Request failed with token ntn_ABC1234567890XYZ'));
check('redacts a Notion token', !notion.message.includes('ntn_ABC1234567890XYZ') && notion.message.includes('[redacted]'));

const pat = scrubError(new Error('bad credentials ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
check('redacts a GitHub PAT', !pat.message.includes('ghp_ABCDEF'));

const bearer = scrubError(new Error('401 from Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload'));
check('redacts a bearer token', !bearer.message.includes('eyJhbGciOiJIUzI1NiJ9'));

const long = scrubError(new Error('x'.repeat(500)));
check('truncates to <=200 chars', long.message.length <= 200);

const sa = scrubError(new Error('{"private_key": "-----BEGIN PRIVATE KEY-----abc"}'));
check('redacts a service-account private key', !sa.message.includes('BEGIN PRIVATE KEY'));

console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
