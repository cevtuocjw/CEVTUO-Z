/**
 * 把**被清掉的过程序列**从仓库里的快照补回服务器的合并文件。
 *
 *   bun scripts/chealth-restore-series.mjs <服务器的 merged-health.json> [--out 文件]
 *   bun scripts/chealth-restore-series.mjs <...> --write     # 直接写回原文件（先自动备份）
 *
 * ⚠️⚠️ 为什么需要它（2026-09-30 实测）。
 *
 *   手机端过去是**带富化**的（仓库那份 09-29 的快照：25/25 场都有 `hrSeries`、
 *   `activeCalories`，2 场有 `powerSeries`），现在基本不带了
 *   （服务器 `raw-health.json`：117 场里只有 13 场有 `hrSeries`，`powerSeries` **一场都没有**）。
 *   再加上服务器 `mergeSessions` 那个「整表替换」的 bug（已修），
 *   两头夹击 ⇒ 页面上一大片「这一场没有过程曲线」，而**那些数据本来是有的**。
 *
 * ⚠️⚠️ **只填空，绝不覆盖。** 服务器上那份是**更新**的（手机还在推），
 *    所以每一场都以服务器的值为准，只有当服务器**缺**这个字段、
 *    而仓库那份**有**的时候才补进去。
 *    ⚠️ 「缺」的定义要写清楚：字段不存在、是 null、或者数组长度 < 2
 *      （长度 1 的序列画不出任何东西，等同于没有）。
 *
 * ⚠️ 它**不改天数**（`days`）—— 那份没有丢，而且它才是页面上的主数据。
 *    动的只有 `sessions` 里缺的那几个富化字段。
 *
 * ⚠️ 服务器那两个文件是**明文 JSON**（不是密封的）——`raw-health.json` 是手机
 *    推上来的原始导出，`merged-health.json` 是合并后的。索引是发布时才密封的。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

import { openSealed } from '../apps/dashboard/src/platform/health-crypto';

/** ⚠️ 只有这几个是「过程序列 / 富化」字段 —— 其它一律不碰。 */
const ENRICH = [
  'hrSeries',
  'powerSeries',
  'cadenceSeries',
  'speedSeries',
  'hrAvg',
  'hrMax',
  'hrSource',
  'powerAvg',
  'powerMax',
  'cadenceAvg',
  'speedMaxMps',
  'distanceM',
  'activeCalories',
];

/** 「有值」的判据 —— ⚠️ 长度 1 的序列画不出任何东西，等同于没有。 */
function has(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 1;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

const [src, ...rest] = process.argv.slice(2);
if (!src) {
  console.error('用法：bun scripts/chealth-restore-series.mjs <合并文件> [--out 文件|--write]');
  process.exit(1);
}
const WRITE = rest.includes('--write');
const outIdx = rest.indexOf('--out');
const OUT = outIdx >= 0 ? rest[outIdx + 1] : null;

const merged = JSON.parse(readFileSync(src, 'utf8'));

// 仓库那份是**密封**的（发布产物），要解开
const KEY = 'CEVTUO_HEALTH_PASSPHRASE=';
const line = readFileSync('services/ingest/.env.server-backup', 'utf8')
  .split('\n')
  .find((l) => l.startsWith(KEY));
if (!line) throw new Error('services/ingest/.env.server-backup 里没有 ' + KEY);
const repo = JSON.parse(
  openSealed(readFileSync('data/chealth/index.json', 'utf8'), line.slice(KEY.length).trim()),
);

const byStart = new Map((repo.sessions ?? []).map((s) => [s.start, s]));
const sessions = merged.sessions ?? [];

const filled = [];
let touched = 0;
for (const s of sessions) {
  const old = byStart.get(s.start);
  if (!old) continue;
  const got = [];
  for (const k of ENRICH) {
    if (has(s[k])) continue; // 服务器有 ⇒ 一个字都不改
    if (!has(old[k])) continue; // 两边都没有 ⇒ 没什么可补
    s[k] = old[k];
    got.push(Array.isArray(old[k]) ? `${k}(${old[k].length}点)` : k);
  }
  if (got.length) {
    touched += 1;
    filled.push(`  ${s.start.slice(5, 16)} ${String(s.type).padEnd(8)} ← ${got.join(', ')}`);
  }
}

console.log(`\n服务器 ${sessions.length} 场 · 仓库快照 ${byStart.size} 场`);
console.log(`可以补的：${touched} 场\n`);
filled.forEach((l) => console.log(l));

// 补完之后各字段的覆盖
const cov = {};
for (const s of sessions) for (const k of ENRICH) if (has(s[k])) cov[k] = (cov[k] ?? 0) + 1;
console.log('\n补完之后：');
for (const k of ENRICH) console.log(`  ${k.padEnd(16)} ${cov[k] ?? 0}/${sessions.length}`);

if (WRITE) {
  const bak = `${src}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  copyFileSync(src, bak);
  writeFileSync(src, JSON.stringify(merged, null, 2));
  console.log(`\n✓ 已写回 ${src}（备份在 ${bak}）`);
} else if (OUT) {
  writeFileSync(OUT, JSON.stringify(merged, null, 2));
  console.log(`\n✓ 已写出 ${OUT}（没动原文件）`);
} else {
  console.log('\n（dry-run —— 加 --out 文件 或 --write 才真的写）');
}
