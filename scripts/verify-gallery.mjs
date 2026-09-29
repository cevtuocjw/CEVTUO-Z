/**
 * 画廊 / 画框的验证器 —— 驱动真页面，读事件前后的 DOM。
 *
 *   bun scripts/verify-gallery.mjs [基础地址]        # 默认 http://127.0.0.1:8125/z
 *
 * ⚠️ 为什么必须这么验，不能靠看截图：
 *
 *   「画框在不在」看一眼截图就知道，但**它是不是真的会动**看一眼截图**看不出来** ——
 *   截图只有一帧，而这一轮要的就是「鼠标/触摸时的高级感动画」。
 *   所以这里做的是：派发真实指针事件，然后读 `--tx/--ty/--mx/--my` 有没有变、
 *   有没有回到 0 —— 这正是「假动画」和真动画的分界：
 *   **假的**在 pointermove 前后读出来一模一样（它只在 :active 时缩一下）。
 *
 * ⚠️ 覆盖的断言（每条都有一个会失败的对照，见文件末尾「负向对照」）：
 *
 *   A. 每一页都有**且只有一枚**画框                       （「每页必须有一张」）
 *   B. 画框里那张图**真的加载出来了**（naturalWidth > 0）  （src 写对≠图能显示）
 *   C. 背景换成了画廊里那一张（不是老的五张 home.jpg 等）
 *   D. 主页在右、内页在左                                  （读者的方向要求）
 *   E. 指针移动 ⇒ 倾角和高光**都变**
 *   F. 指针离开 ⇒ 回到 0 / 50%
 *   G. 按下 ⇒ `gal--press`（框收 0.975），松手 ⇒ 没有
 *   H. 框内那个 `<img>` 不能被拖走（`draggable` 关掉）
 *   I. reduced-motion 下**状态照样变、只是不走过去**（过渡时长 0）
 *   J. 画框不压在正文上（`elementsFromPoint` 看底下还有什么）
 *   K. 至少一半露在屏幕内（窄屏允许被裁，但不能只剩一条边）
 *   M. 正文在屏幕内且有宽度（让位让过头同样是坏的）
 *
 * ⚠️ 负向对照（改坏了应该 FAIL）：
 *   · 把 `pointermove` 监听删掉 ⇒ E 失败
 *   · 把 `reset` 从 pointerleave 上摘掉 ⇒ F 失败
 *   · 把 `gallerySide` 改成恒返回 'left' ⇒ D 失败
 *   · 把 `<img src>` 写成不存在的文件 ⇒ B 失败（而 A 照样绿）
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://127.0.0.1:8125/z').replace(/\/$/, '');

/** 页面 → 期望的那张图（和 platform/gallery.ts 的 GALLERY 对齐）。 */
const EXPECT = {
  home: 'g02',
  coof: 'g03',
  cnsr: 'g01',
  paperr: 'g05',
  chealth: 'g04',
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * 等到画框挂上、里面那张图有尺寸、**而且是这一页应该有的那张**。
 *
 * ⚠️⚠️ 最后那个条件不是多余的，它是这个验证器**唯一栽过的那次**：
 *
 *   一开始只等「有一枚画框 + 里面的图加载完了」。本地全绿，线上 4 条 D 失败
 *   （内页画框跑到右边）。**线上其实是对的** —— 探针读出来 coof 是 `gal--left`。
 *
 *   原因是 Taro 换页时**旧页面的那枚画框还挂在 DOM 上**，于是上面两个条件
 *   在旧元素上立刻满足，读到的就是上一页的 `gal--right`。
 *   而同一时刻背景已经是对的 —— 因为 `applyBackground` 挂在 `hashchange` 上，
 *   是**事件发生时**才算的，不依赖 React 重渲染。
 *   ⇒ **同一个页面上，一个查得早、一个查得晚，于是「背景换了画框没换」。**
 *     这条症状会把人引向「代码有 bug」，而代码是对的。
 *
 * ⚠️ 所以等待条件必须包含「等到的是**新的那一个**」，加时间只是碰运气 ——
 *    而碰运气的断言在慢机器上会随机变红，那比没有断言更糟。
 */
async function waitFrame(page, file) {
  await page.waitForSelector('.gal', { timeout: 15000 });
  await page.waitForFunction(
    (want) => {
      const frames = document.querySelectorAll('.gal');
      const el = frames[frames.length - 1];
      const img = el && el.querySelector('.gal__photo');
      const src = img && (img.getAttribute('src') || '');
      return !!img && img.complete && img.naturalWidth > 0 && src.includes(want);
    },
    `/gallery/${file}.jpg`,
    { timeout: 15000 }
  );
}

/** 读画框此刻的四个变量 + 变换矩阵。 */
function readVars(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.gal');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      tx: cs.getPropertyValue('--tx').trim(),
      ty: cs.getPropertyValue('--ty').trim(),
      mx: cs.getPropertyValue('--mx').trim(),
      my: cs.getPropertyValue('--my').trim(),
      transform: cs.transform,
      box: el.getBoundingClientRect().toJSON(),
    };
  });
}

const browser = await chromium.launch();
// ⚠️ 视口可以换（`VW=390 bun scripts/verify-gallery.mjs`）——
//    画框在窄屏有一档完全不同的尺寸和让位量，**只在 1440 下全绿说明不了窄屏**。
const VW = Number(process.env.VW || 1440);
const VH = Number(process.env.VH || 900);
const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
const page = await ctx.newPage();

try {
  // ── A–D：逐页检查 ───────────────────────────────────────────
  for (const [key, file] of Object.entries(EXPECT)) {
    await page.goto(`${BASE}/#/pages/${key}/index`, { waitUntil: 'domcontentloaded' });
    await waitFrame(page, file);

    const info = await page.evaluate((want) => {
      const frames = [...document.querySelectorAll('.gal')];
      // ⚠️ 取**装着这一页那张图**的那一枚，不是 `[0]` —— 换页时旧的那枚
      //    可能还在 DOM 里（见 `waitFrame` 上面那段）。
      const el =
        frames.find((f) => {
          const i = f.querySelector('.gal__photo');
          return i && (i.getAttribute('src') || '').includes(want);
        }) || frames[0];
      const img = el ? el.querySelector('.gal__photo') : null;
      const wall = document.querySelector('.cevtuo-wallpaper');
      const bg = wall ? getComputedStyle(wall).backgroundImage : '';
      return {
        count: frames.length,
        cls: el ? el.className : '',
        src: img ? img.currentSrc || img.src : '',
        natural: img ? img.naturalWidth : 0,
        draggable: img ? img.draggable : null,
        bg,
      };
    }, `/gallery/${file}.jpg`);

    check(`A ${key} 有且只有一枚画框`, info.count === 1, `count=${info.count} cls="${info.cls}"`);
    check(`B ${key} 画框里的图真的渲染了`, info.natural > 0, `naturalWidth=${info.natural}`);
    check(
      `C ${key} 背景换成了画廊的 ${file}.jpg`,
      info.bg.includes(`/gallery/${file}.jpg`) && !/static\/(home|coof|cnsr|paperr|chealth)\.jpg/.test(info.bg),
      info.bg.slice(0, 120)
    );
    const wantSide = key === 'home' ? 'right' : 'left';
    check(
      `D ${key} 画框在${wantSide === 'right' ? '右' : '左'}侧`,
      info.cls.includes(`gal--${wantSide}`),
      `cls="${info.cls}"`
    );
    check(`H ${key} 画框里的图不可拖动`, info.draggable === false, `draggable=${info.draggable}`);

    /**
     * ── J：画框不能压在正文上 ──────────────────────────────
     *
     * ⚠️ 这条是**看了图**才想到要加的：CHEALTH 内页截图上，左侧那枚画框
     *    正好盖住「13,268 步」那张卡片的左半截。
     *    而 A/B/C/D 全绿 —— 「画框在不在、在哪一侧、图加载没有」都不管它压没压住东西。
     *
     * ⚠️ 判据用 `elementsFromPoint`（在画框内取 3×3 个点，看**底下还有什么**），
     *    不比对固定选择器 —— 正文的类名每页都不一样，写选择器就等于每加一个
     *    组件都要回来补一次，而漏补的那次**看起来和通过一模一样**。
     *    这里只认「节点自己有非空文字」，所以壁纸、容器、装饰都不会误报。
     */
    const clash = await page.evaluate((want) => {
      const frames = [...document.querySelectorAll('.gal')];
      const el = frames.find((f) => {
        const i = f.querySelector('.gal__photo');
        return i && (i.getAttribute('src') || '').includes(want);
      });
      if (!el) return ['(找不到画框)'];
      const r = el.getBoundingClientRect();
      const bad = new Set();
      for (let i = 1; i <= 3; i++) {
        for (let j = 1; j <= 3; j++) {
          const x = r.left + (r.width * i) / 4;
          const y = r.top + (r.height * j) / 4;
          for (const n of document.elementsFromPoint(x, y)) {
            if (n.closest('.gal') || n.closest('.cevtuo-wallpaper')) continue;
            const own = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
            if (own) bad.add(`${n.tagName.toLowerCase()}.${String(n.className || '').split(' ')[0]}`);
          }
        }
      }
      return [...bad];
    }, `/gallery/${file}.jpg`);
    check(`J ${key} 画框没有压在正文上`, clash.length === 0, clash.slice(0, 4).join(', '));

    /**
     * ── K：至少一半露在屏幕里 ────────────────────────────────
     *
     * ⚠️ 读者 2026-09-29 允许窄屏上画框被屏幕边裁掉一部分，但要求
     *    **露出来的面积大于整张的一半**。把这条「允许」写成一个可判定的数 ——
     *    否则「裁多少都行」在实现里很快就会变成「只剩一条边也算有一张」。
     */
    const shown = await page.evaluate((want) => {
      const frames = [...document.querySelectorAll('.gal')];
      const el = frames.find((f) => {
        const i = f.querySelector('.gal__photo');
        return i && (i.getAttribute('src') || '').includes(want);
      });
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return (w * h) / (r.width * r.height);
    }, `/gallery/${file}.jpg`);
    check(`K ${key} 画框至少一半露在屏幕内`, shown > 0.5, `${(shown * 100).toFixed(0)}%`);

    /**
     * ── M：正文真的在屏幕上、而且有宽度 ──────────────────────
     *
     * ⚠️⚠️ 这条是**补一个盲区**，而它抓到的是一个真 bug：
     *    窄屏上正文被 `padding-left: 378px` 推到 x=394，而视口只有 390 ——
     *    **整个正文在屏幕外**，而 J/K 照样全绿：
     *    画框确实没压住任何东西，**因为没有任何东西可压**。
     *    截图上是「一片空白」，断言上是「全过」。
     *
     *    ⇒ 「让位让够了」的反面是「让过头」，同一个数两头都能坏。
     *      而只有这条断言是盯着**正文**的，前面十二条全都盯着画框。
     */
    const bodyBox = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.section__body')];
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { x: r.x, right: r.right, w: r.width };
    });
    check(
      `M ${key} 正文在屏幕内且有宽度`,
      !!bodyBox && bodyBox.x < VW && bodyBox.right > 0 && bodyBox.w > VW * 0.45,
      bodyBox
        ? `x=${Math.round(bodyBox.x)} right=${Math.round(bodyBox.right)} w=${Math.round(bodyBox.w)} vw=${VW}`
        : '(没有 .section__body)'
    );
  }

  // ── E–G：交互，在主页上做 ───────────────────────────────────
  await page.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
  await waitFrame(page, EXPECT.home);
  // ⚠️ 等过渡走完再读，否则读到的是上一段过渡的中间值。
  await page.waitForTimeout(700);

  const before = await readVars(page);
  const b = before.box;
  // 移到**右下角**（偏离中心最远，倾角最明显）
  const px = b.x + b.width * 0.88;
  const py = b.y + b.height * 0.85;
  await page.mouse.move(px, py);
  await page.waitForTimeout(700);
  const hovered = await readVars(page);

  check(
    'E 指针移到框上 ⇒ 倾角变了',
    hovered.tx !== before.tx || hovered.ty !== before.ty,
    `tx ${before.tx}→${hovered.tx}  ty ${before.ty}→${hovered.ty}`
  );
  check(
    'E 指针移到框上 ⇒ 高光位置跟着走',
    hovered.mx !== before.mx && hovered.my !== before.my,
    `mx ${before.mx}→${hovered.mx}  my ${before.my}→${hovered.my}`
  );
  check(
    'E 倾角方向正确（右下 → 向右倾）',
    parseFloat(hovered.ty) > 1 && parseFloat(hovered.tx) < -1,
    `tx=${hovered.tx} ty=${hovered.ty}`
  );
  check(
    'E 变换矩阵真的变了（不是变量变了但没接进 transform）',
    hovered.transform !== before.transform,
    `${before.transform} → ${hovered.transform}`
  );

  // 按下
  await page.mouse.down();
  await page.waitForTimeout(200);
  const pressed = await page.evaluate(() => {
    const el = document.querySelector('.gal');
    const fr = document.querySelector('.gal__frame');
    return { cls: el.className, frame: getComputedStyle(fr).transform };
  });
  check('G 按下 ⇒ gal--press 挂上', pressed.cls.includes('gal--press'), `cls="${pressed.cls}"`);
  check(
    'G 按下 ⇒ 框收了一点（<1）',
    /matrix\(0\.9[0-9]+/.test(pressed.frame),
    pressed.frame
  );
  await page.mouse.up();

  // 离开
  await page.mouse.move(20, 20);
  await page.waitForTimeout(700);
  const left = await readVars(page);
  check(
    'F 指针离开 ⇒ 倾角回到 0',
    parseFloat(left.tx) === 0 && parseFloat(left.ty) === 0,
    `tx=${left.tx} ty=${left.ty}`
  );
  check('F 指针离开 ⇒ 高光回到中心 50%', left.mx === '50%' && left.my === '50%', `${left.mx}/${left.my}`);
  check('G 松手 ⇒ gal--press 摘掉', !(await page.evaluate(() => document.querySelector('.gal').className)).includes('gal--press'));

  /**
   * ── L：背景的玻璃层真的在「流动」 ──────────────────────────
   *
   * ⚠️ 读者要的是「玻璃质感而且有流动感」。**「有流动感」这句话本身没法验**，
   *    能验的是它下面那件事：`transform` 随时间在变。
   *    ⇒ 不写这条的话，「动画被别处的 `animation: none` 干掉」
   *      或者「写了 keyframes 但名字对不上」都会**静默通过** ——
   *      而这两种坏法在截图上一模一样（都是一张静止的玻璃）。
   */
  const glassA = await page.evaluate(
    () => getComputedStyle(document.querySelector('.cevtuo-glass')).transform
  );
  await page.waitForTimeout(1800);
  const glassB = await page.evaluate(
    () => getComputedStyle(document.querySelector('.cevtuo-glass')).transform
  );
  check('L 玻璃层在流动（transform 随时间变）', glassA !== glassB, `${glassA.slice(0, 26)} → ${glassB.slice(0, 26)}`);
  check(
    'L 玻璃层有动画名（不是静态的）',
    (await page.evaluate(() => getComputedStyle(document.querySelector('.cevtuo-glass')).animationName)) !== 'none',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cevtuo-glass')).animationName)
  );
  // ⚠️ 玻璃是**内容**（照片得透过来），不是装饰 —— 它必须一直在，和画框一样。
  check(
    'L 玻璃层的混合模式是 soft-light（调照片，不是盖白）',
    (await page.evaluate(() => getComputedStyle(document.querySelector('.cevtuo-glass')).mixBlendMode)) === 'soft-light',
    ''
  );

  // ── I：reduced-motion ───────────────────────────────────────
  const rmCtx = await browser.newContext({
    viewport: { width: VW, height: VH },
    reducedMotion: 'reduce',
  });
  const rm = await rmCtx.newPage();
  await rm.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
  await rm.waitForSelector('.gal');
  const rmBox = await rm.evaluate(() => {
    const el = document.querySelector('.gal');
    const r = el.getBoundingClientRect();
    return {
      dur: getComputedStyle(el).transitionDuration,
      transform: getComputedStyle(el).transform,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    };
  });
  // ⚠️ 坐标**必须从框自己身上读**，不能写死。第一版这里写的是 `(1200, 500)`，
  //    而画框在 1440 宽下左边缘是 1254 —— 那一按落在框**外面**，
  //    于是 `gal--press` 当然没挂上，而**失败信息看起来像是代码坏了**。
  await rm.mouse.move(rmBox.x, rmBox.y);
  await rm.mouse.down();
  const rmPress = await rm.evaluate(() => document.querySelector('.gal').className);
  check(
    'I reduced-motion：过渡关掉（0s），但按下状态照样变',
    rmBox.dur.startsWith('0s') && rmPress.includes('gal--press'),
    `duration=${rmBox.dur} press=${rmPress.includes('gal--press')}`
  );
  // ⚠️ 流动**停**、玻璃**在** —— 要关的是「动」，不是「看得见的东西」。
  const rmGlass = await rm.evaluate(() => {
    const el = document.querySelector('.cevtuo-glass');
    const cs = getComputedStyle(el);
    return { anim: cs.animationName, blend: cs.mixBlendMode };
  });
  check(
    'I reduced-motion：玻璃的流动停掉，但玻璃层还在',
    rmGlass.anim === 'none' && rmGlass.blend === 'soft-light',
    `animation-name=${rmGlass.anim} mix-blend=${rmGlass.blend}`
  );
  await rmCtx.close();
} finally {
  await browser.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
if (bad.length) {
  console.log('失败：');
  for (const r of bad) console.log(`  ✗ ${r.name}`);
  process.exit(1);
}
