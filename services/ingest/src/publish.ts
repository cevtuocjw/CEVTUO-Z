/**
 * Get the freshly generated index onto the site.
 *
 * ⚠️ This is the step that was MISSING, and its absence is invisible.
 *
 * The converter writes `data/paperr/index.json` next to itself, on this server.
 * The page does not read it there — the page fetches
 * `data/paperr/index.json` from the Pages origin, because that is the only
 * origin the bundle knows about. So between "the device pushed" and "the site
 * shows it" there was a manual step: run the sync on the development machine
 * and publish from there.
 *
 * That defeats the entire reason this server exists. The device is supposed to
 * be able to sync while the Mac is shut and in a bag.
 *
 * ── Why the REST API and not git
 *
 * The box is CentOS 8, which is EOL — its package mirrors are gone, so there is
 * no `git` and no realistic way to install one. It would not help anyway: a
 * clone of this repository is 45MB of data and images that this job never
 * touches, and a 769MB machine is no place for it.
 *
 * Two HTTP calls move one 18KB file. It is the only credential on the machine,
 * and it can write exactly one path in one repository.
 *
 * ── Why it compares before writing
 *
 * ⚠️ Same reason `handleIngest` skips an unchanged export. The device pushes on
 * every WiFi connect. A blind PUT would be an empty commit every 30 minutes,
 * which buries real changes in the log and burns Pages build minutes.
 */

import { readFile } from 'node:fs/promises';

/**
 * ⚠️ A discriminated union, not `{ changed: boolean; error?: string }`.
 *
 * The optional-field version type-checks while letting a caller read `changed`
 * on a failed publish and conclude the site is up to date. "I did not publish"
 * and "I could not publish" need different words on the admin page and in the
 * push response, and this is what stops them being confused for each other.
 */
export type PublishResult =
  /** `changed: false` means there was nothing to do — no token, or identical. */
  | { ok: true; changed: boolean }
  /** A real failure. The reason is safe to show: it is scrubbed by the caller. */
  | { ok: false; error: string };

export interface PublisherConfig {
  token: string | null;
  repo: string;
  branch: string;
  /** The path inside the repository, from the repo root. */
  path: string;
  /** Where the file is on this disk. */
  localPath: string;
  /** Overridable so a test can point at a local server. */
  api?: string;
}

const API_DEFAULT = 'https://api.github.com';

interface ContentsResponse {
  sha?: string;
  content?: string;
  encoding?: string;
}

/** GitHub returns base64 with embedded newlines; `Buffer` tolerates them. */
function sameContent(remote: ContentsResponse, local: string): boolean {
  if (!remote.content) return false;
  try {
    return Buffer.from(remote.content, 'base64').toString('utf8') === local;
  } catch {
    return false;
  }
}

export function githubPublisher(cfg: PublisherConfig): {
  publish: () => Promise<PublishResult>;
} {
  const api = (cfg.api ?? API_DEFAULT).replace(/\/+$/, '');
  const url = `${api}/repos/${cfg.repo}/contents/${cfg.path}`;

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${cfg.token ?? ''}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // ⚠️ GitHub rejects requests with no User-Agent. Without this the very
    // first real publish fails with a 403 that reads like an auth problem.
    'User-Agent': 'cevtuo-ingest',
  });

  return {
    async publish(): Promise<PublishResult> {
      // ⚠️ No token is a supported state, not a failure. The service is
      // perfectly useful without it — the device's export is stored, the charts
      // are on the admin page — it just does not reach the public site. Saying
      // so every push would train the operator to ignore the message.
      if (!cfg.token) return { ok: true, changed: false };

      let local: string;
      try {
        local = await readFile(cfg.localPath, 'utf8');
      } catch {
        return { ok: false, error: `找不到 ${cfg.path}，转换器没写出东西` };
      }

      try {
        const head = await fetch(`${url}?ref=${encodeURIComponent(cfg.branch)}`, { headers: headers() });

        let sha: string | undefined;
        if (head.status === 200) {
          const remote = (await head.json()) as ContentsResponse;
          // ⚠️ The comparison is against the DECODED remote file, not its sha.
          // Git's blob sha is over a header plus the content and cannot be
          // computed here; comparing that would always differ and we would be
          // back to an empty commit on every push.
          if (sameContent(remote, local)) return { ok: true, changed: false };
          sha = remote.sha;
        } else if (head.status !== 404) {
          return { ok: false, error: `读取远端失败 HTTP ${head.status}` };
        }
        // 404 means the file does not exist on that branch yet — a first
        // publish, or a fresh gh-pages. PUT without a sha creates it.

        const put = await fetch(url, {
          method: 'PUT',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `ingest: 阅读统计更新 (${new Date().toISOString().slice(0, 16)}Z)`,
            content: Buffer.from(local, 'utf8').toString('base64'),
            branch: cfg.branch,
            ...(sha ? { sha } : {}),
          }),
        });

        if (!put.ok) {
          const text = (await put.text()).slice(0, 200);
          return { ok: false, error: `写入远端失败 HTTP ${put.status} ${text}` };
        }
        return { ok: true, changed: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/**
 * Built from the environment, or `null` when publishing is not configured.
 *
 * ⚠️ The token is read here and never logged, never returned in a response
 * body, and never written anywhere but the systemd `EnvironmentFile`.
 */
export function publisherFromEnv(repoRoot: string): ReturnType<typeof githubPublisher> | null {
  const token = process.env.CEVTUO_GITHUB_TOKEN || null;
  return githubPublisher({
    token,
    repo: process.env.CEVTUO_GITHUB_REPO || 'cevtuocjw/CEVTUO-Z',
    branch: process.env.CEVTUO_GITHUB_BRANCH || 'gh-pages',
    path: 'data/paperr/index.json',
    localPath: `${repoRoot}/data/paperr/index.json`,
    api: process.env.CEVTUO_GITHUB_API || undefined,
  });
}
