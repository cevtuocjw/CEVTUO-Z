/**
 * 线上那份密文索引里，**到底有哪些字段是真的有数的**。
 *
 *   bun scripts/chealth-coverage.ts
 *
 * ⚠️ 为什么需要它。
 *
 * `ChealthDay` 的类型几乎每个字段都是可选的 —— 那是诚实的（不同来源写不同的
 * 指标），但它意味着**类型检查完全不能告诉你某一项有没有数据**。
 * 而这一页的整条设计原则是「拿不到数据的功能就不做」：
 * 三星健康有「活动时间/楼层/血氧/HRV」，我们的类型里也有 `floors` / `hrvMs`，
 * 但**躺在类型里**和**躺在数据里**是两件事。
 *
 * ⚠️ 这个项目已经因为「以为有数」栽过：HRV、呼吸率、皮温、体重在 30 天里
 *    一条记录都没有，而页面差点把它们画成 0（见 index.tsx 抬头那四条）。
 *    所以做新功能之前，先量一遍。
 */
import { readFileSync } from 'node:fs';

import { openSealed } from '../apps/dashboard/src/platform/health-crypto';

const KEY = 'CEVTUO_HEALTH_PASSPHRASE=';
const line = readFileSync('services/ingest/.env.server-backup', 'utf8')
  .split('\n')
  .find((l) => l.startsWith(KEY));
if (!line) throw new Error('services/ingest/.env.server-backup 里没有 ' + KEY);
const pass = line.slice(KEY.length).trim();

// ⚠️ 路径可以传参 —— 这样才能拿它去问**线上**那一份（`raw.githubusercontent.com`
//    没有 CDN 缓存，`z.cevtuogrnd.com` 有，最多差 10 分钟）。
const FILE = process.argv[2] ?? 'data/chealth/index.json';
const idx = JSON.parse(openSealed(readFileSync(FILE, 'utf8'), pass)) as {
  from: string;
  to: string;
  dayCount: number;
  days: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  totals: Record<string, unknown>;
  origins: Record<string, unknown>;
};

const days = idx.days ?? [];
const sessions = idx.sessions ?? [];

console.log(`\n索引区间 ${idx.from} → ${idx.to}   共 ${days.length} 天 / ${sessions.length} 场运动`);
console.log(`totals 非空 ${Object.entries(idx.totals ?? {}).filter(([, v]) => v !== null && v !== undefined).length}/${Object.keys(idx.totals ?? {}).length}`);
console.log(`来源 ${Object.keys(idx.origins ?? {}).length} 个\n`);

function coverage(label: string, rows: Record<string, unknown>[], numeric = true) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  console.log(`── ${label}（${rows.length} 条）`);
  for (const k of keys) {
    const hit = rows.filter((r) => {
      const v = r[k];
      if (v === null || v === undefined) return false;
      // ⚠️ 「有值」不等于「有数」：空数组、空对象、0 都要分开看。
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'object') return Object.keys(v).length > 0;
      if (numeric && typeof v === 'number') return true;
      return true;
    }).length;
    const pct = rows.length ? Math.round((hit / rows.length) * 100) : 0;
    const flag = hit === 0 ? '  ✗ 一条都没有' : hit < rows.length ? '  ~ 部分' : '  ✓ 全有';
    console.log(`   ${k.padEnd(18)} ${String(hit).padStart(3)}/${rows.length}  ${String(pct).padStart(3)}%${flag}`);
  }
  console.log('');
}

coverage('days', days);
coverage('sessions', sessions);

// ⚠️ 序列类字段单独看 —— 「这一场有没有功率曲线」和「功率平均值是多少」
//    是两个不同的问题，混在覆盖率里会看不出真相。
const SERIES = ['hrSeries', 'powerSeries', 'cadenceSeries', 'speedSeries'];
console.log('── 过程序列（只统计长度）');
for (const k of SERIES) {
  const lens = sessions.map((s) => (Array.isArray(s[k]) ? (s[k] as unknown[]).length : 0));
  const withIt = lens.filter((n) => n > 1).length;
  console.log(`   ${k.padEnd(18)} ${String(withIt).padStart(3)}/${sessions.length} 场有  最长 ${Math.max(0, ...lens)} 点`);
}

// ⚠️ 楼层是三星「活动」那屏的一个正式指标，我们的类型里有 `floors` ——
//    但只有在真有数的时候才值得给它一屏。
// ── 逐日表 ─────────────────────────────────────────────────
//
// ⚠️ 读者 2026-09-29 问「为什么 9/1 到 9/13 的数据好像有一点奇怪」，
//    而三星截图那张九月日历上 1 号到 29 号**几乎全满**（目标已实现 27/29 天）。
//    要对上这个问题，只有把**每一天**摊开看：哪几天没有步数、
//    `stepSources` 说那天是谁写的、`origins` 说各来源一共写了多少条。
console.log('\n── 逐日');
console.log('   日期          步数      来源(谁写的:条数)                睡眠s   总消耗  活动  活动分');
// ⚠️ 最后一列「活动分」= `activeMinutes`。**要盯住它别是 1440** ——
//    那个数意味着 Google Fit 的整天聚合记录被并进来了（见 SyncWorker 里的注释）。
for (const d of days) {
  const src = d.stepSources
    ? Object.entries(d.stepSources as Record<string, number>)
        .map(([k, v]) => `${String(k).split('.').pop()}:${v}`)
        .join(' ')
    : '—';
  const pad = (v: unknown, n: number) => String(v ?? '—').padStart(n);
  console.log(
    `   ${d.date}  ${pad(d.steps, 7)}  ${src.padEnd(32)} ${pad(d.sleepSeconds, 7)} ${pad(d.calories, 7)} ${pad(d.activeCalories, 6)} ${pad(d.activeMinutes, 6)}`,
  );
}

console.log('\n── 来源（origins）');
for (const [pkg, o] of Object.entries(idx.origins ?? {})) {
  const oo = o as { count?: number; lastAt?: string };
  console.log(`   ${pkg.padEnd(42)} ${String(oo.count ?? '—').padStart(6)} 条   最后 ${oo.lastAt ?? '—'}`);
}

const floors = days.filter((d) => typeof d.floors === 'number' && (d.floors as number) > 0);
console.log(`\n楼层 floors：${floors.length}/${days.length} 天有非零值`);
const ex = days.filter((d) => typeof d.exerciseCount === 'number' && (d.exerciseCount as number) > 0);
console.log(`每日运动次数 exerciseCount：${ex.length}/${days.length} 天有非零值`);
const cad = days.filter((d) => typeof d.stepsCadenceAvg === 'number');
console.log(`步频 stepsCadenceAvg：${cad.length}/${days.length} 天有值`);
const spd = days.filter((d) => typeof d.speedAvgMps === 'number');
console.log(`速度 speedAvgMps：${spd.length}/${days.length} 天有值`);
console.log('');
