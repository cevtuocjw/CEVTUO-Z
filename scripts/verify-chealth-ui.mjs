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

/**
 * ⚠️⚠️ 先确认**页面真的解锁了**，再往下跑。
 *
 *    本地 `bun run app:build:h5` 和 `deploy-pages.sh` 都会**清掉 `dist/data` 软链**
 *    （项目里早有记录）。没挂上时 CHEALTH 页取不到密文索引 ⇒ 退回「需要口令」
 *    那一屏 ⇒ 下面**每一条**都红：柱状图 0 张、日历 0 格、三环 0 条、
 *    「主屏收成了 3 屏 — 1 屏」…… 我实测过一次，**29 条失败里没有一条说的是真原因**。
 *
 *    ⚠️ 这不是「多加一层保险」。一次报 29 条假失败和一次报 1 条真原因，
 *      差别是下一个人要不要花半小时去排查一个不存在的问题。
 */
const unlockedTiles = await page.evaluate(() => document.querySelectorAll('.chc__tile').length);
if (unlockedTiles === 0) {
  console.log('\n  ⚠️⚠️ 页面没解锁（`.chc__tile` 一个都没有）—— 后面的失败都只是这一个原因。');
  console.log('      本地跑的话，先确认 dist/data 挂上了：');
  console.log('        ln -sfn ../../../data apps/dashboard/dist/data');
  console.log('      （`bun run app:build:h5` 和 `deploy-pages.sh` 都会清掉它。）\n');
  console.log('0/1 通过\n');
  await browser.close();
  process.exit(1);
}

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

/**
 * ⚠️⚠️ 这一段**改过方向**，而且是被读者推翻的 —— 值得记下来。
 *
 *    原来写的是「「今天」那根和过去的日子颜色不同」。那是我 2026-09-29 上午
 *    自己定的方案（今天满色、过去 42% 淡版），不是读者的要求。
 *    读者的反馈：「柱状图还是跟三星健康的太不像啦，**尤其是很粗**，
 *    然后颜色和那些细节还是不像」。
 *
 *    ⚠️ 三星的实际做法是：**所有柱子同一个实色**，今天是靠**轴上那个日期**
 *      标出来的（三星把今天的日期印成醒目色）。淡版让整张图发灰 ——
 *      那正是「不像」的最大来源。
 *
 *    ⇒ 断言跟着**判据换了信息来源**（柱子颜色 → 轴标签），
 *      不是把阈值放宽。这两件事的区别是：前者换了问题，后者藏了问题。
 */
const barPaint = await page.evaluate(() => {
  const out = [];
  for (const r of document.querySelectorAll('.chc__rows')) {
    const bars = [...r.querySelectorAll('.chc__bar')];
    const past = bars.find((b) => !b.className.includes('--empty'));
    out.push({
      bg: past ? getComputedStyle(past).backgroundColor : '',
      // ⚠️ 读者原话是「尤其是很粗」。原来 14 根均分 290px = 每根 18px。
      w: past ? Math.round(past.getBoundingClientRect().width) : 0,
      axisMarked: Boolean(r.querySelector('.chc__axis-today')),
    });
  }
  return out;
});

// ⚠️ 透明色有两种序列化：`rgba(r,g,b,a)` 和 `color(srgb r g b / a)`。
//    只匹配前者的话，新版 Chrome 上的淡版会被当成实色放过去。
const translucent = barPaint.filter((b) => /rgba\(|\/ *0?\.\d+/.test(b.bg));
check(
  '柱子是**实色**（三星那样），不是淡版',
  barPaint.length > 0 && translucent.length === 0,
  translucent.length ? `${translucent.length} 张还是淡版：${translucent[0]?.bg}` : `例如 ${barPaint[0]?.bg}`,
);
check(
  '今天是靠**轴上的日期**标出来的（不是靠柱子颜色）',
  barPaint.length > 0 && barPaint.every((b) => b.axisMarked),
  barPaint.filter((b) => !b.axisMarked).length
    ? `${barPaint.filter((b) => !b.axisMarked).length} 张没有标记今天的轴标签`
    : `${barPaint.length} 张都标了`,
);
check(
  '柱子够细（三星那种细竖条，不是一堵墙）',
  barPaint.length > 0 && barPaint.every((b) => b.w > 0 && b.w <= 13),
  `宽度 ${barPaint.map((b) => b.w).join('/')}px（改之前是 18px）`,
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
await anonPage.goto(`${BASE}/#/pages/chealth/index?k=__definitely_wrong__`, { waitUntil: 'networkidle' });
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
  const gs = [...document.querySelectorAll('.chc__rings-g')].map((e) => e.textContent.trim());
  const rows = [...document.querySelectorAll('.chc__rings-row')];
  const card = document.querySelector('.chc__rings')?.closest('.chc__card');
  return {
    goals: gs,
    cardText: card ? card.textContent.replace(/\s+/g, ' ').trim() : '',
    // ⚠️ 分母必须在**读数那一行**里，不能折到第二行去 ——
    //    第一版没有 `white-space: nowrap`，`步数 9,686 / 9,000` 被折成两行，
    //    `/ 9,000` 缩进到数值下面，读起来像子标题而不是分母。
    //    ⚠️ 而它在截图里「看着还挺整齐」，只有量行数才抓得住。
    rowsWrapped: rows.filter((r) => r.getBoundingClientRect().height > 34).length,
    // ⚠️⚠️ **溢出**（不是折行）：`nowrap` 拒绝折行时，多出来的那截会安静地
    //    叠到**旁边的元素**上 —— 实测 `/ 9,000` 的最后一个 0 压在心上。
    //    ⇒ 折行看得出来，溢出看不出来。这一条就是为它加的。
    overflow: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
  };
});
/**
 * ⚠️⚠️ 这条**改过判据**，因为逐行的 `/目标` 被自己的布局证伪了。
 *
 *    原判据是「每一行读数里都写着 `/ 9,000`」。但 2026-09-29 实测：
 *    带上分母之后最长那行要 ~195px，而环左边那列只有 ~174px，
 *    `nowrap` 不让折行 ⇒ **文字压在心上**（截图里能看见）。
 *    三星那块环卡上也**没有**逐行分母。
 *
 *    ⇒ 目标改成断言「**这张卡里有目标**」，位置不限定在行内 ——
 *      它现在写在环下面的说明里（`目标 9,000 步 · 400 千卡活动消耗 · …`）。
 *    ⚠️ 这条比原来**更弱**（不限定位置），所以配一条更强的补上：
 *      读数行**不许溢出**（`scrollWidth <= clientWidth`）——
 *      那才是这次踩到的那个坑。
 */
check(
  '三环这张卡里写明了目标（`9,000 步`）',
  /9,000/.test(goal.cardText),
  `卡里的文字：${goal.cardText.slice(0, 80) || '(空)'}`,
);
check('环的三行读数都没有折行', goal.rowsWrapped === 0, `${goal.rowsWrapped} 行被折成两行`);

// ── 三个同心圆环（读者 2026-09-29 点名要的）────────────────────
const rings = await page.evaluate(() => {
  const svg = document.querySelector('.chc__rings-svg');
  /**
   * ⚠️ 这段**又改回来了**，而且值得记一笔它来回了两趟：
   *
   *    圆环 → 心形（`path`）→ 圆环（`circle`），一天之内。
   *    每换一次，这条断言就红一次 —— **而功能一直是正常的**。
   *
   *    ⇒ 它测的是**实现用的元素类型**，不是「有三个环」这件事。
   *      但也不能简单换成「数一数 SVG 里有几个图形」：那样加一道高光
   *      就会把它弄红（高光也是 `circle`）。所以分成两条：
   *        · 轨道 = 图形总数 − 弧 − 高光   ← 这条对实现不敏感
   *        · 高光 = 和弧**成对**出现        ← 这条钉住新的玻璃层
   *    ⚠️ 认图形仍然按**类名**（`.chc__ring-arc` / `.chc__ring-gloss`），
   *      不按元素名 —— 下一次再换形状时，红的应该是「有几个环」，
   *      而不是「你用错了标签」。
   */
  const shapes = svg ? [...svg.querySelectorAll('circle, path')] : [];
  const arcs = shapes.filter((s) => s.classList.contains('chc__ring-arc'));
  const gloss = shapes.filter((s) => s.classList.contains('chc__ring-gloss'));
  const rows = [...document.querySelectorAll('.chc__rings-row')].map((r) => ({
    label: (r.querySelector('.chc__rings-l') || {}).textContent || '',
    none: Boolean(r.querySelector('.chc__rings-none')),
    v: (r.querySelector('.chc__rings-v') || {}).textContent || '',
  }));
  /**
   * ⚠️⚠️ 高光必须**贴在它所服务的那条弧的外缘**，半径 = 弧半径 + 3。
   *
   *    画在**同一条中心线上**时它只是一条浅色的线，看起来像「两种颜色的环」；
   *    偏到外缘才读成**一道反光** —— 也就是「玻璃」和「塑料」的区别。
   *    ⇒ 所以这里量的是**两个半径的差**，不是「有没有一条白线」。
   *      一条和弧重合的白线会通过「存在性」断言，却完全没有玻璃感。
   */
  const pairs = svg
    ? [...svg.querySelectorAll('g')].map((g) => {
        const a = g.querySelector('.chc__ring-arc');
        const gl = g.querySelector('.chc__ring-gloss');
        return {
          hasArc: Boolean(a),
          hasGloss: Boolean(gl),
          dr: a && gl ? Number(gl.getAttribute('r')) - Number(a.getAttribute('r')) : null,
          glossOpacity: gl ? Number(gl.getAttribute('stroke-opacity')) : null,
        };
      })
    : [];
  return {
    shapes: shapes.length,
    arcs: arcs.length,
    gloss: gloss.length,
    pairs,
    rows,
  };
});
// 每个指标一圈「轨道」，有进度的再叠一条「弧」。三条轨道一个都不能少。
check(
  '三个环的轨道都在（圆环）',
  rings.shapes - rings.arcs - rings.gloss === 3,
  `轨道 ${rings.shapes - rings.arcs - rings.gloss} 条 / 弧 ${rings.arcs} 条 / 高光 ${rings.gloss} 条`,
);
/**
 * ⚠️ 两条**成对**断言。`pairs` 是按 `<g>` 分组的（一个指标一组），
 *    所以「3 对里 2 对缺高光」和「总共 2 条高光」是两件不同的事，
 *    而后者会**通过**。这正是「数总数、不数归属」那个老毛病。
 */
check(
  '玻璃高光和它所贴的弧成对出现',
  rings.pairs.length === 3 && rings.pairs.every((p) => p.hasArc === p.hasGloss),
  rings.pairs.map((p, i) => `#${i + 1} ${p.hasArc ? '弧' : '—'}/${p.hasGloss ? '高光' : '—'}`).join(' · '),
);
check(
  '高光贴在弧的**外缘**（半径 = 弧 + 3），不是压在中心线上',
  rings.pairs.filter((p) => p.hasGloss).length > 0 &&
    rings.pairs.filter((p) => p.hasGloss).every((p) => p.dr === 3),
  rings.pairs.filter((p) => p.hasGloss).map((p) => `Δr=${p.dr}`).join(' · ') || '(一条高光都没有)',
);
check(
  '高光是**淡的**（不透明度 < 0.6），不是又描了一圈',
  rings.pairs.filter((p) => p.hasGloss).length > 0 &&
    rings.pairs.filter((p) => p.hasGloss).every((p) => p.glossOpacity !== null && p.glossOpacity < 0.6),
  rings.pairs.filter((p) => p.hasGloss).map((p) => `α=${p.glossOpacity}`).join(' · ') || '(一条高光都没有)',
);
check('环旁边有三行读数', rings.rows.length === 3, `${rings.rows.length} 行：${rings.rows.map((r) => r.label).join('/')}`);

/**
 * ⚠️⚠️ 「未采集」和「0」必须长得不一样。
 *
 *    没有这一行，`活动时间` 会被画成一圈空轨道 + 读数 `0` —— 那是把
 *    「我们没采这一项」说成「他今天一分钟都没动」。
 *    这个项目反复栽在同一个形状上（缺数据画成 0、占位符冒充真数据）。
 *
 *    ⚠️⚠️ 判据**按行名找，不数总数**。第一版写的是「未采集恰好 1 处」，
 *      本机绿、**线上红**（报了 2 处）—— 因为线上那份索引更新，
 *      而 `activeCalories` 只在 healthsync 写过的那些日子才有（实测 10/31 天），
 *      所以「活动消耗」那一行今天也可能没有数。
 *
 *      ⇒ 写死一个总数，测的是**那一天的数据碰巧长什么样**，不是页面行为。
 *        断言该钉住的是「这一项没采集时必须写未采集」，而不是「一共几项没采集」。
 */
/**
 * ⚠️⚠️ 这条断言**改过一次，而且是被自己打红的** —— 值得记下来。
 *
 *    第一版写的是「「活动时间」写「未采集」」。它在手机端还没上报时是绿的；
 *    2026-09-29 装上带 `activeMinutes` 的版本之后，线上渲染成了「88 分钟」，
 *    于是它**红了 —— 而那是功能正常工作的证据**。
 *
 *    ⇒ 断言写成了「这一项永远是空的」，测的就成了**那一天的数据状态**，
 *      不是页面行为。数据一到位它必然红，而它红了不代表有 bug。
 *      这正是这个项目反复吃亏的那个形状。
 *
 *    ⇒ 真正的规则是：**要么是真数，要么写「未采集」，绝不许是 0。**
 *      它和手机端有没有上报无关。
 */
const timeRow = rings.rows.find((r) => r.label === '活动时间');
check(
  '「活动时间」要么是真数，要么写「未采集」—— 绝不许是 0',
  Boolean(timeRow) && (timeRow.none || parseFloat(timeRow.v) > 0),
  timeRow ? (timeRow.none ? '未采集（手机端还没上报）' : `实测 ${timeRow.v}`) : '找不到这一行',
);
// ⚠️ 补一条更硬的：**任何一个环都不许把「没采集」画成 0**。
check(
  '没有哪个环把「没采集」画成 0',
  rings.rows.every((r) => r.none || !/^0(\.0+)?$/.test(r.v.trim())),
  rings.rows.map((r) => `${r.label}=${r.none ? '未采集' : r.v}`).join(' · '),
);

/**
 * ⚠️ 读者 2026-09-29：「消耗应该是**活动消耗**，总消耗每天要格外标记出来一下」。
 *
 *    环上画的必须是**活动消耗**（能控制的那一半），总消耗单独一行。
 *    ⚠️ 这条防的是「把两者合成一个数」—— 总消耗含基础代谢（实测没活动的日子
 *      恒为 1,662），混进环里读者会以为那是自己动出来的。
 */
const kcal = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.chc__rings-row')].map((r) => ({
    label: (r.querySelector('.chc__rings-l') || {}).textContent || '',
  }));
  const tm = document.querySelector('.chc__totalmark');
  return {
    labels: rows.map((r) => r.label),
    hasTotal: Boolean(tm),
    totalText: tm ? tm.textContent.trim() : '',
  };
});
check('环上是「活动消耗」，不是总消耗', kcal.labels.includes('活动消耗'), kcal.labels.join('/'));
check(
  '总消耗单独一行标出来（含基础代谢）',
  kcal.hasTotal && /总消耗/.test(kcal.totalText) && /基础代谢/.test(kcal.totalText),
  kcal.totalText || '(没有这一行)',
);

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

// ══════════════════════════════════════════════════════════════
// 2026-09-29 第二轮：运动页 天/周/月、达标日历、心率曲线区间着色。
// ══════════════════════════════════════════════════════════════

// ── 运动屏：三段胶囊真的在驱动窗口 ────────────────────────────
//
// ⚠️ 这条测的是「**切换真的换了数据**」，不是「高亮会动」。
//    一个只改高亮、不改窗口的分段控件看起来完全正常 ——
//    读者点了「月」，标题写着月，数字还是周的那一份。
const barsOf = () => page.evaluate(() => document.querySelectorAll('.chc__rows .chc__bar').length);
await page.evaluate(() => {
  const s = document.querySelector('.stack');
  if (s) s.scrollTop = s.clientHeight;
});
await page.waitForTimeout(800);

const seg = await page.evaluate(() => ({
  items: [...document.querySelectorAll('.chc__seg-i')].map((e) => e.textContent.trim()),
  on: [...document.querySelectorAll('.chc__seg-i--on')].map((e) => e.textContent.trim()),
  groups: document.querySelectorAll('.chc__gh').length,
  big: (document.querySelector('.chc__big') || {}).textContent || '',
}));
check('运动屏有 天/周/月 三段', seg.items.join('') === '天周月', seg.items.join(' / '));
check('有且只有一档被选中', seg.on.length === 1, `选中「${seg.on[0] ?? '无'}」`);
check('有按天分组的日期头', seg.groups > 0, `${seg.groups} 个日期头`);

const barsWeek = await barsOf();
await page.evaluate(() => {
  const it = [...document.querySelectorAll('.chc__seg-i')].find((e) => e.textContent.trim() === '月');
  if (it) it.click();
});
await page.waitForTimeout(700);
const afterMonth = await page.evaluate(() => ({
  on: [...document.querySelectorAll('.chc__seg-i--on')].map((e) => e.textContent.trim())[0] ?? '',
  big: (document.querySelector('.chc__big') || {}).textContent || '',
}));
const barsMonth = await barsOf();

check('切到「月」高亮跟着走', afterMonth.on === '月', `选中「${afterMonth.on}」`);
check(
  '切档**真的换了窗口**（不是只换高亮）',
  barsMonth > barsWeek && afterMonth.big !== '',
  `柱状图 ${barsWeek} → ${barsMonth} 根；总时长 周=${seg.big} 月=${afterMonth.big}`,
);

// ── 达标日历：三种状态必须都在 ────────────────────────────────
//
// ⚠️⚠️ 这条防的是**把「没记录」画成「没达标」**。
//    那等于替读者编了一个事实：他那天可能走了两万步，只是手机没同步。
//    日历上如果没有「没记录」这个独立状态，两条断言里 `none` 会是 0。
await page.evaluate(() => {
  const s = document.querySelector('.stack');
  if (s) s.scrollTop = 0;
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.igrid__cell')][3];
  if (c) c.click();
});
await page.waitForTimeout(700);
const cal = await page.evaluate(() => {
  const dots = [...document.querySelectorAll('.chc__cal-dot')];
  const has = (d, k) => d.className.includes(k);
  const hitDot = dots.find((d) => has(d, '--hit'));
  return {
    n: dots.length,
    hit: dots.filter((d) => has(d, '--hit')).length,
    some: dots.filter((d) => has(d, '--some')).length,
    none: dots.filter((d) => !has(d, '--hit') && !has(d, '--some')).length,
    // ⚠️⚠️ 颜色，不只是 class 名 —— 这一条是**补的**。
    //    第一次跑的时候圆点全是白的：日历在弹窗里，卡片带的是 `.chc__card`，
    //    而这个类不在 `ChealthCharts.scss` 那组 `--m-*` token 的作用域列表里，
    //    于是 `var(--m, currentColor)` 退回了白色。
    //    ⚠️ 只查 class 名的话，一条**看起来完全正常**的白日历会全绿放行 ——
    //      这正是「幽灵类」第四次咬人的方式。
    hitBg: hitDot ? getComputedStyle(hitDot).backgroundColor : '',
    track: getComputedStyle(document.querySelector('.chc__cal') ?? document.body).getPropertyValue('--m-steps').trim(),
    // ⚠️⚠️ 期望色**当场解析**，不写死。
    //    第一版断言里写的是 `rgb(62, 207, 142)`（当时的 --m-steps 色值）——
    //    2026-09-29 把步数色改成三星那种黄绿（#a8e34a）之后，它立刻变红，
    //    **而页面完全是对的**。
    //    ⇒ 写死一个色值，测的就是「这个色值没被改过」，不是「这一格用了步数的颜色」。
    //      探针元素解析 `var(--m-steps)` 才是真正要断言的那个关系。
    expect: (() => {
      const p = document.createElement('div');
      p.style.color = 'var(--m-steps)';
      // ⚠️⚠️ 探针必须挂在**带 token 的那个容器里面**。
      //    第一版挂在 `document.body` 上，解析出 `rgba(255,255,255,0.96)`
      //    —— 因为 `--m-*` 那组 token 是定义在 `.chc__card` / `.chc__mosaic` /
      //    `.chc__rows` 这些**具体容器**上的（`.chc` 是个匹配不到东西的幽灵类），
      //    body 上根本没有这个自定义属性，`var()` 就落到继承来的颜色上。
      //    ⇒ 探针挂错地方，会得到一条**看起来像页面错了**的失败。
      const host = hitDot?.closest('.chc__card') ?? document.body;
      host.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    })(),
  };
});
check('达标弹窗里有日历', cal.n >= 28, `${cal.n} 格`);
check(
  '日历里「达标 / 有进度 / 没记录」三种状态都在',
  cal.hit > 0 && cal.some > 0 && cal.none > 0,
  `达标 ${cal.hit} · 有进度 ${cal.some} · 没记录 ${cal.none}`,
);
// ⚠️ 达标那格必须是**步数的绿**（#3ecf8e = rgb(62, 207, 142)），不是白、不是灰。
//    这条和上面那条的区别就是「幽灵类」的全部教训：class 名对了，
//    颜色可以完全是错的，而页面看起来照样像个日历。
check(
  '日历上「达标」那格用的是步数的颜色（不是兜底白）',
  cal.hitBg !== '' && cal.hitBg === cal.expect && cal.track !== '',
  `${cal.hitBg} vs --m-steps=${cal.track || '(空 —— 幽灵类又来了)'} 解析成 ${cal.expect}`,
);

// ── 弧形仪表盘（三星「睡眠得分」那个形状）────────────────────
//
// ⚠️⚠️ 这个组件第一版**一次都没被看过就上线了**，因为断言只数了
//    `path` 的个数 —— 而**数得出个数，数不出弧画歪了**。
//    ⇒ 下面这几条特意盯的是**几何关系**，不是元素个数：
//      · 进度弧的 dasharray 长度必须和它自己显示的那个百分比对得上
//      · 末端圆点必须落在弧上（离圆心 ≈ 半径），而不是飘在别处
const gauges = await page.evaluate(() => {
  const out = [];
  for (const g of document.querySelectorAll('.chc__gauge')) {
    const svg = g.querySelector('svg');
    const paths = svg ? [...svg.querySelectorAll('path')] : [];
    const arc = paths.find((p) => p.classList.contains('chc__gauge-arc'));
    const dot = svg ? svg.querySelector('.chc__gauge-dot') : null;
    const shown = (g.querySelector('.chc__gauge-v') || {}).textContent || '';
    const d = arc ? arc.getAttribute('d') : '';
    // 弧的圆心写死在 (60,60)、半径 46（见 GAUGE_ARC）。
    let dotR = null;
    if (dot) {
      const dx = Number(dot.getAttribute('cx')) - 60;
      const dy = Number(dot.getAttribute('cy')) - 60;
      dotR = Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;
    }
    out.push({
      paths: paths.length,
      hasArc: Boolean(arc),
      len: arc ? parseFloat(arc.style.strokeDasharray || '0') : -1,
      shown,
      // ⚠️ 开口朝下：`A 46 46 0 1 1` 里的 `1 1` 是「大弧 + 顺时针」。
      //    改成 `0 1` 会画成剩下那 120°，看起来像一张嘴。
      bigArc: /A 46 46 0 1 1/.test(d),
      dotR,
    });
  }
  return out;
});

check('达标弹窗里有仪表盘（步数 + 睡眠两个）', gauges.length === 2, `${gauges.length} 个`);
check(
  '每个仪表盘都有轨道 + 进度弧 + 末端圆点',
  gauges.every((g) => g.paths === 2 && g.hasArc),
  gauges.map((g) => `${g.paths} path`).join(' / '),
);
check(
  '弧是 240° 大弧（不是画成 120° 的「一张嘴」）',
  gauges.every((g) => g.bigArc),
  gauges.map((g) => (g.bigArc ? '✓' : '✗')).join(' '),
);
// ⚠️ 关系断言：弧长必须和**它自己显示的那个数**对得上。
//    写死一个期望值就变成了「测这个数没被改过」—— 而数字每天在变。
check(
  '进度弧的长度和显示出来的百分比一致',
  gauges.every((g) => Math.abs(g.len - parseFloat(g.shown)) < 1.5),
  gauges.map((g) => `${g.shown} vs dash ${g.len}`).join(' · '),
);
check(
  '末端圆点落在弧上（离圆心 ≈ 半径 46）',
  gauges.every((g) => g.dotR !== null && Math.abs(g.dotR - 46) < 1),
  gauges.map((g) => `r=${g.dotR}`).join(' / '),
);

// ── 关闭按钮是**叉**，不是向下的 V ────────────────────────────
//
// ⚠️ 读者 2026-09-29：「那个正方形的关闭按钮画的有问题」。
//    原来画的是 `chev`（向下的宽浅 V），16px 上糊成圆角方块，
//    而且 V 的意思是「展开/收起」，不是关闭。
//    ⚠️ 这条盯的是**回归**：有人把图标换回 chev、或者把 aspect-ratio 删了。
const closeBtn = await page.evaluate(() => {
  const b = document.querySelector('.sheet__close');
  if (!b) return null;
  const p = b.querySelector('svg path');
  const r = b.getBoundingClientRect();
  return {
    d: p ? p.getAttribute('d') || '' : '',
    w: Math.round(r.width),
    h: Math.round(r.height),
    radius: getComputedStyle(b).borderRadius,
  };
});
check(
  '关闭按钮画的是叉（不是向下的 V）',
  Boolean(closeBtn) && closeBtn.d.startsWith('M6.5 6.5') && !closeBtn.d.includes('12 15.5'),
  closeBtn ? `path=${closeBtn.d.slice(0, 28)}` : '找不到按钮',
);
check(
  '关闭按钮是圆的（不靠两个数恰好相等）',
  Boolean(closeBtn) && Math.abs(closeBtn.w - closeBtn.h) <= 1 && closeBtn.radius.includes('50%'),
  closeBtn ? `${closeBtn.w}×${closeBtn.h} radius=${closeBtn.radius}` : '—',
);

await page.evaluate(() => {
  const el = document.querySelector('.sheet');
  if (el) el.click();
});
await page.waitForTimeout(400);

// ── 心率曲线按区间着色 ────────────────────────────────────────
//
// ⚠️ 这条防的是 `bands` 那条路径静默失效 —— 退回单色之后曲线**照样画得出来**，
//    只是变成一条普通的线，看起来完全正常。
//    ⚠️ 而第一次跑它的时候它**是红的**：`bands` 只加进了类型、没加进解构，
//      运行时报 `Cannot find name` 的等价物（引用未声明的标识符），
//      弹窗直接炸 —— **而 webpack 构建是全绿的**。
await page.evaluate(() => {
  const s = document.querySelector('.stack');
  if (s) s.scrollTop = s.clientHeight;
});
await page.waitForTimeout(700);
await page.evaluate(() => {
  const c = document.querySelector('.chc__sess');
  if (c) c.click();
});
await page.waitForTimeout(800);
const hr = await page.evaluate(() => {
  const lines = [...document.querySelectorAll('.sheet__body line')];
  return {
    segs: lines.length,
    colors: [...new Set(lines.map((l) => l.getAttribute('stroke')))],
    legend: document.querySelectorAll('.chc__band').length,
  };
});
check('心率曲线是逐段上色的（≥2 种颜色）', hr.colors.length >= 2, `${hr.segs} 段 / ${hr.colors.length} 色：${hr.colors.join(' ')}`);
check('曲线下面有区间图例', hr.legend === 5, `${hr.legend} 个（应该有 5 个区间）`);
await page.evaluate(() => {
  const el = document.querySelector('.sheet');
  if (el) el.click();
});
await page.waitForTimeout(300);

await browser.close();
console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
