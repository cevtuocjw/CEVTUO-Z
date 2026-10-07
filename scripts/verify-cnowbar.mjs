#!/usr/bin/env bun
/**
 * 底部 Cnowbar + 字标「CEVTUO Z」的常驻验证（2026-10-05）。
 *
 *   bun scripts/verify-cnowbar.mjs                 # 打本地预览 8125
 *   BASE=http://127.0.0.1:8125/z bun scripts/...
 *
 * ── ⚠️⚠️ 写这个脚本时踩的四个坑，都留在这里别再犯 ──────────────────
 *
 *   ① **「让位量」要量「内容」，不是量容器。**
 *      前两版量的是 `.section` 的盒子 —— 它是**满屏高的 snap 面板**，
 *      底下永远在条下面，于是五页齐刷刷报「被压住」，**是假红**。
 *      第三版改用 `textContent` 筛元素 —— 但**容器也会带（继承来的）textContent**，
 *      于是整屏都被算成"内容"。第四版才用「**只看叶子节点**」。
 *
 *   ② **要限定在「当前可见的那一屏」。** 不限定的话，视口外的其它屏
 *      （它们一条条叠在上下方）的子元素坐标会**碰巧**落进条的范围里 ——
 *      又是一批假红。
 *
 *   ③ **判据是「穿过条的那一段」，不是「在条下面」。** 条底之下还有一条
 *      14px 的缝（和整块屏幕的下缘），落在那里**不算被压住**。
 *      两个方向（垂直 + 水平）都要判 —— 竖排的运行头在右边，
 *      光看纵向会误报。
 *
 *   ④ **`.section__head` 有三条规则**（基础 / medium-up / 窄屏媒体查询），
 *      而窄屏那条在文件**最后** ⇒ 同特异型看顺序，它盖掉前面所有 `bottom`。
 *      底部条一加，竖排的运行头就正好落在条底下 —— **第六次**同一个形状。
 *      这个断言就是防它复发的。
 */

import { chromium } from 'playwright';

/**
 * ⚠️⚠️ **默认必须是 8126（根＝dist 本身），不能是 `8125/z`。**
 *
 *    `taro.config` 的 `publicPath` 是 `'/'` ⇒ 页面里的 JS/CSS 走**站根绝对路径**
 *    （`/js/app.<hash>.js`）。所以站点必须挂在服务器的**根**上：
 *      · 8126 → 根就是 dist      ⇒ `/js/…` ✓
 *      · 8125 → 根是 `/tmp/sv`，站点在 `/z/` ⇒ 它会去要 `8125/js/…` ✗ 404
 *
 * ⚠️ 而 404 之后的形状是**整页空白**，于是这里的第一条断言
 *    `getComputedStyle(document.querySelector('.wordmark__text'))` 拿到 null
 *    ⇒ **抛异常 ⇒ 后面 306 条一条都不跑**，输出看起来像"产品坏了"。
 *    这正是 FACT 纪律 2（崩溃 ≠ 失败）和纪律 8（工具链的毛病伪装成被测对象的毛病）。
 *    ⇒ 换端口时先看一眼：`curl -s -o /dev/null -w '%{http_code}' $BASE/js/app.<hash>.js`
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8126';
const PAGES = ['home', 'coof', 'cnsr', 'paperr', 'chealth'];
const VIEWPORTS = [
  { w: 1440, h: 900, tag: '桌面 1440' },
  { w: 840, h: 900, tag: '宽屏 840' },
  { w: 390, h: 844, tag: '手机 390' },
];

let pass = 0;
let fail = 0;
let skip = 0;
const results = [];
const t = (ok, msg) => {
  if (ok === 'skip') {
    skip++;
    results.push('  ○ SKIP  ' + msg);
  } else if (ok) {
    pass++;
    results.push('  ✓ ' + msg);
  } else {
    fail++;
    results.push('  ✗ ' + msg);
  }
};

const browser = await chromium.launch({
  headless: true,
  // ⚠️ 打本地 127.0.0.1 也要关代理：面板的代理规则会把它也接走。
  args: ['--no-proxy-server', '--proxy-bypass-list=*'],
});

for (const vp of VIEWPORTS) {
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      colorScheme: theme,
      deviceScaleFactor: 1,
    });
    for (const page of PAGES) {
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
      await p.goto(`${BASE}/index.html#/pages/${page}/index`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2600);

      const label = `${vp.tag} / ${theme} / ${page}`;

      // ── ① 底部条在、顶栏不在、字标在 ──────────────────────────
      const base = await p.evaluate(() => ({
        bar: !!document.querySelector('.cnowbar'),
        topbars: document.querySelectorAll('.topbar').length,
        wm: !!document.querySelector('.wordmark__text'),
        wmText: (document.querySelector('.wordmark__text')?.textContent || '').trim(),
        wmBg: (() => {
          const s = getComputedStyle(document.querySelector('.wordmark__text'));
          return { img: s.backgroundImage, color: s.backgroundColor, shadow: s.textShadow, blend: s.mixBlendMode };
        })(),
        back: !!document.querySelector('.cnb__btn--back'),
        items: [...document.querySelectorAll('.cnowbar .cnb__items .cnb__btn')].length,
      }));
      t(base.bar, `${label} —— 底部条在`);
      t(base.topbars === 0, `${label} —— 没有旧顶栏（实测 ${base.topbars} 个）`);
      t(base.wm && base.wmText === 'CEVTUO Z', `${label} —— 字标是「CEVTUO Z」（实测「${base.wmText}」）`);
      // 「完全没有背景」：底是透明、且没有背景图（字晕不算背景，不判）
      t(
        base.wmBg.img === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(base.wmBg.color),
        `${label} —— 字标没有背景`,
      );

      /*
       * ── ①b 底部条**够得着**吗（读者 2026-10-07 要的可拖动）─────────────
       *
       * 读者原话：「下边的导航栏，可以用鼠标和手指拖动来回查看，这样才能看到
       *           右边的被遮挡的内容」。
       *
       * ⚠️⚠️ 2026-10-05 那条判据问的是「**装得下吗**」。条现在改成可横向滚动了，
       *    那个问法就不再是契约 —— 装不下不等于读者看不到。新的契约是
       *    **够不着才算坏**。
       *
       * ⚠️⚠️ 而且判据**不许写「`max <= 0 ||` 就通过」那种形状**：
       *    正常情况下本来就不溢出，那条在真出问题时也是绿的
       *    （FACT 纪律 15：测运气的断言永远绿）。
       *    所以要盯的是两件**行为**：
       *      · 它是不是一个真的可滚容器（写回 `overflow-x: hidden` 立刻红）；
       *      · 真溢出时，改 `scrollLeft` 读回来变了没有（写回 `hidden` 时读到 0）。
       */
      const drag = await p.evaluate(() => {
        const el = document.querySelector('.cnowbar .cnb__items');
        if (!el) return null;
        const s = getComputedStyle(el);
        const max = el.scrollWidth - el.clientWidth;
        let readback = null;
        let before = 0;
        if (max > 0) {
          before = el.scrollLeft;
          el.scrollLeft = max; // 试着滚到最右
          readback = el.scrollLeft; // ⚠️ 不可滚的容器这里读到 0
          el.scrollLeft = before; // 归位，别影响后面的几何断言
        }
        return {
          overflowX: s.overflowX,
          touchAction: s.touchAction,
          max,
          readback,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        };
      });
      t(!!drag, `${label} —— 找得到 .cnb__items`);
      if (drag) {
        t(
          /auto|scroll/.test(drag.overflowX),
          `${label} —— 底部条是横向可滚容器（overflow-x=${drag.overflowX}）`,
        );
        t(
          /pan-x|auto|manipulation/.test(drag.touchAction),
          `${label} —— 手指能横向拖（touch-action=${drag.touchAction}）`,
        );
        t(
          drag.max <= 0 || drag.readback >= drag.max - 2,
          `${label} —— 右边被遮住的内容真的滚得到（溢出 ${drag.max}px → 读到 ${drag.readback}）`,
        );
      }
      t(base.wmBg.blend === 'difference', `${label} —— 字标逐像素反色（mix-blend-mode）`);

      // ⚠️ 主页是栈底 ⇒ 不该有返回键；别的页必须有。
      t(
        page === 'home' ? base.back === false : base.back === true,
        `${label} —— 返回键${page === 'home' ? '不' : ''}出现`,
      );

      // ── ② 两侧让位：内容不许穿过底部条 / 顶部字标 ────────────────
      await p.evaluate(() => {
        const st = document.querySelector('.stack');
        if (st) st.scrollTop = st.scrollHeight;
      });
      await p.waitForTimeout(900);
      await p.evaluate(() => {
        const last = [...document.querySelectorAll('.section')].pop();
        last?.querySelectorAll('*').forEach((e) => {
          const s = getComputedStyle(e);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) {
            e.scrollTop = e.scrollHeight;
          }
        });
      });
      await p.waitForTimeout(700);

      const clash = await p.evaluate(() => {
        const bar = document.querySelector('.cnowbar').getBoundingClientRect();
        const wm = document.querySelector('.wordmark__text').getBoundingClientRect();
        // ⚠️ 只看**当前盖住视口中心**的那一屏（见文件头 ②）
        const visible = [...document.querySelectorAll('.section')].filter((s) => {
          const r = s.getBoundingClientRect();
          return r.top <= window.innerHeight / 2 && r.bottom >= window.innerHeight / 2;
        });
        const hits = [];
        let clipped = 0;
        /**
         * ⚠️⚠️ **被裁剪掉的不算**（第五版才补上，前面几版的假红全出自这里）。
         *
         *    `.section__body` 是 `overflow: auto` 的滚动容器。里面的行滚出上边之后
         *    **看不见了**，但 `getBoundingClientRect()` **照样报出它在视口外的坐标**。
         *    于是「滚动后有一行跑到 y=50」被判成「被字标压住」——
         *    而它压根没被画出来。
         *
         *    ⇒ 判据：这个元素的矩形必须在**每一个**会裁剪的祖先之内。
         */
        const isPainted = (e, sec) => {
          let n = e.parentElement;
          while (n && n !== sec.parentElement) {
            const s = getComputedStyle(n);
            const clips = /auto|scroll|hidden/.test(s.overflow) || /auto|scroll|hidden/.test(s.overflowY);
            if (clips) {
              const a = n.getBoundingClientRect();
              const r = e.getBoundingClientRect();
              if (r.top < a.top - 1 || r.bottom > a.bottom + 1 || r.left < a.left - 1 || r.right > a.right + 1) return false;
            }
            n = n.parentElement;
          }
          return true;
        };
        for (const sec of visible) {
          for (const e of sec.querySelectorAll('*')) {
            // ⚠️ **叶子才算内容**（见文件头 ①）
            if (e.children.length) continue;
            const s = getComputedStyle(e);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
            const r = e.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            if (!(e.textContent || '').trim() && e.tagName !== 'IMG') continue;
            const cross = (a) => r.bottom > a.top + 1 && r.top < a.bottom - 1 && r.right > a.left + 1 && r.left < a.right - 1;
            const hitsBar = cross(bar);
            const hitsWm = cross(wm);
            if (!hitsBar && !hitsWm) continue;
            if (!isPainted(e, sec)) {
              clipped++;
              continue;
            }
            hits.push((hitsBar ? '被条压：' : '被字标压：') + (e.className || '').toString().slice(0, 26));
          }
        }
        /**
         * ⚠️⚠️ **这条才是真正管用的那条。**
         *
         *    上面那条「内容元素穿过条」是**碰运气**的断言：内容恰好不在条带里，
         *    它就永远绿。实测：把让位量 `--cnb-h` 改成 `0`（=完全没有让位），
         *    它**依然 276 通过 / 0 失败** —— 等于什么都没测。
         *
         *    ⇒ 改成断言**布局契约**：当前这一屏的**内容盒底**必须在条顶之上。
         *      这才是「让位量算出来了没有」的直接判据，内容多寡不影响它。
         */
        const body = visible[0]?.querySelector('.section__body');
        const bodyBottom = body ? Math.round(body.getBoundingClientRect().bottom) : null;
        return {
          panels: visible.length,
          hits: [...new Set(hits)],
          clipped,
          bodyBottom,
          barTop: Math.round(bar.top),
          clearance: bodyBottom == null ? null : Math.round(bar.top - bodyBottom),
        };
      });
      t(clash.panels >= 1, `${label} —— 量到了一屏（实测 ${clash.panels}）`);
      t(clash.hits.length === 0, `${label} —— 内容没被条/字标压住${clash.hits.length ? '：' + clash.hits.slice(0, 3).join('、') : ''}`);
      // ⚠️ 布局契约：内容盒底必须在条顶之上（这条**不靠内容碰巧**，见上面那段）
      t(
        clash.clearance != null && clash.clearance >= 8,
        `${label} —— 内容盒给底部条让了位（余量 ${clash.clearance}px）`,
      );

      t(errs.length === 0, `${label} —— 没有页面异常${errs.length ? '：' + errs[0] : ''}`);

      await p.close();
    }
    await ctx.close();
  }
}

/*
 * ── ③ UO 面板 —— **这一段删掉了（2026-10-07，读者：「UO 不用测了」）** ──
 *
 * ⚠️ 它测的是 **`.sheet` / `.sheet__panel` / `.nowb__row` / 「最近 24 小时」**，
 *    那是 UO 面板**改版前**的整体弹窗。面板后来改成了从底部条长出的泡泡
 *    （`.nowb` + `data-open` + `.nowb__line`）⇒ 这 6 条全部失效，而且失效得很坏：
 *      · 5 条是**假红**（等到的东西永远不存在）；
 *      · `Escape 能关掉面板` 是**假绿** —— 它断言的是 `!document.querySelector('.sheet')`，
 *        而 `.sheet` 压根不存在 ⇒ **它永远通过**，且和"Escape 有没有用"毫无关系。
 *
 * ⚠️ 留着比删掉更糟：一片红会让人以为面板坏了，而那条绿的会让人以为
 *    键盘可关这件事验过了。**两条都是假信息。**
 * ⚠️ 将来要重新验 UO，按当前 DOM 写，并且先做负向对照（改回去必须会红）。
 */

await browser.close();

console.log(results.join('\n'));
console.log(`\n${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
process.exit(fail === 0 ? 0 : 1);
