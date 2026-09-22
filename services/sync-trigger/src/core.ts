/**
 * Sync trigger + status — the account-free implementation.
 *
 * ── Why this shape ─────────────────────────────────────────────
 * The original plan put this on a Cloudflare Worker. There is no Cloudflare
 * account, so the same logic is written against a `fetch`-typed interface and
 * hosted on the Mac instead (see `server.ts`). Nothing in this file knows where
 * it runs, so deploying it to a Worker later is a new adapter, not a rewrite.
 *
 * ── Why not put the token in the app ───────────────────────────
 * Because it does not survive contact with reality. A mini-program package is
 * decompilable and the H5 bundle is plaintext JavaScript, so any credential
 * shipped in the client is public. The token lives here, server-side, and the
 * client only ever holds `CEVTUO_CLIENT_TOKEN` — which grants exactly one
 * thing: the ability to ask for a sync. It cannot read or write the repo.
 *
 * ── Why the service needs a token at all, given it is on localhost ─
 * It does not, strictly — it binds 127.0.0.1. The bearer check costs nothing and
 * means that if this is ever put behind a tunnel, it is not instantly a public
 * "anyone can burn your Actions minutes" button. Default bind is loopback.
 */

import {
  SyncStatusSchema,
  SyncTriggerResponseSchema,
  type SyncStatus,
  type SyncTriggerResponse,
} from '@cevtuo/schema';
// ⚠️ nextScheduledAt and scrubError already exist in pipeline-core. They are
// imported, not reimplemented: a second copy of the schedule maths would drift
// from the one the committed sync-meta.json is written with, and a second
// secret-scrubber would drift from the one the 28 core tests already cover.
import { nextScheduledAt as coreNextScheduledAt, isoInstant, scrubError } from '@cevtuo/pipeline-core';

/** GitHub is dispatched at this cadence by `.github/workflows/sync.yml`. */
export const CADENCE_HOURS = 5;

/** How long a just-triggered sync suppresses further triggers (double-tap guard). */
export const DEFAULT_DEBOUNCE_SECONDS = 60;

export interface Env {
  /** Fine-grained PAT with **Actions: write** and nothing else. */
  githubToken: string;
  owner: string;
  repo: string;
  workflowFile: string;
  /** Bearer token the client presents. NOT the GitHub token. */
  clientToken: string;
  debounceSeconds: number;
}

export function envFrom(source: Record<string, string | undefined>): Env {
  const need = (k: string): string => {
    const v = source[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    githubToken: need('CEVTUO_GITHUB_TOKEN'),
    owner: source.CEVTUO_REPO_OWNER ?? 'cevtuocjw',
    repo: source.CEVTUO_REPO_NAME ?? 'CEVTUO-Z',
    workflowFile: source.CEVTUO_WORKFLOW_FILE ?? 'sync.yml',
    clientToken: need('CEVTUO_CLIENT_TOKEN'),
    debounceSeconds: Number(source.CEVTUO_DEBOUNCE_SECONDS ?? DEFAULT_DEBOUNCE_SECONDS),
  };
}

/** Minimal slice of the Actions API this service depends on. */
export interface GithubApi {
  listRecentRuns(limit: number): Promise<GithubRun[]>;
  dispatch(inputs: Record<string, string>): Promise<void>;
}

export interface GithubRun {
  id: number;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | …
  created_at: string;
  html_url: string;
}

const GH = 'https://api.github.com';

export function githubApi(env: Env, doFetch: typeof fetch = fetch): GithubApi {
  const headers = {
    Authorization: `Bearer ${env.githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cevtuo-sync-trigger',
  };

  return {
    async listRecentRuns(limit) {
      const url = `${GH}/repos/${env.owner}/${env.repo}/actions/workflows/${env.workflowFile}/runs?per_page=${limit}`;
      const res = await doFetch(url, { headers });
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await safeText(res)}`);
      const body = (await res.json()) as { workflow_runs?: GithubRun[] };
      return body.workflow_runs ?? [];
    },

    async dispatch(inputs) {
      const url = `${GH}/repos/${env.owner}/${env.repo}/actions/workflows/${env.workflowFile}/dispatches`;
      const res = await doFetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        // ⚠️ The dispatch endpoint returns 204 with NO body — the run id cannot
        // be read from here. It has to be recovered by listing runs afterwards.
        body: JSON.stringify({ ref: 'main', inputs }),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await safeText(res)}`);
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    // scrubError, not a local regex: GitHub echoes the Authorization header back
    // on some 401s, and pipeline-core's pattern list is the audited one.
    return scrubError(new Error((await res.text()).slice(0, 200))).message;
  } catch {
    return '<unreadable>';
  }
}

/** Route every error string through pipeline-core's scrubber before it is returned. */
function safeMessage(e: unknown): string {
  return scrubError(e).message;
}

export function isAuthorized(env: Env, authHeader: string | null): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const presented = authHeader.slice(7);
  // Length check first so timingSafeEqual never throws on a mismatched length.
  if (presented.length !== env.clientToken.length) return false;
  return timingSafeEqual(presented, env.clientToken);
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const QUEUED = new Set(['queued', 'requested', 'waiting', 'pending']);

export function isActive(run: GithubRun): boolean {
  return run.status === 'in_progress' || QUEUED.has(run.status);
}

/**
 * The next `0 *​/5 * * *` boundary, derived from the cron rather than stored.
 *
 * Delegates to pipeline-core so this can never disagree with the
 * `nextScheduledAt` sitting in the committed data/sync-meta.json.
 *
 * GitHub's schedule is best-effort and can drift 10–30 min under load, which is
 * why the app labels it "预计" and not a promise.
 */
export function nextScheduledAt(now: Date): string {
  return coreNextScheduledAt(now, CADENCE_HOURS);
}

export const WORKFLOW_URL = (env: Env, runId: number) =>
  `https://github.com/${env.owner}/${env.repo}/actions/runs/${runId}`;

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

/**
 * Trigger a sync.
 *
 * Responds with the existing `SyncTriggerResponseSchema`. `accepted: false` is
 * a normal answer, not an error: it means a run is already queued or running,
 * which is exactly what the workflow's `concurrency: cancel-in-progress: false`
 * is designed to make safe. Better to tell the user "已经有一个在跑了" than to
 * queue a second no-op run behind it.
 */
export async function handleSync(env: Env, api: GithubApi, now = new Date()): Promise<SyncTriggerResponse> {
  let runs: GithubRun[];
  try {
    runs = await api.listRecentRuns(10);
  } catch (e) {
    return { accepted: false, runId: null, message: `无法读取运行状态: ${safeMessage(e)}` };
  }

  const active = runs.find(isActive);
  if (active) {
    return {
      accepted: false,
      runId: String(active.id),
      message: '已有一个同步在排队或运行中',
      retryAfterSeconds: env.debounceSeconds,
    };
  }

  const newest = runs[0];
  if (newest) {
    const ageSeconds = (now.getTime() - Date.parse(newest.created_at)) / 1000;
    if (ageSeconds >= 0 && ageSeconds < env.debounceSeconds) {
      return {
        accepted: false,
        runId: String(newest.id),
        message: '刚刚已经同步过',
        retryAfterSeconds: Math.max(1, Math.ceil(env.debounceSeconds - ageSeconds)),
      };
    }
  }

  try {
    await api.dispatch({ source: 'coof', force_meta: 'false' });
  } catch (e) {
    return { accepted: false, runId: null, message: `触发失败: ${safeMessage(e)}` };
  }

  return {
    accepted: true,
    runId: await recoverRunId(api, now),
    message: '已触发同步',
  };
}

/**
 * Recover the id of the run we just dispatched.
 *
 * `dispatches` returns 204 with no body, so the only way to get the id is to
 * look. The dispatch→run-creation gap is not instantaneous, hence the retries;
 * giving up returns null rather than guessing, because a wrong run id would
 * deep-link the user to someone else's run.
 */
async function recoverRunId(api: GithubApi, now: Date, attempts = 4): Promise<string | null> {
  const dispatchedAfter = now.getTime() - 15_000; // clock slack
  for (let i = 0; i < attempts; i++) {
    await sleep(i === 0 ? 1200 : 1500);
    try {
      const fresh = (await api.listRecentRuns(5)).find(
        (r) => Date.parse(r.created_at) >= dispatchedAfter,
      );
      if (fresh) return String(fresh.id);
    } catch {
      // Fall through and retry; a failed lookup must not fail an accepted trigger.
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Freshness, read live from the Actions API — more current than any committed file. */
export async function handleStatus(
  env: Env,
  api: GithubApi,
  now = new Date(),
): Promise<SyncStatus> {
  const base = {
    runningNow: false,
    lastRunAt: null as string | null,
    lastRunStatus: null as SyncStatus['lastRunStatus'],
    nextScheduledAt: nextScheduledAt(now),
    runId: null as string | null,
    runUrl: null as string | null,
  };

  try {
    const runs = await api.listRecentRuns(10);
    const active = runs.find(isActive);
    const newest = runs[0];

    const status: SyncStatus = {
      ...base,
      runningNow: Boolean(active),
      // Re-encoded through isoInstant to +08:00 so every timestamp the app sees
      // carries the same offset as the ones in data/sync-meta.json. Same instant,
      // one format — otherwise the UI shows two clock conventions side by side.
      lastRunAt: newest ? isoInstant(new Date(newest.created_at)) : null,
      lastRunStatus: newest ? mapConclusion(newest) : null,
      runId: active ? String(active.id) : (newest ? String(newest.id) : null),
      runUrl: active ? active.html_url : (newest?.html_url ?? null),
    };
    return SyncStatusSchema.parse(status);
  } catch {
    // Degrade to schedule-only. A status endpoint that 500s takes the whole
    // diagnostics panel down with it, which is worse than a partial answer.
    return SyncStatusSchema.parse(base);
  }
}

function mapConclusion(run: GithubRun): SyncStatus['lastRunStatus'] {
  if (run.status === 'in_progress') return 'in_progress';
  if (QUEUED.has(run.status)) return 'queued';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export { SyncStatusSchema, SyncTriggerResponseSchema };
