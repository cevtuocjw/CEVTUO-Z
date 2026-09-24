/**
 * The real converter — runs the pipeline on this machine.
 *
 * ⚠️ This is what removes the GitHub Actions dependency. The first design
 * committed the raw export and let a workflow convert it, which required a
 * `workflow`-scoped token to push the file and an `Actions`-scoped token on this
 * server. Running `sync-paperr.ts` locally needs neither: the PAT holds Contents
 * and nothing else, and the repository needs no workflow file at all.
 *
 * ⚠️ It lives in its own module rather than inside `server.ts` so it can be
 * driven from a test. `server.ts` binds a port on import, which makes anything
 * defined in it untestable.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { scrubError } from '@cevtuo/pipeline-core';
import { INDEX_PATH, RAW_PATH, type Converter } from './core';

/** Repo root from `services/ingest/src/` — three levels up. */
export const defaultRepoRoot = (): string => resolve(import.meta.dir, '..', '..', '..');

export function repoConverter(repoRoot: string = defaultRepoRoot()): Converter {
  return {
    async run(rawText) {
      try {
        // ⚠️ Written into the CHECKOUT, not a temp dir, because that is where
        // the CLI reads it from. The checkout is a build artefact on this
        // machine: every deploy `git reset --hard`s it, and the only things
        // that ever leave it are the two files the ingest commits.
        const rawAbs = join(repoRoot, RAW_PATH);
        await mkdir(dirname(rawAbs), { recursive: true });
        await writeFile(rawAbs, rawText, 'utf8');

        const proc = Bun.spawn(['bun', 'run', 'pipeline/src/cli/sync-paperr.ts'], {
          cwd: repoRoot,
          stdout: 'ignore',
          // ⚠️ Captured, not inherited. A failing run prints the reason on its
          // last lines, and that reason is what the operator reads on the admin
          // page — inheriting stdout would put it in the journal and nowhere
          // the person who needs it would look.
          stderr: 'pipe',
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = (await new Response(proc.stderr).text()).trim();
          const last = err.split('\n').filter(Boolean).slice(-2).join(' ');
          return { error: scrubError(new Error(last || `转换器退出码 ${code}`)).message };
        }

        return { indexText: await readFile(join(repoRoot, INDEX_PATH), 'utf8') };
      } catch (e) {
        return { error: scrubError(e).message };
      }
    },
  };
}
