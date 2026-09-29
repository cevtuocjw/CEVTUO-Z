/**
 * CHEALTH —— 三屏 + 七个弹窗逐张截图，并把每一张的 DOM 事实一起读回来。
 *
 *   bun scripts/shot-chealth.mjs <url> <out-dir>
 *
 * ⚠️ 为什么不是直接用 shot-panel.mjs：那个只会 scrollTop 逐屏走。
 *    2026-09-28 晚这一页改成了「三屏 + 弹窗」，**弹窗只有点开才渲染**
 *    （`Sheet` 在 `open=false` 时 `return null`）。只滚屏的话，七个弹窗
 *    一张都拍不到 —— 而它们恰好是这一轮改动的主体。
 *
 * ⚠️ 每个弹窗拍两张：**打开那一刻**，和**内容滚到底之后**。
 *    只拍第一张会漏掉「面板里的表比面板还高」这类问题 ——
 *    而 `.sheet__panel` 是 `max-height: 86vh`，长了就是内部滚动，
 *    截图上完全看不出来还有下半截。
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8125/z').replace(/\/$/, '');
const OUT = process.argv[3] ?? '/tmp/chealth';
// ⚠️ 宽度可传：桌面端（≥900px）这一页有专门的布局，只看 390px 是看不到的。
const W = Number(process.argv[4] ?? 390);
const H = Number(process.argv[5] ?? 844);
const PASS = (() => {
  try {
    const key = 'CEVTUO_HEALTH_PASSPHRASE=';
    const p = new URL('../services/ingest/.env.server-backup', import.meta.url);
    const l = readFileSync(p, 'utf8').split('\n').find((x) => x.startsWith(key));
    return l ? l.slice(key.length).trim() : '';
  } catch { return ''; }
})();

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });

await page.goto(`${BASE}/#/pages/chealth/index?k=${PASS}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

/** 每张图都附一段 DOM 事实 —— 图只说「看着不对」，数才说「哪里不对」。 */
async function facts(tag) {
  const f = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const card = q('.chc__card');
    const sheet = q('.sheet__panel');
    const body = q('.sheet__body');
    const target = q('.chc__target');
    const plot = q('.chc__plot');
    const secBody = [...document.querySelectorAll('.section__body')];
    return {
      sections: document.querySelectorAll('.section').length,
      cards: document.querySelectorAll('.chc__card').length,
      tiles: document.querySelectorAll('.chc__tile').length,
      igrid: document.querySelectorAll('.igrid__cell').length,
      charts: document.querySelectorAll('.chc__rows').length,
      cardRadius: card ? getComputedStyle(card).borderRadius : '—',
      cardPad: card ? getComputedStyle(card).padding : '—',
      labelTrack: card ? getComputedStyle(card.querySelector('.card__label') || card).letterSpacing : '—',
      sheetH: sheet ? Math.round(sheet.getBoundingClientRect().height) : 0,
      sheetMax: sheet ? getComputedStyle(sheet).maxHeight : '—',
      sheetOverflow: sheet && body ? body.scrollHeight - body.clientHeight : 0,
      targetBottom: target ? getComputedStyle(target).bottom : '—',
      plotPos: plot ? getComputedStyle(plot).position : '—',
      targetBottomPx: target && plot
        ? Math.round(target.getBoundingClientRect().bottom - plot.getBoundingClientRect().bottom)
        : null,
      panelOverflow: secBody.map((b) => b.scrollHeight - b.clientHeight).filter((n) => n > 4),
      igridColors: [...document.querySelectorAll('.igrid__ico')].map(
        (e) => getComputedStyle(e).backgroundColor,
      ),
    };
  });
  console.log(`   ${tag}  ` + JSON.stringify(f));
  return f;
}

// ── 三屏 ────────────────────────────────────────────────────
for (let i = 0; i < 3; i += 1) {
  await page.evaluate((idx) => {
    const el = document.querySelector('.stack');
    if (el) el.scrollTop = idx * el.clientHeight;
  }, i);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/p${i}.png` });
  await facts(`p${i}`);
}

// ── 六个图标入口 + 单场运动 ──────────────────────────────────
await page.evaluate(() => { const el = document.querySelector('.stack'); if (el) el.scrollTop = 0; });
await page.waitForTimeout(600);

const KEYS = ['zones', 'week', 'power', 'streak', 'kinds', 'sources'];
for (let i = 0; i < KEYS.length; i += 1) {
  const opened = await page.evaluate((idx) => {
    const cells = [...document.querySelectorAll('.igrid__cell')];
    if (!cells[idx]) return false;
    cells[idx].click();
    return true;
  }, i);
  if (!opened) { console.log(`   ⚠️ 第 ${i} 个图标格不存在`); continue; }
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/s-${KEYS[i]}.png` });
  const f = await facts(`sheet:${KEYS[i]}`);
  if (f.sheetOverflow > 4) {
    await page.evaluate(() => { const b = document.querySelector('.sheet__body'); if (b) b.scrollTop = b.scrollHeight; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/s-${KEYS[i]}-end.png` });
  }
  // 点蒙层关掉 —— 走的是读者真会走的路径
  await page.evaluate(() => { const s = document.querySelector('.sheet'); if (s) s.click(); });
  await page.waitForTimeout(400);
}

// ── 单场运动 ────────────────────────────────────────────────
const hasSess = await page.evaluate(() => {
  const c = document.querySelector('.chc__sess');
  if (!c) return false;
  c.click();
  return true;
});
if (hasSess) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/s-session.png` });
  const f = await facts('sheet:session');
  if (f.sheetOverflow > 4) {
    await page.evaluate(() => { const b = document.querySelector('.sheet__body'); if (b) b.scrollTop = b.scrollHeight; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/s-session-end.png` });
  }
} else {
  console.log('   ⚠️ 没有运动卡片可以点开');
}

await browser.close();
console.log(`\n图在 ${OUT}\n`);
