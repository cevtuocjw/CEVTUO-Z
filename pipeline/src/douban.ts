/**
 * Douban poster lookup.
 *
 * Used to fill in the ~867 COO entries that have no poster in Notion — 856 of
 * them predate the POSTER property entirely, so there is nothing to download,
 * only something to find.
 *
 * ⚠️ Douban has no public API and actively throttles scripted traffic. This
 * module therefore:
 *   · runs at a deliberately slow, single-threaded pace (see DOUBAN_DELAY_MS)
 *   · caches every lookup on disk, so a re-run never re-asks for a known answer
 *   · treats "not found" as a cacheable result, not a failure
 *
 * It is a BACKFILL tool, not part of the 5-hourly sync. Enrichment is a one-off
 * pass over content that barely changes; folding it into the schedule would mean
 * hammering Douban forever for data that is already known.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withRetry } from '@cevtuo/pipeline-core';

/** Douban tolerates slow sequential access; it does not tolerate bursts. */
const DOUBAN_DELAY_MS = 1500;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export interface DoubanMatch {
  title: string;
  year: string | null;
  posterUrl: string | null;
  url: string;
  /** Douban's own id, handy for spotting a wrong match by eye. */
  subjectId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip the Latin half of a bilingual title — Douban indexes the Chinese one. */
export function searchTerm(fullTitle: string): string {
  // "镜的第三乐章 Miroirs No. 3" -> "镜的第三乐章"
  const chinese = fullTitle.split(/\s{1,}[A-Za-z]/)[0]?.trim();
  const term = chinese && chinese.length >= 2 ? chinese : fullTitle;
  // Drop the trailing year/parenthetical noise Douban search chokes on.
  return term.replace(/[（(].*?[)）]/g, '').trim();
}

/**
 * Parse the search results page.
 *
 * Douban's markup is not stable and has changed repeatedly; this reads the
 * minimum it needs and returns [] rather than throwing when the shape moves,
 * so a layout change degrades to "no match" instead of a crashed backfill.
 */
export function parseSearchResults(html: string): DoubanMatch[] {
  const out: DoubanMatch[] = [];

  // Verified against the live page markup (2026-09). Structure per result:
  //   <div class="result">
  //     <div class="pic"><a class="nbg" href="...link2/?url=...subject%2F<id>%2F..."
  //          onclick="moreurl(this,{... sid: <id> ...})"><img src="https://img*.doubanio.com/..."></a></div>
  //     <div class="content"><div class="title"><h3><span>[电影]</span>&nbsp;<a ...>片名</a>
  //          ...</h3><div class="rating-info">...<span class="subject-cast">原名:X / 导演 / 演员 / 2025</span>
  //
  // ⚠️ The title is NOT in <span class="title"> — that is the container div. An
  // earlier version matched the wrong element and silently returned zero results
  // for every query, which looks exactly like "Douban has nothing" rather than a
  // parser bug.
  const blocks = html.split('<div class="result">').slice(1);

  for (const block of blocks) {
    // Result blocks are uniform, but bound the slice so one result's data can't
    // leak into the next if the markup shifts.
    const scope = block.slice(0, 3000);

    const subjectId =
      scope.match(/sid:\s*(\d+)/)?.[1] ??
      scope.match(/subject%2F(\d+)%2F/)?.[1] ??
      scope.match(/subject\/(\d+)/)?.[1];
    if (!subjectId) continue;

    const posterUrl =
      scope.match(/<img[^>]+src="(https:\/\/[^"]*doubanio\.com[^"]*)"/)?.[1] ??
      scope.match(/<img[^>]+data-src="(https:\/\/[^"]*doubanio\.com[^"]*)"/)?.[1] ??
      null;

    // The anchor text inside <h3>, minus the "[电影]" prefix span.
    const title =
      scope
        .match(/<h3>[\s\S]*?<a[^>]*>([^<]+)<\/a>/)?.[1]
        ?.trim()
        .replace(/\/\s*$/, '') ?? '';
    if (!title) continue;

    // subject-cast reads "原名:Zootopia 2 / 杰拉德·布什 / 金妮弗·古德温 / 2025"
    const year = scope.match(/<span class="subject-cast">[^<]*?(\d{4})\s*<\/span>/)?.[1] ?? null;

    out.push({
      title,
      year,
      posterUrl: posterUrl ? normalisePosterUrl(posterUrl) : null,
      url: `https://movie.douban.com/subject/${subjectId}/`,
      subjectId,
    });
  }
  return out;
}

/**
 * Douban serves several sizes from one image path. `s_ratio_poster` is a small
 * thumbnail (often ~100px) and is too soft for a 320px card; `l` is the large
 * cover. Rewriting the size segment is more reliable than picking a different
 * result.
 */
export function normalisePosterUrl(url: string): string {
  return url
    .replace('/view/photo/s_ratio_poster/', '/view/photo/l/')
    .replace('/view/photo/m_ratio_poster/', '/view/photo/l/')
    .replace('/view/photo/s/', '/view/photo/l/');
}

// ─────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────

export interface DoubanCache {
  /** keyed by the search term. */
  [term: string]: { match: DoubanMatch | null; at: string };
}

export class DoubanClient {
  private cache: DoubanCache = {};
  private cachePath: string;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir: string) {
    this.cachePath = join(cacheDir, 'douban-cache.json');
  }

  /**
   * Load the on-disk cache.
   *
   * ⚠️ This file belongs in `.gitignore`, not in the repo: it is a scratch
   * database of third-party lookups, not project content, and committing it would
   * conflate "what our data is" with "what we once asked Douban".
   */
  async load(): Promise<void> {
    const raw = await readFile(this.cachePath, 'utf8').catch(() => null);
    if (!raw) return;
    try {
      this.cache = JSON.parse(raw) as DoubanCache;
    } catch {
      this.cache = {};
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf8');
  }

  get stats(): { cached: number; fetched: number } {
    return { cached: this.hits, fetched: this.misses };
  }

  /** Look up one title, using the cache when possible. */
  async lookup(fullTitle: string, yearHint: number | null): Promise<DoubanMatch | null> {
    const term = searchTerm(fullTitle);
    const cached = this.cache[term];
    if (cached) {
      this.hits++;
      return cached.match;
    }

    this.misses++;
    await sleep(DOUBAN_DELAY_MS);

    const match = await withRetry(
      async () => {
        const res = await fetch(
          `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(term)}`,
          { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } },
        );
        if (res.status === 403 || res.status === 418) {
          // Douban's anti-bot response. Surfacing this is more useful than
          // silently recording "not found", which would poison the cache.
          throw new Error(`douban blocked the request (HTTP ${res.status})`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseSearchResults(await res.text());
      },
      { attempts: 3, baseDelayMs: 3000, jitterMs: 2000, label: `douban "${term}"` },
    ).catch(() => [] as DoubanMatch[]);

    // Prefer an exact year match; fall back to the first result, which Douban
    // ranks by relevance and is usually right for an exact title.
    // (Not `yearHint && ...` — under noUncheckedIndexedAccess that expression is
    // typed `0 | DoubanMatch`, which is not assignable here.)
    const byYear = yearHint ? match.find((m) => m.year === String(yearHint)) : undefined;
    const exact: DoubanMatch | null = byYear ?? match[0] ?? null;

    this.cache[term] = { match: exact, at: new Date().toISOString() };
    return exact;
  }
}
