/**
 * `z.object` 会**静默丢掉** schema 里没写的键 —— 这个断言就是钉住这一点的。
 *
 *   bun scripts/verify-chealth-schema.ts
 *
 * ⚠️⚠️ 为什么值得单独一个文件。
 *
 * 这个坑已经在同一个文件里记过**两次**：
 *   · 第一次：原始导出被 zod 解析后才存，`.default()` 补上、不认识的键丢掉 ——
 *     于是存的不是「设备发了什么」，而是「这一版 schema 理解了什么」
 *   · 第二次：`hrSeries` / `powerSeries` / `cadenceSeries` 三个键没写进 schema，
 *     手机端明明在发，服务器上就是没有，**零报错**
 *
 * 症状永远是同一个：**手机推了、服务器上没有、没有任何地方会报错。**
 * 它不可能被「跑一遍看看」发现 —— 只能靠直接问 schema。
 *
 * ⚠️ 所以这个断言测的不是「某个字段现在能不能过」，而是
 *    **「手机端会发的每一个键，schema 都必须认识」**。
 */
import { HealthRawSchema } from '../services/ingest/src/chealth';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * ⚠️ 手机端 `SyncWorker.buildPayload` 会写进每一天的键。
 *    加字段时**这里也要加** —— 忘了加的下场就是静默丢掉。
 *    （清单是照着 `day.put(...)` 逐个抄的，不是猜的。）
 */
const DAY_KEYS = [
  'date',
  'stepSources',
  'steps',
  'activeMinutes',
  'distanceM',
  'stepsCadenceAvg',
  'speedAvgMps',
  'speedMaxMps',
  'calories',
  'activeCalories',
  'floors',
  'sleepSeconds',
  'hrAvg',
  'hrMax',
  'restingHr',
  'hrvMs',
  'spo2Pct',
  'respRate',
  'weightKg',
  'exerciseCount',
];

/** 会话里手机端会写的键。 */
const SESSION_KEYS = [
  'start',
  'minutes',
  'type',
  'exerciseType',
  'title',
  'source',
  'sources',
  'distanceM',
  'activeCalories',
  'hrAvg',
  'hrMax',
  'hrSource',
  'hrSeries',
  'powerAvg',
  'powerMax',
  'powerSeries',
  'cadenceAvg',
  'cadenceSeries',
  'speedMaxMps',
  'speedSeries',
];

const DAY_SAMPLES: Record<string, unknown> = {
  date: '2026-09-29',
  stepSources: { 'com.sec.android.app.shealth': 100 },
  steps: 9686,
  activeMinutes: 75,
  distanceM: 6400,
  stepsCadenceAvg: 42.5,
  speedAvgMps: 1.2,
  speedMaxMps: 3.4,
  calories: 1953,
  activeCalories: 515,
  floors: 12,
  sleepSeconds: 20790,
  hrAvg: 72,
  hrMax: 143,
  restingHr: 62,
  hrvMs: 38,
  spo2Pct: 96,
  respRate: 14,
  weightKg: 72,
  exerciseCount: 2,
};

const SESSION_SAMPLES: Record<string, unknown> = {
  start: '2026-09-29T18:44:00+08:00',
  minutes: 50,
  type: 'BIKING',
  exerciseType: 8,
  title: '骑行',
  source: 'a.b',
  sources: ['a.b'],
  distanceM: 26520,
  activeCalories: 423,
  hrAvg: 143,
  hrMax: 182,
  hrSource: 'a.b',
  hrSeries: [[0, 120], [1, 130]],
  powerAvg: 273,
  powerMax: 402,
  powerSeries: [[0, 250], [1, 300]],
  cadenceAvg: 85,
  cadenceSeries: [[0, 80], [1, 90]],
  speedMaxMps: 12.5,
  speedSeries: [[0, 8], [1, 9]],
};

function payload() {
  return {
    schemaVersion: 1 as const,
    device: 'health-connect',
    exportedAt: '2026-09-29T10:00:00+08:00',
    appVersion: '1.3',
    days: [DAY_SAMPLES],
    sessions: [SESSION_SAMPLES],
    origins: { 'a.b': { count: 1, lastAt: '2026-09-29T09:00:00+08:00' } },
  };
}

console.log('\nCHEALTH 上报 schema · zod 静默丢键检查\n');

const parsed = HealthRawSchema.safeParse(payload());
if (!parsed.success) {
  console.log('  FAIL  样例负载本身就过不了 schema');
  console.log(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
  console.log(`\n0/1 通过\n`);
  process.exit(1);
}

const day = parsed.data.days[0] as unknown as Record<string, unknown>;
const sess = parsed.data.sessions[0] as unknown as Record<string, unknown>;

const lostDay = DAY_KEYS.filter((k) => !(k in day));
check(
  'daily 的每一个键都活过了 zod',
  lostDay.length === 0,
  lostDay.length ? `被丢掉的：${lostDay.join(', ')}  ← 手机推了、服务器上不会有` : `${DAY_KEYS.length} 个键全部保留`,
);

const lostSess = SESSION_KEYS.filter((k) => !(k in sess));
check(
  'session 的每一个键都活过了 zod',
  lostSess.length === 0,
  lostSess.length ? `被丢掉的：${lostSess.join(', ')}` : `${SESSION_KEYS.length} 个键全部保留`,
);

// ⚠️ 单独把 activeMinutes 再钉一次：它是 2026-09-29 新加的，
//    而**加字段最容易漏的就是这一步**（schema 不写 = 静默丢）。
check(
  '`activeMinutes` 能过 schema（2026-09-29 新加的）',
  typeof day.activeMinutes === 'number',
  `解析出来是 ${JSON.stringify(day.activeMinutes)}`,
);

// ⚠️ 反向：**不认识的键必须被丢掉**。这条不是「测 bug」，是钉住行为 ——
//    要是哪天有人把 schema 改成 passthrough，上面那些断言会全部变成空话
//    （什么都过得去，等于没检查）。
const withJunk = HealthRawSchema.safeParse({
  ...payload(),
  days: [{ ...DAY_SAMPLES, totallyMadeUpKey: 1 }],
});
const junkDay = withJunk.success ? (withJunk.data.days[0] as unknown as Record<string, unknown>) : {};
check(
  '反向对照：不认识的键**确实**会被丢掉',
  withJunk.success && !('totallyMadeUpKey' in junkDay),
  withJunk.success ? 'schema 不是 passthrough，上面的断言有意义' : '负载没解析成功',
);

console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
