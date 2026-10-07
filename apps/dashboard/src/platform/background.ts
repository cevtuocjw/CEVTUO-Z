/**
 * Per-page background image, resolved at runtime.
 *
 * ⚠️ Why this is not a CSS rule, and not a CSS variable holding a `url()`.
 *
 * Both were tried and both fail silently, each for a different reason:
 *
 *   1. A `url()` in the app's stylesheet resolves against the STYLESHEET's
 *      directory, not the page's. Under a subdirectory deploy that is
 *      `/z/css/static/home.jpg` — a 404.
 *   2. A `url()` stored in a custom property on `:root` and consumed via
 *      `background-image: var(--page-bg)` is WORSE, and fails even at the site
 *      root. A relative URL inside a custom property is substituted as a token
 *      stream and then resolved against the consuming stylesheet — the same
 *      wrong base — so the declaration is invalid and the browser drops the
 *      entire `background-image`. Measured: the layer reported `none`, so no
 *      photo rendered at all and no error was logged anywhere.
 *
 * Setting the absolute URL from JS sidesteps both: the base is the only thing
 * that is unambiguous, and it is computed once, here.
 *
 * ⚠️ This MUST stay in sync with the `static/*.jpg` files copied by the
 * `build:h5` script (apps/dashboard/package.json) and with the regex in the
 * inline script in src/index.html that stamps `data-page`.
 */

/** Mirrors `@mixin wallpaper-dark` in styles/wallpaper.scss. */
const DARK_SCRIM =
  'linear-gradient(to bottom, rgba(10,11,15,0.34) 0%, rgba(10,11,15,0.10) 38%, rgba(10,11,15,0.52) 100%)';

/**
 * Mirrors `@mixin wallpaper-light` in styles/wallpaper.scss.
 *
 * ⚠️ The alpha here was 0.90 → 0.97, which made the photo invisible: at 90%+
 * opacity the layer contributes 3–10% of the final pixel, so the light theme
 * rendered as flat cream and the wallpaper looked broken rather than dim. It
 * survived because it was authored while the background was not painting at
 * all — see the three failed approaches in `applyBackground` — so there was
 * never a photo to notice the scrim was erasing. Verified side by side against
 * the dark theme, which uses 0.34 → 0.52 and shows the image plainly.
 *
 * Still deliberately heavier than the dark scrim: light mode sets dark type, so
 * the backing has to stay light or the text loses contrast against a dark
 * photo.
 *
 * ⚠️ Tuned against BOTH wallpapers, not one. An intermediate value of
 * 0.66 → 0.58 read well over `home.jpg` (soft peach clouds) and badly over
 * `coof.jpg` (high-contrast red/white flowers), where the small labels —
 * "本年度", "部" — dissolved into the image and the dark type lost contrast.
 * One number has to hold for both, and legibility wins over how much of the
 * photo shows: a wallpaper nobody can read text over is not a wallpaper.
 */
// ⚠️ 0.80 / 0.74 / 0.88 → 0.58 / 0.46 / 0.70（读者 2026-09-29：
//    「背景的白色模糊太白，可以改为玻璃质感而且有流动感」）。
//
//    上面那段论证「浅色主题必须压得重」**是对的**，但结论错了：
//    让字读得清不止「多盖一点」一条路。另一条是**别平铺着盖** ——
//    把白色换成一层会流动的玻璃（`styles/wallpaper.scss` 的 `.cevtuo-glass`），
//    照片留着、只是没了边。磨砂纸和玻璃的区别正在这里。
//
//    ⚠️ 这个值必须和 `styles/wallpaper.scss` 里 `wallpaper-light` 的
//      那一份**一起改** —— 那份是挂载前的兜底，这份是真正在画的。
//      同一个数字存两份，正是这个项目反复栽的那个形状。
const LIGHT_SCRIM =
  'linear-gradient(to bottom, rgba(246,243,240,0.58) 0%, rgba(242,240,238,0.46) 46%, rgba(236,235,234,0.70) 100%)';

/**
 * ⚠️ 这张「页面 → 背景图」的表**搬到 `platform/gallery.ts` 了**
 *    （读者 2026-09-29：「用这些图片把网站上的所有图片背景都换掉」，
 *      并且每页的那张图同时要出现在一枚画框里）。
 *
 *    ⇒ 一个页面一张图，**只在一个地方定义**（`GALLERY`）——
 *      背景和画框各自查一次。两处各写一份的结果不是「差不多」，
 *      是背景换了画框没换，而两边单独看都正常。
 *
 *    ⚠️ 老的五张背景图（`static/home.jpg` 等）**没有删**，留在库里当备用：
 *      想换回某一张，把 `gallery.ts` 里那张的路径指过去就行。
 *      （它们是 900px 左右的老图，画质比新的画廊低一档。）
 */
import { cdnImage } from './cdn';
import { PAGE_ORDER, galleryFile, onGalleryReroll } from './gallery';

const DEFAULT_PAGE = 'home';

/**
 * The route segment for the current hash, or `home`.
 *
 * ⚠️ Feature-detects rather than reading `process.env.TARO_ENV` — `process` does
 * not exist in this bundle and touching it throws at runtime (see
 * platform/data.ts). In the mini program there is no `location`, so this returns
 * the default and the caller skips the DOM work entirely.
 */
export function currentPage(): string {
  if (typeof location === 'undefined') return DEFAULT_PAGE;

  /*
   * ⚠️⚠️⚠️ **页面名在 `pathname` 里，不在 `hash` 里（2026-10-07 路由改成 browser）。**
   *
   * 原来只读 hash ⇒ `currentPage()` **永远返回 `home`**。后果是**两处**，
   * 而且都不报错、都"看起来正常"：
   *   ① `backgroundUrl()` 永远给主页那张 ⇒ **每一页的背景都一样**
   *      （读者 2026-10-07：「进入 CHEALTH 等页面的时候我希望的是更换另一个背景
   *        要是不同的，这样感觉明白我是在主页还是不是在主页」）；
   *   ② `GalleryFrame` 也以为自己在主页 ⇒ 内页挂的是**主页那三枚画框**
   *      （右侧、三枚），而不是内页该有的那一枚。
   *
   * ⚠️ 这一段要认 **四种** URL，因为站点同时存在它们：
   *    · `/chealth`                      —— browser 路由的干净 URL（线上主用）
   *    · `/`                              —— 主页
   *    · `/pages/chealth/index`          —— Taro 的原始页名（旧深链、探针在用）
   *    · `#/pages/chealth/index`         —— 更早的 hash 路由（老书签；
   *                                          `index.html` 里那段改写脚本会把它换掉，
   *                                          但它跑之前仍然可能被读到）
   *
   * ⚠️ 判据仍然是「**在不在 `PAGE_ORDER` 里**」：不判的话任何一段路径
   *    （`index.html`、`z`…）都会被算成一个已知页面，于是背景和画框
   *    都静默地退到兜底那一张。
   */
  const known = (s: string | undefined): string | undefined =>
    s && (PAGE_ORDER as readonly string[]).includes(s) ? s : undefined;

  const path = location.pathname || '';

  // ① `/pages/<name>/index` —— 原始页名
  const mPath = /\/pages\/([a-z]+)\/index/.exec(path);
  const fromPath = known(mPath?.[1]);
  if (fromPath) return fromPath;

  // ② `/chealth`、`/CEVTUO-Z/chealth` —— 干净 URL 的最后一段
  const lastSeg = path.replace(/\/+$/, '').split('/').pop();
  const fromSeg = known(lastSeg);
  if (fromSeg) return fromSeg;

  // ③ 旧的 hash 路由
  const mHash = /#\/pages\/([a-z]+)\//.exec(location.hash || '');
  const fromHash = known(mHash?.[1]);
  if (fromHash) return fromHash;

  return DEFAULT_PAGE;
}

/**
 * Absolute URL of the background for the current page.
 *
 * ⚠️ Built from the PAGE's directory, not from the origin.
 *
 * The app is not always served from a domain root — it is tested under `/z/`
 * locally and ships to GitHub Pages at `/CEVTUO-Z/`. Anchoring at the origin
 * produced `http://host/static/home.jpg`, which is a 404 in both of those, and
 * the background simply never appeared.
 *
 * The H5 router is hash-based, so `location.pathname` is the mount point and
 * nothing after it moves between routes — taking the directory of it is stable
 * for the lifetime of the document.
 */
/**
 * ⚠️ 把仓库里的相对路径（`static/...`）变成**绝对 URL**。
 *
 *    抽出来是因为**画框**也要用同一套解析（`GalleryFrame` 的 `<img src>`）——
 *    两处各写一遍的结果是其中一个在子目录部署下 404，而另一个正常。
 *    ⚠️ 上面这段注释记着三次失败：相对 URL 会按**样式表**的目录解析。
 *      所以「谁去解析」这件事只能有一个答案，就是这里。
 */
export function assetUrl(rel: string): string {
  // ⚠️ No `location` in the mini program, and no DOM to apply this to either —
  // unreachable there, but returning a bare relative path beats throwing.
  if (typeof location === 'undefined') return rel;

  /*
   * ⚠️⚠️ **基准恒为 `/`（根），不再从 `pathname` 推。**
   *
   * 原来那行靠"`#/pages/x/index` 永远进不了 pathname"来保证 pathname 就是挂载点。
   * 而 2026-10-07 路由改成了 **browser** ⇒ pathname **就是路由** ⇒
   * 在 `/pages/home/index` 上推出 `/pages/home/`，壁纸和图片全变成
   * `/pages/home/static/...` ⇒ **404**（表现是壁纸不见了，而页面不报错）。
   *
   * 现在 `publicPath` 是 `/`、站点根挂载（三处生产入口都是根），所以基准就是 `/`。
   * ⚠️ 这条和 `platform/data.ts` 里那份 `assetUrl` 是**同一个决定**，要改一起改。
   */
  return `${location.origin}/${rel.replace(/^\/+/, '')}`;
}

/**
 * 图片专用：能走国内镜像就走，否则**原样**走本域。
 *
 * ⚠️ 为什么不是直接改 `assetUrl` —— 它也喂 `data/...`（见 `cdn.ts` 里的三条判据）。
 */
export function imageUrl(rel: string): string {
  return cdnImage(rel) ?? assetUrl(rel);
}

export function backgroundUrl(): string {
  // ⚠️⚠️ 背景**改从画廊取**（读者 2026-09-29：「用这些图片把网站上的所有图片
  //    背景都换掉」）。五种页面都在 `PAGE_ORDER` 里，所以这一句就是「换背景」的
  //    全部 —— 换图只改 `platform/gallery.ts` 一处。
  //    ⚠️ `galleryFile` 自己带兜底（任何没配的页面拿第一张），
  //      所以这里不需要再兜一层。
  const file = galleryFile(currentPage());
  // ⚠️ 背景是图片 ⇒ 走 `imageUrl`（国内那台机器），不是 `assetUrl`
  return imageUrl(file);
}

/**
 * Paints the background onto an element, and keeps it current across routes.
 *
 * ⚠️ Returns a cleanup function. Taro's H5 router does not reload the document
 * between pages, so without the `hashchange` listener the background would stay
 * on whichever image the visitor landed on first.
 */
/**
 * ⚠️⚠️ **browser 路由下，`hashchange` 和 `popstate` 都不够。**
 *
 *   · `hashchange` —— 路由改 browser 之后 **hash 根本不变**，它一次都不触发；
 *   · `popstate`   —— 只在**前进/后退**时触发；
 *   · Taro 的 `navigateTo`（点分区、点返回键）走的是 **`history.pushState`**，
 *     ⚠️ **它不触发任何事件**。
 *
 * ⇒ 不把 `pushState`/`replaceState` 包一层，换页时壁纸就**纹丝不动** ——
 *    而它和"背景本来就该是这张"长得一模一样，一句报错都没有。
 *
 * ⚠️ 只包**一次**（模块级），不从 effect 里包：`Wallpaper` 每页挂一个，
 *    包多次会把 history 套成好几层，而且卸载时没法还原。
 */
const ROUTE_EVT = 'cevtuo:route';
let routePatched = false;

function patchHistoryOnce(): void {
  if (routePatched || typeof window === 'undefined' || !window.history) return;
  routePatched = true;
  for (const name of ['pushState', 'replaceState'] as const) {
    const orig = window.history[name];
    if (typeof orig !== 'function') continue;
    window.history[name] = function (this: History, ...args: unknown[]) {
      const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
      // ⚠️ 先改完 URL 再发事件 —— 监听者要读的是**新的** `location.pathname`。
      window.dispatchEvent(new Event(ROUTE_EVT));
      return r;
    } as typeof window.history[typeof name];
  }
}

export function applyBackground(el: HTMLElement | null): () => void {
  if (!el || typeof location === 'undefined') return () => {};

  // ⚠️ Read the resolved theme, not `prefers-color-scheme`. The theme class is
  // stamped on `html` by an inline script before first paint and re-stamped by
  // applyRootClasses(), so the class is the single source of truth — and it is
  // the thing the rest of the stylesheet keys off. Asking the media query
  // instead would let the photo's scrim disagree with the palette around it.
  //
  // ⚠️ 这一读从「effect 建立时读一次」挪进了 `paint()` —— 因为 `paint` 现在
  //    还会在**换页**时被调用，而主题可能在那之后变过（系统切深/浅色）。
  //    读一次的话，换页会把旧主题的 scrim 又刷回去。
  //    （原来是 `const isLight = …` 写在函数体里，`paint` 闭包捕获它。）

  // ⚠️ Sets the WHOLE `background-image`, photo AND scrim, in one declaration.
  //
  // Three approaches were tried and all three failed, each differently:
  //
  //   1. `background-image` set to the photo alone — clobbered the scrim from
  //      wallpaper.scss, so type sat on the raw photo with no contrast control.
  //   2. a relative `url()` in a custom property consumed by the stylesheet —
  //      re-resolved against the STYLESHEET's directory and 404'd.
  //   3. an absolute URL in a custom property consumed as
  //      `linear-gradient(...), var(--page-photo)` — the property computed to
  //      the correct value and the browser still reported `background-image:
  //      none`. Chrome (and therefore the WeChat WebView, which is Chromium)
  //      will not substitute a `url()` into a layered background-image.
  //
  // Owning the full value here means the scrim has to come along, so the two
  // gradients below must stay in step with wallpaper.scss. The colour values are
  // duplicated deliberately: the alternative is a stylesheet rule that silently
  // does nothing, which is what this replaces.
  const paint = () => {
    const isLight = document.documentElement.classList.contains('theme-light');
    const scrim = isLight ? LIGHT_SCRIM : DARK_SCRIM;
    el.style.backgroundImage = `${scrim}, url("${backgroundUrl()}")`;
  };
  paint();

  /*
   * ⚠️ 三个都要挂，缺一就有一整类导航换不动背景：
   *    · `hashchange` —— 老路由 / 老书签；
   *    · `popstate`   —— 前进、后退；
   *    · `ROUTE_EVT`  —— Taro 的 `pushState`（见 `patchHistoryOnce`）。
   */
  patchHistoryOnce();
  window.addEventListener('hashchange', paint);
  window.addEventListener('popstate', paint);
  window.addEventListener(ROUTE_EVT, paint);
  /**
   * ⚠️⚠️ 换一批（`rerollGallery`）之后**必须重画**，否则「下拉刷新换一批」
   *    只换画框不换壁纸 —— 而它们本该是**同一张画**（`gallery.ts` 那张表）。
   *
   *    读者 2026-10-04：「下边的**背景和画框**要每次点击刷新键才会（变）」。
   *    画框那半边早就接了（`GalleryFrame` 的 `epoch`），壁纸这半边漏了 ——
   *    因为壁纸是这里**命令式**写上去的一整条 `background-image`，
   *    React 重渲染碰不到它。两套机制、一个事件，所以要有这个订阅。
   */
  const off = onGalleryReroll(paint);
  return () => {
    window.removeEventListener('hashchange', paint);
    window.removeEventListener('popstate', paint);
    window.removeEventListener(ROUTE_EVT, paint);
    off();
  };
}
