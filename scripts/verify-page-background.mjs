/*
 * 背景「按页不同 + 每次刷新都换」的常驻验证。
 *
 * 读者 2026-10-07：
 *   「进入例如 CHEALTH 等页面的时候我希望的是更换另一个背景要是不同的，
 *     这样感觉明白我是在主页还是不是在主页，但是同时刷新的时候主页还是
 *     其他页面背景都是换的」。
 *
 * ── ⚠️⚠️ 为什么判据要写在**同一份文档**里 ──────────────────────────
 *
 * `gallery.ts` 的牌堆是**每次加载重洗**的，所以"主页的背景 ≠ CHEALTH 的背景"
 * 这个比较**不能在两次加载之间做** —— 那样它们 8/9 的概率天然不同，
 * 断言**永远绿**，根本测不到 `currentPage()` 是不是坏的
 * （FACT 纪律 15：测运气的断言要换成测契约的断言）。
 *
 * ⇒ 契约是：**同一份文档里**，走完五个页面，五张背景**两两不同**。
 *    因为 `galleryFile(page)` 取的是**同一个洗好的牌堆**的第 0/1/2/3/4 张，
 *    而洗牌是个排列 ⇒ 五个下标必然拿到五张不同的图。
 *    旧代码（只读 `location.hash`）下 `currentPage()` 恒为 `home`
 *    ⇒ 五张**全是 `deck[0]`** ⇒ 这条断言当场红。
 *
 * 用法：
 *   bun scripts/verify-page-background.mjs [BASE]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8126';
const PAGES = ['/', '/coof', '/cnsr', '/paperr', '/chealth'];

let pass = 0;
let fail = 0;
const t = (ok, msg) => {
  if (ok) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
};

/**
 * ⚠️ 壁纸那个元素没有稳定的约定名，所以**按内容找**：
 *    它是**唯一**一个 inline style 里带 `static/gallery/` 的元素。
 *    （`applyBackground` 是命令式写 `el.style.backgroundImage` 的。）
 */
const READ_BG = `
  (() => {
    const all = [...document.querySelectorAll('*')];
    const hit = all.find((e) => (e.getAttribute('style') || '').includes('static/gallery/'));
    if (!hit) return { url: null, tag: null };
    const m = /url\\("([^"]+)"\\)/.exec(hit.style.backgroundImage || '');
    return { url: m ? m[1] : null, tag: hit.className || hit.tagName };
  })()
`;

const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-bypass-list=*'] });

// ── ① 同一份文档里走完五页：五张必须两两不同 ──────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  /*
   * ⚠️ 主页要用 `${BASE}/`，**不是 `/index.html`**。
   *    browser 路由下 `/index.html` 不是一条已知路由 ⇒ 页面根本不渲染，
   *    ⇒ 量不到背景。那看起来像"主页的背景坏了"，其实是**夹具指错了地址**。
   */
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);

  const seen = [];
  for (const path of PAGES) {
    // ⚠️ 用**真的 `pushState`** 走 —— 那正是 Taro 的 `navigateTo` 干的事，
    //    也是旧代码漏掉的那条路（它只听 `hashchange`，而 hash 不再变）。
    await p.evaluate((to) => window.history.pushState({}, '', to), path);
    await p.waitForTimeout(260);
    const bg = await p.evaluate(READ_BG);
    seen.push(bg.url);
    console.log(`  · ${path} → ${bg.url ? bg.url.split('/').pop() : '(量不到)'}  [${bg.tag}]`);
  }

  t(seen.every(Boolean), '五页都量到了背景图');
  const uniq = new Set(seen.filter(Boolean));
  t(uniq.size === PAGES.length, `五个页面拿到 ${uniq.size} 张不同的背景（应为 ${PAGES.length}）`);
  t(seen[0] !== seen[4], `主页和 CHEALTH 的背景不同（${seen[0]?.split('/').pop()} vs ${seen[4]?.split('/').pop()}）`);
  await ctx.close();
}

// ── ② 刷新会换（主页和内页都要换）────────────────────────────
for (const [name, path] of [['主页', '/'], ['CHEALTH', '/chealth']]) {
  const got = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2400);
    const bg = await p.evaluate(READ_BG);
    got.push(bg.url ? bg.url.split('/').pop() : null);
    await ctx.close();
  }
  const n = new Set(got.filter(Boolean)).size;
  t(got.every(Boolean), `${name} —— 每次都量到了背景（${got.join(' ')}）`);
  // ⚠️ 5 次里至少 2 种。用"每次都不同"会把 1/9 的巧合判成失败（假红）。
  t(n >= 2, `${name} —— 刷新会换背景（5 次拿到 ${n} 种）`);
}

await browser.close();
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
