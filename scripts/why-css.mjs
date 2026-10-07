#!/usr/bin/env bun
/*
 * **「这条 CSS 到底被谁盖住了？」** —— 把命中某个元素、且写了某个属性的规则
 * **按样式表顺序**全列出来。
 *
 * 用法：
 *   bun scripts/why-css.mjs <url> <选择器> [属性]
 * 例：
 *   bun scripts/why-css.mjs http://127.0.0.1:8126/ '.reel__card' opacity
 *
 * ── ⚠️ 为什么要有这个工具（2026-10-07 用它一击命中）──────────────────
 *
 * 读者报「电影海报完全不动、和标题没有对应」。查下去发现：
 * 产物里 `.reel__card{opacity:0}` **明明写着**，而实测 `computedOpacity` 是 **1**。
 * ⇒ 被盖住了。而**同特异型的规则谁赢只看顺序** —— 这个项目在这条上栽过**七次**，
 *   每次都是"grep 源码看不出问题，因为盖它的人住在另一个文件里、还写在后面"。
 *
 * 靠这个脚本一次就读出来了：
 *   `.section__body--enter > view :not(.reveal):not(.pc-reveal):not(.panel-gif):not(.hero-orn)`
 *   —— 特异型 (0,5,1)，一条**后代选择器**，`animation: section-enter … both`
 *   把 `.section__body` 下**每一个**元素的 opacity 顶到 1。
 *
 * ⇒ 比「反复猜 / 二分注释掉」快得多：直接把答案列出来。
 *
 * ⚠️ 只看**同源**样式表：跨域的 `cssRules` 会抛，脚本跳过并计入 `crossOrigin`。
 */
import { chromium } from 'playwright';

const [, , URL_ARG, SEL, PROP = 'opacity'] = process.argv;
if (!URL_ARG || !SEL) {
  console.error('用法：bun scripts/why-css.mjs <url> <选择器> [属性]');
  process.exit(2);
}

const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-bypass-list=*'] });
const page = await browser.newPage();
await page.goto(URL_ARG, { waitUntil: 'domcontentloaded' });
// ⚠️ 异步长出来的元素要等一等 —— 太早查会"找不到元素"，而那看起来像选择器写错了。
await page.waitForTimeout(Number(process.env.WAIT ?? 5000));

const out = await page.evaluate(
  ([sel, prop]) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, sel };
    const hits = [];
    let crossOrigin = 0;
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        crossOrigin += 1;
        continue;
      }
      const where = sheet.href ? sheet.href.split('/').pop() : 'inline';
      const walk = (list, at) => {
        for (const r of list) {
          if (r.cssRules && !r.selectorText) {
            walk(r.cssRules, r.conditionText || r.name || at);
            continue;
          }
          if (!r.selectorText) continue;
          if (!(r.style?.cssText || '').includes(prop)) continue;
          let m = false;
          try {
            m = el.matches(r.selectorText);
          } catch {
            m = false;
          }
          if (m) {
            hits.push({
              where: at || where,
              sel: r.selectorText,
              value: r.style.getPropertyValue(prop),
              // ⚠️ 命中数给出"可疑程度"：带 :not()/:is() 的会长得很大。
              specificityish: (r.selectorText.match(/[:#.\[\]]/g) || []).length,
            });
          }
        }
      };
      walk(rules, '');
    }
    const cs = getComputedStyle(el);
    return {
      found: true,
      cls: el.className,
      computed: cs.getPropertyValue(prop),
      animationName: cs.animationName,
      hits,
      crossOrigin,
      sheets: document.styleSheets.length,
    };
  },
  [SEL, PROP],
);

console.log(JSON.stringify(out, null, 2));
if (out.found && out.hits?.length) {
  console.log(`\n⚠️ 有 ${out.hits.length} 条规则命中它并写了 ${PROP} —— **最后一条赢**：`);
  const last = out.hits[out.hits.length - 1];
  console.log(`   ${last.where}  ${last.sel}  → ${PROP}: ${last.value}`);
}
await browser.close();
