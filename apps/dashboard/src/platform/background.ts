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
import { PAGE_ORDER, galleryFile } from './gallery';

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
  const m = /#\/pages\/([a-z]+)\//.exec(location.hash || '');
  const key = m?.[1];
  // ⚠️ 判据从「在不在 BACKGROUNDS 里」改成「在不在 PAGE_ORDER 里」——
  //    那张表搬走了（见上面那段）。**仍然要判**：不判的话任何
  //    `/pages/<什么>/index` 都会被当成一个已知页面，于是画框和背景
  //    都拿到兜底图，而 `gallerySide` 也会按「内页」处理。
  return key && (PAGE_ORDER as readonly string[]).includes(key) ? key : DEFAULT_PAGE;
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

  const path = location.pathname || '/';
  // `#/pages/x/index` never reaches pathname (it is the hash), so this is the
  // mount directory: '/' at a root deploy, '/z/' or '/CEVTUO-Z/' otherwise.
  const base = path.slice(0, path.lastIndexOf('/') + 1);
  return `${location.origin}${base}${rel}`;
}

export function backgroundUrl(): string {
  // ⚠️⚠️ 背景**改从画廊取**（读者 2026-09-29：「用这些图片把网站上的所有图片
  //    背景都换掉」）。五种页面都在 `PAGE_ORDER` 里，所以这一句就是「换背景」的
  //    全部 —— 换图只改 `platform/gallery.ts` 一处。
  //    ⚠️ `galleryFile` 自己带兜底（任何没配的页面拿第一张），
  //      所以这里不需要再兜一层。
  const file = galleryFile(currentPage());
  return assetUrl(file);
}

/**
 * Paints the background onto an element, and keeps it current across routes.
 *
 * ⚠️ Returns a cleanup function. Taro's H5 router does not reload the document
 * between pages, so without the `hashchange` listener the background would stay
 * on whichever image the visitor landed on first.
 */
export function applyBackground(el: HTMLElement | null): () => void {
  if (!el || typeof location === 'undefined') return () => {};

  // ⚠️ Read the resolved theme, not `prefers-color-scheme`. The theme class is
  // stamped on `html` by an inline script before first paint and re-stamped by
  // applyRootClasses(), so the class is the single source of truth — and it is
  // the thing the rest of the stylesheet keys off. Asking the media query
  // instead would let the photo's scrim disagree with the palette around it.
  const isLight = document.documentElement.classList.contains('theme-light');

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
    const scrim = isLight ? LIGHT_SCRIM : DARK_SCRIM;
    el.style.backgroundImage = `${scrim}, url("${backgroundUrl()}")`;
  };
  paint();

  window.addEventListener('hashchange', paint);
  return () => window.removeEventListener('hashchange', paint);
}
