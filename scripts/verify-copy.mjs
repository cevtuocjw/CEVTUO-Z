/**
 * 页面上**真的显示出来**的字有没有毛病。
 *
 *   bun scripts/verify-copy.mjs [base-url]
 *
 * ⚠️ 为什么要有这个文件。
 *
 * 2026-09-28 截图看 CHEALTH，发现分析那一屏上赫然印着：
 *
 *     取的是**最近 30 天实测到的最高值**，不是 220−年龄
 *
 * —— Markdown 的粗体标记直接渲染出来了。全站扫下来 5 处，全在这一页。
 *
 * ⚠️⚠️ 它挂了很久没人报，**因为星号夹在中文里看着像排版符号，不像错误**。
 *    这正是「看起来像那么回事的错」最难被发现的原因：它不缺、不乱、不难看，
 *    只是不对。所以它需要一条**机器看的**断言，而不是下一个人的眼睛。
 *
 * ⚠️ 判据是**页面上渲染出来的文本**（`TreeWalker` 走文本节点），不是源码。
 *    源码里满篇都是 `**`（注释里），按源码 grep 会淹在噪音里；
 *    而「渲染出来的是什么」才是读者看到的东西。
 *
 * ⚠️ 同样这一类的东西一起查：反引号、未替换的模板占位、以及
 *    `undefined` / `NaN` / `null` / `[object Object]` —— 它们和星号是同一种
 *    错误：**一个内部表示泄漏到了读者面前**，而且都长得不像崩溃。
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

/**
 * ⚠️ 每一条都要能**指认自己**：`**` 单查会把「`***`」这种也捞进来，
 *    所以每条都给一个说得清的理由。
 *
 * ⚠️ `NaN` / `null` 用词边界匹配。中文正文里不会自然出现 `null` 这四个字母，
 *    但 `null` 会出现在技术词里（比如这里的注释），所以要限定「独立成词」。
 */
const SMELLS = [
  { re: /\*\*/, why: 'Markdown 粗体标记泄漏（应该用嵌套 <Text>，不是写 **）' },
  { re: /`/, why: '反引号泄漏（Markdown 行内代码标记）' },
  { re: /\{\{|\}\}/, why: '未替换的模板占位符' },
  { re: /\[object Object\]/, why: '对象被直接拼进字符串' },
  { re: /(?<![A-Za-z])undefined(?![A-Za-z])/, why: 'undefined 泄漏到界面' },
  { re: /(?<![A-Za-z])NaN(?![A-Za-z])/, why: 'NaN 泄漏到界面' },
];

const ROUTES = [
  ['home', '#/pages/home/index?panel=0'],
  ['coof', '#/pages/coof/index'],
  ['cnsr', '#/pages/cnsr/index'],
  ['paperr', '#/pages/paperr/index'],
  ['chealth', `#/pages/chealth/index${PASS ? `?k=${PASS}` : ''}`],
];

console.log(`\n页面文案 · ${BASE}\n`);

if (!PASS) {
  console.log('  ℹ️  services/ingest/.env.server-backup 里没有口令 ⇒ CHEALTH 只扫到未解锁态');
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});

for (const [name, route] of ROUTES) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  try {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    // ⚠️ 逐屏滚一遍：一屏之外的内容也在 DOM 里，但有些块是滚动到位才渲染的
    //    （图表、懒加载）。不滚的话会漏掉后面几屏 —— 而这次的星号**就在第 6 屏**。
    const panels = await page.evaluate(() => {
      const s = document.querySelector('.stack');
      return s ? Math.max(1, Math.round(s.scrollHeight / s.clientHeight)) : 1;
    });
    for (let i = 0; i < panels; i += 1) {
      await page.evaluate((idx) => {
        const s = document.querySelector('.stack');
        if (s) s.scrollTop = idx * s.clientHeight;
      }, i);
      await page.waitForTimeout(350);
    }

    const hits = await page.evaluate((smells) => {
      const found = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        for (const s of smells) {
          if (new RegExp(s.re).test(t)) {
            found.push({ why: s.why, text: t.slice(0, 120) });
            break;
          }
        }
      }
      return found;
    }, SMELLS.map((s) => ({ re: s.re.source, why: s.why })));

    /**
     * ⚠️⚠️ 弹窗**不在**上面那次扫描的范围里，必须单独走一遍。
     *
     *    `Sheet` 在 `open === false` 时 `return null` —— **没点开的弹窗，
     *    它的文字根本不在 DOM 里**，`document.body` 的 TreeWalker 自然走不到。
     *    上面那圈「逐屏滚一遍」也救不了：滚的是面板栈，弹窗不在栈里。
     *
     *    ⚠️ 2026-09-29 的实例：达标弹窗里写了
     *      `分母是**这个月有记录的天数**`，四个星号原样渲染给读者看，
     *      而**这条断言当时是绿的**。那正是 `73b8a6a` 修过的那一类错，
     *      只是这次它落在了新加的弹窗里 —— 覆盖不到的地方，错误会重新长出来。
     *
     *    ⚠️ 判据仍然是「**页面自己渲染出来的文字**」，不是源码里 grep 一遍：
     *      源码里 `**` 到处都是（注释、正则、模板），只有渲染出来才算泄漏。
     */
    const sheetHits = [];
    const entries = await page.evaluate(() => document.querySelectorAll('.igrid__cell').length);
    for (let i = 0; i < entries; i += 1) {
      const opened = await page.evaluate((idx) => {
        const c = [...document.querySelectorAll('.igrid__cell')][idx];
        if (!c) return false;
        c.click();
        return true;
      }, i);
      if (!opened) continue;
      await page.waitForTimeout(420);
      const r = await page.evaluate((smells) => {
        const body = document.querySelector('.sheet__body');
        const title = (document.querySelector('.sheet__title') || {}).textContent || '';
        if (!body) return { found: [], title };
        const found = [];
        const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
          const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          for (const s of smells) {
            if (new RegExp(s.re).test(t)) {
              found.push({ why: s.why, text: t.slice(0, 100) });
              break;
            }
          }
        }
        return { found, title };
      }, SMELLS.map((s) => ({ re: s.re.source, why: s.why })));
      for (const f of r.found) sheetHits.push({ ...f, text: `［弹窗「${r.title}」］${f.text}` });
      // 点蒙层关掉 —— 走读者真会走的路径
      await page.evaluate(() => {
        const el = document.querySelector('.sheet');
        if (el) el.click();
      });
      await page.waitForTimeout(250);
    }

    /**
     * ⚠️⚠️ 防「**空扫描**」。
     *
     *    本地跑的时候 `bun run app:build:h5` 会**清掉 `dist/data` 软链**
     *    （项目里早有记录）。没挂上的话，CHEALTH 页取不到密文索引 ⇒
     *    退回「需要口令」那一屏 ⇒ **六个弹窗一个都不存在** ⇒
     *    `sheetHits` 永远是空的 ⇒ **断言照样是绿的**。
     *
     *    ⚠️ 这个坑**当场就咬了一次**：我做完负向对照去跑，它报「1 屏，干净」，
     *      看起来像「bug 修好了」，其实是根本没能解锁 ——
     *      一条**因为没跑到而通过**的断言，比没有断言更危险。
     */
    if (name === 'chealth' && PASS) {
      check(
        'chealth：真的解锁了（弹窗扫描不是空跑）',
        entries === 6,
        `${panels} 屏 / ${entries} 个图标入口` +
          (entries !== 6 ? '  ← 页面退回了「需要口令」？先看 dist/data 挂上没有' : ''),
      );
    }

    const all = [...hits, ...sheetHits];
    check(
      `${name}：没有内部表示泄漏到界面`,
      all.length === 0 && errs.length === 0,
      all.length
        ? `${all.length} 处，例如「${all[0].text}」← ${all[0].why}`
        : errs.length
          ? `页面报错 ${errs[0]}`
          : `${panels} 屏${entries ? ` + ${entries} 个弹窗` : ''}，干净`,
    );
  } catch (e) {
    check(`${name}：能打开`, false, String(e).slice(0, 120));
  }
  await page.close();
}

await browser.close();
console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
