/**
 * 两个主题下的**可读性**检查 —— 逐页、逐主题，量文字和它背后那块底的对比度。
 *
 *   bun scripts/verify-theme-contrast.mjs [基础地址]
 *   bun scripts/verify-theme-contrast.mjs --report     # 只报数，不判红
 *
 * ⚠️⚠️ 为什么必须有这个文件。
 *
 * 2026-09-29 发现：**浅色主题下四张弹窗全是黑底黑字**，对比度 1.05:1，
 * 完全读不出来。根因是 `Sheet.scss` 里写的 `var(--surface, #16181d)` ——
 * 而 `--surface` 这个 token 在整个主题体系里**根本不存在**
 * （tokens.scss 里只有 `--glass-*` / `--page-bg` / `--text-*`），
 * 于是那个深色兜底从第一天起一直生效。
 *
 * ⚠️ 它能活这么久，不是因为难发现，是因为**它只在一个主题下坏** ——
 *    深色主题下白字配黑底，碰巧完全正确。
 *    而所有截图、所有验证、所有人工检查，**都只跑了一个主题**。
 *    ⇒ 这个脚本存在的全部意义就是：**把「两个主题都看一遍」从人的自觉变成机器的事。**
 *
 * ⚠️ 判据是**算出来的对比度**，不是「看起来还行」。按 WCAG：
 *    正文 4.5:1，大字（≥18.66px 粗体或 ≥24px）3:1。
 *    这里对正文要求 4.5，对 ≥18px 的字放宽到 3.0。
 *
 * ⚠️ 背景色的取法：**沿祖先往上找第一个不透明的 `background-color`**。
 *    不能只看元素自己 —— 绝大多数文字元素自己是透明的，
 *    而 bug 恰恰全在「它祖先那层底」上。
 *    ⚠️ 半透明背景（玻璃）**跳过**，继续往上找：玻璃的最终颜色取决于
 *      它背后是什么，静态算不出来，硬算会得到一堆假的红。
 *      代价是「玻璃上的浅字」查不出来 —— 这个取舍写在 `SKIP_ALPHA` 那里。
 *
 * ⚠️ 已知的例外写在 `ALLOW` 里，**每一条都要有理由**。
 *    加例外比调阈值好：阈值一放松，真正的问题就一起漏过去了。
 */
import { chromium } from 'playwright';

const REPORT_ONLY = process.argv.includes('--report');
const BASE = (process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8125/z').replace(/\/$/, '');

const PAGES = ['home', 'coof', 'cnsr', 'paperr', 'chealth'];

/**
 * ⚠️ 允许低于阈值的例外。**加一条就意味着放弃一处检查**，所以每条都要写清为什么。
 * 键是「页面无关」的 CSS 选择器片段，值是理由。
 */
const ALLOW = [
  // 轴标签 / 刻度是刻意的三级灰，它不该和正文抢注意力。
  { sel: 'chc__axis', why: '图表刻度，刻意低对比（三星同样处理）' },
  { sel: 'chc__tile-note', why: '口径说明，刻意弱于主数字' },
  { sel: 'chc__cell > span', why: '' },
];

/** 半透明到这个程度以上才当成「不透明背景」。 */
const SKIP_ALPHA = 0.9;

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) console.log(`✗ ${name}  ${detail || ''}`);
}

const browser = await chromium.launch();

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();

  for (const key of PAGES) {
    await page.goto(`${BASE}/#/pages/${key}/index`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2600);

    /**
     * ⚠️ 量的是**真正贴着字的那个节点**（自己带文字节点的元素），
     *    不是它的容器 —— 容器的颜色可能和字的不一样。
     */
    const bad = await page.evaluate(
      ({ skipAlpha, allow }) => {
        const lum = (c) => {
          const m = c.match(/[\d.]+/g).map(Number);
          const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        /**
         * ⚠️⚠️ 两种写法都要认：`rgba(r, g, b, a)` **和** `color(srgb r g b / a)`。
         *
         *    第一版只认 `rgba()`，于是 `color-mix()` 的结果
         *    （序列化成 `color(srgb 0.039 0.047 0.062 / 0.056)`）被当成
         *    **完全不透明** —— 浅色主题上立刻刷出 27 处「黑字配黑底」的假红，
         *    而那一层其实是 5.6% 的黑，根本不是什么黑底。
         *    ⚠️ 这个坑 FACT 里记过（`color-mix()` 不序列化成 rgba），
         *      我还是踩了：**记在文档里不等于写进代码里**。
         */
        const alphaOf = (c) => {
          if (!c) return 0;
          if (c.startsWith('color(')) {
            const m = c.match(/\/\s*([\d.]+%?)\s*\)/);
            if (!m) return 1;
            return m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
          }
          const m = c.match(/rgba?\([^)]*\)/);
          if (!m) return 1;
          const parts = m[0].match(/[\d.]+/g).map(Number);
          return parts.length >= 4 ? parts[3] : 1;
        };
        /**
         * 沿祖先找第一个不透明的底；**找不到就返回 null**。
         *
         * ⚠️⚠️ 「找不到」必须返回 null 而不是退回 body 的颜色。
         *    页面上绝大多数文字其实压在**壁纸照片**上，而壁纸是
         *    `position: fixed` 的一层、**不是任何文字的祖先**。
         *    退回 body 会得到「白底」，于是深色主题下每一条白字都被判成
         *    「白字配白底」—— 第一版一次刷出 100 多条假红，真问题全被埋了。
         *
         *    ⚠️ 代价要写清楚：**「压在照片上的字」这一类查不出来**。
         *      那需要另一套办法（截图像素采样），不在这个脚本里做。
         *      这里只查「有明确底色」的那些面 —— 而这次真出事的弹窗面板
         *      恰恰就是有明确底色的，所以它够用。
         */
        /**
         * ⚠️⚠️ **壁纸层以上的祖先，背景都作废。**
         *
         *    踩了两次才想明白：
         *      ① 退回 `body` 的底色 → 每一条白字都成了「白底白字」（假红 100+）
         *      ② 改成「走到 body 就停」→ 还是白底白字，因为中间还有一层
         *         **Taro 的页面壳 `div.taro_page`**，它 `position:absolute;
         *         z-index:0`、满屏、底是 `rgb(255,255,255)`。
         *
         *    ⚠️ 那个白底**确实被画了**，只是随即被壁纸盖住 —— 壁纸是
         *      `position: fixed; z-index: -1`，而 `.taro_page` 因为
         *      `position:absolute + z-index:0` 形成了一个层叠上下文，
         *      负 z-index 的子层正好画在**它自己的底之上、其它内容之下**。
         *      ⇒ 结论：**从壁纸那一层往上，任何 `background-color` 都不是
         *        用户看到的东西。** 用户看到的是照片。
         *
         *    ⇒ 所以停的条件不是「到 body」，是「到**装着壁纸的那个元素**」。
         *      这一条是推导出来的，不是试出来的 —— 换个页面壳实现也不会失效。
         */
        const stops = new Set();
        const wall = document.querySelector('.cevtuo-wallpaper');
        for (let n = wall; n; n = n.parentElement) stops.add(n);

        const effBg = (el) => {
          let n = el;
          while (n && !stops.has(n)) {
            const cs = getComputedStyle(n);
            const bg = cs.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && alphaOf(bg) >= skipAlpha) return bg;
            n = n.parentElement;
          }
          return null;
        };

        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          const own = [...el.childNodes].filter((c) => c.nodeType === 3 && c.textContent.trim());
          if (!own.length) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const cls = String(el.className || '');
          if (allow.some((a) => a.sel && cls.includes(a.sel))) continue;

          const fg = cs.color;
          if (alphaOf(fg) < 0.5) continue;       // 淡淡的字（水印之类）不算
          const bg = effBg(el);
          if (bg === null) continue;   // 压在照片上，静态算不出来 —— 见 effBg 上面那段
          const cr = ratio(fg, bg);

          /**
           * ⚠️⚠️ **描边（`text-shadow`）也算一种对比度来源，但要够格才算。**
           *
           *    日历格子 `.pc-cal__day` 是这条规则的由来：它坐在
           *    「近白到近黑」五档填充上，作者自己写了注释说明
           *    「单一墨色在这条色阶的某一端必然读不出来」，
           *    然后**用 `text-shadow: var(--text-halo)` 描边解决** ——
           *    浅色主题是 `rgba(255,255,255,.86)` 的白描边包着黑字。
           *
           *    ⇒ 我的检查器第一版不懂这件事，把它报成 1:1 的红。
           *      但**不能因此就无脑放过所有带描边的字** ——
           *      描边的颜色如果和字本身也差不多，那它什么也救不了。
           *      判据：**描边色和字色的对比 ≥ 4.5**，且描边不透明度 ≥ 0.7。
           *      （4.5 是「字被描出来了」的下限，比「描边很好看」严。）
           */
          const haloOk = (() => {
            const ts = cs.textShadow;
            if (!ts || ts === 'none') return false;
            const cols = ts.match(/rgba?\([^)]*\)|color\([^)]*\)/g) || [];
            return cols.some((c) => alphaOf(c) >= 0.7 && ratio(fg, c) >= 4.5);
          })();

          const size = parseFloat(cs.fontSize);
          const bold = parseInt(cs.fontWeight, 10) >= 600;
          const large = size >= 24 || (size >= 18.66 && bold);
          const need = large ? 3 : 4.5;
          if (cr < need && !haloOk) {
            out.push({
              cls: cls.split(' ').slice(0, 2).join('.'),
              text: own.map((c) => c.textContent.trim()).join(' ').slice(0, 24),
              cr: Number(cr.toFixed(2)),
              need,
              fg,
              bg,
              size: Math.round(size),
            });
          }
        }
        // 同一个类只留最差的一条，否则一个 bug 会刷出几十行
        const byCls = new Map();
        for (const b of out) {
          const prev = byCls.get(b.cls);
          if (!prev || b.cr < prev.cr) byCls.set(b.cls, b);
        }
        return [...byCls.values()].sort((a, b) => a.cr - b.cr);
      },
      { skipAlpha: SKIP_ALPHA, allow: ALLOW }
    );

    const tag = `${scheme}/${key}`;
    if (REPORT_ONLY) {
      console.log(`${tag}: 低于阈值的文字 ${bad.length} 处`);
      for (const b of bad.slice(0, 6)) {
        console.log(`    ${String(b.cr).padStart(5)}:1 (需 ${b.need})  .${b.cls}  ${b.size}px  「${b.text}」  ${b.fg} on ${b.bg}`);
      }
    } else {
      check(
        `${tag} 正文对比度达标`,
        bad.length === 0,
        bad.slice(0, 3).map((b) => `${b.cr}:1 .${b.cls}「${b.text}」`).join('  ')
      );
    }
  }

  // ── 弹窗也要查：它是这次真出事的那个面 ──────────────────────
  for (const key of ['chealth', 'paperr']) {
    await page.goto(`${BASE}/#/pages/${key}/index`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2600);
    const cell = page.locator('.igrid__cell').first();
    if (!(await cell.count())) continue;
    await cell.click();
    await page.waitForTimeout(900);

    const panel = await page.evaluate(() => {
      const p = document.querySelector('.sheet__panel');
      if (!p) return null;
      const cs = getComputedStyle(p);
      const t = p.querySelector('.chc__card-t, .sheet__title, [class*=card-t]');
      return {
        bg: cs.backgroundColor,
        fg: t ? getComputedStyle(t).color : null,
        w: Math.round(p.getBoundingClientRect().width),
      };
    });
    if (panel && panel.fg) {
      const cr = await page.evaluate(
        ([a, b]) => {
          const lum = (c) => {
            const m = c.match(/[\d.]+/g).map(Number);
            const f = (v) => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
          };
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        },
        [panel.bg, panel.fg]
      );
      check(
        `${scheme}/${key} 弹窗文字对比度 ≥ 4.5`,
        cr >= 4.5,
        `${cr.toFixed(2)}:1  ${panel.fg} on ${panel.bg}`
      );
    }
    await page.keyboard.press('Escape').catch(() => {});
  }

  await ctx.close();
}

await browser.close();

if (REPORT_ONLY) {
  console.log('\n（--report 模式：只报数，不判红）');
} else {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}
