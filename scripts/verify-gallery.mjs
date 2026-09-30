/**
 * 画廊 / 画框的验证器 —— 驱动真页面，读事件前后的 DOM。
 *
 *   bun scripts/verify-gallery.mjs [基础地址]        # 默认 http://127.0.0.1:8125/z
 *   VW=390 VH=844 bun scripts/verify-gallery.mjs     # 窄屏**必须单独跑**
 *
 * ⚠️ 为什么必须这么验，不能靠看截图：
 *
 *   「画框在不在」看一眼截图就知道，但**它是不是真的会动**看一眼截图**看不出来** ——
 *   截图只有一帧，而这一轮要的就是「鼠标/触摸时的高级感动画」。
 *
 * ⚠️ 覆盖的断言（每条都有一个会失败的对照，见文件末尾「负向对照」）：
 *
 *   A. 画框**枚数**对得上（主页 3、COOF 0、其余各 1）     （读者 2026-09-30）
 *   B. 每一枚里的图**真的加载出来了**（naturalWidth > 0）
 *   C. 背景换成了画廊里那一张（不是老的五张 home.jpg 等）
 *   D. 主页在右、内页在左
 *   E. 指针移动 ⇒ 倾角和高光**都变**（⚠️ 靠几何命中，不靠 DOM 命中）
 *   F. 指针离开 ⇒ 回到 0 / 50%
 *   G. 按下 ⇒ `gal--press`（框收 0.975），松手 ⇒ 没有
 *   H. 每一枚的 `<img>` 都不能被拖走（`draggable` 关掉）
 *   I. reduced-motion 下**状态照样变、只是不走过去**（过渡时长 0）
 *   J. ⚠️ **画框压在正文之下**（这一条是**反过来**的，见下面那段）
 *   K. 每一枚至少一半露在屏幕内（窄屏允许被裁，但不能只剩一条边）
 *   M. 正文在屏幕内且有宽度（让位让过头同样是坏的）
 *   N. **画框真的被画出来了**（不是掉到壁纸底下 —— 那是「看起来少了一件东西」）
 *   O. 主页那三枚**各放一张不同的图**（同源时和壁纸糊成一整块）
 *   P. **不为画框让位**（宽窄屏都是）—— 判据是**不变量**，见下面那段
 *   Q. **全站做法与照片互不重样**（读者：「CNSR 和主页上的画框是一样的，
 *      这种不允许出现」）+ **没有池塘那张（g08）**
 *   R. **每一枚都有可见的框**（读者：「不允许出现池塘这幅这样没有画框的」）
 *
 * ⚠️ 负向对照（改坏了应该 FAIL）：
 *   · 把 `pointermove` 的几何监听删掉 ⇒ E 失败
 *   · 把 `reset` 从 `pointerup` 上摘掉 ⇒ F 失败
 *   · 把 `.gal` 的 `z-index` 改回 8 ⇒ J 失败
 *   · 把让位量改回 106/378 ⇒ P 失败（内边距会随有没有画框而变）
 *   · 把某枚的 `photo` 指成另一枚的 ⇒ Q 失败
 *   · 把某个做法改回「无框」（padding 0 + 透明底）⇒ R 失败
 *   · 把 `.gal` 的 `z-index` 改成 −2 ⇒ N 失败（掉到壁纸底下，屏幕上是空的）
 *
 * ⚠️⚠️ 这一轮最贵的一条经验，记在这里免得重犯：
 *    **偶发红一条、每次红的还是不同的一页** —— 我查了三轮，
 *    先怀疑随机分配算错、又怀疑 Taro 换页读到上一页、再怀疑壁纸没预热，
 *    三次都在**改产品代码看不出来的地方**。
 *    真因是**断言里那条正则**：`g0\d+` 匹配 `g01`…`g09`，**匹配不上 `g10`**。
 *    而背景是随机的 ⇒ 轮到 g10 的那一页红。
 *    ⇒ 「检查器报假红，要当检查器的 bug 来修」——不是放宽判据，
 *      是**把正则改对**（`g\d+`）。判据一点没松。
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://127.0.0.1:8125/z').replace(/\/$/, '');

/**
 * ⚠️⚠️ 页面 → 期待的画框。这张表就是读者 2026-09-30 那三条要求的编码：
 *    ① COOF **不放**（`frames: 0`）
 *    ② 主页**放更多**（3 枚）
 *    ③ 其余各一枚
 *
 * `photos` 只在主页给：三枚必须**各是一张不同的图** ——
 * 三枚都放 g02（主页背景本身那张）时，无框画布那枚和壁纸糊成一整块，
 * 而 DOM 上一切正常（`A` 数得对、`B` 图加载了、`D` 方向对）。
 * **是看截图看出来的。**
 */
/**
 * ⚠️⚠️ `photos` **内页也必须给**，不能只在主页给。
 *
 *    重写这一版时我先只给主页写了 `photos`，于是内页只等「有一枚画框、
 *    图加载完了」—— 而 **Taro 换页时上一页的画框还挂在 DOM 上**，
 *    那个条件在旧元素上立刻满足 ⇒ 读到的是**上一页那一枚**。
 *
 *    现场证据（`A` 那条的 detail 里带 `cls`，就是为了这个）：
 *      `A paperr 画框枚数 = 1  cls="gal--left gal--frame-double"`
 *      `A chealth 画框枚数 = 1  cls="gal--left gal--frame-moulding"`
 *    —— paperr 该是 `moulding`、chealth 该是 `bevel`，**各错位了一页**。
 *    ⚠️ 而它**全绿**：枚数对、`gal--left` 对、图加载了、M/P 也都过 ——
 *      「上一页那枚画框」和「这一页这枚」在所有条件上都长得一样。
 *
 *    ⇒ 这正是这个文件抬头警告过的那个坑，我重写时把它丢了。
 *      **夹具要按页给，不能只给需要区分的那些页。**
 */
const PAGES = [
  { key: 'home', frames: 3, side: 'right' },
  { key: 'coof', frames: 0, side: null },
  { key: 'cnsr', frames: 1, side: 'left' },
  { key: 'paperr', frames: 1, side: 'left' },
  { key: 'chealth', frames: 1, side: 'left' },
];

/**
 * ⚠️⚠️ **夹具（`photos`）没了，而且是故意的。**
 *
 *    读者 2026-09-30：「所有的画和所有的画框要每次刷新都随机出」——
 *    于是**没有任何一张图或一种做法是可以写死的**。
 *
 *    ⚠️ 那原来靠 `photos` 挡的那个坑（Taro 换页时读到**上一页残留的画框**）
 *      现在谁来挡？—— `window.__root()`。它把查询限定在**当前可见的**
 *      `.taro_page` 上，旧页面是 `display:none`，于是根本查不到。
 *      **一个机制同时解决了两个问题**，这比再加一份夹具稳。
 *      ⚠️ 但前提是 `__root()` 真的在用 —— 去掉它，这条会静默失效。
 */
const POOL = ['g01','g02','g03','g04','g05','g06','g07','g09','g10'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * 等到**这一页该有的那几枚**都在、图都加载完。
 *
 * ⚠️⚠️ 这里栽过一次，所以条件写得比看起来啰嗦：
 *
 *   Taro 换页时**旧页面的画框还挂在 DOM 上**，于是「有一枚画框 + 图加载完了」
 *   在旧元素上立刻满足，读到的是上一页的 `gal--right` —— 本地全绿、线上 4 条
 *   D 失败（内页画框跑到右边），**而线上其实是对的**。
 *   ⇒ 等待条件必须包含「等到的是**这一页的**那几枚」，加时间只是碰运气，
 *     而碰运气的断言在慢机器上会随机变红，那比没有断言更糟。
 *
 * ⚠️ 而 `frames: 0` 的页面（COOF）等的就是**「一枚都没有」** ——
 *    第一版没有这一档，于是脚本在 COOF 上死等一枚不存在的 `g03`，
 *    15 秒后抛 `TimeoutError`，**后面 40 多条断言一条都没跑**。
 *    崩溃会把「一条断言失败」伪装成「验证器坏了」。
 */
async function waitFrames(page, n, key) {
  // ⚠️ 先等**路由真的切过去** —— 只等「有几枚画框」会满足于**上一页**那一枚。
  if (key) {
    await page.waitForFunction((k) => (location.hash || '').includes(`/pages/${k}/`), key, {
      timeout: 15000,
    });
  }
  /**
   * ⚠️⚠️ 再等「**只剩一个可见的 `.taro_page`**」。
   *
   *    换页时新旧两页会**同时可见**一小会儿，而「取第一个」和「取最后一个」
   *    都只是**猜**新页在前还是在后 —— 实测两种都读到过上一页。
   *    ⇒ 唯一靠得住的判据是「过渡结束了」：可见页只剩一个。
   *      那时不管取哪个都对。
   *
   * ⚠️ 反例（没等这个时的现场）：CNSR 和 CAPPERR 每次都拿到**完全一样**的
   *    做法和照片 —— 看起来像「随机分配算错了」，其实是**读错了页面**。
   */
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.taro_page')].filter(
        (el) => getComputedStyle(el).display !== 'none',
      ).length === 1,
    undefined,
    { timeout: 15000 },
  );
  // ⚠️ 壁纸也要等 —— `applyBackground` 挂在 `hashchange` 上，比 React 渲染**晚**。
  //    不等的话 C 断言会读到预热前的那份兜底样式（实测红过一次）。
  await page.waitForFunction(
    () => {
      // ⚠️ 必须用**同一个 `__root()`**，不能另写一个「取第一个可见页」——
      //    两处选页不一样的话，等的是 A 页、量的是 B 页，
      //    于是「等到了」和「量到的是预热前那份」同时成立（实测窄屏红过一次）。
      const w = window.__root().querySelector('.cevtuo-wallpaper');
      return !!w && getComputedStyle(w).backgroundImage.includes('/gallery/');
    },
    undefined,
    { timeout: 15000 },
  );
  // ⚠️ 过渡结束后**再停一拍**：React 可能还会把最后一枚画框换上去，
  //    而那时图还没解码完 ⇒ `B`（图真的渲染了）会偶发红。
  //    实测：三次里红过一次（`naturalWidth=0`）。**碰运气的断言在慢机器上
  //    会随机变红，那比没有断言更糟** —— 所以这里等一拍，不是等运气。
  await page.waitForTimeout(350);
  await page.waitForFunction(
    ({ n }) => {
      const frames = [...window.__root().querySelectorAll('.gal')];
      if (frames.length !== n) return false;
      if (!n) return true;
      const imgs = frames.map((f) => f.querySelector('.gal__photo'));
      if (imgs.some((i) => !i || !i.complete || i.naturalWidth === 0)) return false;
      return true;
    },
    { n },
    { timeout: 20000 },
  );
}

/** 读第 `i` 枚画框此刻的四个变量 + 变换矩阵。 */
function readVars(page, i = 0) {
  return page.evaluate((idx) => {
    const el = window.__root().querySelectorAll('.gal')[idx];
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
  }, i);
}

const browser = await chromium.launch();

/**
 * ⚠️⚠️ Taro 会把**上一个页面留在 DOM 里**（`.taro_page` 被置为 `display:none`）。
 *    于是 `window.__root().querySelector('.gal')` / `.cevtuo-glass` 拿到的是
 *    **文档里第一个** —— 也就是**已经隐藏的那一页上的那个**。
 *
 *    症状是「什么都读不到」：`getBoundingClientRect()` 全是 0、
 *    `getAnimations()` 返回空数组、`getComputedStyle().transform` 是 `none`。
 *    ⇒ 断言报出「玻璃没有在流动」这种**看起来像产品坏了**的结论，而产品是好的。
 *      （2026-09-30 实测：宽屏绿、窄屏红 —— 因为窄屏上画框挂在正文上面，
 *        测试的点击**穿过去落到卡片上、触发了导航**，于是多出一个隐藏页面。）
 *
 *    ⇒ 一切查询都限定到**当前可见的那个 `.taro_page`**。
 */
const ROOT = () => {
  const visible = [...document.querySelectorAll('.taro_page')].filter(
    (el) => getComputedStyle(el).display !== 'none',
  );
  /**
   * ⚠️⚠️ **优先挑「壁纸已经上过图」的那一页。**
   *
   *    换页时新旧两页会同时可见，而新页刚插进来时它的 `.cevtuo-wallpaper`
   *    还是 `index.html` 里那份**预热前的兜底渐变**（`applyBackground` 挂在
   *    `hashchange` 上，比 React 渲染晚）。
   *
   *    ⚠️ 只按「第一个 / 最后一个」挑**都会挑中它** —— 实测两种都读到过
   *      上一页或半成品页，症状是 `C`（背景是画廊里的一张）**随机红一页**，
   *      看起来像「背景有时候没换」，其实是**读错了页面**。
   *
   *    ⇒ 判据用「这一页准备好了没有」，不用「它在 DOM 里排第几」。
   *      位置是实现的细节，准备好了才是我们要的那一页。
   */
  const ready = visible.filter((el) => {
    const w = el.querySelector('.cevtuo-wallpaper');
    return !!w && getComputedStyle(w).backgroundImage.includes('/gallery/');
  });
  return ready[ready.length - 1] || visible[visible.length - 1] || document;
};

// ⚠️ 视口可以换（`VW=390 ...`）——
//    画框在窄屏有一档完全不同的尺寸**和一条不同的让位规则**，
//    **只在 1440 下全绿说明不了窄屏**。
const VW = Number(process.env.VW || 1440);
const VH = Number(process.env.VH || 900);
const NARROW = VW <= 700;

const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
// ⚠️ `addInitScript` 必须在 `newContext` **之后**（它挂在上下文上），
//    而且要在 `newPage` **之前**（每次导航前注入）。
await ctx.addInitScript(`window.__root = ${ROOT.toString()};`);
const page = await ctx.newPage();

/**
 * ⚠️⚠️ `P` 的**判据**（这一条换过两次，值得写清楚为什么）：
 *
 *    第一版是「窄屏 padding-left ≤ 32」—— 用**魔数**。宽屏基础内边距是 48px
 *    （`.section` 自己的），于是它在宽屏一直红，**而代码是对的**。
 *    调阈值到 64 能变绿，但那只是把魔数挪了个位置：
 *    下一次改版式，48 可能变成 72，这条又会莫名其妙地红。
 *
 *    ⇒ 真正的判据是**不变量**：内边距**不该随「这一页有没有画框」变化**。
 *      COOF 一枚画框都没有，其余四页有 —— 五页在同一个视口下必须**一模一样**。
 *      有让位的时候这个数会差 378px（宽屏）或 106px（窄屏），
 *      而「无让位」时它恒等。**一个数都不用挑。**
 */
const padLefts = [];
/** ⚠️ 全局收集：做法和照片。用来查「不许重样」。 */
const allStyles = [];
const allPhotos = [];

try {
  // ── A–D / H–P：逐页检查 ─────────────────────────────────────
  for (const P of PAGES) {
    await page.goto(`${BASE}/#/pages/${P.key}/index`, { waitUntil: 'domcontentloaded' });
    await waitFrames(page, P.frames, P.key);

    const readInfo = () => page.evaluate(() => {
      const frames = [...window.__root().querySelectorAll('.gal')];
      /**
       * ⚠️⚠️ **壁纸必须和「我们量到的那几枚画框」同一页** —— 从画框自己往上找。
       *
       *    原来这里又调了一次 `window.__root()`，于是「量画框」和「量壁纸」
       *    是**两次独立的挑选**，中间页面可能变 ⇒ 量到的壁纸是**另一页**的
       *    （或预热前那份兜底渐变）。症状：`C` **随机红一页**，
       *    三次重读也读不到 —— 因为重读的还是同一个错对象。
       *
       *    ⇒ 锚在**已经量到的东西**上：`frames[0].closest('.taro_page')`。
       *      没画框的页面（COOF）锚在 `.section` 上。
       *      「同一个页面」这件事就变成了**结构性**的，不再靠再挑一次。
       */
      const anchorEl = frames[0] || window.__root().querySelector('.section');
      const pageRoot = (anchorEl && anchorEl.closest('.taro_page')) || window.__root();
      const wall = pageRoot.querySelector('.cevtuo-wallpaper');
      const bg = wall ? getComputedStyle(wall).backgroundImage : '';
      // ⚠️ 临时诊断：C 失败时要知道**为什么**读不到（下面 detail 里会打出来）
      const diag = {
        visiblePages: [...document.querySelectorAll('.taro_page')].filter(
          (el) => getComputedStyle(el).display !== 'none',
        ).length,
        rootIsDoc: pageRoot === document,
        wallInline: wall ? (wall.getAttribute('style') || '(无内联)') : '(没有壁纸元素)',
        wallCls: wall ? String(wall.className) : '-',
        hash: (location.hash || '').slice(0, 30),
      };
      return {
        count: frames.length,
        frames: frames.map((el) => {
          const img = el.querySelector('.gal__photo');
          const r = el.getBoundingClientRect();
          return {
            cls: String(el.className),
            src: img ? (img.currentSrc || img.src) : '',
            natural: img ? img.naturalWidth : 0,
            draggable: img ? img.draggable : null,
            z: getComputedStyle(el).zIndex,
            style: String(el.className).match(/gal--frame-([a-z]+)/)?.[1] ?? '?',
            framePad: (() => {
              const fr = el.querySelector('.gal__frame');
              return fr ? parseFloat(getComputedStyle(fr).paddingTop) : -1;
            })(),
            frameBg: (() => {
              const fr = el.querySelector('.gal__frame');
              if (!fr) return 'none';
              const cs = getComputedStyle(fr);
              return cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor;
            })(),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          };
        }),
        bg,
        diag,
        // ⚠️ `.section` 的 padding-left 就是让位量的**落点** ——
        //    窄屏它必须回到基础值（不让位）。
        padLeft: (() => {
          const s = window.__root().querySelector('.section');
          return s ? Math.round(parseFloat(getComputedStyle(s).paddingLeft)) : -1;
        })(),
      };
    });

    /**
     * ⚠️ **有界重读**（最多 3 次），不是调阈值。
     *
     *    壁纸是 `applyBackground` 在 `hashchange` 之后**异步**写上去的，
     *    而它和「读一次」之间有一瞬 —— 实测宽屏和窄屏**各偶发红过一次**，
     *    红的都是 `C`（读到预热前那份兜底渐变）。
     *    ⚠️ 判据没有放宽（还是「必须匹配到画廊里的一张」）——
     *      只是允许**再读一次**。放宽阈值会把真问题一起漏过去，
     *      重读不会：真的没换过的话三次都读不到。
     */
    let info = await readInfo();
    for (let attempt = 0; attempt < 3 && !/gallery\/g\d+\.jpg/.test(info.bg); attempt += 1) {
      await page.waitForTimeout(400);
      info = await readInfo();
    }

    check(
      `A ${P.key} 画框枚数 = ${P.frames}`,
      info.count === P.frames,
      `count=${info.count}${P.frames ? ` cls="${info.frames.map((f) => f.cls.replace('gal ', '')).join(' | ')}"` : ''}`,
    );
    check(
      `B ${P.key} 每一枚里的图都真的渲染了`,
      info.frames.every((f) => f.natural > 0),
      P.frames ? info.frames.map((f) => f.natural).join(', ') : '(没有画框，无需检查)',
    );
    const bgName = (info.bg.match(/gallery\/(g\d+)\.jpg/) || [])[1] || '';
    check(
      `C ${P.key} 背景是画廊里的一张（不是老的五张背景图）`,
      POOL.includes(bgName) && !/static\/(home|coof|cnsr|paperr|chealth)\.jpg/.test(info.bg),
      `bg=${bgName || '(没有)'}  计算值全文=[${info.bg}]  inline=[${info.diag.wallInline}]`,
    );
    check(
      `D ${P.key} 画框在${P.side === 'right' ? '右' : P.side === 'left' ? '左' : '（无）'}侧`,
      P.side === null
        ? info.count === 0
        : info.frames.every((f) => f.cls.includes(`gal--${P.side}`)),
      P.side === null ? `count=${info.count}` : info.frames.map((f) => f.cls).join(' | ').slice(0, 90),
    );
    check(
      `H ${P.key} 每一枚里的图都不可拖动`,
      info.frames.every((f) => f.draggable === false),
      P.frames ? info.frames.map((f) => f.draggable).join(', ') : '(没有画框，无需检查)',
    );

    /**
     * ── J：⚠️ **画框压在正文之下**（2026-09-30 反过来的一条）──────
     *
     * ⚠️ 原来是「画框**不能**压在正文上」，判据是 `elementsFromPoint`
     *    在画框里取 3×3 个点、看底下还有没有带文字的东西。
     *
     * ⚠️⚠️ 读者 2026-09-30 把这层关系**整个翻过来了**：
     *    「现在的画框在内容上面，要在内容文字的下面才可以，
     *      以及在边栏这些组件的下面」「不怕内容压住」。
     *    ⇒ 判据变成：**画框里任何一个点上，都不能有带文字的东西在它下面** ——
     *      换句话说，画框不许出现在任何文字之上。
     *
     * ⚠️ 而「z-index 是负的」**不足以**证明这一条：它是**声明的意图**，
     *    不是实际结果（本项目为「写在样式表里 ≠ 浏览器认了它」栽过 ——
     *    `.pc-cal__day` 的 `text-shadow` 计算值是 `none`，防护实际为零）。
     *    ⇒ 所以这里仍然用 `elementsFromPoint` 去读**真实的层叠次序**。
     *
     * ⚠️⚠️ 而 `.gal` 是 `pointer-events: none`（指针跟随改走 geometry，
     *    见 GalleryFrame.tsx 抬头）⇒ 它**不会出现在 `elementsFromPoint` 里**。
     *    ⇒ 探测前**临时**把它打开，探完立刻还原。
     *      不改这一步的话，这条断言会永远「绿」—— 因为它找不到画框，
     *      而「找不到」和「没压住」在这里长得一模一样。
     */
    const overText = await page.evaluate(() => {
      const out = [];
      for (const el of window.__root().querySelectorAll('.gal')) {
        const prev = el.style.pointerEvents;
        el.style.pointerEvents = 'auto';
        try {
          const r = el.getBoundingClientRect();
          for (let i = 1; i <= 4; i += 1) {
            for (let j = 1; j <= 4; j += 1) {
              const x = r.left + (r.width * i) / 5;
              const y = r.top + (r.height * j) / 5;
              const stack = window.__root().elementsFromPoint ?? document.elementsFromPoint(x, y);
              const at = stack.findIndex((n) => n.closest('.gal'));
              if (at < 0) continue;
              // 画框**之后**（也就是在它下面）还有带文字的东西 ⇒ 画框压住了正文
              for (const n of stack.slice(at + 1)) {
                if (n.closest('.cevtuo-wallpaper')) continue;
                const own = [...n.childNodes].some(
                  (k) => k.nodeType === 3 && k.textContent.trim(),
                );
                if (own) out.push(`${n.tagName.toLowerCase()}.${String(n.className || '').split(' ')[0]}`);
              }
            }
          }
        } finally {
          el.style.pointerEvents = prev;
        }
      }
      return [...new Set(out)].slice(0, 4);
    });
    check(
      `J ${P.key} 画框压在正文之下（没有文字在它下面）`,
      overText.length === 0,
      overText.join(', ') || (P.frames ? '干净' : '(没有画框，无需检查)'),
    );

    // ── K：每一枚至少一半露在屏幕内 ──────────────────────────────
    // ⚠️ 读者 2026-09-29 允许窄屏上画框被屏幕边裁掉一部分，但要求
    //    **露出来的面积大于整张的一半**。把这条「允许」写成一个可判定的数 ——
    //    否则「裁多少都行」在实现里很快就会变成「只剩一条边也算有一张」。
    const shown = info.frames.map((f) => {
      const { x, y, w, h } = f.rect;
      const ow = Math.max(0, Math.min(x + w, VW) - Math.max(x, 0));
      const oh = Math.max(0, Math.min(y + h, VH) - Math.max(y, 0));
      return (ow * oh) / (w * h);
    });
    check(
      `K ${P.key} 每一枚至少一半露在屏幕内`,
      shown.every((s) => s > 0.5),
      P.frames ? shown.map((s) => `${(s * 100).toFixed(0)}%`).join(', ') : '(没有画框)',
    );

    /**
     * ── M：正文真的在屏幕上、而且有宽度 ──────────────────────────
     *
     * ⚠️⚠️ 这条是**补一个盲区**，而它抓到的是一个真 bug：
     *    窄屏上正文被 `padding-left: 378px` 推到 x=394，而视口只有 390 ——
     *    **整个正文在屏幕外**，而 J/K 照样全绿：
     *    画框确实没压住任何东西，**因为没有任何东西可压**。
     *    截图上是「一片空白」，断言上是「全过」。
     *    ⇒ 「让位让够了」的反面是「让过头」，同一个数两头都能坏。
     */
    const bodyBox = await page.evaluate(() => {
      const el = window.__root().querySelector('.section__body');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width) };
    });
    check(
      `M ${P.key} 正文在屏幕内且有宽度`,
      !!bodyBox && bodyBox.x < VW && bodyBox.right > 0 && bodyBox.w > VW * 0.45,
      bodyBox ? `x=${bodyBox.x} right=${bodyBox.right} w=${bodyBox.w} vw=${VW}` : '(没有 .section__body)',
    );

    /**
     * ── P：⚠️ **窄屏不让位** ────────────────────────────────────
     *
     * ⚠️⚠️ 读者 2026-09-30：「在窄屏幕上，所有的内容都要压住画框，
     *    不能画框不敢被压住导致内容看不了多少位置」。
     *
     *    M 那条**抓不到这个**：窄屏让位 106px 时正文还有 334−106=228，
     *    而 `228 / 390 = 0.58 > 0.45` ⇒ **M 照样绿**。
     *    ⇒ 「够不够宽」和「有没有白白窄掉一条」是两件事，要两条断言。
     *      （和「让够了 / 让过头」那次同一个形状：一个数两头都能坏。）
     */
    padLefts.push([P.key, info.padLeft]);

    /**
     * ── O：主页三枚**各放一张不同的图** ──────────────────────────
     *
     * ⚠️ 这是**看截图**发现的：三枚都放 g02（主页背景本身那张）时，
     *    无框画布那枚和壁纸糊成一整块，读不出「这是挂在墙上的另一件东西」。
     *    而 A/B/D 全绿 —— 枚数对、图加载了、方向对，**没有一条在问「是不是同一张」**。
     */
    if (P.frames > 1) {
      const names = info.frames.map((f) => f.src.split('/').pop());
      check(
        `O ${P.key} 每一枚放的是不同的图（且都不是背景那张）`,
        new Set(names).size === names.length && !names.includes(`${bgName}.jpg`),
        names.join(', '),
      );
    }

    // ── R：每一枚都**看得出来是个框** ──────────────────────────
    /**
     * ⚠️ 读者 2026-09-30：「也不允许出现池塘这幅这样**没有画框**的」。
     *
     *    判据是「外框有厚度（padding > 0）**且**它自己在画东西
     *    （背景不是透明的）」—— 两条都要：
     *      · 只查 padding：一个 `padding: 0` 但带描边的框会被误杀；
     *      · 只查背景：一个 `transparent` 背景 + 纯投影的「无框画布」
     *        正是要挡的那个（它**看起来就是没框**）。
     *    ⚠️ 不写这条的话，把某个做法改回无框**在页面上看不出来** ——
     *      它只是「显得轻了一点」。
     */
    const noFrame = info.frames
      .map((f, i) => ({ i, ...f }))
      .filter((f) => !(f.framePad > 0) || f.frameBg === 'none' || f.frameBg === 'transparent');
    check(
      `R ${P.key} 每一枚都有可见的框（不是无框画布）`,
      noFrame.length === 0,
      P.frames
        ? info.frames.map((f) => `pad=${f.framePad} ${String(f.frameBg).slice(0, 22)}`).join(' | ')
        : '(没有画框)',
    );

    for (const f of info.frames) allStyles.push(f.style);
    allPhotos.push(...info.frames.map((f) => f.src.split('/').pop()));
  }

  /**
   * ── Q：⚠️ **全站的做法不许重样** ─────────────────────────────
   *
   *    读者 2026-09-30：「CNSR 和主页上的画框是一样的，这种不允许出现」。
   *    ⚠️ 这一条**必须全局查**，不能一页一页查 ——
   *      重样恰恰是发生在**两页之间**的，而每一页单独看都「有画框、方向对」。
   */
  check(
    'Q 全站画框做法互不重样（读者：CNSR 和主页不许一样）',
    new Set(allStyles).size === allStyles.length,
    allStyles.join(', '),
  );
  check(
    'Q 全站画框里的照片也互不重样',
    new Set(allPhotos).size === allPhotos.length,
    allPhotos.join(', '),
  );
  check(
    'Q 没有用到已删掉的池塘那张（g08）',
    !allPhotos.includes('g08.jpg') && !allStyles.includes('float'),
    `photos=${allPhotos.join(',')} styles=${allStyles.join(',')}`,
  );

  // ── P：内边距不随画框变化（见上面那段）──────────────────────
  const uniq = [...new Set(padLefts.map(([, v]) => v))];
  check(
    'P 正文左边距不随「这页有没有画框」变化（没有让位）',
    uniq.length === 1,
    padLefts.map(([k, v]) => `${k}=${v}`).join(' ') + `  → 不同值 ${uniq.length} 个`,
  );

  // ── E–G：交互，在主页上做 ───────────────────────────────────
  await page.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
  await waitFrames(page, 3, 'home');
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
    `tx ${before.tx}→${hovered.tx}  ty ${before.ty}→${hovered.ty}`,
  );
  check(
    'E 指针移到框上 ⇒ 高光位置跟着走',
    hovered.mx !== before.mx && hovered.my !== before.my,
    `mx ${before.mx}→${hovered.mx}  my ${before.my}→${hovered.my}`,
  );
  check(
    'E 倾角方向正确（右下 → 向右倾）',
    parseFloat(hovered.ty) > 1 && parseFloat(hovered.tx) < -1,
    `tx=${hovered.tx} ty=${hovered.ty}`,
  );
  check(
    'E 变换矩阵真的变了（不是变量变了但没接进 transform）',
    hovered.transform !== before.transform,
    `${before.transform.slice(0, 30)} → ${hovered.transform.slice(0, 30)}`,
  );

  // 按下
  await page.mouse.down();
  await page.waitForTimeout(200);
  const pressed = await page.evaluate(() => {
    const el = window.__root().querySelector('.gal');
    const fr = el.querySelector('.gal__frame');
    return { cls: el.className, frame: getComputedStyle(fr).transform };
  });
  check('G 按下 ⇒ gal--press 挂上', pressed.cls.includes('gal--press'), `cls="${pressed.cls}"`);
  check('G 按下 ⇒ 框收了一点（<1）', /matrix\(0\.9[0-9]+/.test(pressed.frame), pressed.frame);
  await page.mouse.up();

  /**
   * ⚠️⚠️ **`mouse.up()` 之后要立刻回主页** —— 这不是随手加的一步。
   *
   *    画框是 `pointer-events: none`（故意的：它不该抢内容的点击），
   *    所以这一按**会穿过去落到下面的内容上**：宽屏落在空的页边距里没事，
   *    **窄屏画框正好挂在正文上面 ⇒ 真的触发一次导航**。
   *    导航之后「当前可见的那页」就不是主页了，`readVars` 读到 `null`，
   *    而 `left.tx` 会抛 `TypeError` —— **崩溃会把「一条断言失败」
   *    伪装成「验证器坏了」**，而这两件事的处理方式完全不同。
   *
   *    ⇒ 先回主页，再测「指针离开」。
   *      （宽屏一直没暴露，就是因为那一按落在空的页边距里。）
   */
  await page.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
  await waitFrames(page, 3, 'home');
  await page.waitForTimeout(300);

  // 离开
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
  const left = await readVars(page);
  // ⚠️ 读空**报失败，不要崩** —— 见上面那段。
  check(
    'F 指针离开 ⇒ 倾角回到 0',
    !!left && parseFloat(left.tx) === 0 && parseFloat(left.ty) === 0,
    left ? `tx=${left.tx} ty=${left.ty}` : '(读不到画框)',
  );
  check(
    'F 指针离开 ⇒ 高光回到中心 50%',
    !!left && left.mx === '50%' && left.my === '50%',
    left ? `${left.mx}/${left.my}` : '(读不到画框)',
  );
  const released = await page.evaluate(() => {
    const el = window.__root().querySelector('.gal');
    return el ? String(el.className) : null;
  });
  check(
    'G 松手 ⇒ gal--press 摘掉',
    !!released && !released.includes('gal--press'),
    released ?? '(读不到画框)',
  );

  /**
   * ⚠️⚠️ E–G 那几下 `mouse.down()` 会**点穿画框**落到下面的内容上
   *    （画框是 `pointer-events: none`，那是故意的 —— 它不该抢内容的点击），
   *    而窄屏上画框正好挂在正文上面 ⇒ **真的会触发导航**。
   *    ⇒ 后面 N/I/L 要先回到主页，否则测的是别的页面。
   */
  await page.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
  await waitFrames(page, 3, 'home');
  await page.waitForTimeout(400);

  /**
   * ── N：⚠️⚠️ **画框真的被画出来了**（不是掉到壁纸底下）──────────
   *
   * ⚠️ 这是 `z-index: -1` 方案唯一致命的近邻：壁纸也是 −1，
   *    而 Taro 的页面壳 `.taro_page` 是个层叠上下文。
   *    画框一旦给成 −2/−3（或者 DOM 顺序排到壁纸**前面**），
   *    它就会画在壁纸**底下** —— 屏幕上是「少了一件东西」，
   *    而 DOM 里它**完全正常**：在、尺寸对、图加载了、z-index 是负的。
   *
   *    ⇒ 所以判据必须是**像素**，不能是 DOM：
   *      把画框 `visibility: hidden` 前后各截一张，两张**必须不同**。
   *      ⚠️ 用 `reducedMotion` 的上下文截 —— 玻璃层在漂移，
   *        否则两张本来就不同，这条断言永远绿。
   */
  const rmCtx = await browser.newContext({
    viewport: { width: VW, height: VH },
    reducedMotion: 'reduce',
  });
  await rmCtx.addInitScript(`window.__root = ${ROOT.toString()};`);
  const rm = await rmCtx.newPage();
  await rm.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
  await rm.waitForSelector('.gal');
  await rm.waitForTimeout(500);

  const clips = await rm.evaluate(() =>
    [...window.__root().querySelectorAll('.gal')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.max(1, Math.round(Math.min(r.width, innerWidth - Math.max(0, r.x)))),
        height: Math.max(1, Math.round(Math.min(r.height, innerHeight - Math.max(0, r.y)))),
      };
    }),
  );
  const painted = [];
  for (const clip of clips) {
    const a = await rm.screenshot({ clip });
    await rm.evaluate(() => window.__root().querySelectorAll('.gal').forEach((e) => (e.style.visibility = 'hidden')));
    const c = await rm.screenshot({ clip });
    await rm.evaluate(() => window.__root().querySelectorAll('.gal').forEach((e) => (e.style.visibility = '')));
    painted.push(!a.equals(c));
  }
  check(
    'N 每一枚画框真的改变了像素（没掉到壁纸底下）',
    painted.length === 3 && painted.every(Boolean),
    painted.map((p) => (p ? '有' : '**没有**')).join(', '),
  );

  // ── I：reduced-motion ───────────────────────────────────────
  const rmBox = await rm.evaluate(() => {
    const el = window.__root().querySelector('.gal');
    const r = el.getBoundingClientRect();
    return {
      dur: getComputedStyle(el).transitionDuration,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    };
  });
  // ⚠️ 坐标**必须从框自己身上读**，不能写死。第一版这里写的是 `(1200, 500)`，
  //    而画框在 1440 宽下左边缘是 1254 —— 那一按落在框**外面**，
  //    于是 `gal--press` 当然没挂上，而**失败信息看起来像是代码坏了**。
  await rm.mouse.move(rmBox.x, rmBox.y);
  await rm.mouse.down();
  const rmPress = await rm.evaluate(() => window.__root().querySelector('.gal').className);
  check(
    'I reduced-motion：过渡关掉（0s），但按下状态照样变',
    rmBox.dur.startsWith('0s') && rmPress.includes('gal--press'),
    `duration=${rmBox.dur} press=${rmPress.includes('gal--press')}`,
  );

  /**
   * ── L：背景的玻璃层真的在「流动」 ──────────────────────────
   *
   * ⚠️ 读者要的是「玻璃质感而且有流动感」。**「有流动感」这句话本身没法验**，
   *    能验的是它下面那件事：`transform` 随时间在变。
   *    ⇒ 不写这条的话，「动画被别处的 `animation: none` 干掉」
   *      或者「写了 keyframes 但名字对不上」都会**静默通过**。
   *
   * ⚠️⚠️ 元素不在时要**报失败，不能崩**。
   *    第一版这里直接 `getComputedStyle(window.__root().querySelector('.cevtuo-glass'))`，
   *    而线上当时还是旧构建（没有玻璃层）⇒ 整个脚本抛异常退出，
   *    **后面所有断言一条都没跑**。
   *    ⇒ 崩溃会把「一条断言失败」伪装成「验证器坏了」，而这两件事的处理方式
   *      完全不同：前者去看产品代码，后者去看测试代码。**别让它们长得一样。**
   */
  const readGlass = () =>
    page.evaluate(() => {
      const el = window.__root().querySelector('.cevtuo-glass');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { transform: cs.transform, anim: cs.animationName, blend: cs.mixBlendMode };
    });
  const glassA = await readGlass();
  await page.waitForTimeout(1800);
  const glassB = await readGlass();
  check('L 玻璃层存在', !!glassA, glassA ? '' : '页面上没有 .cevtuo-glass（线上还是旧构建？）');
  check(
    'L 玻璃层在流动（transform 随时间变）',
    !!glassA && !!glassB && glassA.transform !== glassB.transform,
    glassA ? `${glassA.transform.slice(0, 26)} → ${glassB.transform.slice(0, 26)}` : '',
  );
  check('L 玻璃层有动画名（不是静态的）', !!glassA && glassA.anim !== 'none', glassA ? glassA.anim : '');
  check(
    'L 玻璃层的混合模式是 soft-light（调照片，不是盖白）',
    !!glassA && glassA.blend === 'soft-light',
    glassA ? glassA.blend : '',
  );

  // ⚠️ 流动**停**、玻璃**在** —— 要关的是「动」，不是「看得见的东西」。
  const rmGlass = await rm.evaluate(() => {
    const el = window.__root().querySelector('.cevtuo-glass');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { anim: cs.animationName, blend: cs.mixBlendMode };
  });
  check(
    'I reduced-motion：玻璃的流动停掉，但玻璃层还在',
    !!rmGlass && rmGlass.anim === 'none' && rmGlass.blend === 'soft-light',
    rmGlass ? `animation-name=${rmGlass.anim} mix-blend=${rmGlass.blend}` : '(没有玻璃层)',
  );
  await rmCtx.close();
} finally {
  await browser.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通过  （视口 ${VW}×${VH}）`);
if (bad.length) {
  console.log('失败：');
  for (const r of bad) console.log(`  ✗ ${r.name}`);
  process.exit(1);
}
