/**
 * The real converter — runs the pipeline on this machine.
 *
 * ⚠️ This is what removes the GitHub Actions dependency. The first design
 * committed the raw export and let a workflow convert it, which required a
 * `workflow`-scoped token to push the file and an `Actions`-scoped token on this
 * server. Running `sync-paperr.ts` locally needs neither.
 *
 * ⚠️ Lives in its own module rather than inside `server.ts` so a test can drive
 * it. `server.ts` binds a port on import, which makes anything defined in it
 * untestable.
 */

import { resolve } from 'node:path';

import { scrubError } from '@cevtuo/pipeline-core';
import type { Converter } from './core';

/**
 * Repo root from `services/ingest/src/` — three levels up.
 *
 * ⚠️ `CEVTUO_REPO_ROOT` wins when set, and it MUST be set in production.
 *
 * The derived path assumes the SOURCE LAYOUT this file was written in. Bundled
 * — which is how the Aliyun box runs it, because CentOS 8 is EOL and 769MB does
 * not hold a workspace `bun install` — `import.meta.dir` is the bundle's
 * directory, `..'..'..'` walks off the end of the filesystem, and the data
 * directory silently becomes `/data`.
 *
 * ⚠️ It does not fail loudly. The first symptom was a device push coming back
 * `EROFS: read-only file system, mkdir '/data'` — systemd's `ProtectSystem=strict`
 * catching it before it could matter. Without that hardening the service would
 * have started happily and simply never found the reader's data.
 *
 * Same variable, same value, as `repoPath()` in pipeline-core — they have to
 * agree, or the server writes the export somewhere the converter never looks.
 */
export const defaultRepoRoot = (): string =>
  process.env?.CEVTUO_REPO_ROOT || resolve(import.meta.dir, '..', '..', '..');

export function repoConverter(repoRoot: string = defaultRepoRoot()): Converter {
  return {
    async convert() {
      try {
        // ⚠️ `CEVTUO_PIPELINE_CMD` names a pre-bundled CLI. Deployment runs
        // `bun build` on the development machine and ships the single output
        // file, because the server has no git and no node_modules — see
        // `repoPath` in pipeline-core for the rest of that arrangement. Unset,
        // this runs the TypeScript source in place, which is what dev and the
        // verification suite do.
        const bundled = process.env.CEVTUO_PIPELINE_CMD;
        const proc = Bun.spawn(
          bundled ? ['bun', bundled] : ['bun', 'run', 'pipeline/src/cli/sync-paperr.ts'],
          {
          cwd: repoRoot,
          stdout: 'ignore',
          // ⚠️ Captured, not inherited. A failing run prints the reason on its
          // last lines, and that reason is what the operator reads on the admin
          // page — inheriting stdout would put it in the journal and nowhere
          // the person who needs it would look.
            stderr: 'pipe',
          },
        );
        const code = await proc.exited;
        if (code !== 0) {
          const err = (await new Response(proc.stderr).text()).trim();
          const last = err.split('\n').filter(Boolean).slice(-2).join(' ');
          return { error: scrubError(new Error(last || `转换器退出码 ${code}`)).message };
        }
        // ⚠️ Nothing to hand back. The CLI writes BOTH outputs itself — the
        // public index (committed by the sync job) and the private current file
        // (read by `handleCurrent`). Returning one of them here would invite a
        // second writer for a derivation that already has one.
        return { ok: true };
      } catch (e) {
        return { error: scrubError(e).message };
      }
    },
  };
}
