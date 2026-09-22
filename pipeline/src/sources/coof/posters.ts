/**
 * Poster re-hosting.
 *
 * ⚠️ This is not an optimisation, it is required for correctness.
 *
 * Notion serves uploaded files from `prod-files-secure.s3.us-west-2.amazonaws.com`
 * behind signed URLs. Measured on the live API: `X-Amz-Expires=3600` — the link
 * is dead one hour after the query that produced it. A poster URL committed into
 * `data/` therefore 404s before the next 5-hourly sync even runs.
 *
 * So we download each poster once and re-host it under `data/coof/posters/`.
 * Two further reasons this is the right shape:
 *
 *   · The image is served from our own origin, so it needs no separate WeChat
 *     `downloadFile合法域名` entry beyond the one already registered.
 *   · Re-hosting lets us cap the size, which matters because the mini-program
 *     package budget is 2MB and posters are the only realistically large asset.
 *
 * Downloading is best-effort: a poster that fails leaves `poster: null` and the
 * app renders a placeholder. A missing image must never fail the sync.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { writeBytesIfChanged } from '@cevtuo/pipeline-core';

/** Posters are displayed at ~200px; 400 gives headroom for 2x screens. */
const TARGET_WIDTH = 400;

const USER_AGENT = 'CEVTUO-Z-pipeline/0.1 (+https://apps.cevtuogrnd.com)';

export interface PosterResult {
  /** Origin-relative path for the app, or null when the download failed. */
  path: string | null;
  bytes: number;
  downloaded: boolean;
}

/**
 * Resize and re-encode.
 *
 * Uses macOS `sips` — there is no image library in the dependency tree and adding
 * one (sharp) would pull a large native binary into a CI job that only needs to
 * shrink a few hundred stills. When `sips` is unavailable (the GitHub runner is
 * Linux), this returns null and the caller stores the original bytes: bigger, but
 * correct. A sync that produces large posters beats one that produces none.
 *
 * ⚠️ Output is JPEG, not WebP, and that is not a preference.
 * `sips -s format webp` exits 0 on this macOS but silently emits PNG anyway —
 * verified by reading the magic bytes, which came back `89 50 4E 47` in files
 * named `.webp`. Silent wrong-format output is worse than an error, so we ask for
 * the format that is actually honoured. JPEG suits photographic posters and is
 * universally decodable, including in the mini-program renderer.
 */
async function transcode(bytes: Uint8Array): Promise<Uint8Array | null> {
  const tmpIn = join(tmpdir(), `cevtuo-poster-${randomUUID()}`);
  const tmpOut = `${tmpIn}.jpg`;
  try {
    await writeFile(tmpIn, bytes);
    const proc = Bun.spawnSync([
      'sips',
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '72', // quality; posters are small and mostly flat
      '-Z', String(TARGET_WIDTH),
      tmpIn,
      '--out', tmpOut,
    ]);
    if (proc.exitCode !== 0) return null;
    return new Uint8Array(await readFile(tmpOut));
  } catch {
    return null;
  } finally {
    await rm(tmpIn, { force: true }).catch(() => {});
    await rm(tmpOut, { force: true }).catch(() => {});
  }
}

/**
 * Download one poster and write it to `dataDir/coof/posters/<id>.webp`.
 *
 * Returns the origin-relative path on success, `null` on any failure.
 */
export async function rehostPoster(
  movieId: string,
  url: string,
  dataDir: string,
): Promise<PosterResult> {
  const relPath = `data/coof/posters/${movieId}.jpg`;
  const absPath = join(dataDir, 'coof', 'posters', `${movieId}.jpg`);

  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { path: null, bytes: 0, downloaded: false };

    const original = new Uint8Array(await res.arrayBuffer());
    const encoded = (await transcode(original)) ?? original;

    await mkdir(dirname(absPath), { recursive: true });
    // The binary variant keeps an unchanged poster from touching its mtime, which
    // is what stops a no-op sync from producing a diff for every single poster.
    const outcome = await writeBytesIfChanged(absPath, encoded);

    return { path: relPath, bytes: encoded.byteLength, downloaded: outcome === 'written' };
  } catch {
    return { path: null, bytes: 0, downloaded: false };
  }
}

/**
 * Re-host a batch of posters with bounded concurrency.
 *
 * Notion's S3 front end starts refusing connections well before a few hundred
 * parallel requests, and a serial loop over ~500 posters takes minutes.
 */
export async function rehostPosters(
  items: Array<{ id: string; url: string | null }>,
  dataDir: string,
  concurrency = 8,
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const queue = items.filter((i): i is { id: string; url: string } => Boolean(i.url));

  let cursor = 0;
  let downloaded = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      if (!item) break;
      const { path } = await rehostPoster(item.id, item.url, dataDir);
      results.set(item.id, path);
      if (path) downloaded++;
      else failed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  console.log(`    海报: 成功 ${downloaded}, 失败 ${failed}, 无图 ${items.length - queue.length}`);
  return results;
}
