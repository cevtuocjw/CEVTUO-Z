/**
 * 手机宽度下 CHEALTH 页面的版式与交互断言。
 *
 *   bun scripts/verify-chealth-ui.mjs [base-url]
 *
 * ⚠️ 为什么值得单独一个文件。
 *
 * 2026-09-28 那天在这一页上连着挖出三个**同一形状**的错，全都是
 * 「注释说 A、代码做 B、而页面看起来很正常」：
 *
 *   1. 马赛克四块的字号写死 30px，而四块的可用宽度是 144/98/53px
 *      ⇒ 三块在截断，睡眠那块的标签被切成「睡.」
 *   2. 柱状图注释写着「默认选中最后一天（= 今天）」，而 `useState` 的初值
 *      在 `days` 还是空数组时求值 ⇒ 永远停在**最老的那一天**
 *   3. 缺数据的读数是 `—`，而它在 21px 粗体下**就是一根横线**
 *      ⇒ 「活动消耗」那一格看起来像分隔线
 *
 * 三个都不是崩溃，三个都通过了类型检查，三个都能截出一张「看着还行」的图。
 * ⇒ 它们只能被**量出来的数**抓住。
 *
 * ⚠️ 所以这个文件的判据全部是**数值**（scrollWidth / clientWidth / 第几根），
 *    不是截图。截图能告诉你「看着不对」，量出来的数才能告诉你「哪里不对」。
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

if (!PASS) {
  console.log('\n  FAIL  拿到口令（services/ingest/.env.server-backup）');
  console.log('\n0/1 通过\n');
  process.exit(1);
}

console.log(`\nCHEALTH 版式与交互 · ${BASE}\n`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 140));
});

await page.goto(`${BASE}/#/pages/chealth/index?k=${PASS}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

/** 页面一共几屏 —— 后面要逐屏走一遍。 */
const panels = await page.evaluate(() => {
  const s = document.querySelector('.stack');
  return s ? Math.max(1, Math.round(s.scrollHeight / s.clientHeight)) : 1;
});

// ── 逐屏：马赛克文字不许被截断 ──────────────────────────────
let tileBad = [];
let labelBad = [];
for (let i = 0; i < panels; i += 1) {
  await page.evaluate((idx) => {
    const s = document.querySelector('.stack');
    if (s) s.scrollTop = idx * s.clientHeight;
  }, i);
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => {
    const out = { values: [], labels: [] };
    for (const v of document.querySelectorAll('.chc__tile-v')) {
      const t = (v.textContent || '').trim();
      if (v.scrollWidth > v.clientWidth + 1) out.values.push(`「${t}」要 ${v.scrollWidth}px 只有 ${v.clientWidth}px`);
    }
    for (const l of document.querySelectorAll('.chc__mlabel')) {
      const t = (l.textContent || '').trim();
      if (l.scrollWidth > l.clientWidth + 1) out.labels.push(`「${t}」要 ${l.scrollWidth}px 只有 ${l.clientWidth}px`);
    }
    return out;
  });
  tileBad = tileBad.concat(r.values);
  labelBad = labelBad.concat(r.labels);
}

check('马赛克的数值不溢出它的块', tileBad.length === 0, tileBad[0] ?? '四块全部装得下');
check('马赛克的标签不被截断', labelBad.length === 0, labelBad[0] ?? '没有省略号切字');

// ── 柱状图：默认选中的必须是**最后一根**（今天） ──────────────
//
// ⚠️ 这条防的是一个具体的历史 bug：`useState(Math.max(0, days.length - 1))`
//    在 `days` 为空时求值得到 0，而 `useState` 初值只取一次 ——
//    于是「默认选中今天」这句注释从来没有生效过，选中的是 14 天前那天。
const charts = await page.evaluate(() => {
  const out = [];
  for (const rows of document.querySelectorAll('.chc__rows')) {
    const bars = [...rows.querySelectorAll('.chc__bar')];
    if (!bars.length) continue;
    const sel = bars.findIndex((b) => b.className.includes('--sel'));
    const today = bars.findIndex((b) => b.className.includes('--today'));
    out.push({
      bars: bars.length,
      sel,
      today,
      readout: (rows.querySelector('.chc__readout') || {}).textContent || '',
    });
  }
  return out;
});

check('页面上找得到柱状图', charts.length > 0, `${charts.length} 张`);

const wrongSel = charts.filter((c) => c.today >= 0 && c.sel !== c.today);
check(
  '每张柱状图默认选中的是「今天」那根',
  wrongSel.length === 0,
  wrongSel.length
    ? `${wrongSel.length} 张选错，例如选中第 ${wrongSel[0].sel} 根而今天是第 ${wrongSel[0].today} 根`
    : `${charts.length} 张全部对齐`,
);

// ── 缺数据的读数必须**像一句话**，不能是一个破折号 ────────────
//
// ⚠️ 21px 粗体的 `—` 就是一根横线。它会被读成排版，不会被读成「缺失」。
const dashes = await page.evaluate(() =>
  [...document.querySelectorAll('.chc__readout-v')]
    .map((v) => (v.textContent || '').trim())
    .filter((t) => /^[—–-]/.test(t)),
);
check(
  '缺数据没有伪装成一根横线',
  dashes.length === 0,
  dashes.length ? `${dashes.length} 处读数是破折号：${dashes[0]}` : '没有裸破折号读数',
);

// ── 柱状图必须是**每个指标自己的颜色** ────────────────────────
//
// ⚠️⚠️ 这条防的是「幽灵类」，而它是这个项目里最难自己暴露的一类错：
//
//    `--m-steps` 那组 token 挂在 `.chc` 上 —— 而**没有任何元素带 `chc` 这个类**。
//    SCSS 里 `.chc { &__rows { … } }` 编译出来是 `.chc__rows`，那个类是真在用的，
//    但裸的 `.chc` 匹配不到任何东西。后果：BarRow 行内的 `--m: var(--m-steps)`
//    **确实写上去了**，而 `--m-steps` 自己是空的 ⇒ 四张图又退回同一个灰。
//
//    ⚠️ DOM 看起来完全正常，类型检查、构建、截图**都不会报**。
//       只有把计算出来的颜色读出来才知道。这个坑已经咬了两次
//       （第一次是马赛克的 `--blue`）。
const tones = await page.evaluate(() =>
  [...document.querySelectorAll('.chc__rows')].map((r) => {
    const bars = [...r.querySelectorAll('.chc__bar')];
    const today = bars.find((b) => b.className.includes('--today'));
    const past = bars.find(
      (b) => !b.className.includes('--today') && !b.className.includes('--empty'),
    );
    return {
      m: getComputedStyle(r).getPropertyValue('--m').trim(),
      today: today ? getComputedStyle(today).backgroundColor : '',
      past: past ? getComputedStyle(past).backgroundColor : '',
    };
  }),
);

const noTone = tones.filter((t) => !t.m);
check(
  '每张柱状图拿到了自己指标的颜色 token',
  noTone.length === 0 && tones.length > 0,
  noTone.length
    ? `${noTone.length} 张的 --m 是空的（幽灵类没挂上，会退回灰色）`
    : tones.map((t) => t.m).join(' / '),
);

const sameColor = tones.filter((t) => t.today !== '' && t.today === t.past);
check(
  '「今天」那根和过去的日子颜色不同',
  sameColor.length === 0,
  sameColor.length
    ? `${sameColor.length} 张的今天和过去同色（今天认不出来）`
    : `例如今天 ${tones[0]?.today} vs 过去 ${tones[0]?.past}`,
);

check(
  '不同指标用不同颜色',
  new Set(tones.map((t) => t.m)).size >= 2,
  `${new Set(tones.map((t) => t.m)).size} 种：${[...new Set(tones.map((t) => t.m))].join(' ')}`,
);

/**
 * ⚠️ 本机跑的时候 ingest 心跳那条报错是**环境造成的，不是页面坏了**：
 *    `ALLOWED_ORIGINS` 里没有 `127.0.0.1`，线上有。
 *
 * ⚠️ 匹配要放宽到「Failed to load resource」：浏览器的控制台文案有两种 ——
 *    带 URL 的 CORS 说明，和不带任何 URL 的 `net::ERR_FAILED`。
 *    只匹配前者的话，本机这条断言会永远红，然后就没人看它了。
 *    （线上照样会报出来，因为 `LOCAL` 是 false。）
 */
const LOCAL = /127\.0\.0\.1|localhost/.test(BASE);
const real = errors.filter(
  (e) => !(LOCAL && /CORS|ERR_FAILED|Failed to load resource/.test(e)),
);
check('没有页面错误', real.length === 0, real[0] ?? '干净');

// ── 未解锁那一屏：必须真的能打字 ─────────────────────────────
//
// ⚠️⚠️ 这一组防的是一个**截图上完全看不出来**的错：输入框外壳在、样式也对，
//    但里面真正能打字的 `<input>` 只有几个像素宽。
//
//    实测（2026-09-28，修复前）：
//        taro-input-core.chc__unlock-input   30 x 44
//        input.weui-input                     4 x 22
//    ⇒ 手机上点不到也打不了字。而截图里它只是「一个细长的框」——
//      看起来像设计，不像坏了。
//
//    ⚠️ 原因是**特异性平手**：`.card` 和 `.chc__unlock` 都是单类选择器，
//       胜负由样式表引入顺序决定，而 demo.scss 在后 —— `.card` 的
//       `flex-direction: row` 一直赢。
//       这个项目在 `.chc__stack` 上**已经踩过一次**，这是第二次。
//
// ⚠️ 用一个**全新 context**（不带口令）—— 主 context 是解锁态的，
//    看不到这一屏。而这一屏恰恰是读者第一次打开时唯一看到的东西。
const anon = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: 'dark',
  isMobile: true,
  hasTouch: true,
});
const anonPage = await anon.newPage();
await anonPage.goto(`${BASE}/#/pages/chealth/index`, { waitUntil: 'networkidle' });
await anonPage.waitForTimeout(2500);
const lock = await anonPage.evaluate(() => {
  const shell = document.querySelector('.chc__unlock-input');
  const inner = shell ? shell.querySelector('input') : null;
  const r = (el) => (el ? el.getBoundingClientRect() : { width: 0, height: 0 });
  return {
    hasShell: !!shell,
    shellW: Math.round(r(shell).width),
    innerW: Math.round(r(inner).width),
    innerH: Math.round(r(inner).height),
    sections: document.querySelectorAll('.section').length,
    tiles: document.querySelectorAll('.chc__tile').length,
  };
});
await anon.close();

check('未解锁时有输入框', lock.hasShell, `外壳 ${lock.shellW}px 宽`);
check(
  '真正能打字的 <input> 足够大',
  lock.innerW >= 80 && lock.innerH >= 16,
  `内层 input ${lock.innerW}×${lock.innerH}px` +
    (lock.innerW < 80 ? '  ← 小于 80px，手机上是点不到的' : ''),
);
check(
  '未解锁时不渲染那三屏空数据',
  lock.sections === 1 && lock.tiles === 0,
  `${lock.sections} 屏 / ${lock.tiles} 个马赛克块（应该是 1 屏 / 0 块）` +
    (lock.sections > 1 ? '  ← 读者会看到一屏「需要口令」后面跟着三屏空白' : ''),
);

// ══════════════════════════════════════════════════════════════
// 2026-09-29：十屏收成三屏 + 七个弹窗 + 三星视觉。
//
// ⚠️⚠️ 上面那 12 条**一条都没覆盖这一轮的东西** —— 弹窗、目标线、达标进度、
//    六个图标入口、卡片圆角，全在断言的盲区里。
//    这正是这个项目反复栽的那个坑：**「断言全绿」和「这一版是对的」是两件事**，
//    绿色的部分没变，不代表新加的部分没坏。
//
// ⚠️ 加断言守两条规矩：
//   · 测**页面自己算出来的东西**（计算样式、真实几何），不是测 DOM 里有没有那个字符串
//   · 每条都要有会失败的对照 —— 下面这些我逐条把 bug 放回去验过（见文件末尾注释）
// ══════════════════════════════════════════════════════════════

await page.evaluate(() => {
  const s = document.querySelector('.stack');
  if (s) s.scrollTop = 0;
});
await page.waitForTimeout(700);

// ── 十屏收成了三屏 ────────────────────────────────────────────
const shape = await page.evaluate(() => ({
  sections: document.querySelectorAll('.section').length,
  dots: document.querySelectorAll('.rail__dot').length,
  entries: document.querySelectorAll('.igrid__cell').length,
}));
check('主屏收成了 3 屏', shape.sections === 3, `${shape.sections} 屏`);
// ⚠️ 导轨的方块数和屏数必须**同时**对。它们曾经不一致 ——
//    因为「正在骑 MyWhoosh」那个徽标是 `<PageStack>` 的兄弟节点，它就是第 11 屏，
//    而 `count` 还写着 10。
check('导轨方块数和屏数一致', shape.dots === 3, `${shape.dots} 个`);
check('图标格有 6 个入口', shape.entries === 6, `${shape.entries} 个`);

/**
 * ⚠️⚠️ 六个图标的颜色**互不相同**，而且不能是兜底灰。
 *
 * 这条防的是**幽灵类**：`--m-*` 那组 token 挂在 `.chc`（一个没有任何元素带的类）
 * 和少数几个真实容器上。`.igrid` 一旦不在那个列表里，行内的
 * `--m: var(--m-heart)` 就指向一个**空的** `--m-heart`，六个圆底全退成 `#6b7280`。
 * ⚠️ 而 DOM、类型检查、构建、截图**都不会说一个字**。
 * 这个坑在 `.chc__mosaic`（`--blue`）和 `.chc__rows`（`--m`）上已经咬过两次。
 */
const icoColors = await page.evaluate(() =>
  [...document.querySelectorAll('.igrid__ico')].map((e) => getComputedStyle(e).backgroundColor),
);
check(
  '六个图标的颜色互不相同（不是兜底灰）',
  icoColors.length === 6 &&
    new Set(icoColors).size === 6 &&
    !icoColors.includes('rgb(107, 114, 128)'),
  `${new Set(icoColors).size} 种：${icoColors.join(' ')}`,
);

/**
 * ⚠️ 马赛克的标签要**各是各的指标色** —— 这条是照真机截图抄的
 *    （三星「每日活动量」那屏：步数=绿 / 活动时间=青 / 活动卡路里=紫）。
 *    删掉 `.chc__mlabel { color: var(--m) }` 之后四块会继承同一个颜色，
 *    这条立刻变红。**蓝色实底那块故意是白的**，所以判据是「至少 3 种」不是「4 种」。
 */
const mlabel = await page.evaluate(() =>
  [...document.querySelectorAll('.chc__mlabel')].map((e) => getComputedStyle(e).color),
);
check(
  '马赛克的标签用各自指标的颜色',
  new Set(mlabel).size >= 3,
  `${new Set(mlabel).size} 种：${mlabel.join(' ')}`,
);

// ── 目标线与达标进度 ──────────────────────────────────────────
//
// ⚠️⚠️ 「目标线在绘图区**里面**」这条防的是一个很安静的错：
//    `.chc__target` 是 `position: absolute; bottom: N%`，包含块是
//    `.chc__plot`（我给它加了 `position: relative`）。少了那一句，
//    包含块会一路上溯到卡片 —— 虚线于是画到标题上面去。
//    ⚠️ **而它看起来仍然是一条水平虚线，不像坏了。**
const target = await page.evaluate(() => {
  const t = document.querySelector('.chc__target');
  const p = t ? t.closest('.chc__plot') : null;
  if (!t || !p) return null;
  const tr = t.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  return {
    plotPos: getComputedStyle(p).position,
    inside: tr.bottom > pr.top - 1 && tr.bottom < pr.bottom + 1,
    fromBottom: Math.round(pr.bottom - tr.bottom),
    plotH: Math.round(pr.height),
  };
});
check('步数图上有目标线', target !== null,
  target ? `距图底 ${target.fromBottom}px / 图高 ${target.plotH}px` : '找不到 .chc__target');
check(
  '目标线定位在绘图区里（不是相对卡片）',
  Boolean(target) && target.plotPos === 'relative' && target.inside,
  target ? `position=${target.plotPos} 在区内=${target.inside}` : '—',
);

const goal = await page.evaluate(() => {
  const g = document.querySelector('.chc__tile-goal');
  const tile = g ? g.closest('.chc__tile') : null;
  const fill = document.querySelector('.chc__goal-fill');
  const track = fill ? fill.parentElement : null;
  return {
    hasRule: Boolean(tile && tile.querySelector('.chc__tile-rule')),
    text: g ? g.textContent.trim() : '',
    // ⚠️ 条的长度必须来自**那一个**比例，不能是写死的宽度 ——
    //    这个项目吃过亏：柱状图曾用 88/84/76/72 四个手写数字，
    //    眼睛会把「长度差」读成「数据差」。
    fillPct:
      fill && track
        ? Math.round((fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100)
        : -1,
  };
});
check(
  '今天那块砖有发丝线和 `/目标`（照真机截图）',
  goal.hasRule && /^\/\s*[\d,]+/.test(goal.text),
  `"${goal.text}" 发丝线=${goal.hasRule}`,
);
check('达标进度条的长度来自真实比例', goal.fillPct >= 1 && goal.fillPct <= 100, `${goal.fillPct}%`);

// ── 三星那套卡片 ──────────────────────────────────────────────
const card = await page.evaluate(() => {
  const c = document.querySelector('.chc__card');
  const bar = document.querySelector('.chc__bar');
  return {
    radius: c ? parseFloat(getComputedStyle(c).borderRadius) || 0 : -1,
    shadow: c ? getComputedStyle(c).boxShadow : '',
    barRadius: bar ? parseFloat(getComputedStyle(bar).borderTopLeftRadius) || 0 : -1,
  };
});
// ⚠️ 全站的 `.card` 是 `border-radius: 0` + 只有一条上边线（「印刷目录」那套）。
//    读者 2026-09-28 的原话是「完全 CSS 看起来不像三星的 APP 那个界面」。
//    这条防的是它哪天退回 0 —— 而退回之后页面**仍然完全正常**，只是不像三星了。
check('CHEALTH 的卡片是圆角（不是全站的 0）', card.radius >= 16, `${card.radius}px`);
check('卡片有描边（彩色壁纸上边界不糊）', card.shadow.includes('inset'), card.shadow.slice(0, 70));
check('柱子是胶囊形（不是 3px 直角）', card.barRadius >= 8, `${card.barRadius}px`);

// ── 七个弹窗 ──────────────────────────────────────────────────
//
// ⚠️⚠️ 「铺满视口」这条防的是 `.sheet` 的 `position: fixed` **静默失效**。
//    `fixed` 的包含块是最近一个带 transform / filter / backdrop-filter /
//    contain / will-change 的祖先 —— 只要有人给 `.stack` 或 `.section`
//    加上其中任意一条，弹窗就会改成相对那一屏定位，**跑进面板里面去**。
//    ⚠️ 它看起来仍然是一个「有蒙层、有标题、有内容」的面板，不像坏了；
//      而「跑进面板里」真正的问题是它会被那个面板的滚动裁掉。
const SHEETS = ['zones', 'week', 'power', 'streak', 'kinds', 'sources'];
const sheetBad = [];
for (let i = 0; i < SHEETS.length; i += 1) {
  await page.evaluate((idx) => {
    const cells = [...document.querySelectorAll('.igrid__cell')];
    if (cells[idx]) cells[idx].click();
  }, i);
  await page.waitForTimeout(450);
  const r = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    const p = document.querySelector('.sheet__panel');
    if (!s || !p) return { open: false };
    const sr = s.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    return {
      open: true,
      covers: Math.abs(sr.width - innerWidth) < 2 && Math.abs(sr.top) < 2,
      panelInView: pr.bottom <= innerHeight + 2 && pr.top >= -2,
      empty: !p.textContent.trim(),
    };
  });
  if (!r.open) sheetBad.push(`${SHEETS[i]}:没打开`);
  else if (!r.covers) sheetBad.push(`${SHEETS[i]}:没铺满视口（fixed 失效？）`);
  else if (!r.panelInView) sheetBad.push(`${SHEETS[i]}:面板跑到视口外`);
  else if (r.empty) sheetBad.push(`${SHEETS[i]}:是空的`);
  // 关掉 —— 点蒙层，走读者真会走的路径
  await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    if (s) s.click();
  });
  await page.waitForTimeout(300);
  if (await page.evaluate(() => Boolean(document.querySelector('.sheet')))) {
    sheetBad.push(`${SHEETS[i]}:关不掉`);
  }
}
check(
  '六个图标入口都能开出铺满视口的弹窗、且关得掉',
  sheetBad.length === 0,
  sheetBad[0] ?? `${SHEETS.length} 个全部通过`,
);

// ⚠️ 单场运动是**另一个**触发点（点列表卡片，不是点图标格），单独走一遍。
const sessOpened = await page.evaluate(() => {
  const c = document.querySelector('.chc__sess');
  if (!c) return 'no-card';
  c.click();
  return 'clicked';
});
if (sessOpened === 'clicked') {
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => {
    const p = document.querySelector('.sheet__panel');
    const curves = document.querySelectorAll('.sheet__body .chc__spark').length;
    return { title: (document.querySelector('.sheet__title') || {}).textContent || '', curves };
  });
  check('点运动卡片能开出场次弹窗', s.title.length > 0, `标题「${s.title}」曲线 ${s.curves} 条`);
  await page.evaluate(() => {
    const el = document.querySelector('.sheet');
    if (el) el.click();
  });
  await page.waitForTimeout(300);
} else {
  check('点运动卡片能开出场次弹窗', false, '页面上没有 .chc__sess（最近 30 天没有运动？）');
}

await browser.close();
console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
