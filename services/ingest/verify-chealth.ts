/**
 * The health ingest's rules, driven against a real handler.
 *
 *   bun run services/ingest/verify-chealth.ts
 *
 * ⚠️ Everything here targets ONE property: **a 15-minute sliding window must
 * accumulate into a history.** Health Connect only ever hands the phone the
 * last 30 days, so the server sees a moving view of the same fortnight over and
 * over. Get the merge wrong and the failure has a 30-day fuse — the site looks
 * perfect and then one morning it has exactly 30 days of history and always
 * will. Nothing crashes. Nothing logs.
 *
 * ⚠️ Every assertion below was written with its NEGATIVE CONTROL in mind: the
 * mutation that should make it fail is named in the comment above it. An
 * assertion that cannot fail is a comment.
 */

import {
  HealthRawSchema,
  pruneOld,
  buildIndexFromStore,
  buildSealedIndexFromStore,
  handleHealthIngest,
  mergeDays,
  sealIndex,
  type HealthDay,
  type HealthStore,
} from './src/chealth';

let passed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; return; }
  failures.push(label);
  console.error(`  ✗ ${label}`);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failures.push(label);
  console.error(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`);
}

function section(name: string): void {
  console.log(`\n▸ ${name}`);
}

// ─────────────────────────────────────────────────────────────
// An in-memory store, faithful to the four-file shape
// ─────────────────────────────────────────────────────────────

function memStore(): HealthStore & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  const get = (k: string) => files[k] ?? null;
  const put = (k: string) => async (t: string) => { files[k] = t; };
  return {
    files,
    readRaw: async () => get('raw'),
    writeRaw: put('raw'),
    readMerged: async () => get('merged'),
    writeMerged: put('merged'),
    readHeartbeat: async () => get('heartbeat'),
    writeHeartbeat: put('heartbeat'),
    writeIndex: put('index'),
  };
}

const ENV = { healthToken: 'tok-health-test', maxBytes: 512 * 1024 };

function push(store: HealthStore, days: HealthDay[], extra: Record<string, unknown> = {}) {
  return handleHealthIngest(
    ENV,
    store,
    'Bearer tok-health-test',
    JSON.stringify({
      schemaVersion: 1,
      device: 'health-connect',
      exportedAt: '2026-09-24T15:00+08:00',
      appVersion: '1.0',
      days,
      ...extra,
    }),
  );
}

const day = (d: string, extra: Partial<HealthDay> = {}): HealthDay => ({ date: d, ...extra });

// ─────────────────────────────────────────────────────────────
section('① 窗口是滑动的 —— 这是整个服务的理由');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();

  // 第 1 天：手机送来 30 天窗口
  const first = Array.from({ length: 30 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, { steps: 100 * (i + 1) }));
  const r1 = await push(s, first);
  eq(r1.status, 202, '首次推送 → 202 committed');
  eq(r1.body.status, 'committed', '首次推送 status=committed');

  // 第 31 天：窗口整体右移一天 —— 8-01 掉出窗口，9-01 进来。
  // 服务端必须保留 8-01。
  //
  // ⚠️ 负向对照：把 mergeDays 换成「直接用 incoming 覆盖已存」，
  //    下面这条必须 FAIL（30 天变成 30 天但最老的是 8-02）。
  const shifted = Array.from({ length: 30 }, (_, i) => day(`2026-08-${String(i + 2).padStart(2, '0')}`, { steps: 100 * (i + 2) }));
  await push(s, shifted);

  const merged = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  // ⚠️ 31，不是 30。两次窗口的并集是 8-01..8-31 —— 多出来的那一天**就是**
  //    「累积」本身。写 30 会掩盖掉这个模块唯一要做的事。
  eq(merged.days.length, 31, '两次窗口并集 = 31 天（累积生效）');
  eq(merged.days[0]!.date, '2026-08-01', '最早的一天还是 8-01 —— 没有被窗口挤掉');
  eq(merged.days[30]!.date, '2026-08-31', '最新的一天是 8-31');

  // ⚠️ 换成一个真的会丢数据的版本，确认断言不是恒真。
  const naive = { days: [...shifted] };
  ok(!naive.days.some((d) => d.date === '2026-08-01'), '负向对照：原样覆盖确实会丢掉 8-01');
}

// ─────────────────────────────────────────────────────────────
section('② 同一天，新的赢');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  await push(s, [day('2026-09-24', { steps: 3000, calories: 120 })]);
  await push(s, [day('2026-09-24', { steps: 12000, calories: 500 })]);

  const m = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  eq(m.days.length, 1, '还是同一天，没有多出一条');
  // ⚠️ 负向对照：让「已存的赢」—— 这条会停在 3000。
  //    今天在过完之前是不完整的，冻结在早上 9 点的数字是本文件里最容易
  //    看错的一个错答案：3000 步看起来很合理。
  eq(m.days[0]!.steps, 12000, '当天步数被 21:00 的推送更新到 12000');
}

// ─────────────────────────────────────────────────────────────
section('③ 新数据缺的字段，保留旧的');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  await push(s, [day('2026-09-24', { steps: 5000, restingHr: 58, spo2Pct: 97.2 })]);
  await push(s, [day('2026-09-24', { steps: 6000 })]);

  const m = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  eq(m.days[0]!.steps, 6000, '步数更新');
  eq(m.days[0]!.restingHr, 58, '这次没读到的静息心率被保留');
  eq(m.days[0]!.spo2Pct, 97.2, '这次没读到的血氧被保留');
}

// ─────────────────────────────────────────────────────────────
section('④ 0 不是「缺失」');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  await push(s, [day('2026-09-24', { steps: 5000 })]);
  await push(s, [day('2026-09-24', { steps: 0 })]);
  const m = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  // ⚠️ 把 0 当成空洞，就会让旧的 5000 永远赖在那一天 —— 一个不会被
  //    任何后续同步纠正的数字。手表没戴是真的 0。
  eq(m.days[0]!.steps, 0, '真的 0 覆盖掉 5000，而不是被当成缺失');

  const s2 = memStore();
  await push(s2, [day('2026-09-24', { steps: 5000 })]);
  await push(s2, [day('2026-09-24', { steps: null as unknown as number })]);
  const m2 = HealthRawSchema.parse(JSON.parse(s2.files.merged!));
  eq(m2.days[0]!.steps, 5000, 'null 才算缺失，保留旧值');
}

// ─────────────────────────────────────────────────────────────
section('⑤ 心跳在「数据没变」时也要动');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  await push(s, [day('2026-09-24', { steps: 5000 })]);
  const beat1 = s.files.heartbeat;
  ok(!!beat1, '第一次推送写了心跳');

  // ⚠️ 负向对照：把 handleHealthIngest 里 `await store.writeHeartbeat(...)`
  //    那一行挪到 `if (!changed) return ...` 之后，这条必须 FAIL。
  //    理由和 CAPPERR 一样：「手机来过」和「数字变了」是两件事，
  //    而只有后者能在数据里看见。没有心跳，一次正常同步看起来就是坏的。
  const s2 = memStore();
  await push(s2, [day('2026-09-24', { steps: 5000 })]);
  const before = s2.files.heartbeat;
  const r = await push(s2, [day('2026-09-24', { steps: 5000 })]);
  eq(r.body.status, 'unchanged', '同样内容再推 → unchanged');
  ok(!!s2.files.heartbeat, 'unchanged 也写了心跳（文件存在）');
  ok(before !== undefined, '心跳文件在两次推送后都在');
}

// ─────────────────────────────────────────────────────────────
section('⑥ 发布的是「累积」的，不是「窗口」的');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  await push(s, Array.from({ length: 30 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, { steps: 1000 })));
  await push(s, Array.from({ length: 30 }, (_, i) => day(`2026-08-${String(i + 2).padStart(2, '0')}`, { steps: 1000 })));

  const indexText = await buildIndexFromStore(s);
  ok(indexText !== null, 'buildIndexFromStore 有东西可发布');
  const idx = JSON.parse(indexText!);

  // ⚠️⚠️ 这条是整个文件里最重要的一条。
  //    负向对照：把 buildIndexFromStore 改成接收 payload 并用 payload.days，
  //    它依然会返回一个看起来完全正常的 30 天数组 —— 只是少了 8-01。
  //    这就是「静默丢数据」的样子：没有错误，只有一个永远不增长的历史。
  eq(idx.dayCount, 31, 'index 有 31 天（累积，不是窗口）');
  eq(idx.days[0].date, '2026-08-01', 'index 里最早的一天是 8-01，不是窗口的第一天');

  // 负向对照（真的跑一遍）：从窗口算出来的 index 会丢掉 8-01
  const fromWindow = { dayCount: 30, first: '2026-08-02' };
  ok(fromWindow.first !== idx.days[0].date, '负向对照：用窗口算的 index 起点确实不同');
}

// ─────────────────────────────────────────────────────────────
section('⑦ 凭据 / 体积 / 格式');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  const bad = await handleHealthIngest(ENV, s, 'Bearer wrong', JSON.stringify({ schemaVersion: 1, device: 'x', exportedAt: 'y', days: [] }));
  eq(bad.status, 401, '错 token → 401');
  eq(Object.keys(s.files).length, 0, '401 之后什么都没写');

  const s2 = memStore();
  const noauth = await handleHealthIngest(ENV, s2, null, '{}');
  eq(noauth.status, 401, '没有 Authorization → 401');

  const s3 = memStore();
  const junk = await handleHealthIngest(ENV, s3, 'Bearer tok-health-test', '{not json');
  eq(junk.status, 400, '非法 JSON → 400');
  eq(Object.keys(s3.files).length, 0, '非法 JSON 不写任何文件');

  const s4 = memStore();
  const ver = await push(s4, [day('2026-09-24', { steps: 1 })], { schemaVersion: 2 });
  eq(ver.status, 400, 'schemaVersion 不是 1 → 400');

  const s5 = memStore();
  const badDate = await push(s5, [day('2026/09/24', { steps: 1 })]);
  eq(badDate.status, 400, '日期格式不对 → 400');

  const s6 = memStore();
  const big = await handleHealthIngest(
    // ⚠️ 10，不是 200：payload 本身只有 88 字节，200 的话它**没超**，
    //    这条断言就变成了在测「一个正常请求返回 202」。
    { ...ENV, maxBytes: 10 }, s6, 'Bearer tok-health-test',
    JSON.stringify({ schemaVersion: 1, device: 'x', exportedAt: 'y', days: [{ date: '2026-09-24', steps: 1 }] }),
  );
  eq(big.status, 413, '超过 maxBytes → 413');

  // ⚠️ 读不出 merged 时不能把推送也拒了 —— 手机手上那 14 天是唯一的，
  //    为了保住一个读不出来的文件而丢掉它，是错的取舍。
  const s7 = memStore();
  s7.files.merged = '{corrupt';
  const r7 = await push(s7, [day('2026-09-24', { steps: 42 })]);
  eq(r7.status, 202, 'merged 损坏时仍然接受推送');
  const m7 = HealthRawSchema.parse(JSON.parse(s7.files.merged!));
  eq(m7.days[0]!.steps, 42, '损坏的旧文件被新数据取代');
}

// ─────────────────────────────────────────────────────────────
section('⑧ 合并本身（不经 HTTP）');
// ─────────────────────────────────────────────────────────────
{
  const { days } = mergeDays(
    [day('2026-09-01', { steps: 1 }), day('2026-09-03', { steps: 3 })],
    [day('2026-09-02', { steps: 2 }), day('2026-09-03', { steps: 3 })],
  );
  eq(days.map((d) => d.date), ['2026-09-01', '2026-09-02', '2026-09-03'], '补进来的日期按顺序插到位');

  // ⚠️ 没有变化就必须报 changed=false，否则每 15 分钟一次 GitHub 提交。
  const same = mergeDays(
    [day('2026-09-01', { steps: 1 }), day('2026-09-03', { steps: 3 })],
    [day('2026-09-01', { steps: 1 }), day('2026-09-03', { steps: 3 })],
  );
  eq(same.changed, false, '内容完全一样 → changed=false（不产生空提交）');

  // ⚠️ 键顺序不同、内容相同 —— 必须**也**是 false。
  //    负向对照：把 canonical() 换回 JSON.stringify，这条会 FAIL。
  //    这是 CAPPERR 那个「每 30 分钟一个空 commit」的坑从这里进来的一条路。
  const reordered = mergeDays(
    [{ date: '2026-09-01', steps: 1, restingHr: 60 } as HealthDay],
    [{ restingHr: 60, steps: 1, date: '2026-09-01' } as HealthDay],
  );
  eq(reordered.changed, false, '同样的键值、不同的键顺序 → 仍然 changed=false');
  ok(
    JSON.stringify({ a: 1, b: 2 }) !== JSON.stringify({ b: 2, a: 1 }),
    '负向对照：裸 JSON.stringify 确实对键顺序敏感',
  );

  const c2 = mergeDays([day('2026-09-01', { steps: 1 })], [day('2026-09-01', { steps: 2 })]);
  eq(c2.changed, true, '数值变了 → changed=true');

  const c3 = mergeDays([], []);
  eq(c3.changed, false, '两边都空 → changed=false');
}

// ─────────────────────────────────────────────────────────────
section('⑨ 汇总只对「有该指标的天」求平均');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  // 30 天里只有 3 天有静息心率。对全部 30 天求平均会得到一个又错又不起眼的数。
  // ⚠️ 负向对照：把 restingHr7d 的算法改成除以 7，它会从 60 变成 25.7。
  await push(s, [
    day('2026-09-22', { restingHr: 60 }),
    day('2026-09-23', { restingHr: 60 }),
    day('2026-09-24', { restingHr: 60 }),
    ...Array.from({ length: 27 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, { steps: 1 })),
  ]);
  const idx = JSON.parse((await buildIndexFromStore(s))!);
  eq(idx.totals.restingHr7d, 60, '7 天静息心率 = 60（只对 3 个有数据的天求平均）');
  eq(idx.totals.stepsToday, null, '今天没有步数 → null，不是 0');
  eq(idx.totals.steps7d, 0, '7 天步数：只有一天有，且那天的 steps 是 undefined → 0');
}

// ─────────────────────────────────────────────────────────────
section('⑩ 发布出去的是密文，不是明文');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  await push(s, [day('2026-09-24', { steps: 12345, restingHr: 58, spo2Pct: 97.2, weightKg: 71.5 })]);
  const plain = (await buildIndexFromStore(s))!;

  // 没有口令 → 什么都不发布，绝不降级成明文
  const noPass = await buildSealedIndexFromStore(s, null);
  ok(!('sealed' in noPass), '没配口令 → 不发布（不是发布明文）');

  const sealed = await buildSealedIndexFromStore(s, 'correct horse battery staple');
  ok('sealed' in sealed, '有口令 → 发布密文');
  const body = ('sealed' in sealed ? sealed.sealed : '') as string;
  const env = JSON.parse(body);

  eq(env.v, 1, '信封带版本号'); 
  eq(env.kdf, 'PBKDF2-SHA256', '信封带 KDF');
  eq(env.iter, 200000, '信封带迭代次数（读的人不必猜）');
  ok(!!env.salt && !!env.iv && !!env.ct, 'salt / iv / ct 都在');

  // ⚠️⚠️ 唯一真正重要的断言：密文里不能出现明文。
  //    负向对照：把 sealIndex 换成「直接返回 plaintext」，下面每一条都会 FAIL。
  ok(!body.includes('12345'), '密文里没有步数 12345');
  ok(!body.includes('restingHr'), '密文里没有字段名 restingHr');
  ok(!body.includes('2026-09-24'), '密文里没有日期');
  ok(!body.includes('weightKg'), '密文里没有体重字段名');
  // 确认我们检查的确实是「不该出现的明文」（而不是这条断言恒真）
  ok(plain.includes('12345') && plain.includes('restingHr'), '负向对照：明文里这些确实都在');

  // ⚠️ 同一个明文加密两次必须不同 —— salt 和 IV 都要是新的。
  //    IV 复用是 AES-GCM 唯一不能犯的错。
  const again = JSON.parse((await sealIndex(plain, 'correct horse battery staple')));
  ok(again.salt !== env.salt, '两次加密的 salt 不同');
  ok(again.iv !== env.iv, '两次加密的 IV 不同');
  ok(again.ct !== env.ct, '两次加密的密文不同');
}

// ─────────────────────────────────────────────────────────────
section('⑪ 会话进得了 index，走路被挡在外面');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  const r = await handleHealthIngest(
    ENV, s, 'Bearer tok-health-test',
    JSON.stringify({
      schemaVersion: 1, device: 'health-connect', exportedAt: '2026-09-24T17:00+08:00',
      days: [day('2026-09-24', { steps: 100 })],
      sessions: [
        { start: '2026-09-20T18:58+08:00', minutes: 62, type: 'BIKING', exerciseType: 8,
          source: 'com.google.android.apps.fitness', hrAvg: 149, hrMax: 173 },
        { start: '2026-09-08T08:26+08:00', minutes: 25, type: 'WALKING', exerciseType: 79,
          source: 'nl.appyhapps.healthsync' },
      ],
      ridingNow: true,
    }),
  );
  eq(r.status, 202, '带会话的推送被接受');

  const idx = JSON.parse((await buildIndexFromStore(s))!);

  // ⚠️⚠️ 这条是 2026-09-24 那个真 bug 的回归测试。
  //    当时 `server.ts` 传了 sessions，而 `buildIndexFromStore` 没传 ——
  //    手机发了 58 条会话，发布出去的 index 里 sessions 是空的，
  //    而且**没有任何报错**：两个调用点都合法，只是一个少传了带默认值的参数。
  //    负向对照：把 buildIndexFromStore 里那两个参数删掉，这条必须 FAIL。
  eq(idx.sessions.length, 1, '★ 会话真的进了 index（这次漏传过，回归测试守在这里）');
  eq(idx.sessions[0].type, 'BIKING', '留档的是骑行那条');
  eq(idx.sessions[0].hrAvg, 149, '骑行的心率带上了');
  ok(!idx.sessions.some((x: { type: string }) => x.type === 'WALKING'),
     '走路被挡在 index 外面');
  eq(idx.ridingNow, true, 'ridingNow 传到了 index');

  // ⚠️ 但走路**必须还在合并存储里** —— 读者的要求是「获取但不显示」。
  //    在存储这一层删掉，就等于把「以后想改主意」的路也一起删了。
  const merged = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  eq(merged.sessions!.length, 2, '存储里两条都在（走路只是不显示，不是不要）');
}

// ─────────────────────────────────────────────────────────────
section('⑫ 运动明细变了也必须算「变了」');
// ─────────────────────────────────────────────────────────────
{
  const s = memStore();
  const base = {
    schemaVersion: 1 as const, device: 'health-connect', exportedAt: '2026-09-24T17:00+08:00',
    days: [day('2026-09-24', { steps: 100 })],
  };
  const sess = (extra: Record<string, unknown>) => ({
    start: '2026-09-23T18:44+08:00', minutes: 63, type: 'BIKING', exerciseType: 8,
    source: 'nl.appyhapps.healthsync', ...extra,
  });

  const r1 = await handleHealthIngest(ENV, s, 'Bearer tok-health-test',
    JSON.stringify({ ...base, sessions: [sess({})] }));
  eq(r1.status, 202, '第一次带会话 → committed');

  // ⚠️⚠️ 这一条是 2026-09-24 那个真 bug 的回归测试。
  //    当时 `changed` 只看 days，于是运动明细从无到有、心率曲线加上去，
  //    服务端都回 200「unchanged」并且什么都不写 ——
  //    手机收到成功码、日志写正常状态、页面上就是少字段。
  //    负向对照：把 changed 改回 `daysChanged`，这条会 FAIL 成 200。
  const r2 = await handleHealthIngest(ENV, s, 'Bearer tok-health-test',
    JSON.stringify({ ...base, sessions: [sess({ hrSeries: [[0, 90], [30, 150], [62, 182]] })] }));
  eq(r2.status, 202, '★ 只改会话内容（加心率曲线）→ 必须也算 changed');
  eq(r2.body.status, 'committed', '★ 而且真的提交了');

  const m = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  eq(m.sessions![0]!.hrSeries!.length, 3, '心率曲线真的落盘了');
  eq(m.sessions![0]!.hrSeries![2]![1], 182, '峰值那一点在');

  // 完全一样再推 → 这次才是 unchanged，否则每 15 分钟一个空提交
  const r3 = await handleHealthIngest(ENV, s, 'Bearer tok-health-test',
    JSON.stringify({ ...base, sessions: [sess({ hrSeries: [[0, 90], [30, 150], [62, 182]] })] }));
  eq(r3.status, 200, '内容真的没变 → unchanged（不产生空提交）');
}

// ─────────────────────────────────────────────────────────────
section('⑫b ⚠️⚠️ 富化失败的那一轮**不能**把已经存好的过程序列清掉');
// ─────────────────────────────────────────────────────────────
//
// ⚠️⚠️ 这是 2026-09-30 查出来的真 bug 的回归测试，而它的形状值得单独说：
//
//    `hrSeries` / `powerSeries` / `cadenceSeries` 是手机对这场运动的时间窗
//    **单独读一次**得来的 —— schema 自己的注释就写着 "each of which can come
//    back empty"。那一次读失败时，手机发的这条**没有**这些键。
//
//    而 `mergeSessions` 原来是「窗口内整表替换」，于是**一次读失败 = 永久丢失
//    那场的曲线**，而且零报错、返回 202「成功」。
//
//    实测代价：本地那份快照 25/25 场都有心率序列（点数 = 时长 + 1），
//    线上 30 场里只剩 4 场 —— 同一场（09-13 15:12 骑行 44 分）
//    本地 45 点、线上一！个！都！没！有。
//
//    ⚠️ 修法是把 `mergeSessions` 的语义**和 `mergeDay` 对齐**：
//      「哪些场次存在」以 incoming 为准，「每一场有哪些字段」用 stored 打底。
//      两套语义并存正是长出这个 bug 的原因。
//
//    ⚠️⚠️ 负向对照：把 `mergeSessions` 改回「整表替换」，这条当场 FAIL。
{
  const s = memStore();
  const base = {
    schemaVersion: 1 as const, device: 'health-connect', exportedAt: '2026-09-24T17:00+08:00',
    days: [day('2026-09-24', { steps: 100 })],
  };
  const sess = (extra: Record<string, unknown>) => ({
    start: '2026-09-23T18:44+08:00', minutes: 63, type: 'BIKING', exerciseType: 8,
    source: 'nl.appyhapps.healthsync', ...extra,
  });

  // 第一轮：带序列
  await handleHealthIngest(ENV, s, 'Bearer tok-health-test',
    JSON.stringify({ ...base, sessions: [sess({ hrSeries: [[0, 90], [30, 150]], powerSeries: [[0, 200], [30, 260]] })] }));

  // 第二轮：同一场，但这一轮富化**失败了**（没有 hrSeries / powerSeries），
  //        只有汇总值。窗口内有这一场 ⇒ 场次本身当然要留。
  const r = await handleHealthIngest(ENV, s, 'Bearer tok-health-test',
    JSON.stringify({ ...base, sessions: [sess({ hrAvg: 135 })] }));

  const m = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  eq(m.sessions!.length, 1, '这一场还在（窗口内以 incoming 为准）');
  eq(m.sessions![0]!.hrAvg, 135, '这一轮的汇总值是新的');
  eq(m.sessions![0]!.hrSeries?.length, 2, '★ 上一轮存的心率序列**没有被清掉**');
  eq(m.sessions![0]!.powerSeries?.length, 2, '★ 功率序列也没有被清掉');
  void r;

  // ⚠️ 反过来也要成立：手机显式发空数组 = 「这里确实没有」⇒ 以它为准。
  //    不然就从一个 bug 翻到另一个 bug（永远删不掉的东西）。
  await handleHealthIngest(ENV, s, 'Bearer tok-health-test',
    JSON.stringify({ ...base, sessions: [sess({ hrSeries: [] })] }));
  const m2 = HealthRawSchema.parse(JSON.parse(s.files.merged!));
  eq(m2.sessions![0]!.hrSeries?.length, 0, '显式空数组 ⇒ 以 incoming 为准（能删掉）');
}

// ─────────────────────────────────────────────────────────────
section('⑬ 保留期：超过一个月的删掉，但绝不按墙上时钟删');
// ─────────────────────────────────────────────────────────────
{
  // 造 100 天，看只剩最近 31 天
  const many = Array.from({ length: 100 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return day(d, { steps: 1000 });
  });
  const sessions = [
    { start: '2026-06-05T10:00+08:00', minutes: 30, type: 'BIKING', exerciseType: 8, source: 'x' },
    { start: '2026-09-05T10:00+08:00', minutes: 30, type: 'BIKING', exerciseType: 8, source: 'x' },
  ];
  const r = pruneOld(many, sessions, 31);
  eq(r.days.length, 31, '只留最近 31 天');
  eq(r.droppedDays, 69, '删掉 69 天');
  eq(r.cutoff, '2026-08-09', '截止日是「最新那天减 30」（2026-09-08）');
  eq(r.sessions.length, 1, '运动明细也按同一个截止日裁剪');
  eq(r.sessions[0]!.start.slice(0, 10), '2026-09-05', '留下的是九月那条');

  // ⚠️⚠️ 最关键的一条：截止日跟着**数据**走，不跟着当前时间走。
  //    一份停在三个月前的数据，跑完保留期必须**一天都没少** ——
  //    否则手机停同步一段时间，服务器会把自己清空，那是备份的反面。
  //    负向对照：把 frontier 换成 `new Date()`，这条会 FAIL（100 天全删光）。
  const stale = Array.from({ length: 20 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return day(d, { steps: 10 });
  });
  const r2 = pruneOld(stale, [], 31);
  eq(r2.days.length, 20, '★ 三个月没更新的数据，一条都没被删');
  eq(r2.droppedDays, 0, '★ 而且报告说没删任何东西');

  // 空输入不该炸
  const r3 = pruneOld([], [], 31);
  eq(r3.days.length, 0, '空输入返回空');
  eq(r3.cutoff, null, '空输入没有截止日');
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  for (const f of failures) console.error(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} 条全部通过`);
