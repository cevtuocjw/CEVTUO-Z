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

import { withRetry, writeBytesIfChanged } from '@cevtuo/pipeline-core';

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
 * Request headers for an image URL.
 *
 * ⚠️ Douban returns **HTTP 418** to a bare fetch — verified: the same URL gives
 * 200 with a browser User-Agent and a Referer, and 418 without. Notion's S3 has
 * no such requirement but does not object to the extras, so one header set covers
 * both hosts. Without this, every Douban poster "downloads" as a 13-byte error
 * page and the failure looks like a network problem rather than a missing header.
 */
function fetchHeadersFor(url: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (url.includes('doubanio.com') || url.includes('douban.com')) {
    headers.Referer = 'https://movie.douban.com/';
    headers.Accept = 'image/avif,image/webp,image/jpeg,image/*,*/*;q=0.8';
  }
  return headers;
}

/**
 * A file counts as a usable poster only if it is non-trivial and actually a JPEG.
 *
 * ⚠️ The magic-byte check is not paranoia. `sips -s format webp` once exited 0
 * while writing PNG data into `.webp` files, so an extension-based check would
 * have accepted 145 mislabelled files. Verify the bytes, not the name.
 */
async function readValidJpeg(absPath: string): Promise<number | null> {
  const buf = await readFile(absPath).catch(() => null);
  if (!buf || buf.byteLength < 512) return null;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return isJpeg ? buf.byteLength : null;
}

/**
 * Download one poster and write it to `dataDir/coof/posters/<id>.jpg`.
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

  // A poster's Notion page id never changes, so a poster already on disk is
  // final. Re-downloading all of them every run made a full sync issue ~340
  // requests where ~5 were needed, and that volume is what pushed the S3 front
  // end into resetting connections (193 of 342 failed on the first full run).
  // Skipping known-good files is both faster and markedly more reliable.
  const existing = await readValidJpeg(absPath);
  if (existing) {
    return { path: relPath, bytes: existing, downloaded: false };
  }

  const bytes = await withRetry(
    async () => {
      const res = await fetch(url, { headers: fetchHeadersFor(url) });
      if (!res.ok) {
        // 418 is Douban's anti-bot answer to a bare request. Retrying won't help,
        // so fail immediately with a message that says what actually happened
        // rather than burning four backoff attempts on it.
        if (res.status === 418 || res.status === 403) {
          const err = new Error(
            `HTTP ${res.status} — image host rejected the request (anti-bot; needs Referer/UA)`,
          );
          err.name = 'BlockedError';
          throw err;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    {
      attempts: 5,
      // Jitter matters: all workers retry in lockstep otherwise, so they collide
      // again on every attempt and the backoff buys nothing.
      baseDelayMs: 700,
      jitterMs: 600,
      label: `poster ${movieId.slice(0, 8)}`,
    },
  ).catch(() => null);

  if (!bytes) {
    // ⚠️ Non-destructive: report the old path rather than null. A single flaky
    // socket would otherwise rewrite `poster` to null, and the next run would
    // flip it back — one new commit per run from nothing but network jitter,
    // silently defeating the whole no-commit-storm design.
    const fallback = await readFile(absPath).catch(() => null);
    return fallback
      ? { path: relPath, bytes: fallback.byteLength, downloaded: false }
      : { path: null, bytes: 0, downloaded: false };
  }

  const encoded = (await transcode(bytes)) ?? bytes;

  await mkdir(dirname(absPath), { recursive: true });
  // The binary variant keeps an unchanged poster from touching its mtime, which
  // is what stops a no-op sync from producing a diff for every single poster.
  const outcome = await writeBytesIfChanged(absPath, encoded);

  return { path: relPath, bytes: encoded.byteLength, downloaded: outcome === 'written' };
}

/**
 * Re-host a batch of posters with bounded concurrency.
 *
 * Notion's S3 front end starts refusing connections well before a few hundred
 * parallel requests, and a serial loop over ~500 posters takes minutes.
 */
/**
 * Re-host a batch of posters with bounded concurrency.
 *
 * ⚠️ Concurrency is deliberately low. At 8 workers a full 342-poster run had 193
 * connection failures; Notion's S3 front end resets sockets well before the
 * request rate looks high on paper. Combined with skipping posters already on
 * disk, a steady-state run now issues a handful of requests instead of hundreds.
 */
export async function rehostPosters(
  items: Array<{ id: string; url: string | null }>,
  dataDir: string,
  concurrency = 5,
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
      const { path, downloaded: isNew } = await rehostPoster(item.id, item.url, dataDir);
      results.set(item.id, path);
      if (isNew) downloaded++;
      else if (!path) failed++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));

  const skipped = queue.length - downloaded - failed;
  console.log(
    `    海报: 新下载 ${downloaded}, 已存在 ${skipped}, 失败 ${failed}, 无图 ${items.length - queue.length}`,
  );
  return results;
}
