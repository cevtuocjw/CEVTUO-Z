/**
 * Pipeline primitives shared by every source.
 *
 * The single most important function here is `writeIfChanged`. The whole
 * "a no-op 5-hourly run produces ZERO commits" guarantee — which keeps GitHub
 * Pages from burning its 10-builds-per-hour budget and keeps the repo history
 * readable — depends on `stableJson` + `writeIfChanged` + the rule that brand
 * payloads carry no timestamps (see @cevtuo/schema).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ─────────────────────────────────────────────────────────────
// Canonical JSON
// ─────────────────────────────────────────────────────────────

/**
 * Serialise with recursively sorted keys, 2-space indent, trailing newline.
 *
 * Two runs that produce the same data produce byte-identical files. Without this,
 * key ordering that varies between runs would show up as a diff and we'd commit
 * on every scheduled run.
 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue; // never emit `undefined` — it isn't valid JSON
    out[key] = sortKeys(src[key]);
  }
  return out;
}

/** Short, stable content hash used as a payload's `dataVersion`. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 12);
}

// ─────────────────────────────────────────────────────────────
// Write only when the bytes actually differ
// ─────────────────────────────────────────────────────────────

export type WriteOutcome = 'written' | 'unchanged';

export async function writeIfChanged(absPath: string, contents: string): Promise<WriteOutcome> {
  const existing = await readFile(absPath, 'utf8').catch(() => null);
  if (existing === contents) return 'unchanged';
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents, 'utf8');
  return 'written';
}

/**
 * Binary counterpart to `writeIfChanged`.
 *
 * ⚠️ Do not route binary through `writeIfChanged`. Converting bytes to a string
 * and back corrupts them — the WebP headers survive but the payload does not,
 * producing images that decode as garbage.
 */
export async function writeBytesIfChanged(absPath: string, contents: Uint8Array): Promise<WriteOutcome> {
  const existing = await readFile(absPath).catch(() => null);
  if (existing && existing.byteLength === contents.byteLength && existing.equals(Buffer.from(contents))) {
    return 'unchanged';
  }
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents);
  return 'written';
}

export async function readJson<T>(absPath: string): Promise<T | null> {
  const raw = await readFile(absPath, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Time formatting — one field, parses everywhere, slices to "14:05"
// ─────────────────────────────────────────────────────────────

/** Offset in minutes for `date` in `timeZone`, without needing `Intl` at the call site. */
function offsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * "2026-09-22T14:05+08:00" — minute precision, explicit offset.
 *
 * The app renders this as `value.slice(11, 16)` → "14:05", which needs no
 * timezone maths and no `Intl` on the client (mini-program `Intl` is unreliable).
 */
export function isoInstant(date: Date, timeZone = 'Asia/Shanghai'): string {
  const off = offsetMinutes(date, timeZone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const local = new Date(date.getTime() + off * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** "2026-09-22" in the given zone. Day keys everywhere use this. */
export function dayKey(date: Date, timeZone = 'Asia/Shanghai'): string {
  return isoInstant(date, timeZone).slice(0, 10);
}

/**
 * Next run of a `0 *&#47;5 * * *` style cadence.
 *
 * GitHub's schedule is best-effort and can drift 10–30 min under load, so this is
 * labelled "scheduled" not "guaranteed" in the UI. It exists so the app can show a
 * countdown while offline.
 */
export function nextScheduledAt(from: Date, everyHours: number, timeZone = 'Asia/Shanghai'): string {
  const next = new Date(from.getTime());
  next.setUTCMinutes(0, 0, 0);
  // GitHub cron is UTC-based; advance to the next multiple of `everyHours`.
  const hours = next.getUTCHours();
  const step = Math.floor(hours / everyHours) * everyHours + everyHours;
  next.setUTCHours(step);
  return isoInstant(next, timeZone);
}

// ─────────────────────────────────────────────────────────────
// Error scrubbing — these strings end up in a publicly readable file
// ─────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\b(ntn|secret)_[A-Za-z0-9]{10,}/g, // Notion
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub PAT
  /\bsk-[A-Za-z0-9-]{16,}/g, // generic API key
  /\bya29\.[A-Za-z0-9._-]{10,}/g, // Google OAuth
  /"(private_key|client_secret|refresh_token|access_token)"\s*:\s*"[^"]*"/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
];

/**
 * Truncate and redact before an error message can reach a public JSON file or
 * the app's diagnostics panel. Errs on the side of over-redaction.
 */
export function scrubError(input: unknown, maxLength = 200): { code: string; message: string } {
  const err = input instanceof Error ? input : new Error(String(input));
  // Node puts the useful detail in `cause` for wrapped fetch errors.
  const detail = (err as { cause?: unknown }).cause;
  let message = detail instanceof Error ? `${err.message}: ${detail.message}` : err.message;

  for (const re of SECRET_PATTERNS) message = message.replace(re, '[redacted]');
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > maxLength) message = `${message.slice(0, maxLength - 1)}…`;

  return { code: (err.name || 'Error').slice(0, 48), message };
}

// ─────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────

/** Retry with exponential backoff — Notion and Drive both rate-limit. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseDelayMs = 500, label = 'request' }: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`  ${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** Repo-relative path → absolute, rooted at the repository. */
export function repoPath(...segments: string[]): string {
  const here = new URL('.', import.meta.url).pathname;
  // packages/pipeline-core/src/index.ts → repo root is three levels up
  const root = join(here, '..', '..', '..');
  return join(root, ...segments);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
