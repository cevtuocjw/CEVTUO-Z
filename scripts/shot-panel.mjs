/**
 * 单页逐屏截图 —— 给「这一屏到底长什么样」这类问题用。
 *
 *   bun scripts/shot-panel.mjs <url> <out-dir> [屏数]
 *
 * ⚠️ 用 Playwright 自带的 Chromium，不用本机 Chrome。
 *    本机 Chrome 153 会对页面做自动暗色反色，`Page.captureScreenshot` 返回的是
 *    **反色后的像素** —— 图看着权威但是假的，这个项目已经因此把一整轮设计
 *    方向带偏过。
 *
 * ⚠️ 逐屏靠**驱动 .stack 的 scrollTop**，和导轨点击走同一条路径。
 *    直接改 URL 里的 ?panel= 只到得了首屏，后面几屏的渲染路径根本没跑到 ——
 *    而「渲染路径没跑到」正是这个项目里 bug 最集中的地方。
 *
 * ⚠️ 每次截图都回读 DOM 事实（哪几屏在视口里、内容多高）。图只能告诉你
 *    「看着不对」，DOM 才能告诉你「哪里不对」。
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const TARGET = process.argv[2];
const OUT = process.argv[3] ?? '/tmp/panel';
const PANELS = Number(process.argv[4] ?? 4);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

await page.goto(TARGET, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

for (let i = 0; i < PANELS; i++) {
  await page.evaluate((idx) => {
    const el = document.querySelector('.stack');
    if (el) el.scrollTop = idx * el.clientHeight;
  }, i);
  await page.waitForTimeout(1000);
  const file = OUT + '/p' + i + '.png';
  await page.screenshot({ path: file });
  const facts = await page.evaluate(() => {
    const stack = document.querySelector('.stack');
    const secs = [...document.querySelectorAll('.section')];
    const body = [...document.querySelectorAll('.section__body')];
    return {
      stackH: stack ? stack.clientHeight : 0,
      scrollTop: Math.round(stack ? stack.scrollTop : -1),
      sections: secs.length,
      // ⚠️ 内容比面板高就会被裁 —— 2026-09-28 CHEALTH 第 2 屏内容 2868px
      //    而面板只有 844px，画到了外面去。这个数字就是那个 bug 的指纹。
      overflow: body.map((b) => b.scrollHeight - b.clientHeight).filter((n) => n > 4),
      tops: secs.map((s, i) => ({ i, top: Math.round(s.getBoundingClientRect().top) })),
    };
  });
  const vis = facts.tops.filter((t) => Math.abs(t.top) < 120).map((t) => t.i);
  console.log('\n── p' + i + ' → ' + file);
  console.log('   sections=' + facts.sections + ' scrollTop=' + facts.scrollTop + '/' + facts.stackH + ' 可见屏=' + vis.join(','));
  if (facts.overflow.length) console.log('   ⚠️ 内容溢出的面板: ' + facts.overflow.join(', ') + ' px');
}

await browser.close();
