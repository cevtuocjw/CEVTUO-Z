/**
 * CNSR staggered refresh — ONE source per run.
 *
 *   bun scripts/cnsr-sync.mjs              # refresh whichever source is due
 *   bun scripts/cnsr-sync.mjs --all        # bootstrap: all four, this once
 *   bun scripts/cnsr-sync.mjs --force learn
 *   bun scripts/cnsr-sync.mjs --status
 *
 * ⚠️ Why one at a time.
 *
 * The user's rule: four sources refreshing together is one burst against a
 * workspace-wide Notion budget, and the burst is the thing that earns a 429.
 * Staggered, each run touches one source and each source comes round once every
 * two days — which is also the freshness the four modules advertise.
 *
 * ⚠️ The slot is derived from the CLOCK, not from "whatever is oldest".
 *
 * An oldest-first picker looks equivalent and is not: it re-picks the same
 * source on every run until that source's timestamp moves, so a workflow that
 * fires every five hours spends the first two or three runs on one source and
 * starves the rest. A clock slot assigns each 12-hour window to exactly one
 * source, so the cycle is a property of the calendar rather than of how often
 * the job happens to fire.
 *
 * The idempotence check is what stops the extra runs inside a 12-hour window
 * from refreshing the same source two or three times.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argAfter = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const SOURCES = ['shopping', 'learn', 'techlearn', 'techai'];
/** Hours per slot. Four sources × 12h = 48h = the two-day cycle. */
const SLOT_HOURS = 12;
const SLOT_MS = SLOT_HOURS * 3600_000;

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const outDir = join(root, 'data', 'cnsr');
const indexFile = join(outDir, 'index.json');

let index = { sources: [] };
if (existsSync(indexFile)) {
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {
    // An unreadable index is treated as "nothing has ever synced", which
    // bootstraps rather than skipping. Skipping would be the silent failure.
    index = { sources: [] };
  }
}

const slotOf = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.floor(t / SLOT_MS) : -1;
};

const slot = Math.floor(Date.now() / SLOT_MS);
const done = new Map((index.sources ?? []).map((s) => [s.key, s]));

if (argv.includes('--status')) {
  console.log(`当前时段 ${slot}（每 ${SLOT_HOURS} 小时一个，${SOURCES.length} 个时段 = 2 天一轮）`);
  for (const key of SOURCES) {
    const e = done.get(key);
    const when = e ? slotOf(e.updatedAt) : -1;
    const state = when < 0 ? '从未同步' : when === slot ? '本时段已刷' : `已 ${slot - when} 个时段`;
    console.log(`  ${key.padEnd(11)} ${(e?.updatedAt ?? '—').padEnd(22)} ${state}`);
  }
  process.exit(0);
}

// ── Decide what to run ───────────────────────────────────────
let todo = [];

const forced = argAfter('--force');
if (forced) {
  if (!SOURCES.includes(forced)) {
    console.error(`未知来源: ${forced}（可选 ${SOURCES.join(' / ')}）`);
    process.exit(1);
  }
  todo = [forced];
} else if (argv.includes('--all')) {
  todo = SOURCES;
} else {
  // ⚠️ Bootstrap first. Until every source has a timestamp, the four modules
  // would render empty for two days while the stagger worked through them one
  // at a time. The one-off cost is ~40 requests, once, ever.
  const missing = SOURCES.filter((k) => slotOf(done.get(k)?.updatedAt) < 0);
  if (missing.length) {
    console.log(`首次同步：${missing.join(', ')} 都还没有数据，本次全部补齐（只发生一次）`);
    todo = missing;
  } else {
    const due = SOURCES[slot % SOURCES.length];
    if (slotOf(done.get(due)?.updatedAt) === slot) {
      console.log(`本时段（${slot}）已经刷过 ${due}，跳过。下次轮到的时段：${slot + 1} → ${SOURCES[(slot + 1) % SOURCES.length]}`);
      process.exit(0);
    }
    todo = [due];
  }
}

console.log(`本次刷新：${todo.join(', ')}（时段 ${slot}，每 ${SLOT_HOURS}h 一个）`);

// ── Run the extractor, one source at a time ──────────────────
let failed = 0;
for (const key of todo) {
  const proc = Bun.spawnSync(['bun', 'run', join(root, 'scripts', 'cnsr-extract.mjs'), '--write', '--only', key], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    // ⚠️ Continue with the rest rather than aborting the whole stagger. One
    // source failing (a Notion hiccup, a rate limit) must not stop the others
    // from coming round — and the exit code at the end still reports it.
    console.error(`✗ ${key} 同步失败（退出码 ${proc.exitCode}）`);
    failed += 1;
  }
}

process.exit(failed ? 1 : 0);
