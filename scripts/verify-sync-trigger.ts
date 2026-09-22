/**
 * Behavioural checks for the sync trigger service.
 *
 *   bun run scripts/verify-sync-trigger.ts
 *
 * These aren't ceremony either. The three that would actually hurt in production:
 *
 *   1. A token reaching an HTTP response body. This service exists *because*
 *      client-side credentials are public; leaking the server-side one would
 *      defeat the entire point.
 *   2. Double-triggering. Actions minutes are real, and a queued no-op run still
 *      occupies the concurrency group and shows up in the user's history.
 *   3. A response that fails its own zod schema — the app parses with the same
 *      schemas, so a mismatch is a runtime crash on the client, not a warning.
 */

import {
  SyncStatusSchema,
  SyncTriggerResponseSchema,
} from '@cevtuo/schema';
import { nextScheduledAt as coreNextScheduledAt } from '@cevtuo/pipeline-core';
import {
  handleStatus,
  handleSync,
  isAuthorized,
  nextScheduledAt,
  type Env,
  type GithubApi,
  type GithubRun,
} from '@cevtuo/sync-trigger/core';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}

const ENV: Env = {
  githubToken: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  owner: 'cevtuocjw',
  repo: 'CEVTUO-Z',
  workflowFile: 'sync.yml',
  clientToken: 'client-token-abcdefghijklmnop',
  debounceSeconds: 60,
};

const NOW = new Date('2026-09-22T06:07:00Z');

function run(over: Partial<GithubRun> = {}): GithubRun {
  return {
    id: 111,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-22T01:00:00Z',
    html_url: 'https://github.com/cevtuocjw/CEVTUO-Z/actions/runs/111',
    ...over,
  };
}

/** Fake Actions API: no network, deterministic clock. */
function fakeApi(runs: GithubRun[], opts: { dispatchFails?: Error } = {}): GithubApi & { dispatched: number } {
  const api = {
    dispatched: 0,
    async listRecentRuns() {
      return runs;
    },
    async dispatch() {
      if (opts.dispatchFails) throw opts.dispatchFails;
      api.dispatched++;
      // A dispatched run shows up as queued on the next listing.
      runs = [run({ id: 999, status: 'queued', conclusion: null, created_at: new Date(NOW.getTime() + 1500).toISOString() }), ...runs];
    },
  };
  return api as GithubApi & { dispatched: number };
}

// ─────────────────────────────────────────────────────────────
console.log('\n── isAuthorized (the only thing between the world and your Actions minutes) ──');

check('rejects a missing header', !isAuthorized(ENV, null));
check('rejects a non-Bearer scheme', !isAuthorized(ENV, 'Basic client-token-abcdefghijklmnop'));
check('rejects a wrong token', !isAuthorized(ENV, 'Bearer wrong-token-abcdefghijklmnop'));
check('rejects a prefix of the real token', !isAuthorized(ENV, 'Bearer client-token-abcdefghijklmno'));
check('rejects the real token plus one char', !isAuthorized(ENV, 'Bearer client-token-abcdefghijklmnopX'));
check('accepts the exact token', isAuthorized(ENV, 'Bearer client-token-abcdefghijklmnop'));
check(
  'does NOT accept the GitHub token as the client token',
  !isAuthorized(ENV, `Bearer ${ENV.githubToken}`),
);

// ─────────────────────────────────────────────────────────────
console.log('\n── nextScheduledAt (must match pipeline-core exactly) ──');

// The bug this guards: a naive ms-based ceil returns the CURRENT time at an
// exact boundary, so the app shows "next sync: now" forever at 06:00:00.
eq('at an exact boundary it moves forward, not stalls',
  new Date(nextScheduledAt(new Date('2026-09-22T06:00:00Z'))).getTime() > Date.parse('2026-09-22T06:00:00Z'), true);

check('is always strictly in the future',
  [0, 5, 10, 59].every((m) =>
    new Date(nextScheduledAt(new Date(Date.UTC(2026, 8, 22, 6, m)))).getTime() > Date.UTC(2026, 8, 22, 6, m)));

check('lands on a 5-hour UTC boundary',
  new Date(nextScheduledAt(NOW)).getUTCHours() % 5 === 0);

eq('agrees with pipeline-core (single source of truth)',
  nextScheduledAt(NOW), coreNextScheduledAt(NOW, 5));

// ─────────────────────────────────────────────────────────────
console.log('\n── handleSync: happy path ──');

{
  const api = fakeApi([run()]);
  const res = await handleSync(ENV, api, NOW);
  check('accepted', res.accepted, JSON.stringify(res));
  eq('dispatched exactly once', api.dispatched, 1);
  check('recovered a run id', res.runId !== null, `runId=${res.runId}`);
  check('satisfies SyncTriggerResponseSchema', SyncTriggerResponseSchema.safeParse(res).success);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── handleSync: refuses to pile up runs ──');

{
  const api = fakeApi([run({ id: 777, status: 'in_progress', conclusion: null, created_at: new Date(NOW.getTime() - 300_000).toISOString() })]);
  const res = await handleSync(ENV, api, NOW);
  check('not accepted while a run is in progress', !res.accepted, JSON.stringify(res));
  eq('did NOT dispatch a second run', api.dispatched, 0);
  eq('points the UI at the run already going', res.runId, '777');
  check('tells the client when to retry', (res.retryAfterSeconds ?? 0) > 0);
  check('satisfies schema', SyncTriggerResponseSchema.safeParse(res).success);
}

{
  const api = fakeApi([run({ id: 888, status: 'queued', conclusion: null, created_at: new Date(NOW.getTime() - 10_000).toISOString() })]);
  const res = await handleSync(ENV, api, NOW);
  check('not accepted while a run is queued', !res.accepted, JSON.stringify(res));
  eq('did NOT dispatch', api.dispatched, 0);
}

{
  // Double-tap: last run finished 5s ago. Inside the debounce window.
  const api = fakeApi([run({ created_at: new Date(NOW.getTime() - 5_000).toISOString() })]);
  const res = await handleSync(ENV, api, NOW);
  check('double-tap is debounced', !res.accepted, JSON.stringify(res));
  eq('did NOT dispatch', api.dispatched, 0);
  check('retryAfter counts down, not resets', (res.retryAfterSeconds ?? 0) <= 55, `got ${res.retryAfterSeconds}`);
}

{
  // Just outside the window: must be allowed again.
  const api = fakeApi([run({ created_at: new Date(NOW.getTime() - 61_000).toISOString() })]);
  const res = await handleSync(ENV, api, NOW);
  check('allowed again once the debounce window passes', res.accepted, JSON.stringify(res));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── handleSync: failures never leak the token ──');

{
  // GitHub echoes the Authorization header back on some 401s. This is the exact
  // shape a real "bad token" failure takes.
  const api = fakeApi([], { dispatchFails: new Error(`401 Bad credentials: Bearer ${ENV.githubToken}`) });
  const res = await handleSync(ENV, api, NOW);
  check('not accepted', !res.accepted);
  check('token is NOT in the response', !JSON.stringify(res).includes(ENV.githubToken), JSON.stringify(res));
  check('message is redacted', res.message.includes('[redacted]'), res.message);
  check('still satisfies schema', SyncTriggerResponseSchema.safeParse(res).success);
}

{
  const api: GithubApi = {
    async listRecentRuns() {
      throw new Error(`GET failed with token ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ`);
    },
    async dispatch() {},
  };
  const res = await handleSync(ENV, api, NOW);
  check('a read failure is not accepted', !res.accepted);
  check('and its token is scrubbed too', !res.message.includes('ghp_ZZZZ'), res.message);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── handleStatus ──');

{
  const api = fakeApi([run({ id: 555, status: 'completed', conclusion: 'success' })]);
  const st = await handleStatus(ENV, api, NOW);
  eq('not running', st.runningNow, false);
  eq('reports last conclusion', st.lastRunStatus, 'success');
  eq('points at the last run', st.runId, '555');
  check('satisfies SyncStatusSchema', SyncStatusSchema.safeParse(st).success);
}

{
  const api = fakeApi([run({ id: 556, status: 'in_progress', conclusion: null, created_at: new Date(NOW.getTime() - 60_000).toISOString() })]);
  const st = await handleStatus(ENV, api, NOW);
  eq('runningNow is true mid-run', st.runningNow, true);
  eq('reports in_progress', st.lastRunStatus, 'in_progress');
}

{
  const api = fakeApi([run({ conclusion: 'timed_out' })]);
  const st = await handleStatus(ENV, api, NOW);
  eq('timed_out maps to failure, not unknown', st.lastRunStatus, 'failure');
}

{
  const api = fakeApi([]);
  const st = await handleStatus(ENV, api, NOW);
  eq('no runs at all ⇒ nulls, not a crash', [st.lastRunAt, st.lastRunStatus], [null, null]);
  check('still satisfies schema', SyncStatusSchema.safeParse(st).success);
}

{
  // Degraded path: a status endpoint that 500s takes the whole diagnostics
  // panel with it, which is worse than a partial answer.
  const api: GithubApi = {
    async listRecentRuns() { throw new Error('rate limited'); },
    async dispatch() {},
  };
  const st = await handleStatus(ENV, api, NOW);
  check('a failing API still returns a valid status', SyncStatusSchema.safeParse(st).success);
  eq('and admits it does not know the last run', st.lastRunStatus, null);
  check('but still supplies the schedule', typeof st.nextScheduledAt === 'string' && st.nextScheduledAt.length > 0);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── timestamp format consistency ──');

{
  const api = fakeApi([run({ created_at: '2026-09-22T01:00:00Z' })]);
  const st = await handleStatus(ENV, api, NOW);
  check('lastRunAt carries a +08:00 offset like sync-meta.json',
    /\+08:00$/.test(st.lastRunAt ?? ''), String(st.lastRunAt));
  check('nextScheduledAt is an ISO instant too',
    /(Z|[+-]\d{2}:\d{2})$/.test(st.nextScheduledAt), st.nextScheduledAt);
}

console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
