/**
 * CHEALTH 的**数据面**断言 —— 解封线上索引直接查，不需要浏览器。
 *
 *   bun scripts/verify-chealth-data.mjs [base-url]
 *
 * ⚠️ 为什么要有这个文件。
 *
 * CHEALTH 一直**只有页面级检查**：`verify-https-live.mjs` 验它「能渲染」、
 * `verify-paperr-ui.mjs` 验它「数据陈旧时会警告」—— 而**没有任何一条断言在看
 * 数据本身**。2026-09-28 为了「同一场骑行在页面上出现两行」查了很久，最后是靠
 * 在手机上跑探针才看到原始记录；而那个问题**在数据里一眼就能看出来**，
 * 根本不需要浏览器。
 *
 * ⚠️⚠️ 所有判据都从**规则**推导，**不写死日期**。
 *
 * 写死日期是这个项目已经踩过的坑：夹具抄了「今天的数据恰好如此」，于是断言测的
 * 是日历而不是规则 —— 数据一修好，测试反而红了。
 * 这里查的是「任意两场会话不得大幅重叠」，那正是手机端去重**声称**做到的事，
 * 和今天是哪天无关。
 *
 * ⚠️ 这个脚本查的是**已经上传的**那份索引，所以它同时也在验手机端的改动有没有
 * 真的部署出去。手机上报 → 阿里云 → gh-pages → CDN 最多要十分钟；
 * 刚推完就红，先看心跳时间，别急着改代码。
 */

import { readFileSync } from 'node:fs';
// ⚠️ 用应用自己那个解封函数，不在这里重写一份。重写一份就可能和页面解出不同的
// 结果，而测试照样绿 —— 这个项目在 CAPPERR 的字数统计上正是这么吃过亏的
// （127 对 109，两边都不报错）。
import { openSealed } from '../apps/dashboard/src/platform/health-crypto.ts';

const BASE = (process.argv[2] ?? 'https://z.cevtuogrnd.com').replace(/\/$/, '');

/**
 * ⚠️⚠️ 心跳**不在 Pages 站点上**，在 ingest 服务那边。
 *
 * 我第一版写的是 `${BASE}/data/chealth/heartbeat.json` —— 那个路径不存在，
 * Pages 对未知路径回的是 `index.html`，于是 `res.json()` 抛
 * 「Unrecognized token '<'」。**它看起来像心跳坏了，其实是我地址写错了。**
 * 一个报错指向错误的地方，比不报错更费时间。
 *
 * `verify-https-live.mjs` 量的一直是 `api.cevtuogrnd.com:8443` 那个，照抄它。
 */
const HEARTBEAT =
  process.env.CHEALTH_HEARTBEAT ?? 'https://api.cevtuogrnd.com:8443/api/chealth/heartbeat.json';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * ⚠️ 缺口令 ⇒ **大声失败**，不是跳过。
 *
 * `verify-paperr-ui.mjs` 那边的做法是「跳过并说明」，因为它查的是页面，
 * 口令只是解锁手段、不是被测对象。这里不一样：索引是**加密的**，
 * 没有口令就什么都查不了 —— 那等于这个脚本什么都没验。
 * 静默通过会让「读不到密钥」看起来像「数据没问题」。
 */
const PASS = (() => {
  try {
    const key = 'CEVTUO_HEALTH_PASSPHRASE=';
    const p = new URL('../services/ingest/.env.server-backup', import.meta.url);
    const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(key));
    return line ? line.slice(key.length).trim() : null;
  } catch {
    return null;
  }
})();

if (!PASS) {
  check('能拿到索引口令', false, 'services/ingest/.env.server-backup 里读不到 CEVTUO_HEALTH_PASSPHRASE');
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(1);
}

console.log(`\nCHEALTH 数据面 · ${BASE}\n`);

// ── 心跳 ───────────────────────────────────────────────────────────────
let beat = null;
try {
  const res = await fetch(HEARTBEAT, { cache: 'no-store' });
  beat = await res.json();
  check('心跳拿到 200', res.status === 200, `HTTP ${res.status}`);
} catch (e) {
  check('心跳拿到 200', false, String(e.message ?? e));
}

// ── 索引 ───────────────────────────────────────────────────────────────
let idx = null;
let sealedBytes = 0;
try {
  const res = await fetch(`${BASE}/data/chealth/index.json`, { cache: 'no-store' });
  const sealed = await res.text();
  sealedBytes = sealed.length;
  idx = JSON.parse(openSealed(sealed, PASS));
  check('索引能解开', true, `${idx.dayCount} 天 / ${idx.sessions?.length ?? 0} 场会话 / ${sealedBytes} 字节密文`);
} catch (e) {
  check('索引能解开', false, String(e.message ?? e));
}

if (idx) {
  // ⚠️ 心跳和数据必须说同一天。差一天是正常的（跨零点），差几天就是链路断了。
  if (beat) {
    /**
 * ⚠️⚠️ **心跳永远是线上的**（`HEARTBEAT` 写死指向 `api.cevtuogrnd.com:8443`），
 *    而索引跟着 `BASE` 走。所以用**本地** base 跑的时候，
 *    「索引 to」（本地那份，可能是几天前导出的）和「心跳 to」（线上的）
 *    **本来就不该相等** —— 这不是产品的问题，是**两个来源被拿来比**。
 *
 *    ⇒ 本地 base 下**显式跳过并说明**，不报红。
 *      ⚠️ 是「跳过并说明」，不是「让它通过」—— 静默通过和真的对上是两件事，
 *        而这个项目最怕的就是这两件事长得一样。
 */
const LOCAL_BASE = /127\.0\.0\.1|localhost/.test(BASE);
if (LOCAL_BASE) {
  console.log(
    `  SKIP  心跳的日期与索引一致  — 本地 base 下不可比（心跳取自线上的 ` +
      `${new URL(HEARTBEAT).host}，索引取自 ${BASE}），改跑线上 base 才有意义`,
  );
} else {
check(
        '心跳的日期与索引一致',
        beat.to === idx.to,
        `索引 to=${idx.to} / 心跳 to=${beat.to}`,
      );
}
  }

  const sessions = idx.sessions ?? [];
  check('有会话数据', sessions.length > 0, `${sessions.length} 场`);

  // ── 判据一：Google Fit 不许出现在会话里 ────────────────────────────
  //
  // 读者 2026-09-28 决定把 Google Fit 当成不存在。它会和 healthsync 各写
  // 一条**同一场活动**的记录，而且类型名都可能不同（「骑行」对「室内骑行」），
  // 所以任何「类型相等才去重」的写法都拦不住。
  const GF = 'com.google.android.apps.fitness';
  const gfHits = sessions.filter((s) => s.source === GF);
  check(
    '会话里没有 Google Fit 来源',
    gfHits.length === 0,
    gfHits.length
      ? `${gfHits.length} 场来自 Google Fit，例如 ${gfHits[0].start} ${gfHits[0].type}`
      : `来源：${[...new Set(sessions.map((s) => s.source))].join(' / ')}`,
  );

  // ── 判据二：任意两场会话不得大幅重叠 ──────────────────────────────
  //
  // ⚠️⚠️ 这是**规则本身**，不是某一组数据的快照。
  //
  // 手机端 `SyncWorker.collectSessions` 声称做到了「重叠 ≥ 较短者一半就合并」。
  // 那就意味着**输出里不该存在这样的两条** —— 有的话，要么合并逻辑漏了，
  // 要么有来源没被排除。与今天是哪天无关。
  //
  // ⚠️ 阈值同样是 50%，不改成「有交集就算」：前后紧挨着的两场运动会共享几秒，
  //    那不是重复。判据要和被验的规则逐字一致，否则测的是另一件事。
  const span = (s) => {
    const t0 = Date.parse(s.start);
    return [t0, t0 + s.minutes * 60_000];
  };
  const overlaps = [];
  const ok = sessions.every((s) => Number.isFinite(Date.parse(s.start)) && s.minutes > 0);
  for (let i = 0; i < sessions.length && ok; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const [aS, aE] = span(sessions[i]);
      const [bS, bE] = span(sessions[j]);
      const ov = Math.min(aE, bE) - Math.max(aS, bS);
      if (ov <= 0) continue;
      const shorter = Math.min(aE - aS, bE - bS);
      if (shorter > 0 && ov * 2 >= shorter) {
        overlaps.push(
          `${sessions[i].start} ${sessions[i].type}(${sessions[i].source.split('.').pop()}) ↔ ` +
            `${sessions[j].start} ${sessions[j].type}(${sessions[j].source.split('.').pop()})`,
        );
      }
    }
  }
  check(
    '没有重叠超过一半的两场会话',
    overlaps.length === 0,
    overlaps.length ? `${overlaps.length} 对，例如 ${overlaps[0]}` : `${sessions.length} 场两两无大幅重叠`,
  );

  // ── 判据三：类型名不能是空或纯数字 ────────────────────────────────
  //
  // ⚠️ 2026-09-28 在手机的「②E 运动明细」探针里看到过一行 `09-25 17:52  0  11 分钟`
  //    —— 类型映射表没覆盖那个枚举值，于是页面上直接显示了原始数字。
  //    数字看起来像数据，所以它会安静地混过去；这里让它响亮一点。
  const badTypes = sessions.filter((s) => !s.type || /^\d+$/.test(s.type));
  check(
    '会话类型名不是空或纯数字',
    badTypes.length === 0,
    badTypes.length
      ? `${badTypes.length} 场，例如 ${badTypes[0].start} type="${badTypes[0].type}" (exerciseType=${badTypes[0].exerciseType})`
      : `共 ${new Set(sessions.map((s) => s.type)).size} 种类型`,
  );

  // ── 判据四：过程数据没丢 ──────────────────────────────────────────
  //
  // ⚠️ 这条是给 2026-09-28 那次回归立的：Health Sync 开始每 15 分钟同步后，
  //    给同一场骑行写了**另一个 exerciseType** 的副本，合并逻辑因此没合并，
  //    页面上的功率/踏频/速度曲线**整条消失**。而 `hrAvg` 这些汇总字段还在，
  //    所以光看「有没有数据」是发现不了的 —— 必须看**序列**。
  const withSeries = sessions.filter(
    (s) => (s.powerSeries?.length ?? 0) + (s.cadenceSeries?.length ?? 0) + (s.speedSeries?.length ?? 0) > 0,
  );
  const rides = sessions.filter((s) => s.type === 'BIKING' || s.type === 'BIKING_STATIONARY');
  check(
    '骑行会话带过程序列',
    rides.length === 0 || withSeries.length > 0,
    `${rides.length} 场骑行，其中 ${rides.filter((s) => (s.powerSeries?.length ?? 0) > 0).length} 场有功率序列`,
  );

  // ── 判据五：序列点数不超过 schema 上限 ────────────────────────────
  //
  // `SessionSchema` 给三个序列都写了 `.max(200)`。超了会被 zod **静默丢掉**
  // （`z.object` 不认识就扔），于是曲线无声消失。
  const over = sessions.filter((s) =>
    [s.powerSeries, s.cadenceSeries, s.speedSeries, s.hrSeries].some((a) => (a?.length ?? 0) > 200),
  );
  check(
    '序列点数都在 200 以内',
    over.length === 0,
    over.length ? `${over.length} 场超限，最大 ${Math.max(...over.flatMap((s) => [s.powerSeries?.length ?? 0, s.cadenceSeries?.length ?? 0, s.speedSeries?.length ?? 0, s.hrSeries?.length ?? 0]))}` : '全部合规',
  );

  console.log(
    `\n  ℹ️  数据到 ${idx.to} · 设备 ${idx.device} · app ${idx.appVersion ?? '—'} · ` +
      `上报于 ${beat?.lastPushAt ?? '—'}`,
  );
}

console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
