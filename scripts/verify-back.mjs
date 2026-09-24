/**
 * The back button, driven for real on the built bundle.
 *
 *   bun scripts/verify-back.mjs [base-url]
 *
 * ⚠️ Why this is separate from verify-paperr-ui.mjs. That script loads the
 * CAPPERR route DIRECTLY and never leaves it, so the back control — the one
 * thing that only exists as a transition between two pages — was never
 * exercised by any assertion in this repo. The reader reported it broken twice.
 *
 * ⚠️ Three arrivals, because they go through different code:
 *   · pushed from the index   → there IS a stack to pop
 *   · deep-linked cold        → stack depth 1, the handler must push the index
 *   · after a browser refresh → Taro's stack is rebuilt from the URL alone
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8098';
const OUT = '/tmp/paperr-ui';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const hash = (p) => p.evaluate(() => window.location.hash);

/**
 * A HARD load.
 *
 * ⚠️ `page.goto()` to a URL that differs only in the hash is a SAME-DOCUMENT
 * navigation — it does not reload. The previous page stays mounted underneath
 * and Taro's stack keeps growing, so `page.goto('#/pages/paperr/index')` right
 * after a visit to the index gives you the index AND a paperr page, and every
 * later count is doubled. The first version of this script did exactly that and
 * reported 72 shelf rows for a 36-row shelf.
 *
 * `about:blank` in between forces a real document load.
 */
async function hardLoad(p, url) {
  await p.goto('about:blank');
  await p.goto(url, { waitUntil: 'domcontentloaded' });
}

async function backVisible(p) {
  return (await p.locator('.topbar__back').count()) > 0;
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

// ── Arrival 1: pushed from the index ────────────────────────
console.log('\n── 从主页点进 CAPPERR，再按返回 ──');
await hardLoad(page, `${BASE}/#/pages/home/index`);
await page.waitForSelector('.home-paperr', { timeout: 20000 });
await page.waitForTimeout(600);

// The home page links to CAPPERR — drive that link, do not type the URL.
const link = page.locator('.home-paperr');
await link.click();
await page.waitForSelector('.pr-row', { timeout: 20000 });
await page.waitForTimeout(900);
check('主页的 CAPPERR 区块点得进 CAPPERR 页', (await hash(page)).includes('paperr'), await hash(page));

check('CAPPERR 页有返回键', await backVisible(page));
// ⚠️ The shelf is 36 rows. Finding 72 means two CAPPERR pages are mounted at
// once — which is not cosmetic: each extra copy is another entry on Taro's
// stack, so the back control needs that many more presses to leave the page.
// That is what "返回键还有问题" turned out to be.
check('CAPPERR 页在 DOM 里只有一份', (await page.locator('.pr-row').count()) === 36,
      `rows=${await page.locator('.pr-row').count()}`);
await page.locator('.topbar__back').click();
await page.waitForTimeout(1200);
const afterBack = await hash(page);
check('按返回回到主页', afterBack.includes('home'), afterBack);
check('回到主页后主页内容真的在', (await page.locator('.home-paperr').count()) > 0);

// ── Arrival 2: deep link, cold ──────────────────────────────
console.log('\n── 冷启动直接打开 CAPPERR，再按返回 ──');
await hardLoad(page, `${BASE}/#/pages/paperr/index`);
await page.waitForSelector('.pr-row', { timeout: 20000 });
await page.waitForTimeout(900);
check('深链进来也有返回键', await backVisible(page));
await page.locator('.topbar__back').click();
await page.waitForTimeout(1400);
const deep = await hash(page);
check('深链按返回也能离开 CAPPERR', !deep.includes('paperr'), deep);

// ── Arrival 3: refresh, then back ───────────────────────────
console.log('\n── 从主页进 CAPPERR，刷新后按返回 ──');
await hardLoad(page, `${BASE}/#/pages/home/index`);
await page.waitForSelector('.home-paperr', { timeout: 20000 });
await page.locator('.home-paperr').click();
await page.waitForSelector('.pr-row', { timeout: 20000 });
await page.waitForTimeout(800);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pr-row', { timeout: 20000 });
await page.waitForTimeout(900);
await page.locator('.topbar__back').click();
await page.waitForTimeout(1400);
const ref = await hash(page);
check('刷新后按返回也能离开 CAPPERR', !ref.includes('paperr'), ref);

check('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

await page.screenshot({ path: `${OUT}/back.png` });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.log('\n失败项:'); for (const f of failed) console.log(`  · ${f.name}  ${f.detail}`); process.exit(1); }
