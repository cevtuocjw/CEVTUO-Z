/**
 * Minimal Notion API client.
 *
 * Only what the pipeline needs: paginated queries, page-block walks, and the
 * property extractors. No SDK — the official client is large, and every shape
 * here has a live-verified counterpart in packages/schema/src/collections.ts.
 *
 * ⚠️ The token is read from the environment and never logged. Error messages go
 * through the caller's scrubber before they can reach a committed file; `data/`
 * is world-readable.
 */

import { withRetry } from '@cevtuo/pipeline-core';

const API = 'https://api.notion.com/v1';

/** Pinned. Notion changes response shapes between versions. */
const NOTION_VERSION = '2022-06-28';

export class NotionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

function token(): string {
  const t = process.env.NOTION_TOKEN?.trim();
  if (!t) {
    throw new Error(
      'NOTION_TOKEN is not set. Copy .env.example to .env and fill it in, ' +
        'or export it before running the pipeline.',
    );
  }
  return t;
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(`${API}${path}`, {
        method: init?.method ?? (init?.body ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${token()}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });

      const text = await res.text();
      if (!res.ok) {
        let code = 'unknown';
        let message = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { code?: string; message?: string };
          code = parsed.code ?? code;
          message = parsed.message ?? message;
        } catch {
          /* non-JSON error body — keep the raw text */
        }
        // 404 on a database almost always means the integration was never added
        // to that page's Connections, not that the id is wrong. Say so, because
        // the raw error sends people hunting for a typo that isn't there.
        if (res.status === 404 && code === 'object_not_found') {
          message +=
            ' — this usually means the page/database was not shared with the integration' +
            ' (open it in Notion → "..." → Connections), not that the id is wrong.';
        }
        throw new NotionError(res.status, code, message);
      }
      return JSON.parse(text) as T;
    },
    { label: `notion ${path}`, attempts: 4 },
  );
}

// ─────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────

export interface NotionPage {
  id: string;
  properties: Record<string, NotionProperty>;
  url: string;
}

export interface NotionProperty {
  id?: string;
  type: string;
  title?: RichText[];
  rich_text?: RichText[];
  number?: number | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  status?: { name: string } | null;
  date?: { start: string; end: string | null } | null;
  files?: Array<{
    name: string;
    type: 'file' | 'external';
    file?: { url: string };
    external?: { url: string };
  }>;
  checkbox?: boolean;
  url?: string | null;
  formula?: { type: string; string?: string | null; number?: number | null };
}

export interface RichText {
  plain_text: string;
}

/**
 * Fetch every row of a database, following pagination.
 *
 * `page_size` is capped at 100 by Notion; the loop is what makes this correct
 * for the larger calendars, which are well past 100 entries.
 */
export async function queryDatabaseAll(
  databaseId: string,
  opts: { filter?: unknown; sorts?: unknown[]; maxPages?: number } = {},
): Promise<NotionPage[]> {
  const out: NotionPage[] = [];
  let cursor: string | undefined;
  const maxPages = opts.maxPages ?? 30;

  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (opts.filter) body.filter = opts.filter;
    if (opts.sorts) body.sorts = opts.sorts;

    const res = await request<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>(
      `/databases/${databaseId}/query`,
      { body },
    );
    out.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor ?? undefined;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Property extraction
//
// ⚠️ Several COOF properties are rich_text holding values that look numeric
// ("86" for runtime, "2025" for year). They must be parsed, not read as numbers —
// reading `.number` on them yields undefined and silently drops the values.
// ─────────────────────────────────────────────────────────────

export function propText(p: NotionProperty | undefined): string {
  if (!p) return '';
  const rt = p.type === 'title' ? p.title : p.rich_text;
  if (rt) return rt.map((t) => t.plain_text).join('').trim();
  // ⚠️ Not every column is rich_text, and the calendars disagree about which
  // ones are. `YEAR` is rich_text in six of them and a NUMBER in COOF2022;
  // `KIND` is multi_select in the new calendars and a SELECT in COOF2022.
  // Reading only rich_text made those cells look empty rather than wrong, so
  // the values vanished silently.
  if (typeof p.number === 'number') return String(p.number);
  if (p.select?.name) return p.select.name;
  if (typeof p.select?.name === 'string') return p.select.name;
  return '';
}

export function propNumber(p: NotionProperty | undefined): number | null {
  return p?.number ?? null;
}

/**
 * Parse an integer out of a rich_text property.
 * Tolerates "86", "86 min", " 86 ", and returns null for anything unparseable
 * or non-positive rather than throwing — a bad cell shouldn't fail the build.
 */
export function propIntFromText(p: NotionProperty | undefined): number | null {
  const raw = propText(p);
  if (!raw) return null;
  const m = raw.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function propMultiSelect(p: NotionProperty | undefined): string[] {
  return (p?.multi_select ?? []).map((o) => o.name).filter(Boolean);
}

export function propDate(p: NotionProperty | undefined): string | null {
  const start = p?.date?.start;
  if (!start) return null;
  // Notion returns either "YYYY-MM-DD" or a full ISO timestamp; we only want the day.
  return start.slice(0, 10);
}

/** First file URL, and whether it is Notion-hosted (and therefore expiring). */
export function propFile(p: NotionProperty | undefined): { url: string; expiring: boolean } | null {
  const f = p?.files?.[0];
  if (!f) return null;
  const url = f.type === 'external' ? f.external?.url : f.file?.url;
  if (!url) return null;
  // Notion-hosted files come from S3 with X-Amz-Expires=3600 — one hour.
  return { url, expiring: f.type === 'file' };
}
