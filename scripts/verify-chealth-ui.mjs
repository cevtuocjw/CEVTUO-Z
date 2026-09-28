/**
 * 手机宽度下 CHEALTH 页面的版式与交互断言。
 *
 *   bun scripts/verify-chealth-ui.mjs [base-url]
 *
 * ⚠️ 为什么值得单独一个文件。
 *
 * 2026-09-28 那天在这一页上连着挖出三个**同一形状**的错，全都是
 * 「注释说 A、代码做 B、而页面看起来很正常」：
 *
 *   1. 马赛克四块的字号写死 30px，而四块的可用宽度是 144/98/53px
 *      ⇒ 三块在截断，睡眠那块的标签被切成「睡.」
 *   2. 柱状图注释写着「默认选中最后一天（= 今天）」，而 `useState` 的初值
 *      在 `days` 还是空数组时求值 ⇒ 永远停在**最老的那一天**
 *   3. 缺数据的读数是 `—`，而它在 21px 粗体下**就是一根横线**
 *      ⇒ 「活动消耗」那一格看起来像分隔线
 *
 * 三个都不是崩溃，三个都通过了类型检查，三个都能截出一张「看着还行」的图。
 * ⇒ 它们只能被**量出来的数**抓住。
 *
 * ⚠️ 所以这个文件的判据全部是**数值**（scrollWidth / clientWidth / 第几根），
 *    不是截图。截图能告诉你「看着不对」，量出来的数才能告诉你「哪里不对」。
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] ?? 'https://z.cevtuogrnd.com').replace(/\/$/, '');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const PASS = (() => {
  try {
    const key = 'CEVTUO_HEALTH_PASSPHRASE=';
    const p = new URL('../services/ingest/.env.server-backup', import.meta.url);
    const l = readFileSync(p, 'utf8').split('\n').find((x) => x.startsWith(key));
    return l ? l.slice(key.length).trim() : '';
  } catch {
    return '';
  }
})();

if (!PASS) {
  console.log('\n  FAIL  拿到口令（services/ingest/.env.server-backup）');
  console.log('\n0/1 通过\n');
  process.exit(1);
}

console.log(`\nCHEALTH 版式与交互 · ${BASE}\n`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 140));
});

await page.goto(`${BASE}/#/pages/chealth/index?k=${PASS}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

/** 页面一共几屏 —— 后面要逐屏走一遍。 */
const panels = await page.evaluate(() => {
  const s = document.querySelector('.stack');
  return s ? Math.max(1, Math.round(s.scrollHeight / s.clientHeight)) : 1;
});

// ── 逐屏：马赛克文字不许被截断 ──────────────────────────────
let tileBad = [];
let labelBad = [];
for (let i = 0; i < panels; i += 1) {
  await page.evaluate((idx) => {
    const s = document.querySelector('.stack');
    if (s) s.scrollTop = idx * s.clientHeight;
  }, i);
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => {
    const out = { values: [], labels: [] };
    for (const v of document.querySelectorAll('.chc__tile-v')) {
      const t = (v.textContent || '').trim();
      if (v.scrollWidth > v.clientWidth + 1) out.values.push(`「${t}」要 ${v.scrollWidth}px 只有 ${v.clientWidth}px`);
    }
    for (const l of document.querySelectorAll('.chc__mlabel')) {
      const t = (l.textContent || '').trim();
      if (l.scrollWidth > l.clientWidth + 1) out.labels.push(`「${t}」要 ${l.scrollWidth}px 只有 ${l.clientWidth}px`);
    }
    return out;
  });
  tileBad = tileBad.concat(r.values);
  labelBad = labelBad.concat(r.labels);
}

check('马赛克的数值不溢出它的块', tileBad.length === 0, tileBad[0] ?? '四块全部装得下');
check('马赛克的标签不被截断', labelBad.length === 0, labelBad[0] ?? '没有省略号切字');

// ── 柱状图：默认选中的必须是**最后一根**（今天） ──────────────
//
// ⚠️ 这条防的是一个具体的历史 bug：`useState(Math.max(0, days.length - 1))`
//    在 `days` 为空时求值得到 0，而 `useState` 初值只取一次 ——
//    于是「默认选中今天」这句注释从来没有生效过，选中的是 14 天前那天。
const charts = await page.evaluate(() => {
  const out = [];
  for (const rows of document.querySelectorAll('.chc__rows')) {
    const bars = [...rows.querySelectorAll('.chc__bar')];
    if (!bars.length) continue;
    const sel = bars.findIndex((b) => b.className.includes('--sel'));
    const today = bars.findIndex((b) => b.className.includes('--today'));
    out.push({
      bars: bars.length,
      sel,
      today,
      readout: (rows.querySelector('.chc__readout') || {}).textContent || '',
    });
  }
  return out;
});

check('页面上找得到柱状图', charts.length > 0, `${charts.length} 张`);

const wrongSel = charts.filter((c) => c.today >= 0 && c.sel !== c.today);
check(
  '每张柱状图默认选中的是「今天」那根',
  wrongSel.length === 0,
  wrongSel.length
    ? `${wrongSel.length} 张选错，例如选中第 ${wrongSel[0].sel} 根而今天是第 ${wrongSel[0].today} 根`
    : `${charts.length} 张全部对齐`,
);

// ── 缺数据的读数必须**像一句话**，不能是一个破折号 ────────────
//
// ⚠️ 21px 粗体的 `—` 就是一根横线。它会被读成排版，不会被读成「缺失」。
const dashes = await page.evaluate(() =>
  [...document.querySelectorAll('.chc__readout-v')]
    .map((v) => (v.textContent || '').trim())
    .filter((t) => /^[—–-]/.test(t)),
);
check(
  '缺数据没有伪装成一根横线',
  dashes.length === 0,
  dashes.length ? `${dashes.length} 处读数是破折号：${dashes[0]}` : '没有裸破折号读数',
);

/**
 * ⚠️ 本机跑的时候 ingest 心跳那条报错是**环境造成的，不是页面坏了**：
 *    `ALLOWED_ORIGINS` 里没有 `127.0.0.1`，线上有。
 *
 * ⚠️ 匹配要放宽到「Failed to load resource」：浏览器的控制台文案有两种 ——
 *    带 URL 的 CORS 说明，和不带任何 URL 的 `net::ERR_FAILED`。
 *    只匹配前者的话，本机这条断言会永远红，然后就没人看它了。
 *    （线上照样会报出来，因为 `LOCAL` 是 false。）
 */
const LOCAL = /127\.0\.0\.1|localhost/.test(BASE);
const real = errors.filter(
  (e) => !(LOCAL && /CORS|ERR_FAILED|Failed to load resource/.test(e)),
);
check('没有页面错误', real.length === 0, real[0] ?? '干净');

await browser.close();
console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
