/**
 * 画廊 —— **每个页面一张照片**，它同时驱动两样东西：
 *
 *   ① 这一页的**背景**（`platform/background.ts` 从这里取）
 *   ② 那一枚**画框**里显示的照片（`components/GalleryFrame.tsx`）
 *
 * ⚠️⚠️ **换图只改这一个文件。** 两处各写一份映射的结果不是「差不多」，
 *    是背景换了画框没换（或者反过来）—— 而两边单独看都正常。
 *
 * ── 怎么换 ────────────────────────────────────────────────────
 *
 * 最快的一条（推荐）：
 *
 *     bash scripts/gallery.sh add ~/Downloads/新照片.jpg
 *
 * 它会把图画质压到 1600px、写进 `apps/dashboard/static/gallery/`、
 * 打印出可用的名字，然后你把下面这张表里的一行改成那个名字就行。
 *
 * ⚠️ 图放 `apps/dashboard/static/gallery/`，**必须是 jpg**，长边 1600px 以内 ——
 *    这些照片原图是 6016×3384（单张 8MB），直接上站首屏要等十几秒。
 *    `scripts/gallery.sh add` 会替你压；手动放的话记得先压。
 *
 * ⚠️ 下面每一条的注释写的是**那张照片是什么**（我看过图之后写的），
 *    换图时把注释一起改掉 —— 否则下一个人不知道该挑哪张。
 */
export const GALLERY: Record<string, string> = {
  // 深浅蓝的玻璃天棚，仰拍，网格状反光
  home: 'g02',
  // 两栋高楼夹着一线天，灰白，极简
  coof: 'g03',
  // 黄绿色斑驳的墙面转角，画面中央有一枚白色手绘签名
  cnsr: 'g01',
  // 木质墙面上一幅深棕色的抽象画（画中画）
  paperr: 'g05',
  // 水晶吊灯，暖金色，背景压暗
  chealth: 'g04',
};

/** 兜底：任何没在表里的页面用它，而不是「没有图」。 */
export const GALLERY_FALLBACK = 'g06';

/** 图放在哪 —— 和 `build:h5` 里那条 `cp -R static/.` 对得上。 */
const DIR = 'static/gallery';

/** 页面 → 可以交给 `<img src>` 的**相对路径**（绝对化在 background.ts / 组件里做）。 */
export function galleryFile(page: string): string {
  const name = GALLERY[page] ?? GALLERY_FALLBACK;
  return `${DIR}/${name}.jpg`;
}

/**
 * ⚠️ 画框在左还是在右：**主页在右，内页在左**（读者 2026-09-29 定的）。
 *
 *    不是随手挑的：主页那几屏的文字是**左对齐**的，画框在右不挡字；
 *    而内页（各品牌页）左边是 hero 和标题、右边是长长的说明，
 *    画框压左边反而落在空白处。
 *    ⇒ 判据是「哪一边没有字」，不是「哪一边好看」。
 */
export function gallerySide(page: string): 'left' | 'right' {
  return page === 'home' ? 'right' : 'left';
}

/**
 * ⚠️ 画框**竖直方向**的位置（百分比 —— 画框中心落在视口这个高度）。
 *
 *    读者 2026-09-29：「位置太固定，只要这边的范围就可以」——
 *    之前五页一律钉在 50%，像同一张图在同一个位置贴了五次。
 *    现在每页给一个不同的值，**但都在这一侧的中段**，不越出这个范围。
 *
 *    ⚠️ 范围刻意只取 36~58：再往上碰顶栏、再往下碰底部那行「还有内容」。
 *    ⚠️ 纵向随便动的前提是**宽屏下正文已经横向让开**（见 GalleryFrame.scss
 *      的 `--gal-gutter-left`）—— 两者没有横向交集，所以纵向怎么动都不会压住字。
 *      ⚠️ 窄屏不适用：那里画框挂在屏幕外沿。两者改一个要想着另一个。
 */
export function galleryAnchor(page: string): number {
  const ANCHOR: Record<string, number> = {
    home: 50,
    coof: 42,
    cnsr: 57,
    paperr: 46,
    chealth: 38,
  };
  return ANCHOR[page] ?? 50;
}
