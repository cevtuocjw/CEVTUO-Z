/**
 * 把**所有**画框做法并排渲染出来看 —— 一张图看完，两个主题各一张。
 *
 *   bun scripts/frame-styles.mjs [base-url] [out-dir]
 *   # 默认 http://127.0.0.1:8125/z · /tmp
 *
 * ⚠️⚠️ 为什么需要它。
 *
 *    画框的做法是**每次刷新随机**的（读者 2026-09-30 要的），而一页上
 *    只出现 3–4 枚。想在真实页面上看全 **17 种**，得刷新几十次还不一定凑齐 ——
 *    而「某个做法其实一直是坏的」这件事，在单页截图上**看不出来**
 *    （那一枚恰好没被抽到，或者被内容压住了）。
 *
 *    ⇒ 这个脚本把一枚真实的 `.gal` **克隆 17 份**，逐个换做法类，
 *      摆成网格，然后截图。**用的是真实构建出来的 CSS**（不是另写一份样式表），
 *      所以「CSS 里写了、浏览器没认」这类问题它一样能看出来。
 *
 * ⚠️ 底色用 `var(--page-bg)`（主题 token），不是写死的颜色 ——
 *    写死的话两个主题截出来**一模一样**，而画框恰恰要在两种底色上都看得清。
 *    （第一版就是写死的，两张图字节级相同，差点当成"两个主题都看过了"。）
 *
 * ⚠️ 它**不是断言**，是给人看的。要防「某个做法悄悄坏了」，
 *    靠 `verify-gallery.mjs` 的 R（每一枚都有可见的框）——
 *    那条不管长什么样，只管「是不是个框」。
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8125/z').replace(/\/$/, '');
const OUT = process.argv[3] ?? '/tmp';

/** ⚠️ 从 `platform/gallery.ts` 里读，不在这里抄一份 —— 抄了就会漂移。 */
const SRC = new URL('../apps/dashboard/src/platform/gallery.ts', import.meta.url);
const STYLES = [...(await import(SRC)).FRAME_STYLES];
/** 每种做法配一张不同的照片，免得把「做法」和「照片」看混。 */
const PHOTOS = ['g01','g02','g03','g04','g05','g06','g07','g09','g10','g01','g02','g03','g04','g05','g06','g07','g09'];
const COLS = Math.min(6, STYLES.length);

const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 1700, height: 900 },
    colorScheme: theme,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const origin = new URL(BASE);
  await page.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const built = await page.evaluate(
    ({ STYLES, PHOTOS, COLS, mount }) => {
      const src = document.querySelector('.gal');
      if (!src) return 'no-frame';
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'fixed', inset: '0', zIndex: '99999',
        background: 'var(--page-bg, #101014)',
        display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`,
        gap: '14px', padding: '18px', alignContent: 'start',
      });
      STYLES.forEach((st, i) => {
        const cell = document.createElement('div');
        Object.assign(cell.style, { position: 'relative', height: '230px' });
        const clone = src.cloneNode(true);
        // 去掉 fixed / 行内尺寸，改成网格里的本地排布
        clone.className = `gal gal--left gal--frame-${st}`;
        Object.assign(clone.style, {
          position: 'absolute', left: '50%', top: '50%',
          width: '150px', height: '196px', margin: '0',
          transform: 'translate(-50%,-50%)', opacity: '1',
        });
        clone.style.removeProperty('--gal-inset');
        const img = clone.querySelector('.gal__photo');
        if (img) img.src = `${mount}/static/gallery/${PHOTOS[i % PHOTOS.length]}.jpg`;
        const cap = document.createElement('div');
        cap.textContent = `${i + 1}. ${st}`;
        Object.assign(cap.style, {
          position: 'absolute', bottom: '0', left: '0',
          color: 'var(--text-secondary, #c9c9d1)', font: '12px -apple-system',
        });
        cell.append(clone, cap);
        box.append(cell);
      });
      document.body.append(box);
      return 'ok';
    },
    { STYLES, PHOTOS, COLS, mount: origin.pathname.replace(/\/$/, '') },
  );
  if (built !== 'ok') {
    console.log(`✗ ${theme}: ${built} —— 页面上没有 .gal，先确认 base 对不对`);
    await ctx.close();
    continue;
  }
  await page.waitForTimeout(1800); // 等 17 张图解码
  const h = Math.ceil(STYLES.length / COLS) * 250 + 40;
  const file = `${OUT}/frame-styles-${theme}.png`;
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1700, height: h } });
  console.log(`→ ${file}   ${STYLES.length} 种做法`);
  await ctx.close();
}
await browser.close();
