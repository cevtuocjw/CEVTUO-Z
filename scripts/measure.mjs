/**
 * 量若干选择器在某个视口下的矩形 —— 这个项目「量出来」那套纪律的通用工具。
 *
 *     bun scripts/measure.mjs 1440 .home-chealth .home-chealth__rings
 *     bun scripts/measure.mjs 390 844 .chc__rings-svg
 *
 * ⚠️ 为什么不用截图：截图能看出「难看」，看不出**差 11px**。
 *    这一轮里两次真 bug 都是量出来的：
 *      · `.chc__rings-row` 被压成 39px（内容要 135px）—— 截图上看只是「挤」
 *      · 环卡比睡眠砖矮 11px —— 正是 `.chc__card` 那个 `margin-top: 11px`
 *    ⚠️ 而反过来也成立：断言全绿也说明不了「好看」。两个都要。
 *
 * ⚠️ 参数是**位置**的：先是宽，再是（可选的）高，其余全是选择器。
 *    高度只在「看起来像数字」时才当高度 —— 否则第一个选择器会被吃掉。
 * ⚠️ 用**本地预览**（127.0.0.1:8125），不是线上：线上前面有 CDN，
 *    刚部署的东西十有八九还取不到，量的会是上一版。
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const W = Number(argv[0] ?? 390);
let rest = argv.slice(1);
let H = 900;
if (rest.length && /^\d+$/.test(rest[0])) {
  H = Number(rest[0]);
  rest = rest.slice(1);
}
const selectors = rest.length ? rest : ['.home-chealth'];
const path = process.env.MEASURE_PATH ?? '/';
const base = process.env.MEASURE_BASE ?? 'http://127.0.0.1:8125/z';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.route('**/*', (r) =>
  /^https?:/.test(r.request().url()) && !r.request().url().includes('127.0.0.1:8125') ? r.abort() : r.continue(),
);
await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(Number(process.env.MEASURE_WAIT ?? 2500));

const out = await page.evaluate((sels) => {
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const res = {};
  for (const s of sels) {
    const els = [...document.querySelectorAll(s)];
    if (!els.length) {
      res[s] = '（页面上没有）';
    } else if (els.length === 1) {
      res[s] = r(els[0]);
    } else {
      res[s] = els.map(r);
    }
  }
  return res;
}, selectors);

console.log(JSON.stringify(out, null, 1));
await browser.close();
