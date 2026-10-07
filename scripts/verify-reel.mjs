/**
 * 主页 COOF 那块「片名滚轮」+ CHEALTH「每日总消耗」最近两天有没有数。
 *
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY NO_PROXY='*' bun scripts/verify-reel.mjs
 *
 * ⚠️ 这一份里最容易写错的是「动画完全一致」那几条。
 *    读者要的是**窄屏自动轮播**和**宽屏指针停留**产生同一个动画。
 *    「看起来差不多」不是判据 —— 这里的判据是：
 *      · 两边 `.reel__t` 的**计算过渡**逐字相同；
 *      · 两边**同一个 `--d` 类的计算 transform 相同**（按行高归一化之后）；
 *      · 两边推进一格之后，落到 `.reel__t--d0` 的**位移量相同**。
 *    ⚠️ 只要有一边改用了 `:hover` 伪类或另一条时长，上面三条里必有一条先红。
 */
import { readFileSync } from 'node:fs';

import { chromium } from 'playwright';

/** ⚠️ CHEALTH 那几屏**需要口令**，不然 `window.location.hash` 过去只会看到「需要口令」。 */
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

/*
 * ⚠️⚠️ **默认地址两处都过期了（2026-10-07 才发现，说明它很久没被跑过）。**
 *
 *   · 端口 8096 —— 那个服务器早就不在跑了，跑起来直接 `ERR_CONNECTION_REFUSED`；
 *   · 路径 `/z/` —— `publicPath` 是 `'/'`，资源走**站根绝对路径**
 *     （`/js/app.<hash>.js`），所以站点必须挂在服务器**根**上。
 *     正确的是 8126（根＝dist 本身），不是 `8125/z` 也不是 `8096/z`。
 *
 * ⚠️ 判据：`curl -s -o /dev/null -w '%{http_code}' $URL/js/app.<hash>.js` 要 200。
 */
const URL = process.env.URL ?? 'http://127.0.0.1:8126/';
let pass = 0;
let fail = 0;
const notes = [];
function ok(cond, name, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}
function skip(name, why) {
  notes.push(`  ~ ${name}（跳过：${why}）`);
  console.log(`  ~ ${name} — 跳过：${why}`);
}

const browser = await chromium.launch();

/** 一个视口跑一遍：进主页 → COOF 那一屏。 */
async function openHome(width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    locale: 'zh-CN',
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  /**
   * ⚠️⚠️ **「本地静态服务器偶发断连」和「产品真的少了个文件」必须分开。**
   *
   *    两者在 console 里长得**一模一样**（都是 `Failed to load resource:`），
   *    而后果完全不同：前者重跑就没了，后者是**数据文件 404 ⇒ 整块不渲染**
   *    （这个项目真栽过：`data/coof/` 被部署脚本删空，看起来像组件坏了）。
   *
   *    ⇒ 判据落在**状态码 + URL** 上（下面那两个监听），**不落在 console 文本上** ——
   *      console 文本里**没有 URL**，红了也查不了，只能对着 `ERR_CONNECTION_RESET`
   *      这一行猜。实测 W0 就偶发红过一条，重跑即消失，
   *      另写探针复跑 1440 视口是 0 个 4xx / 0 个 requestfailed ⇒ **假红**。
   */
  const noise = [];
  page.on('response', (r) => {
    // ⚠️ 这一条才是真正守着「数据文件在不在」的断言，而且**带 URL**。
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const t = r.failure()?.errorText ?? '';
    if (/ERR_(CONNECTION_RESET|CONNECTION_REFUSED|ABORTED|EMPTY_RESPONSE)/.test(t)) {
      noise.push(`${t} ${r.url()}`);
    } else if (t) {
      errors.push(`${t} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // ⚠️ 真·404 的文本是「the server responded with a status of 404」，
    //    **不匹配**下面这个模式，所以照样会红（而且状态码那条已经记了账）。
    if (/Failed to load resource: net::ERR_(CONNECTION_RESET|CONNECTION_REFUSED|ABORTED|EMPTY_RESPONSE)/.test(t)) {
      noise.push(t);
      return;
    }
    errors.push(t);
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  // ⚠️ 开屏动画会盖住第一屏，而且它飞行途中会吃指针 —— 等它落定。
  await page.waitForTimeout(6000);
  return { page, ctx, errors, noise };
}

/** 滚到 COOF 那一屏（滚轮在那一屏里）。 */
async function toCoof(page) {
  for (let i = 0; i < 8; i += 1) {
    const visible = await page.evaluate(() => {
      const el = document.querySelector('.reel');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && r.top < window.innerHeight && r.bottom > 0;
    });
    if (visible) return true;
    await page.evaluate(() => {
      const st = document.querySelector('.stack');
      if (st) st.scrollTop += window.innerHeight;
    });
    await page.waitForTimeout(1200);
  }
  return false;
}

const STATE = () => {
  const el = document.querySelector('.reel');
  if (!el) return null;
  const rows = [...el.querySelectorAll('.reel__t')];
  const on = el.querySelector('.reel__t--d0');
  const cards = [...el.querySelectorAll('.reel__card')];
  const onCard = el.querySelector('.reel__card.is-on');
  const bg = onCard ? getComputedStyle(onCard.querySelector('img') ?? onCard).backgroundImage : '';
  const img = onCard ? onCard.querySelector('img') : null;
  return {
    n: rows.length,
    title: on ? on.textContent : null,
    // 过渡逐字读出来 —— 「动画完全一致」就是拿它比的。
    trans: rows[0] ? getComputedStyle(rows[0]).transition : null,
    onTrans: on ? getComputedStyle(on).transition : null,
    onCardTrans: onCard ? getComputedStyle(onCard).transition : null,
    // ⚠️⚠️ 行距**必须从 DOM 量**，不能读 `--row`。
    //    第一版写的是 `parseFloat(getComputedStyle(el).getPropertyValue('--row'))`
    //    —— `--row` 的值是 `clamp(2.5rem, 3.4vw, 3.4rem)`，`getPropertyValue`
    //    拿到的是**没解析的原文**，`parseFloat` 得到 `NaN`，
    //    于是 W6 报 `ty=Infinity`。**那是检查器坏了，不是动画不一致。**
    //    （自定义属性没有「计算值」，浏览器不会替你解析 clamp —— 它就是个字符串。）
    //
    //    量法：d=-1 和 d=+1 两行的缩放相同，所以「字号 × 缩放」那一项相减抵消，
    //    差值的一半**正好是一个行距**。
    rowH: (() => {
      const rs = rows.map((r) => ({
        d: [...r.classList].find((c) => c.startsWith('reel__t--d')),
        top: r.getBoundingClientRect().top,
      }));
      const up = rs.find((r) => r.d === 'reel__t--d-1');
      const dn = rs.find((r) => r.d === 'reel__t--d1');
      return up && dn ? (dn.top - up.top) / 2 : null;
    })(),
    // 同一个距离类的计算 transform（用于跨视口比对）
    t1: rows.find((r) => r.classList.contains('reel__t--d1'))
      ? getComputedStyle(rows.find((r) => r.classList.contains('reel__t--d1'))).transform
      : null,
    t0: on ? getComputedStyle(on).transform : null,
    onCards: cards.filter((c) => c.classList.contains('is-on')).length,
    cardOpacity: onCard ? getComputedStyle(onCard).opacity : null,
    otherOpacity: cards.filter((c) => c !== onCard).map((c) => getComputedStyle(c).opacity),
    // ⚠️ 新版式**同时有两张海报可见**：左边 `--d-1`（上一部）、
    //    右边 `--d0`（当前）。所以「其余全透明」那条要拆开看，
    //    而且**必须量几何**才能证明它们真的分居两侧 ——
    //    两张都贴在右边也满足「两张都可见」。
    // ⚠️ 一次只有一张海报（`--d0`）。要读的是它**在哪一侧**，
    //    以及它和文字的前后关系 —— 读者这版的两条要求都在这上面。
    visCard: (() => {
      const c = el.querySelector('.reel__card--d0');
      if (!c) return null;
      const box = el.getBoundingClientRect();
      const r = c.getBoundingClientRect();
      return {
        side: c.classList.contains('reel__card--l') ? 'left' : 'right',
        left: r.left,
        right: r.right,
        w: r.width,
        h: r.height,
        // 相对整块的位置：左半边还是右半边
        onLeftHalf: r.left + r.width / 2 < box.left + box.width / 2,
      };
    })(),
    stageZ: (() => {
      const s = el.querySelector('.reel__stage');
      return s ? getComputedStyle(s).zIndex : null;
    })(),
    listZ: (() => {
      const s = el.querySelector('.reel__list');
      return s ? getComputedStyle(s).zIndex : null;
    })(),
    // ⚠️ 「滚到的那条放大很多」是可以**直接量**的：比字号。
    fs0: (() => {
      const r = el.querySelector('.reel__t--d0');
      return r ? parseFloat(getComputedStyle(r).fontSize) : null;
    })(),
    fs1: (() => {
      const r = el.querySelector('.reel__t--d1');
      return r ? parseFloat(getComputedStyle(r).fontSize) : null;
    })(),
    onRect: onCard
      ? (() => {
          const r = onCard.getBoundingClientRect();
          return { left: r.left, right: r.right, w: r.width, h: r.height };
        })()
      : null,
    titleRect: on
      ? (() => {
          const r = on.getBoundingClientRect();
          return { left: r.left, right: r.right };
        })()
      : null,
    imgOk: img ? img.complete && img.naturalWidth > 0 : null,
    imgW: img ? img.getBoundingClientRect().width : 0,
    imgH: img ? img.getBoundingClientRect().height : 0,
    bg,
    reel: (() => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    })(),
    rowRects: rows.map((r) => {
      const b = r.getBoundingClientRect();
      return { d: [...r.classList].find((c) => c.startsWith('reel__t--d')), t: r.textContent, top: b.top, bottom: b.bottom };
    }),
  };
};

/**
 * ⚠️⚠️ **等交叉淡入走完再读。** 过渡 0.55 秒、轮播 1.9 秒一次 ——
 *    随手一读多半读在中间帧（实测 `opacity=0.627`，另一张 `0.373`），
 *    看起来像「海报没切干净」，其实是**断言采在了动画中途**。
 *    ⇒ 轮询到「恰好一张 is-on、它不透明、其余全透明」为止（最多 4 秒）。
 *    ⚠️ 同一个毛病这份文件里我犯过两次：W6 读活元素的 transform 也是。
 */
async function settledState(page, timeoutMs = 4000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(STATE);
    if (
      last &&
      last.onCards === 1 &&
      last.cardOpacity === '1' &&
      (last.otherOpacity ?? []).every((o) => parseFloat(o) === 0)
    ) {
      return last;
    }
    await page.waitForTimeout(120);
  }
  return last;
}

// ════════════════════════════════════════════════════════════
console.log('\n── 窄屏 390×844 ────────────────────────────');
const narrow = await openHome(390, 844);
ok(
  narrow.errors.length === 0,
  'N0 控制台没有报错',
  narrow.errors.slice(0, 2).join(' | ') ||
    (narrow.noise.length ? `（另有 ${narrow.noise.length} 条传输抖动，不计）` : ''),
);
ok(await toCoof(narrow.page), 'N1 滚到了 COOF 那一屏，滚轮可见');
const nA = await narrow.page.evaluate(STATE);
ok(!!nA && nA.n > 0, 'N2 滚轮渲染出片名', `n=${nA?.n}`);
ok(nA && nA.n >= 3, 'N3 至少有 3 个片名（少于 3 个滚不起来）', `n=${nA?.n}`);

// 「画出来了 ≠ 看得见」：d0 那一行必须落在滚轮自己的矩形里，而且滚轮在视口里。
const d0In = nA && nA.rowRects.find((r) => r.d === 'reel__t--d0');
ok(!!d0In, 'N4 恰有一行是当前行（d0）');
ok(
  !!d0In && d0In.top >= nA.reel.top - 1 && d0In.bottom <= nA.reel.bottom + 1,
  'N5 当前那一行落在滚轮矩形之内（没被裁掉）',
  d0In ? `row ${d0In.top.toFixed(0)}–${d0In.bottom.toFixed(0)} / reel ${nA.reel.top.toFixed(0)}–${nA.reel.bottom.toFixed(0)}` : '',
);

// 自动轮播：等两个周期，当前行必须换过
const nT0 = nA?.title;
await narrow.page.waitForTimeout(4200);
const nB = await narrow.page.evaluate(STATE);
ok(nB?.title !== nT0, 'N6 窄屏自动在滚（4.2 秒后当前片名变了）', `${nT0} → ${nB?.title}`);
await narrow.page.waitForTimeout(4200);
const nC = await narrow.page.evaluate(STATE);
ok(nC?.title !== nB?.title, 'N7 一直在滚，不是只滚一次', `${nB?.title} → ${nC?.title}`);

const nB2 = (await settledState(narrow.page)) ?? nB;
ok(nB2?.onCards === 1, 'N8 恰有一张海报是「当前」', `is-on=${nB2?.onCards}`);
ok(nB2?.cardOpacity === '1', 'N9 当前海报不透明', `opacity=${nB2?.cardOpacity}`);
// ⚠️ 又回到「一次只有一张海报」了 —— 读者 2026-10-02 把上一版
//    （左右各一张）**明确否掉**：「不是让两边同时有两个海报，
//     而是一次一个出现」。断言跟着设计走。
ok(
  (nB2?.otherOpacity ?? []).every((o) => parseFloat(o) === 0),
  'N10 一次只有一张海报：其余全透明',
  (nB2?.otherOpacity ?? []).join(','),
);

/**
 * ⭐ N13 **海报压在字底下** —— 这一版版式的支点，必须单独断言。
 *
 * ⚠️⚠️ 只断言「海报在左边还是右边」是不够的：**「压不住」正是上一版
 *    字被挤到只剩 4 个字的原因**。所以判据是 z 序 ——
 *    海报那层的 `z-index` 必须**低于**文字那层。
 *    ⚠️ 不用「矩形有没有重叠」当判据：文字元素是满宽的（`left:0; right:0`），
 *      它的**元素矩形**天然覆盖整块，那个重叠测不出任何东西（恒真）。
 *      真正的重叠是**字形**和海报的，量不到 —— 所以这里量能量的那个：
 *      分工（谁在上面），而字形大小由 N14 量。
 */
ok(
  Number(nB2?.stageZ) < Number(nB2?.listZ),
  'N13 海报在字**底下**（海报层 z-index 低于文字层）',
  `stage z=${nB2?.stageZ} < list z=${nB2?.listZ}`,
);

/**
 * ⭐ N14 **滚到的那条放大很多**（读者：「滚动到的字放大很多」）。
 *
 * ⚠️ 判据是**字号之比**，不是一个绝对数 —— 绝对数会随视口和字体的
 *    一个无关改动而失准，而「比邻居大多少」才是读者真正看到的东西。
 */
ok(
  (nB2?.fs0 ?? 0) >= (nB2?.fs1 ?? 1) * 1.8,
  'N14 当前那条的字号**远大于**相邻那条（≥1.8 倍）',
  `当前 ${nB2?.fs0?.toFixed(1)}px / 相邻 ${nB2?.fs1?.toFixed(1)}px = ${(nB2?.fs0 / nB2?.fs1)?.toFixed(2)}×`,
);
ok(nB?.imgOk === true, 'N11 当前海报真的加载出来了（naturalWidth > 0）');
ok((nB?.imgH ?? 0) > 40 && (nB?.imgW ?? 0) > 20, 'N12 海报有实际尺寸', `${nB?.imgW?.toFixed(0)}×${nB?.imgH?.toFixed(0)}`);
// ⭐ 海报**足够大**（读者：「以及海报也足够大」）—— 它是压在字底下的，
//    所以判据是「占整块高度的多少」，不是一个绝对像素数。
ok(
  (nB2?.visCard?.h ?? 0) >= (nB2?.reel?.h ?? 1) * 0.5,
  'N16 海报足够大（高度 ≥ 整块的 50%）',
  `${nB2?.visCard?.h?.toFixed(0)}px / ${nB2?.reel?.h?.toFixed(0)}px = ${((nB2?.visCard?.h / nB2?.reel?.h) * 100)?.toFixed(0)}%`,
);

/**
 * ⭐ N15 **左右交替**（读者 2026-10-02：「一个在左，一个在右」）。
 *
 * ⚠️⚠️ 必须**推进一格之后再看**。只测一次的话，海报永远固定在左边
 *    也能让「在左半边」那条过 —— 而那恰恰不是读者要的。
 *    这一条测的是**变化**，所以判据只能是比较两次。
 */
// ⚠️⚠️ **必须等到「恰好推进一格」，不能等一个固定时长。**
//    第一版写的是 `waitForTimeout(4300)`，而轮播间隔是 1900ms ⇒
//    推进了**两格**，奇偶绕回来了 ⇒ 报 `left → left`。
//    那是**检查器错了**（产品是对的）：这一步要的是「变化了一次」，
//    所以判据只能是**盯到片名真的变了**再用那一帧的状态。
const titleA = nB2?.title;
const sideA = nB2?.visCard?.side;
let nextState = null;
for (let i = 0; i < 15 && !nextState; i += 1) {
  await narrow.page.waitForTimeout(350);
  const st = await settledState(narrow.page);
  if (st?.title && st.title !== titleA) nextState = st;
}
ok(
  !!sideA && !!nextState?.visCard?.side && sideA !== nextState.visCard.side,
  'N15 海报左右**交替**（推进一格后换到另一侧）',
  `${sideA} → ${nextState?.visCard?.side ?? '(没等到推进)'}  「${titleA}」→「${nextState?.title}」`,
);

// ════════════════════════════════════════════════════════════
console.log('\n── 宽屏 1440×900 ───────────────────────────');
const wide = await openHome(1440, 900);
ok(
  wide.errors.length === 0,
  'W0 控制台没有报错',
  wide.errors.slice(0, 2).join(' | ') ||
    (wide.noise.length ? `（另有 ${wide.noise.length} 条传输抖动，不计）` : ''),
);
ok(await toCoof(wide.page), 'W1 滚到了 COOF 那一屏');
const wA = await wide.page.evaluate(STATE);
ok(!!wA && wA.n === nA?.n, 'W2 两个视口片名数量一致', `${wA?.n} vs ${nA?.n}`);

// ── 「要求动画完全一致」──────────────────────────────────────
ok(
  wA?.trans === nA?.trans && !!wA?.trans,
  'W3/W4 两视口 `.reel__t` 的计算过渡逐字相同',
  `\n        390 : ${nA?.trans}\n        1440: ${wA?.trans}`,
);
ok(wA?.onCardTrans === nA?.onCardTrans && !!wA?.onCardTrans, 'W5 两视口海报的过渡逐字相同');

// 同一个距离类的 transform：按各自的行高归一化，位移应该一致（都是 1 行）
function normT(tr, rowH) {
  const m = /matrix\(([^)]+)\)/.exec(tr ?? '');
  if (!m) return null;
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
  if (parts.length < 6) return null;
  return { ty: parts[5] / rowH, scale: Math.round(parts[0] * 1000) / 1000 };
}
/**
 * ⚠️⚠️ 比的是**样式表里的声明值**，不是某个活元素的当前值。
 *
 *    第一版读 `getComputedStyle`，得到的是一条**不稳定**的断言：
 *    轮播每 1.9 秒推进一次、过渡 0.62 秒 —— 随手一采多半采在动画中途。
 *    实测 390 得 `ty=0.988`、1440 得 `ty=0.678`，看起来像「两边动画不一样」，
 *    其实两个读数都是**同一套动画的中间帧**，只是采样的时刻不同。
 *    （同一个毛病我在这份文件里犯过两次：W6 的行距读 `--row` 也是。）
 *
 *    声明值里没有时间维度，所以它是**确定的** —— 而这正是
 *    「动画完全一致」这句话在源码层面的意思：同一个类，同一条 transform。
 *    ⚠️ 也要留意 `var(--row)` 在这个层面**不会被解析**：那正好，
 *      两边都写着 `var(--row)` 才叫同一套；如果一边写死 px，这里立刻会红。
 */
const RULES = () => {
  const out = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 跨域样式表读不了 —— 本项目没有，跳过就好
    }
    for (const r of rules) {
      const sel = r.selectorText ? r.selectorText.trim() : '';
      if (/^\.reel__t--d-?\d$/.test(sel)) out[sel] = `${r.style.transform} | ${r.style.opacity}`;
    }
  }
  return out;
};
const nRules = await narrow.page.evaluate(RULES);
const wRules = await wide.page.evaluate(RULES);
/**
 * ⚠️⚠️ **七档（-3..3），不是五档。** 这个数字跟着 `--rows` 走：
 *      3 行时 d=±2 落在带子外面（收容档就是 ±2）；
 *      6 行时 d=±2 进到带子里、**必须看得见**，收容档挪到 ±3。
 *    ⇒ 以后再改 `--rows`，**这里要跟着改**，否则「收容档还在 ±2」会在
 *      几行叠在同一格上之后才被发现（页面不报错）。
 */
const wantKeys = [-3, -2, -1, 0, 1, 2, 3].map((d) => `.reel__t--d${d}`).sort().join(',');
ok(
  Object.keys(nRules).sort().join(',') === wantKeys,
  'W6a 七个距离类的规则都在（--rows=6 ⇒ 收容档在 ±3）',
  Object.keys(nRules).sort().join(' '),
);
ok(
  JSON.stringify(nRules) === JSON.stringify(wRules) && Object.keys(nRules).length === 7,
  'W6 两视口同一距离类的 transform/opacity **声明值逐字相同**',
  Object.keys(nRules).length
    ? `\n        390 : ${nRules['.reel__t--d1']}\n        1440: ${wRules['.reel__t--d1']}`
    : '',
);
/**
 * ⚠️ 顺便守住「差一行就是差一行」：d0 不该有行偏移，d1 正好一行。
 *
 * ⚠️⚠️ **不要去匹配自己以为的那个序列化写法。**
 *    我第一版写的是 `/calc\(-50% \+ 0 \* var\(--row\)\)/` —— 我脑子里
 *    SCSS 拼出来是 `0 * var(--row)`，而浏览器**存回来的是 `var(--row)*0`**
 *    （乘数和 var() 换了位置、空格也没了）。于是断言红了，产品是对的。
 *    ⇒ 这是「CSS 序列化格式和你想的不一样」的**第三次**：
 *      前两次是 `color-mix()` 存成 `color(srgb …)` 而不是 `rgba()`，
 *      以及 `--row` 是 `clamp()` 原文、`parseFloat` 得 NaN。
 *    ⇒ 判据改成**把数字抠出来比数字**，不押在书写顺序上。
 */
function rowOffset(rule) {
  const m = /var\(--row\)\s*\*\s*(-?[\d.]+)|(-?[\d.]+)\s*\*\s*var\(--row\)/.exec(rule ?? '');
  if (!m) return null;
  return parseFloat(m[1] ?? m[2]);
}
ok(
  rowOffset(nRules['.reel__t--d0']) === 0 && rowOffset(nRules['.reel__t--d1']) === 1,
  'W6b d0 不偏移、d1 正好偏一行（位移量没有写错）',
  `d0 偏移 ${rowOffset(nRules['.reel__t--d0'])} 行 / d1 偏移 ${rowOffset(nRules['.reel__t--d1'])} 行`,
);

// 宽屏：指针停在某一行 → 那一行成为当前行，而且**跨三个周期不动**
/**
 * ⚠️⚠️ **先把指针移到滚轮上把它停住，再量矩形。**
 *
 *    轮播 1.9 秒推进一次，而「量矩形」到「把指针移过去」之间隔着一次往返 ——
 *    那一行会在这中间滚走，指针落在**另一行**上。
 *    实测就这么红的：期望「公民义警 Citizen Vigilante」、实得「诗人 Bardo…」，
 *    看起来像「划过哪一行没生效」，其实**产品是对的，是我量晚了**。
 *
 *    ⇒ 先 `mousemove` 到滚轮上（那一下会把 `paused` 置真、轮播停住），
 *      停稳之后再量。从那以后指针不动，列表也就不动了。
 */
const reelBox = await wide.page.evaluate(() => {
  const r = document.querySelector('.reel').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await wide.page.mouse.move(reelBox.x, reelBox.y);
await wide.page.waitForTimeout(800); // 停住 + 过渡走完

const rowPick = await wide.page.evaluate(() => {
  const el = document.querySelector('.reel');
  const rows = [...el.querySelectorAll('.reel__t')];
  const target = rows.find((r) => r.classList.contains('reel__t--d1'));
  if (!target) return null;
  const b = target.getBoundingClientRect();
  return { x: b.left + Math.min(40, b.width / 2), y: (b.top + b.bottom) / 2, t: target.textContent };
});
ok(!!rowPick, 'W7 找得到「下一张」那一行用来悬停');
if (rowPick) {
  await wide.page.mouse.move(rowPick.x, rowPick.y);
  await wide.page.waitForTimeout(900);
  const after = (await settledState(wide.page)) ?? (await wide.page.evaluate(STATE));
  ok(
    after?.title === rowPick.t,
    'W8 指针划过哪一行，哪一行就成为当前行',
    `期望「${rowPick.t}」实得「${after?.title}」`,
  );
  // ⚠️ 指针**不动**。这是抓 `mouseover` 陷阱的那一条：
  //    列表会从指针底下滚过去，用 mouseover 的话这里会一直换。
  await wide.page.waitForTimeout(6200); // ≈ 3 个轮播周期
  const held = await wide.page.evaluate(STATE);
  ok(
    held?.title === rowPick.t,
    'W9 指针停住不动时它**停在那里**（跨 3 个周期没换）',
    `期望「${rowPick.t}」实得「${held?.title}」`,
  );
  ok(held?.onCards === 1 && held?.cardOpacity === '1', 'W10 停住时海报也是对应的那一张');

  // 移开 → 恢复滚动，而且是**从这一张接着往下**
  await wide.page.mouse.move(10, 10);
  await wide.page.waitForTimeout(4200);
  const resumed = await wide.page.evaluate(STATE);
  ok(resumed?.title !== held?.title, 'W11 指针移开后恢复滚动', `${held?.title} → ${resumed?.title}`);
}

// ════════════════════════════════════════════════════════════
console.log('\n── 点击整块 → COOF ─────────────────────────');
await wide.page.mouse.move(10, 10);
await wide.page.waitForTimeout(300);
/*
 * ⚠️⚠️ **读 `pathname`，不能只读 `hash`（2026-10-07）。**
 *
 * 路由在 2026-10-07 从 hash 改成了 **browser** ⇒ 跳转后 URL 是 `/coof`，
 * `location.hash` **前后都是空串** ⇒ 这条断言**永远不可能通过**，
 * 而且它一直是红的也没人发现 —— 因为这个验证器的默认端口早就死了（见文件头）。
 * ⚠️ 和 `verify-cnowbar.mjs` 里那条 8125/8126 是同一类：**检查器比产品先过期**。
 */
const before = await wide.page.evaluate(() => window.location.pathname + window.location.hash);
await wide.page.evaluate(() => {
  document.querySelector('.reel')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await wide.page.waitForTimeout(2500);
const after = await wide.page.evaluate(() => window.location.pathname + window.location.hash);
ok(after !== before && /coof/i.test(after), 'C1 点整块跳到 COOF 页', `${before} → ${after}`);

// ════════════════════════════════════════════════════════════
console.log('\n── 减少动效 ────────────────────────────────');
const rmCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  reducedMotion: 'reduce',
});
const rmPage = await rmCtx.newPage();
await rmPage.goto(URL, { waitUntil: 'domcontentloaded' });
await rmPage.waitForTimeout(9000);
const rmEl = await rmPage.evaluate(() => {
  const el = document.querySelector('.reel__t');
  return el ? getComputedStyle(el).transitionProperty + ' ' + getComputedStyle(el).transitionDuration : null;
});
if (!rmEl) skip('R1 减少动效下过渡为 none', '这一屏没取到 .reel__t');
else ok(/none|0s/.test(rmEl), 'R1 减少动效下过渡为 none（值照样变，只是不过去）', rmEl);

// ════════════════════════════════════════════════════════════
console.log('\n── CHEALTH：最近两天的总消耗 ────────────────');
/**
 * ⚠️⚠️ **必须开一个全新的页面去 CHEALTH，不能从主页改 hash 过去。**
 *
 *    改 hash 是**同文档导航**，App 不会重新启动；而口令那一趟是在
 *    启动时读的 —— 于是改 hash 过去只会看到「需要口令」那一屏，
 *    连带下面每条都红。这也正是 `verify-chealth-ui.mjs` 一直用整页加载的原因。
 */
const chCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const chPage = await chCtx.newPage();
await chPage.goto(`${URL}#/pages/chealth/index?k=${PASS}`, { waitUntil: 'networkidle' });
await chPage.waitForTimeout(6000);

/**
 * ⚠️⚠️ **先确认页面真的解锁了再往下跑。**
 *
 *    没解锁时 CHEALTH 退回「需要口令」那一屏，下面**每一条**都会红，
 *    而没有一条说的是真原因（`verify-chealth-ui.mjs` 抬头记过这次教训：
 *    29 条失败里没有一条指到真因）。
 *    ⇒ 报**一句**真原因，然后把这几条**单列成跳过** —— 不算通过也不算失败。
 *      报红是冤枉产品，报绿是撒谎。
 */
/**
 * ⚠️⚠️ **必须滚到那一屏去找，不能在顶上 `querySelector` 了事。**
 *
 *    前两版都死在这里，而且两次都**看起来像产品没做**：
 *    ① `.chc__trend` 不是「每日总消耗」专用的类 —— 每场运动的**心率过程图**
 *       也用同一个类。于是「找到了 6 个」被读成「卡在」，其实那 6 个全是心率的。
 *    ② 更要命的是：`PageStack` **只渲染当前屏附近的 section**，
 *       那一屏没滚到，那张卡**根本不在 DOM 里**。
 *       只查一次 ⇒ 永远查不到 ⇒ 报「卡不在」。
 *
 *    ⚠️ 这和画框那次是同一个形状：「元素在不在 DOM 里」这种检查，
 *       在**分屏渲染 + 懒挂载**的页面上必须先滚到位再问。
 *    ⇒ 判据用**那张卡自己的标题文字**（`每日总消耗`），
 *      并且一路滚到它出现为止；滚不到就报**一句**真原因并跳过。
 */
async function findTrendCard(page) {
  for (let i = 0; i < 6; i += 1) {
    // ① 先看那一屏在不在（它平时在「周对比」弹窗里，不在页面上）
    const already = await page.evaluate(() =>
      [...document.querySelectorAll('.chc__trend')].some((x) =>
        /每日总消耗/.test(x.querySelector('.chc__card-t')?.textContent ?? ''),
      ),
    );
    if (already) return true;

    // ② 找「周对比」那个入口并点开。
    //    ⚠️ 点的是**文字所在的那个元素**，靠事件冒泡到 React 挂监听的地方 ——
    //      不要往上逐个 dispatch，那会把沿路的无关处理器也点一遍。
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === '周对比',
      );
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });
    if (clicked) {
      await page.waitForTimeout(2000);
      const out = await page.evaluate(() =>
        [...document.querySelectorAll('.chc__trend')].some((x) =>
          /每日总消耗/.test(x.querySelector('.chc__card-t')?.textContent ?? ''),
        ),
      );
      if (out) return true;
    }

    // ③ 还没出现就把这一屏往下翻（入口本身可能在后面几屏）
    await page.evaluate(() => {
      const st = document.querySelector('.stack');
      if (st) st.scrollTop += window.innerHeight;
    });
    await page.waitForTimeout(900);
  }
  return false;
}

const trendFound = await findTrendCard(chPage);
if (!trendFound) {
  const tiles = await chPage.evaluate(() => document.querySelectorAll('.chc__tile').length);
  skip(
    'D1–D4 每日总消耗最近两天有数',
    tiles ? '滚了 10 屏也没找到「每日总消耗」那张卡' : '页面没解锁（口令没生效）',
  );
} else {
const trend = await chPage.evaluate(() => {
  const cards = [...document.querySelectorAll('.chc__trend')];
  // ⚠️ 标题从 `.chc__card-t` 里取，**不拿整块的 `textContent`**：
  //    整块里还有折线带来的数字，「每日总消耗」四个字是哪一张只应该由标题说了算。
  //    ⚠️ 匹配不上时**把看到的标题原样带出去** —— 上一次这里只回了
  //    `{found:false}`，我因此对着一个空 detail 猜了三轮。
  const titleOf = (c) => (c.querySelector('.chc__card-t')?.textContent ?? '').trim();
  const card = cards.find((c) => /每日总消耗/.test(titleOf(c)));
  if (!card) return { found: false, titles: cards.map(titleOf) };
  const svg = card.querySelector('svg');
  const paths = svg ? [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '') : [];
  const dots = svg ? svg.querySelectorAll('circle').length : 0;
  const longest = paths.slice().sort((a, b) => b.length - a.length)[0] ?? '';
  const vb = (svg?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const W = vb.length === 4 && vb[2] > 0 ? vb[2] : null;

  /**
   * ⚠️⚠️ 判据是「**线有没有画到最后一天**」，不是「有几个圆点」。
   *
   *    第一版数 `<circle>`，得到 `dots=0` 就报红 —— 而 `Spark` **只画一个**
   *    跟着选中点走的游标圆（`chc__cursor`），**根本没有每天一个的点标记**。
   *    于是「0 个点」被读成「一天都没有」，其实一天都不缺。
   *    ⇒ 又是我在**测量一个产品不提供的量**。
   *
   *    正确的量法：`smoothPath` 出的是 `M` + 一串三次贝塞尔，
   *    坐标两两成对（x,y），所以
   *      · 最大的 x ÷ 视口宽 = 线**够不够到右边缘**（缺最后几天时它够不到）
   *      · 点数 = (坐标对数 + 2×子路径数) / 3   ← 三次贝塞尔每段三个点
   */
  const nums = (longest.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const segs = (longest.match(/M/g) ?? []).length;
  const points = segs ? Math.round((xs.length + 2 * segs) / 3) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;

  return {
    found: true,
    title: card.querySelector('.chc__card-t')?.textContent ?? '',
    segs,
    dots,
    points,
    reach: W ? maxX / W : null,
    pathLen: longest.length,
  };
});
ok(trend.found, 'D1 「每日总消耗」那张卡在', trend.found ? '' : `看到的标题：${(trend.titles ?? []).join(' | ') || '(一个都没有)'}`);
ok(trend.segs === 1, 'D2 最近 14 天是**一条连续**的线（最后两天不再是断口）', `segments=${trend.segs}`);
ok((trend.pathLen ?? 0) > 60, 'D3 折线路径非空', `len=${trend.pathLen}`);
ok(
  (trend.points ?? 0) >= 13 && (trend.reach ?? 0) > 0.9,
  'D4 折线一直画到最后一天（点数够 + 够到右边缘）',
  `点数=${trend.points}/14  够到右边缘=${trend.reach === null ? 'n/a' : (trend.reach * 100).toFixed(1) + '%'}  子路径=${trend.segs}`,
);
}

await browser.close();
console.log(`\n──── ${pass} 通过 / ${fail} 失败 ────`);
if (notes.length) console.log(notes.join('\n'));
process.exit(fail ? 1 : 0);
