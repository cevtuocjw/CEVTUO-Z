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

import {
  HEALTH_HEARTBEAT_PATH,
  HEALTH_INDEX_PATH,
  HEALTH_RAW_PATH,
  type HealthStore,
} from './chealth';
import { HEARTBEAT_PATH, RAW_PATH, type Store } from './core';
import { defaultRepoRoot } from './converter';

export function fsStore(repoRoot: string = defaultRepoRoot()): Store {
  const paths = {
    raw: join(repoRoot, RAW_PATH),
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
    readHeartbeat: () => read(paths.heartbeat),
    writeHeartbeat: (t) => write(paths.heartbeat, t),
  };
}

/**
 * The health store.
 *
 * ⚠️⚠️ Four files where reading needs two, and the extra one is the whole
 * design. `raw` is the phone's verbatim last payload — a 30-day sliding window.
 * `merged` is the ACCUMULATING series. They are not interchangeable: the raw
 * window is what the phone just said, the merged file is everything the server
 * has ever been told. Publishing or serving the raw one would mean the site
 * shows 30 days forever. See the header of `chealth.ts`.
 */
export function fsHealthStore(repoRoot: string = defaultRepoRoot()): HealthStore {
  const paths = {
    raw: join(repoRoot, HEALTH_RAW_PATH),
    merged: join(repoRoot, HEALTH_RAW_PATH.replace('raw-health.json', 'merged-health.json')),
    heartbeat: join(repoRoot, HEALTH_HEARTBEAT_PATH),
    index: join(repoRoot, HEALTH_INDEX_PATH),
  };

  const read = async (p: string): Promise<string | null> => {
    try {
      return await readFile(p, 'utf8');
    } catch {
      // ⚠️ Same reasoning as above: only ENOENT is expected, and conflating it
      // with a permission error is the difference between "no data yet" and
      // "this deployment cannot see its own data".
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
    readMerged: () => read(paths.merged),
    writeMerged: (t) => write(paths.merged, t),
    readHeartbeat: () => read(paths.heartbeat),
    writeHeartbeat: (t) => write(paths.heartbeat, t),
    writeIndex: (t) => write(paths.index, t),
  };
}
