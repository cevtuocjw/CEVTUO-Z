/**
 * 线上 HTTPS 站点的实测检查。
 *
 *   bun scripts/verify-https-live.mjs [base-url]
 *
 * ⚠️⚠️ 这个脚本存在的唯一理由：**本地跑通不代表线上跑通**，而这里有一个
 * 具体的、已经骗过一次人的机制。
 *
 * `http://127.0.0.1:8096` 是**安全上下文**。于是：
 *   - `crypto.subtle` 在本地永远可用，在纯 HTTP 线上永远是 `undefined`；
 *   - 混合内容拦截在本地**根本不触发** —— 一个 http 页面去 fetch
 *     `http://120.77.27.128:8789` 完全合法，而在 https 页面上会被浏览器
 *     在 CORS 之前就掐死。
 *
 * 第二条正是 2026-09-28 那次改动的全部内容：站点开 HTTPS 之后，两个心跳
 * （CAPPERR / CHEALTH）如果还指着明文 HTTP，会被静默杀死 ——
 * 而 `fetchPaperrHeartbeat` / `fetchChealthHeartbeat` 都是
 * `catch { return null }`，症状只有页面上两个「—」和零报错。
 *
 * ⚠️ 所以这里必须驱动**真实域名上的真实页面**，不能用 127.0.0.1 代替。
 *
 * 环境依赖：能解析到 GitHub Pages 的 `apps.cevtuogrnd.com`，以及阿里云那台
 * 的 `api.cevtuogrnd.com:8443`。不依赖本机任何服务。
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

// ⚠️ 仪表盘从 2026-09-28 起在 `z.cevtuogrnd.com` **根路径**上 —— 项目站
// 一旦声明自定义域名，GitHub 就把它搬离 `/CEVTUO-Z/`。
// 旧的 `apps.cevtuogrnd.com/CEVTUO-Z/` 会 301 过来（GitHub 自动做的），
// 所以老地址也能跑，但断言「页面是哪个 origin」时会拿到重定向之后的那个。
const BASE = process.argv[2] ?? 'https://z.cevtuogrnd.com';

/**
 * CHEALTH 页面要在「解锁态」下驱动，否则它渲染的是口令输入框，
 * 密文索引那条路根本没被走到。
 * ⚠️ 拿不到口令时**不静默跳过** —— 见下面的 check，它会报 FAIL 并说明原因。
 */
const PASS = (() => {
  try {
    const key = 'CEVTUO_HEALTH_PASSPHRASE=';
    const p = new URL('../services/ingest/.env.server-backup', import.meta.url);
    const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(key));
    return line ? line.slice(key.length).trim() : '';
  } catch {
    return '';
  }
})();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const failed = [];
const consoleErrors = [];
const apiHits = [];

// ⚠️ `requestfailed` 和 `response` 分开收：混合内容**不产生响应**，
// 它连状态码都没有。只看 status 会把「被拦掉」误读成「没发请求」。
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText ?? '?'} ${r.url().slice(0, 90)}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)); });
page.on('response', (r) => {
  if (r.url().includes('/api/')) apiHits.push({ url: r.url(), status: r.status() });
});

// ── CAPPERR ───────────────────────────────────────────────────
await page.goto(`${BASE}/#/pages/paperr/index`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pr-row', { timeout: 30000 });
// ⚠️ 心跳在挂载时拉取，而上面的 goto 就已经挂载完了 —— 必须重新加载，
// 否则监听器看不到那次请求，检查会以为自己坏了。
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pr-row', { timeout: 30000 });
await page.waitForTimeout(2500);

const origin = await page.evaluate(() => location.origin);
check('页面真的是 HTTPS 源', origin.startsWith('https://'), origin);
check('CAPPERR 书架渲染出来了', (await page.locator('.pr-row').count()) > 0,
      `rows=${await page.locator('.pr-row').count()}`);

// ── CHEALTH（解锁态）──────────────────────────────────────────
if (!PASS) {
  check('CHEALTH 解锁态检查（缺口令，无法进行）', false,
        'services/ingest/.env.server-backup 里没有 CEVTUO_HEALTH_PASSPHRASE');
} else {
  await page.goto(`${BASE}/#/pages/chealth/index?k=${PASS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card__label', { timeout: 30000 });
  await page.waitForTimeout(2500);
  check('CHEALTH 页面渲染出来了（密文索引解开了）',
        (await page.locator('.card__label').count()) > 0,
        `cards=${await page.locator('.card__label').count()}`);
}

// ── 两个心跳 ──────────────────────────────────────────────────
// ⚠️ 断言的落点是「**这个页面发出的**请求拿到了 200」，不是「某个地址可用」。
for (const [name, frag] of [['CAPPERR', '/api/paperr/heartbeat.json'],
                            ['CHEALTH', '/api/chealth/heartbeat.json']]) {
  const hit = apiHits.find((h) => h.url.includes(frag));
  if (!hit) {
    check(`${name} 心跳：页面确实发出了请求`, false, '根本没有观察到这次请求（被拦？被删？）');
    continue;
  }
  check(`${name} 心跳拿到 200`, hit.status === 200, `${hit.status} ${hit.url.slice(0, 64)}`);
  // ⚠️ 这一条是这次改动本身。明文 HTTP 在 HTTPS 页面上必被掐死。
  check(`${name} 心跳走的是 HTTPS`, hit.url.startsWith('https://'), hit.url.slice(0, 70));
}

// ── 不该有的东西 ──────────────────────────────────────────────
check('没有请求失败（混合内容会在这里现形）', failed.length === 0, failed.slice(0, 2).join(' | '));
check('没有控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

// ⚠️ 只报告，不断言。它是**信息**：站点从 HTTP 变 HTTPS 之后 crypto.subtle
// 才出现，`health-crypto.ts` 里"不能用 WebCrypto"那段注释的前提因此变了 ——
// 但那段纯 JS 实现依然正确，所以这不该让套件变红。
console.log(`\n  ℹ️  crypto.subtle 在本页是 ${await page.evaluate(() => typeof crypto.subtle)}` +
            `（HTTP 站点上会是 undefined）`);

await browser.close();

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
if (bad.length) {
  console.log('失败项:');
  bad.forEach((r) => console.log(`  · ${r.name}`));
  process.exit(1);
}
