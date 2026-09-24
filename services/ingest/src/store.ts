/**
 * Where the reading data actually lives.
 *
 * ⚠️ In the server's CHECKOUT, under `data/paperr/`, which is gitignored.
 *
 * That is not a shortcut — it is what makes the data survive a redeploy.
 * `deploy.sh` runs `git reset --hard`, which restores tracked files and leaves
 * UNTRACKED ones alone. So the directory has to be both the converter's working
 * area (the CLI reads and writes exactly these paths) and excluded from git.
 *
 * ⚠️ Neither file is in the repository any more, and that is the point: the repo
 * is public, so a reading history committed there is a reading history
 * published. See the note in `core.ts`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CURRENT_PATH, HEARTBEAT_PATH, RAW_PATH, type Store } from './core';
import { defaultRepoRoot } from './converter';

export function fsStore(repoRoot: string = defaultRepoRoot()): Store {
  const paths = {
    raw: join(repoRoot, RAW_PATH),
    current: join(repoRoot, CURRENT_PATH),
    heartbeat: join(repoRoot, HEARTBEAT_PATH),
  };

  const read = async (p: string): Promise<string | null> => {
    try {
      return await readFile(p, 'utf8');
    } catch {
      // ⚠️ Only ENOENT is expected here. A permission error would look identical
      // to "no data yet", which is the difference between an empty dashboard and
      // a broken deployment — so it is worth distinguishing when it happens.
      return null;
    }
  };

  const write = async (p: string, text: string): Promise<void> => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, 'utf8');
  };

  return {
    readRaw: () => read(paths.raw),
    writeRaw: (t) => write(paths.raw, t),
    readCurrent: () => read(paths.current),
    readHeartbeat: () => read(paths.heartbeat),
    writeHeartbeat: (t) => write(paths.heartbeat, t),
  };
}
