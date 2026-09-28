/**
 * 主页索引卡上那几格数字的版式断言。
 *
 *   bun scripts/verify-home-stats.mjs [base-url]
 *
 * ⚠️ 为什么值得为它单开一个文件。
 *
 * 2026-09-28：主页 CHEALTH 那两格接上真数据之后，`9686` 压在 `5.78h` 上，
 * 两个数字叠在一起。而**在此之前每一轮截图它都是好的** —— 因为那两格永远
 * 是「—」，一个字符。
 *
 * ⇒ 一个占位符比真数据短，就替真数据挡了一整类版式 bug。
 *   所以这个文件测的不是「CHEALTH 好不好看」，而是**格子装不装得下最坏的值**：
 *   它不依赖口令、不依赖今天的数据，只问一句「这一格有没有溢出」。
 *
 * ⚠️ 量的是 `scrollWidth > clientWidth`，不是看截图。
 *    溢出的部分会画到隔壁格子上 —— 在图上那是「两个数挨得有点近」，
 *    而 DOM 说的是「这一格比它该在的地方宽了 41px」。
 *    后者能直接定位到原因，前者只能靠猜。
 *
 * ⚠️⚠️ 这条断言在 2026-09-28 之前会**全绿**，因为那时值都是「—」。
 *    写它的时候我特意确认过：把 `statSize()` 摘掉，它必须变红。
 *    一条永远绿的断言比没有断言更糟 —— 它占着「这里测过了」的位置。
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
    const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(key));
    return line ? line.slice(key.length).trim() : null;
  } catch {
    return null;
  }
})();

const PANELS = 4;
const errors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

console.log(`\n主页索引卡版式 · ${BASE}\n`);

// ⚠️ 带口令打开，这样 CHEALTH 那屏是**有真数据**的状态 —— 也就是出 bug 的那个状态。
//    不带口令测的是「—」，而「—」恰恰是不会暴露问题的那个输入。
const url = `${BASE}/#/pages/home/index?panel=0${PASS ? `&k=${PASS}` : ''}`;
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const seen = [];

for (let i = 0; i < PANELS; i += 1) {
  await page.evaluate((idx) => {
    const el = document.querySelector('.stack');
    if (el) el.scrollTop = idx * el.clientHeight;
  }, i);
  await page.waitForTimeout(800);

  const rows = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.section')];
    const vis = secs.find((s) => Math.abs(s.getBoundingClientRect().top) < 120);
    if (!vis) return null;
    return [...vis.querySelectorAll('.stats__item')].map((it) => {
      const v = it.querySelector('.stats__value');
      return {
        text: v ? v.textContent : '',
        chars: v ? v.textContent.length : 0,
        itemW: Math.round(it.getBoundingClientRect().width),
        scrollW: v ? v.scrollWidth : 0,
        clientW: v ? v.clientWidth : 0,
        fontSize: v ? getComputedStyle(v).fontSize : '',
      };
    });
  });

  if (rows === null) {
    check(`第 ${i + 1} 屏能定位到`, false, '找不到可见的 .section');
    continue;
  }
  seen.push(...rows);

  const over = rows.filter((r) => r.scrollW > r.clientW + 1);
  check(
    `第 ${i + 1} 屏：数字不溢出它的格子`,
    over.length === 0,
    over.length
      ? over.map((r) => `"${r.text}" 需要 ${r.scrollW}px 但格子只有 ${r.clientW}px`).join('；')
      : rows.map((r) => `"${r.text}"(${r.chars}字/${r.fontSize})`).join(' '),
  );
}

// ⚠️⚠️ 上面那条只在**格子宽度相同**时才等价于「不压到隔壁」。
//    如果哪天改成不等宽（比如 CHEALTH 那种主次分明的马赛克），
//    `scrollWidth` 仍然可能被 CSS 的 `min-width: 0` 之类吃掉而报不出来。
//    所以补一条直接量**几何位置**的：相邻两格的文字矩形不许相交。
/**
 * ⚠️ 每一组都带上它属于哪一屏 —— 用**标题**认，不用下标。
 *
 * 我自己第一版是按下标取的（`rects[3]` 当 CHEALTH），于是那条断言永远读到
 * `undefined`、永远报「显示的是 (空)」。原因很朴素：CNSR 那屏**没有 stats**，
 * 所以「有 stats 的屏」组成的数组和「第几屏」根本不是一回事。
 * ⚠️ 一个**永远失败**的断言和一个永远绿的断言一样没用，都是噪音。
 */
const groups = await page.evaluate(() => {
  const out = [];
  for (const s of document.querySelectorAll('.section')) {
    const items = [...s.querySelectorAll('.stats__value')];
    if (!items.length) continue;
    const text = s.textContent || '';
    out.push({
      title: text.includes('CHEALTH')
        ? 'CHEALTH'
        : text.includes('CAPPERR')
          ? 'CAPPERR'
          : text.includes('COOF')
            ? 'COOF'
            : '其它',
      vals: items.map((v) => {
        const r = v.getBoundingClientRect();
        return { text: v.textContent, left: Math.round(r.left), right: Math.round(r.right) };
      }),
    });
  }
  return out;
});

let collide = null;
for (const g of groups) {
  for (let i = 0; i + 1 < g.vals.length; i += 1) {
    if (g.vals[i].right > g.vals[i + 1].left + 1) {
      collide = `${g.title}：「${g.vals[i].text}」右边界 ${g.vals[i].right} 越过了「${g.vals[i + 1].text}」的左边界 ${g.vals[i + 1].left}`;
    }
  }
}
check(
  '相邻两格的数字在几何上不相交',
  collide === null,
  collide ?? `检查了 ${groups.length} 组：${groups.map((g) => g.title).join(' / ')}`,
);

// ⚠️ 解锁态下 CHEALTH 必须真的显示数字。
//    这是**上一层**的问题：版式修好了，但如果数据根本没取到，看起来仍然是
//    「—」—— 而「—」恰好是版式永远不会出问题的那个输入。
//    ⇒ 两条缺一不可：一条保证数字显示得出来，一条保证它显示得下。
const chealth = groups.find((g) => g.title === 'CHEALTH');
const chealthTexts = (chealth?.vals ?? []).map((v) => v.text);
const unlocked = chealthTexts.length === 2 && chealthTexts.every((t) => t && t !== '—');
check(
  'CHEALTH 那屏显示了真实数字（不是占位符）',
  Boolean(PASS) && unlocked,
  !PASS
    ? 'services/ingest/.env.server-backup 里没有口令 ⇒ 测不到解锁态'
    : unlocked
      ? chealthTexts.join(' / ')
      : `显示的是 ${chealthTexts.join(' / ') || '(没找到 CHEALTH 那屏)'}`,
);

/**
 * ⚠️ 本机跑的时候，ingest 心跳那条 CORS 报错是**环境造成的，不是页面坏了**：
 *    `ALLOWED_ORIGINS` 里只有线上那几个源，没有 `127.0.0.1`。
 *    部署到 z.cevtuogrnd.com 之后同一个请求是通的。
 *    ⇒ 只对**本机**过滤这一条，线上照样会报出来。
 *    （不这么做的话，本机这条断言永远红，然后就没人看它了。）
 */
// ⚠️ 匹配要放宽到「Failed to load resource」：控制台文案有两种 ——
//    带 URL 的 CORS 说明，和不带任何 URL 的 `net::ERR_FAILED`。
//    只匹配前者的话本机这条永远红，然后就没人看它了。
const LOCAL = /127\.0\.0\.1|localhost/.test(BASE);
const real = errors.filter(
  (e) => !(LOCAL && /CORS|ERR_FAILED|Failed to load resource/.test(e)),
);
check(
  '没有控制台错误',
  real.length === 0,
  real[0] ?? (errors.length ? `（已忽略 ${errors.length} 条本机 CORS 噪音）` : '干净'),
);

await browser.close();

console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
