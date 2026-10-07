#!/usr/bin/env bun
/**
 * 把 weapp 产物里 **WXSS 解析不了的选择器**剔掉。
 *
 *   bun scripts/wxss-strip-unsupported.mjs apps/dashboard/dist/css
 *
 * ── ⚠️⚠️ 为什么需要这一步 ──────────────────────────────────────
 *
 * WXSS 的选择器只有这几类：`.class` / `#id` / `element` / `element, element`
 * / `::after` / `::before`。**它没有通用选择器 `*`，也不吃伪类 `:not()` `:nth-child()`。**
 *
 * 而 H5 那边用得很凶：`Section` 的进场阶梯动画整段都建立在
 * `> *:nth-child(n):not(.reveal)…` 上。**同一份 SCSS 两个平台都要编译**，
 * 于是小程序那边直接编译失败：
 *
 *     wxss 编译错误: ./css/common.wxss: error at token `*`
 *     wxss 编译错误: ./css/common.wxss: error at token `:`
 *
 * ⚠️ 而 Taro 的构建**是成功的**（产物齐全、退出码 0）—— 这个错只在
 *    **微信开发者工具真正编译/上传那一刻**才出现。也就是说：
 *    「构建通过」在这里**什么都不能证明**（这个项目第无数次栽在这个形状上）。
 *
 * ── 剔什么、留什么 ─────────────────────────────────────────────
 *
 * 剔：选择器里含 `:not(` / `:nth-child(` / `:nth-of-type(` 的**那一项**，
 *     以及以组合符开头的不完整项。
 * 留：其余一切 —— 特别是 `flex-shrink` 那条（它现在是
 *     `.section__body > view, .section__body > text, …` 的**纯元素选择器**，
 *     WXSS 认，而且它是**修一个真 bug** 的，不能丢）。
 *
 * ⚠️ 剔掉的后果是小程序**没有那套进场阶梯动画**——那是 H5 的观感精修，
 *    不是功能。宁可没有动画，也不能编译不过。
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';


/**
 * ⚠️⚠️ **给多词字体族名补回引号 —— WXSS 的解析器不吃 `font-family: Helvetica Neue`。**
 *
 * 源码里**是加了引号的**（`tokens.scss` 的 `$font-family-sans`），是 **CSS 压缩器
 * 把引号去掉了**。而那不是压缩器的错：按 CSS 规范，`font-family` 的值可以是
 * **一串标识符**，`Helvetica Neue` 不写引号**完全合法**，浏览器照单全收。
 *
 * ⚠️ **WXSS 不宽容**：它的解析器看到 `Helvetica` 之后是个标识符而不是 `,`/`;`，
 *    就报 ——
 *
 *        Error: 错误 Error: Expected an opening parenthesis.
 *
 *    **没有文件名、没有行号**，而全站有几十处字体栈。
 *
 * ⚠️ 这条坑的形状值得记：**问题不在源码里，在"源码 → 产物"的那一步**。
 *    看源码看不出任何毛病，看产物才知道引号没了。
 */
const GENERIC = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
]);

function requoteFontFamilies(css) {
  return css.replace(/font-family:([^;}]+)/g, (whole, value) => {
    const parts = value.split(',').map((raw) => {
      const t = raw.trim();
      if (!t) return t;
      if (/^['"]/.test(t)) return t;                 // 已经带引号
      if (GENERIC.has(t.toLowerCase())) return t;    // 通用族名不能加引号
      if (!/\s/.test(t)) return t;                   // 单词不用加
      return `'${t}'`;                                // ⚠️ 多词必须加
    });
    return `font-family:${parts.join(',')}`;
  });
}

const dir = process.argv[2] || 'apps/dashboard/dist/css';
const BAD = /:(not|nth-child|nth-of-type|is|where)\(/;

/**
 * ⚠️⚠️ **必须按大括号深度扫，不能用扁平正则 —— 这里已经栽过一次。**
 *
 * 第一版是 `/([^{}]+)\{([^{}]*)\}/g`。它**处理不了嵌套大括号**，而
 * `@keyframes` 正好是嵌套的：
 *
 *     @keyframes chc-ring-draw{from{stroke-dashoffset:var(--len,0)}to{stroke-dashoffset:0}}
 *
 * 扁平正则把 `from{…}` 和后面的内容配错组，切出来的"选择器"里已经带上了
 * 前一条规则的尾巴，于是产物里出现了：
 *
 *     } .chc__ring-gloss){-webkit-animation-delay:.11s;…}
 *
 * —— 一个**以 `)` 开头**的选择器。而微信报的是
 * 「Expected an opening parenthesis.」（**没有文件名、没有行号**）。
 *
 * ⇒ 改成**深度扫描**：只在深度 0 的规则（以及 `@media` 里的规则）上做过滤，
 *    `@keyframes` / `@-webkit-keyframes` **整块原样保留**（它们的"选择器"是
 *    `from` / `to` / `50%`，本来就不含我要剔的东西）。
 */

/** 按**顶层**逗号切分选择器列表（跳过 `()` 里的逗号）。 */
function splitTopLevelCommas(sel) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of sel) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}


/**
 * ⚠️⚠️ **把 `color-mix()` 在构建时算成 `rgba()` —— WXSS 不支持 `color-mix()`。**
 *
 * 定位过程值得记：微信报的是
 *
 *     Error: 错误 Error: Expected an opening parenthesis.
 *
 * —— **没有文件名、没有行号**，而全站有 111 处 `color-mix()`。
 * 靠"按 `}` 边界删段落二分"才找到它。
 *
 * ⚠️⚠️ **而且我第一次"排除"它时被骗了**：那时我删掉全部 `color-mix` 声明，
 *    报错**一字不差**，于是判定"不是它"。真因是**同时还有别的错**
 *    （一个以 `)` 开头的畸形选择器、一批没加引号的多词字体名），
 *    而编译器**只报第一个错**。
 *    ⇒ **用"删掉它看还红不红"来排除原因，只在它是唯一原因时成立。**
 *
 * 形态只有两种（实测 111 处）：
 *   · `color-mix(in srgb, #fff 60%, transparent)` → **可精确算**成 `rgba(255,255,255,.6)`
 *   · `color-mix(in srgb, currentColor 16%, transparent)` → 无对应的普通 CSS 写法
 *
 * ⇒ 第二类用中灰近似，并且**把条数打出来** —— 这是降级，降级必须显式。
 */

/**
 * ⚠️ **清掉小程序里既无意义、WXSS 又可能不认的东西。**
 *
 *   · `@-webkit-keyframes` —— 前缀版，WXSS 只认 `@keyframes`（另有一份无前缀的）
 *   · `::-webkit-scrollbar*` / `::placeholder` / `::-*-input-placeholder`
 *     —— 小程序里根本没有滚动条和原生输入框的这套伪元素
 *
 * ⚠️ 判定"是不是它"必需**一次只留一个变量**（下面 removeKeyframes 用参数控制），
 *    否则和多原因时的"删掉它看还红不红"一样会被骗 —— 这一天已经栽过一次。
 */
function purgeUnsupported(css) {
  let n = 0;
  // 1) 前缀 keyframes 整块
  css = css.replace(/@-webkit-keyframes[\s\S]*?\}\s*\}/g, (m) => { n += 1; return ''; });
  /*
   * 1b) ⚠️⚠️ `-webkit-gradient(linear, …)` —— **2011 年的老渐变语法**，
   *     `autoprefixer` 为远古浏览器生成的。它里面有个**裸词 `linear`**，
   *     而 WXSS 的解析器看到裸词后**期望一个左括号** —— 于是报
   *
   *         Error: 错误 Error: Expected an opening parenthesis.
   *
   *     和那条没有行号的报错**完全吻合**。
   *     ⚠️ 每一条这样的声明旁边都有标准的 `linear-gradient()`，删掉它不丢效果。
   */
  css = css.replace(/[a-z-]+:\s*-webkit-gradient\([^;{}]*;?/g, () => {
    n += 1;
    return '';
  });
  /*
   * 1c) ⚠️ **清掉 autoprefixer 加的厂商前缀属性。**
   *
   *     `-ms-flexbox` / `-ms-flex-direction` / `-webkit-box-shadow` / `-moz-…`
   *     —— 那是为 IE10 / 老 Safari 生成的，小程序既不需要，
   *     而 WXSS 的解析器**未必认识每一个**。每一条旁边都有无前缀的那份。
   *
   *     ⚠️ 只保留**只存在前缀形态**的那几个（`-webkit-line-clamp` 之类），
   *        清掉它们会真的丢功能。
   */
  /*
   * ⚠️⚠️ **匹配吃掉的那个 `{` / `;` 必须原样还回去。**
   *
   * 第一版写的是 `return m.startsWith(';') ? ';' : ''` —— 也就是说
   * **匹配以 `{` 开头时，把那个 `{` 一起删掉了**。
   * 于是**任何"第一条声明就是厂商前缀"的规则，它的 `{` 都会消失**，
   * 选择器和下一条声明粘在一起：
   *
   *     .cevtuo-glassanimation:cevtuo-glass-drift 38s …   ← 少了 `{`
   *
   * ⇒ 整份 CSS 变成无效的 ⇒ 微信那边不报错（它只是解析出一堆垃圾），
   *   而**页面白屏**。我为了修"白屏"而加的清前缀这一步，**自己造出了一个白屏**。
   */
  const keepLead = (m) => {
    n += 1;
    const c = m[0];
    return c === '{' || c === ';' ? c : '';
  };
  if (process.env.KEEP_PREFIX_PROPS) { /* 关掉这步做对照实验 */ } else {
  css = css.replace(/[{;]\s*-(ms|moz|o)-[a-z-]+\s*:[^;{}]*;?/g, keepLead);
  css = css.replace(/[{;]\s*-webkit-(?!line-clamp|box-orient)[a-z-]+\s*:[^;{}]*;?/g, keepLead);
  }
  // 2) 带这些伪元素的**整条规则**
  css = css.replace(/([^{}]*?)(::(-webkit-|-moz-|-ms-)?(scrollbar[\w-]*|placeholder|input-placeholder))([^{}]*)\{[^{}]*\}/g,
    (m) => { n += 1; return ''; });
  return { css, n };
}

function expandColorMix(css) {
  let exact = 0;
  let approx = 0;
  let left = 0;
  let out = '';
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf('color-mix(', i);
    if (start < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, start);
    // 找配对的 `)`（⚠️ 里面可能有嵌套的 `var(--a, var(--b))`）
    let depth = 1;
    let j = start + 'color-mix('.length;
    while (j < css.length && depth > 0) {
      if (css[j] === '(') depth += 1;
      else if (css[j] === ')') depth -= 1;
      j += 1;
    }
    const inner = css.slice(start + 'color-mix('.length, j - 1);
    const args = splitTopLevelCommas(inner).map((x) => x.trim());
    // 只认 `in srgb, <color> <p>%, transparent`
    if (args.length === 3 && /^in srgb$/i.test(args[0]) && /^transparent$/i.test(args[2])) {
      const m = /^(.*?)\s+([\d.]+)%$/.exec(args[1]);
      if (m) {
        const c = m[1].trim();
        const alpha = Number(m[2]) / 100;
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
        if (hex) {
          let h = hex[1];
          if (h.length === 3) h = h.split('').map((x) => x + x).join('');
          exact += 1;
          out += `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
          i = j;
          continue;
        }
        // `currentColor` 和 `var(…)` 都归"近似"：普通 CSS 没有"给颜色加透明度"的
        // 写法，而这些变量分主题定义，静态解析必然有一边错。
        approx += 1;
        out += `rgba(127,127,127,${alpha})`;
        i = j;
        continue;
      }
    }
    /*
     * 三参形态：`color-mix(in srgb, #fff 26%, var(--m))` —— 那是**提亮/压暗**，
     * 不是加透明度。兜底取**不带百分比的那个颜色**（基准色），
     * 丢掉明暗但**保住色相** —— 比换成中灰好得多，因为这些是图表和仪表盘的彩色。
     */
    if (args.length === 3 && /^in srgb$/i.test(args[0])) {
      const plain = args.slice(1).map((x) => x.trim()).filter((x) => x && !/%$/.test(x));
      if (plain.length) {
        approx += 1;
        out += plain[plain.length - 1];
        i = j;
        continue;
      }
    }
    left += 1;
    out += css.slice(start, j);
    i = j;
  }
  return { css: out, exact, approx, left };
}

function filterSelectors(css) {
  let out = '';
  let i = 0;
  let dropped = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace < 0) {
      out += css.slice(i);
      break;
    }
    const prelude = css.slice(i, brace);
    // 找配对的 `}`
    let depth = 1;
    let j = brace + 1;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      j += 1;
    }
    const body = css.slice(brace, j);
    const trimmed = prelude.trim();
    const isAt = trimmed.startsWith('@');
    const isKeyframes = /^@(-webkit-)?keyframes/.test(trimmed);
    if (isAt && !isKeyframes) {
      // `@media` 这类：内部**递归**处理（里面有普通规则）
      out += prelude + '{' + filterSelectors(body.slice(1, -1)).css + '}';
    } else if (isKeyframes) {
      out += prelude + body;            // 原样
    } else {
      /*
       * ⚠️⚠️ **只按"顶层"逗号切 —— `:is(a, b)` 里面的逗号不是分隔符。**
       *
       * 第一版直接 `prelude.split(',')`，而源码里有一条
       *
       *     .chc__rings-svg g:nth-child(2) :is(.chc__ring-arc, .chc__ring-gloss) { … }
       *
       * ⇒ 被劈成 `.… :is(.chc__ring-arc` 和 ` .chc__ring-gloss)` 两半。
       *   前半含 `:nth-child(` 被剔掉 ✓，而**后半不含伪类、于是被当合法选择器留下**，
       *   产物里就出现了
       *
       *     } .chc__ring-gloss){-webkit-animation-delay:.11s;…}
       *
       *   —— 一个**以 `)` 开头**的选择器。微信报的是
       *   「Expected an opening parenthesis.」，**没有文件名、没有行号**。
       */
      const items = splitTopLevelCommas(prelude);
      const keep = items.filter((sel) => {
        const t = sel.trim();
        if (!t) return false;
        if (BAD.test(t)) return false;
        if (/^[>+~]/.test(t)) return false;
        if (/(^|[\s>+~])\*([\s>+~,{]|$)/.test(t)) return false;
        return true;
      });
      dropped += items.length - keep.length;
      if (keep.length) out += keep.join(',') + body;
    }
    i = j;
  }
  return { css: out, dropped };
}

/**
 * ⚠️⚠️⚠️ **删掉"空壳块" —— 小程序白屏的真凶（2026-10-07 定位）。**
 *
 * 前面几步会**把块里的东西清空**（剔掉不支持的伪类/属性选择器），
 * 于是产物里留下一堆**只有壳没有内容**的 at-rule：
 *
 *     @media (prefers-reduced-motion:reduce){}
 *     @media (prefers-color-scheme:light){}
 *
 * ⇒ 它们**语法上是合法 CSS**，但**WXSS 编译不过**，而且报的是
 *   「编译 .wxss 文件错误」这种**不说哪里错**的话。
 *
 * 定位过程（值得记，因为每一步都可能骗人）：
 *   · 清空**全部** wxss ⇒ 页面渲染出裸文字 ⇒ 判定 wxss 是元凶；
 *   · 但"渲染出来了"是**假象** —— 入口 `app.wxss` 只有
 *     `@import "./app-origin.wxss";@import "./css/common.wxss";`
 *     清空它就等于**不加载 common.wxss**，页面当然"正常"（完全没样式）。
 *     ⚠️ 我因此白跑了三轮二分。
 *   · 按构造分组测（比按字节二分快得多）：`env()` / 带兜底的 `var()` /
 *     属性选择器 **全无变化**，只有**删空 @media 块**让页面活了过来。
 *
 * ⚠️ 必须**循环到不动**：删掉内层空块之后，外层可能**变成**空块。
 *
 * ⚠️ 前导（`[^{};]*`）刻意**不许跨 `{` `}` `;`** —— 这样匹配到的必然是一段
 *    完整规则头（`.x` / `@media (...)`），不会误吃掉前面别的内容。
 */
function dropEmptyBlocks(css) {
  let removed = 0;
  let prev = css;
  let out = css;
  do {
    prev = out;
    out = out.replace(/[^{};]*\{\s*\}/g, () => {
      removed += 1;
      return '';
    });
    // 防御：真遇到病态输入也别转不出来
    if (removed > 20000) break;
  } while (out !== prev);
  return { css: out, removed };
}

let files = 0;
let dropped = 0;
const colorMixStat = { exact: 0, approx: 0 };
let purged = 0;
let emptyBlocks = 0;

/*
 * ⚠️⚠️ **必须递归 —— `dist/css/` 下面还有按页面分的子目录。**
 *
 *     dist/css/common.wxss
 *     dist/css/pages/home/index.wxss      ← 这一层第一版完全没处理到
 *     dist/css/pages/cnsr/index.wxss
 *
 * 第一版只 `readdirSync(dir)`，于是**页面级的 wxss 原样带着 `color-mix()` 和
 * 伪类进了包** ⇒ 微信照旧报「Expected an opening parenthesis.」，
 * 而我盯着 `common.wxss` 反复二分，**怎么都找不到** —— 因为它根本不在那儿。
 *
 * ⇒ 同一天第二次栽在同一个形状上：**"我处理过了"和"产物里没有了"是两回事**，
 *    判据只能是**扫一遍产物**（`find dist -name '*.wxss'` 逐个 grep），
 *    不是"我的脚本跑过了"。
 */
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const full = join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.wxss')) targets.push(full);
  }
};
const targets = [];
walk(dir);
for (const p of targets) {
  const raw = readFileSync(p, 'utf8');
  // ⚠️ 先补引号、再剔选择器；写回条件要和 `raw` 比 ——
  //    第一版比的是中间结果，于是"补引号"永远不触发写回（报"处理 0 个文件"）。
  const pu = purgeUnsupported(raw);
  const cm = expandColorMix(pu.css);
  const r = filterSelectors(requoteFontFamilies(cm.css));
  // ⚠️ **最后一步，不能在中间** —— 前面的清空动作才是空块的来源。
  const eb = dropEmptyBlocks(r.css);
  r.css = eb.css;
  emptyBlocks += eb.removed;
  if (/color-mix\(/.test(r.css)) {
    const n = (r.css.match(/color-mix\(/g) || []).length;
    console.log(`wxss: ⚠️ 还有 ${n} 处 color-mix 没能换算（WXSS 会报错）`);
  }
  colorMixStat.exact += cm.exact;
  colorMixStat.approx += cm.approx;
  purged += pu.n;
  dropped += r.dropped;
  if (r.css !== raw) {
    writeFileSync(p, r.css);
    files += 1;
  }
}
console.log(`wxss-strip: 处理 ${files} 个文件 · 剔掉 ${dropped} 个不支持的选择器项 · 删空壳块 ${emptyBlocks} 个 · color-mix 换算 ${colorMixStat.exact} 精确 + ${colorMixStat.approx} 近似 · 清掉 ${purged} 处前缀 keyframes/伪元素`);
