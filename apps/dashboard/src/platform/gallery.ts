/**
 * 画廊 —— 它同时驱动两样东西：
 *
 *   ① 这一页的**背景**（`platform/background.ts` 从这里取）
 *   ② 挂在墙上的那些**画框**（`components/GalleryFrame.tsx`）
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

/** 按**画廊里的名字**取路径（`g07` → `static/gallery/g07.jpg`）。 */
export function photoFile(name: string): string {
  return `${DIR}/${name}.jpg`;
}

/**
 * 画框的**做法**（不是一个「主题色」的开关 —— 是五种结构不同的框）。
 *
 * ⚠️⚠️ 读者 2026-09-29 第二轮：「这个部分的画框要做更多才可以，你只做啦一种画框，
 *    我要求在网站上的各个地方的画框都不一样」。
 *
 *    所以这五个**不是同一个框换颜色**，是五种真的做法：
 *
 *      moulding  木/金属**有截面的实框** + 米白卡纸 + 照片。经典装裱。
 *      gilt      一条**细亮金线**当外框，卡纸是**深色**的（关系反过来）。
 *      float     无框画布 —— 照片自己就是那块布，**厚而软的投影**让它离开墙。
 *      double    **双层卡纸**：外层米白，内层再一圈，中间留一条细缝。
 *      bevel     金属**倒角**框，45° 的亮面在外，暗面在内。
 */
export type FrameStyle = 'moulding' | 'gilt' | 'float' | 'double' | 'bevel';

/**
 * 一枚画框。尺寸**按枚给**，不再是「一页一个尺寸」——
 * 因为主页上要挂好几枚，它们各不一样（读者 2026-09-30：「主页面上放置更多的画框」）。
 *
 * ⚠️ `anchor` 是**竖直中心落在视口的百分之几**；`inset` 是离它那一侧的屏幕边多少 px。
 * ⚠️ 窄屏（≤700px）用 `narrow` 那一组 —— 手机上画框小得多，而且**贴边挂出去**。
 */
export interface FrameSpec {
  /** 给 React 当 key，也用来在验证器里点名。 */
  key: string;
  style: FrameStyle;
  side: 'left' | 'right';
  /** 竖直中心，视口百分比（36~88 —— 再往上碰顶栏，再往下出屏幕）。 */
  anchor: number;
  w: number;
  h: number;
  inset: number;
  /**
   * 这一枚里放的**是哪张**（画廊里的名字）。不给就用这一页背景那一张。
   *
   * ⚠️⚠️ 主页必须**每枚给一张不同的** —— 这是**看了图**才发现的：
   *    三枚都放 g02（也就是主页背景本身那张）时，无框画布那枚
   *    和壁纸**糊成一整块**，读不出「这是挂在墙上的另一件东西」，
   *    只剩框的材料还能认出是个框。
   *    画框和壁纸**同源**是这里唯一的陷阱：单看 DOM 一切正常。
   */
  photo?: string;
  /**
   * ⚠️ 这里**没有** `z` 字段 —— 不是漏了。
   *    三枚画框必须是**同一个** z-index（−1，见 GalleryFrame.scss 那段），
   *    它们之间的前后由**数组顺序**（也就是 DOM 顺序）决定：
   *    同一个 z-index 下，后画的在上面。给成 −1/−2/−3 是错的 ——
   *    壁纸也在 −1，−2/−3 会掉到**壁纸底下**，整枚看不见。
   */
  narrow: { w: number; h: number; inset: number };
}

/**
 * ⚠️⚠️ 读者 2026-09-30 定的三件事，都在这张表里：
 *
 *   ① **COOF 那页不放画框**（`frames()` 对 coof 返回空数组）。
 *   ② **主页放更多**（三枚，尺寸/做法/高度都不同）。
 *   ③ **不怕内容压住** —— 画框是装饰，正文压在上面是对的。
 *      见 `GalleryFrame.scss` 里 `.gal` 的 `z-index` 与窄屏的让位量。
 */
// ⚠️ 三枚的**高度加起来 + 两道缝必须装得进 900 高的视口**：
//    210 + 20 + 320 + 20 + 230 = 800，从 y=57 起，到 y=862 收。
//    第一版没算这一条，中枚和下枚在右下角**叠了 65px** —— 而探针说
//    「三枚都在、都在内容之下」，全绿。**是看截图看出来的。**
//    ⚠️ 视口矮于 ~820 时它们会开始相叠。这是**故意不处理的**：
//      矮视口上要么相叠、要么三枚都小到看不清，而读者要的是「更多画框」。
const HOME_FRAMES: FrameSpec[] = [
  {
    key: 'home-a',
    // 无框画布 —— 最轻的一枚，放在上段
    style: 'float',
    photo: 'g08',
    side: 'right',
    anchor: 18,
    w: 200,
    h: 210,
    inset: 48,
    narrow: { w: 104, h: 118, inset: 60 },
  },
  {
    key: 'home-b',
    // 经典实木框 —— 主画，最大，正中间
    style: 'moulding',
    photo: 'g07',
    side: 'right',
    anchor: 50,
    w: 288,
    h: 320,
    inset: 112,
    narrow: { w: 132, h: 158, inset: 150 },
  },
  {
    key: 'home-c',
    // 双层卡纸 —— 下段，靠边
    style: 'double',
    photo: 'g09',
    side: 'right',
    anchor: 83,
    w: 216,
    h: 230,
    inset: 40,
    narrow: { w: 110, h: 128, inset: 150 },
  },
];

/**
 * 这一页要挂哪几枚画框。**空数组 = 这页不挂**（COOF 就是这样）。
 *
 * ⚠️ 主页在**右**、内页在**左**（读者 2026-09-29）。
 *    不是随手挑的：主页那几屏的文字是**左对齐**的，画框在右不挡字；
 *    而内页左边是 hero 和标题、右边是长长的说明，
 *    画框压左边反而落在空白处。⇒ 判据是「哪一边没有字」，不是「哪一边好看」。
 */
export function frames(page: string): FrameSpec[] {
  // ⚠️⚠️ 读者 2026-09-30：「COOF 这个页面的不放画框，其余的都放」。
  //    ⇒ 空数组。**注意它同时意味着 `--gal-gutter-left` 不会生效**
  //      （那条规则挂在 `.page:has(.gal--left)` 上）—— 这是对的：
  //      没有画框的页面不该白白让掉一条 378px。
  if (page === 'coof') return [];

  if (page === 'home') return HOME_FRAMES;

  // 其余内页：一枚，在左。竖直位置**按页给**（读者：「位置太固定」）——
  // 之前五页一律钉在 50%，像同一张图在同一个位置贴了五次。
  return [
    {
      key: page,
      style: frameStyle(page),
      side: 'left',
      anchor: ANCHOR[page] ?? 50,
      w: WIDE[page]?.w ?? 300,
      h: WIDE[page]?.h ?? 375,
      inset: WIDE[page]?.inset ?? 48,
      narrow: { w: 156, h: 195, inset: -62 },
    },
  ];
}

/**
 * ⚠️ 画框**竖直方向**的位置（百分比 —— 画框中心落在视口这个高度）。
 *
 *    读者 2026-09-29：「位置太固定，只要这边的范围就可以」。
 *    ⚠️ 范围刻意只取 36~58：再往上碰顶栏、再往下碰底部那行「还有内容」。
 */
const ANCHOR: Record<string, number> = {
  cnsr: 57,
  paperr: 46,
  chealth: 38,
};

/**
 * 宽屏下每种做法给内页的尺寸。
 * ⚠️ 只有**一处**有数字 —— 让位量本来是从这里算出来的（见 GalleryFrame.scss）。
 */
const WIDE: Record<string, { w: number; h: number; inset: number }> = {
  cnsr: { w: 304, h: 380, inset: 46 },
  paperr: { w: 300, h: 375, inset: 48 },
  chealth: { w: 300, h: 375, inset: 52 },
};

/**
 * 宽屏下正文要给**左侧**那枚画框让开多少 px。
 *
 * ⚠️⚠️ 这是「四个数是一组、动一个要看另外三个」那条坑的解法：
 *    让位量 = 离边 + 框宽 + 间隙，**从同一份 spec 算出来**，
 *    而不是在 SCSS 里再手写一个数。
 *    这个项目栽过：两处各写一份的结果是改了一处、另一处压着正文，
 *    而**两边单独看都正常**。
 *
 * ⚠️⚠️ 而**窄屏刻意不让**（读者 2026-09-30）：
 *    「在窄屏幕上，所有的内容都要压住画框，不能画框不敢被压住导致内容看不了多少位置」。
 *    ⇒ 手机上让位量是 0，正文满宽，画框在它底下。
 *    这个「窄屏不让」写在 `GalleryFrame.scss` 的媒体查询里（那边管断点）。
 */
export function gutterFor(page: string): number {
  const left = frames(page).find((s) => s.side === 'left');
  if (!left) return 0;
  return left.inset + left.w + 30; // 30 = 正文和画框之间的间隙
}

/**
 * 哪一页用哪种做法。
 *
 * ⚠️⚠️ 读者要的是「**各个地方**的画框都不一样」，所以要**看这张表里的分配**，
 *    不是只看 SCSS 里有几种做法 —— 做法写了五种、而实际只用到四种，
 *    在页面上是**看不出来**的（每一页自己都挺好看）。
 *
 *    2026-09-30 的现场：COOF 不挂画框之后，原本给它的 `gilt` 就成了**死代码**，
 *    而 `moulding` / `double` 各被两处用到（主页与内页各一）——
 *    这一条是**核对这张表**发现的，不是看页面发现的。
 *
 *    现在的分配（六枚画框、五种做法，只有一处在主页和内页之间重了）：
 *      home-a float ・ home-b moulding ・ home-c double
 *      cnsr   double ・ paperr **gilt** ・ chealth bevel
 */
function frameStyle(page: string): FrameStyle {
  const STYLE: Record<string, FrameStyle> = {
    cnsr: 'double',
    // ⚠️ paperr 原来是 `moulding`，和主页那枚重了；改成 `gilt`，
    //    让五种做法**都用上**（细金线 + 深色卡纸，也配「书」这件事）。
    paperr: 'gilt',
    chealth: 'bevel',
    // coof 不放画框（`frames()` 对它返回空数组），这里只是兜底
    coof: 'gilt',
  };
  return STYLE[page] ?? 'moulding';
}
