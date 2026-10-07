#!/usr/bin/env bun
/*
 * **滚动与动效的保真度** —— 补上 420 条几何断言看不见的那一类。
 *
 * 用法：bun scripts/verify-scroll.mjs [BASE]
 *
 * ── 为什么要有这个文件（2026-10-07，读者报的两个症状）──────────────
 *
 * 读者：「主页**滑动不下去**到 01COOF」「chealth 还有轮转这里都**狂闪**」。
 * 而 `verify-cnowbar.mjs` 那 420 条**全绿** —— 因为它们量的是
 * **几何和层级**（元素在哪、压没压住、让位够不够），
 * 这两条坏的都是**交互与动效**：
 *
 *   · **滚动保真**：`.stack` 的 scrollHeight/clientHeight 全都正常，
 *     但**写进去的 scrollTop 会被写回 0** —— 容器"看起来"完全没问题。
 *   · **动效抖动**：入场动画被反复重启（表现是"闪"），
 *     而任何静态断言都看不见"重启"这件事。
 *
 * ⇒ 判据要直接对着**行为**：
 *   ① 直写 `scrollTop = N`，等一会儿**读回来还在不在**（而不是"能不能写"）；
 *   ② **真滚轮**滚一下，读回来还在不在（合成的 `scrollTop=` 和真滚轮走的是两条路）；
 *   ③ ⚠️ **必须真的动过** —— 否则"容器根本不能滚"也会被算成通过
 *      （FACT 纪律 6：退化的数据能骗过"在范围内"这类断言）。
 *
 * ⚠️ 这个 bug 的教训值得单独记：我在这条上**连错两次**（先怪 `onScroll`、
 *    再怪 `:not()` 抬起特异型），两个 A/B 都否掉了。
 *    最后是**写进去读回来**一次就量到了。**先量，再改。**
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8126';
const VPS = [
  { w: 1440, h: 900, tag: '桌面 1440' },
  { w: 390, h: 844, tag: '手机 390' },
];

let pass = 0;
let fail = 0;
const t = (ok, msg) => {
  if (ok) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
};

const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-bypass-list=*'] });

for (const vp of VPS) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5500);

  const geom = await p.evaluate(() => {
    const st = document.querySelector('.stack');
    if (!st) return null;
    return { sh: st.scrollHeight, ch: st.clientHeight, snap: getComputedStyle(st).scrollSnapType };
  });
  t(!!geom && geom.sh > geom.ch + 100, `${vp.tag} —— 滚动容器确实有可滚的内容（${geom?.sh}/${geom?.ch}）`);

  // ① 直写 → 读回
  const STEP = Math.round((geom?.ch ?? 800) * 1.5);
  await p.evaluate((n) => {
    const st = document.querySelector('.stack');
    if (st) st.scrollTop = n;
  }, STEP);
  const straightNow = await p.evaluate(() => document.querySelector('.stack').scrollTop);
  await p.waitForTimeout(500);
  const straightLater = await p.evaluate(() => document.querySelector('.stack').scrollTop);
  t(straightNow > 40, `${vp.tag} —— 直写 scrollTop 立刻生效（${straightNow}）`);
  // ⚠️ 这条是**主判据**：值必须留得住。
  t(
    Math.abs(straightLater - straightNow) < 60,
    `${vp.tag} —— 直写的位置**留得住**（${straightNow} → 500ms 后 ${straightLater}）`,
  );

  // ② 真滚轮（和直写走的是两条路）
  await p.evaluate(() => {
    const st = document.querySelector('.stack');
    if (st) st.scrollTop = 0;
  });
  await p.waitForTimeout(300);
  /*
   * ⚠️⚠️ **滚轮要放在"只有 `.stack` 在管"的地方。**
   *
   * 第一版放在视口**正中** —— 而正中压的是 `.section__body`，
   * **它自己就是滚动容器** ⇒ 滚轮滚的是里层，`.stack.scrollTop` 当然读到 0，
   * 看起来像"滚不动"，其实是**量错了对象**（桌面 1440 报红、手机 390 报绿，
   * 差别就在于那几个像素落在谁身上）。
   * ⇒ 放到**左边距**：那里是 `.section`（不是滚动容器），
   *   滚轮会冒泡到 `.stack` ✓
   */
  /*
   * ⚠️ 让脚本**自己找落点**，不要写死坐标 —— 我已经栽过两次：
   *    写视口正中 ⇒ 落在 `.section__body`（它自己是滚动容器，滚的是里层）；
   *    写左边距 x=8 ⇒ 落在 `page`（`.stack` 不是通栏，那里在它外面）。
   * ⇒ 扫一行，挑出**在 `.stack` 之内、且到 `.stack` 之间没有别的滚动容器**的那个点。
   */
  const spot = await p.evaluate(() => {
    const st = document.querySelector('.stack');
    if (!st) return null;
    const y = Math.round(window.innerHeight / 2);
    for (let x = 6; x < window.innerWidth - 6; x += 6) {
      const e = document.elementFromPoint(x, y);
      if (!e || !st.contains(e)) continue;
      // 从落点往上走到 .stack，中间不许再出现滚动容器
      let n = e;
      let blocked = false;
      while (n && n !== st) {
        const s = getComputedStyle(n);
        if (/auto|scroll/.test(s.overflowY)) { blocked = true; break; }
        n = n.parentElement;
      }
      if (!blocked) return { x, y, under: String(e.className || e.tagName).slice(0, 30) };
    }
    return null;
  });
  if (!spot) {
    t(false, `${vp.tag} —— 找不到一个"只滚 .stack"的落点（量具本身有问题）`);
  }
  await p.mouse.move(spot ? spot.x : Math.round(vp.w / 2), spot ? spot.y : Math.round(vp.h / 2));
  const under = spot ? spot.under : '(没找到)';
  await p.mouse.wheel(0, geom?.ch ?? 800);
  await p.waitForTimeout(700);
  const wheelAt = await p.evaluate(() => document.querySelector('.stack').scrollTop);
  t(
    Math.abs(wheelAt - (geom?.ch ?? 800)) < 80,
    `${vp.tag} —— 真滚轮滚得动且留得住（读到 ${wheelAt}；落点上是 ${String(under).slice(0, 30)}）`,
  );

  // ③ 入场动画有没有被反复重启（"闪"的判据）
  const anim = await p.evaluate(async () => {
    const host = document.querySelector('.section__body--enter') || document.querySelector('.section__body');
    const el = host && [...host.querySelectorAll('*')].find((e) => e.getAnimations && e.getAnimations().length);
    if (!el) return null;
    const a = el.getAnimations()[0];
    const seq = [];
    for (let i = 0; i < 12; i += 1) {
      seq.push(Math.round(Number(a.currentTime) || 0));
      await new Promise((r) => setTimeout(r, 60));
    }
    return seq;
  });
  if (anim) {
    let resets = 0;
    for (let i = 1; i < anim.length; i += 1) if (anim[i] < anim[i - 1] - 40) resets += 1;
    t(resets === 0, `${vp.tag} —— 入场动画没有反复重启（重启 ${resets} 次，序列 ${anim.join(',')}）`);
  } else {
    t(true, `${vp.tag} —— 这一屏没有入场动画可量（跳过，不计失败）`);
  }

  t(errs.length === 0, `${vp.tag} —— 没有页面异常${errs.length ? '：' + errs[0] : ''}`);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
