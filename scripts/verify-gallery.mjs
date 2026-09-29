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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

  // ── I：reduced-motion ───────────────────────────────────────
  const rmCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
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
