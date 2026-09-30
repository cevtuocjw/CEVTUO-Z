/**
 * 画廊 —— 它同时驱动两样东西：
 *
 *   ① 这一页的**背景**（`platform/background.ts` 从这里取）
 *   ② 挂在墙上的那些**画框**（`components/GalleryFrame.tsx`）
 *
 * ⚠️⚠️ **换图只改这一个文件。** 两处各写一份映射的结果不是「差不多」，
 *    是背景换了画框没换（或者反过来）—— 而两边单独看都正常。
 *
 * ── 怎么加图 ──────────────────────────────────────────────────
 *
 *     bash scripts/gallery.sh add ~/Downloads/新照片.jpg
 *
 * 它会把图画质压到 1600px、写进 `apps/dashboard/static/gallery/`、
 * 打印出可用的名字，然后把名字加进下面的 `PHOTOS` 就行。
 *
 * ⚠️ 图放 `apps/dashboard/static/gallery/`，**必须是 jpg**，长边 1600px 以内 ——
 *    这些照片原图是 6016×3384（单张 8MB），直接上站首屏要等十几秒。
 */
/** 画廊里所有的照片。⚠️ 换图/加图只改这一行。 */
const PHOTOS = ['g01', 'g02', 'g03', 'g04', 'g05', 'g06', 'g07', 'g09', 'g10'];

/** 图放在哪 —— 和 `build:h5` 里那条 `cp -R static/.` 对得上。 */
const DIR = 'static/gallery';

/** 按**画廊里的名字**取路径（`g07` → `static/gallery/g07.jpg`）。 */
export function photoFile(name: string): string {
  return `${DIR}/${name}.jpg`;
}

/**
 * ⚠️⚠️ **每次刷新都重新洗牌**（读者 2026-09-30）：
 *    「我需要对于所有的画和所有的画框要每次**刷新都随机出**，
 *      而不是一直保持不变」。
 *
 * ⚠️ 种子在**模块加载时**算一次，同一次加载里所有调用**完全相同** ——
 *    否则每次 React 重渲染画框都会换一张、页面会闪。
 *    「刷新变、渲染不变」正是这里要的那个粒度。
 *
 *   ⚠️ 用 `mulberry32` 而不是 `Math.random()`：需要一个**可复现**的序列，
 *      因为「同一页里两枚画框不能重样」要靠「从洗好的序列里依次取」，
 *      而不是「随机取、撞了再重取」（后者在池子小的时候会死循环）。
 */
const SEED = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 洗一份**确定性**的牌（同一个 `seed` 永远得到同一个顺序）。 */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 画框的**做法**。⚠️ 全部来自读者给的参考图（pin.it 那 7 个链接，
 * 2026-09-30 逐张下载看过），一个都不是我编的：
 *
 *   ornate     油画外框    厚重、深色、多道线脚的雕花木框
 *   gallery    极简细框    **很细**的深框 + **很大**的浅色卡纸 + 小照片
 *   tray       银器托盘    银渐变 + **珠串边** + 圆角（托盘的口沿）
 *   arch       拱顶金属框  拉丝金属板 + **拱形开口**（上面是圆拱）
 *   ricrac     织物滚边    帆布织纹 + 一圈**锯齿滚边**
 *   polaroid   拍立得      白框，**底边特别宽**
 *   film       胶片拼贴    深色片基 + 上下**齿孔**
 *
 *   moulding / gilt / double / bevel 是更早一轮做的，留着。
 *
 *   ── 第二批（同样来自读者给的链接）──────────────────────────
 *   antique   复古金框    细金带 + 一道内阶，几乎不留卡纸
 *   baroque   复古银框    繁复**雕花**银框（最厚的一枚）
 *   lace      蕾丝边      米白蕾丝 + **扇贝形**内缘
 *   gothic    椭圆黑蕾丝  黑色 + **波浪/尖拱**内缘
 *   barbed    铁丝网      细黑**枝桠带刺**的方框
 *   gnarl     哥特枝桠    黑色有机、边缘**不规则**（滴与刺）
 *
 * ⚠️⚠️ **没有「无框」这一档。** 原来有个 `float`（无框画布，只靠投影），
 *    读者 2026-09-30 明确否掉了：「也不允许出现池塘这幅这样**没有画框**的」。
 *    ⇒ 每一种做法都必须**看得出来是个框**（有边、有卡纸或有一圈线）。
 */
export const FRAME_STYLES = [
  'ornate',
  'gallery',
  'tray',
  'arch',
  'ricrac',
  'polaroid',
  'film',
  'moulding',
  'gilt',
  'double',
  'bevel',
  // 读者 2026-09-30 第二批（6 个 pinterest 链接，同样逐张下载看过）
  'antique',
  'baroque',
  'lace',
  'gothic',
  'barbed',
  'gnarl',
] as const;

export type FrameStyle = (typeof FRAME_STYLES)[number];

/**
 * ⚠️ 页面的固定顺序 —— 「哪一页拿哪张图 / 哪种做法」都从这个顺序往后数。
 *    ⚠️ 它必须**稳定**：加一页就往后顺延，不要插在中间（插在中间会让
 *      所有页的分配整体错位，而那是看不见的）。
 */
export const PAGE_ORDER = ['home', 'coof', 'cnsr', 'paperr', 'chealth'] as const;

const PHOTO_DECK = shuffled(PHOTOS, SEED);
const STYLE_DECK = shuffled(FRAME_STYLES, SEED ^ 0x9e3779b9);

/**
 * 这一页的背景用哪张。
 *
 * ⚠️ 读者：「所有的画……每次刷新都随机出」—— 背景也是「一张画」，
 *    所以它跟着一起洗。
 */
export function galleryFile(page: string): string {
  const i = Math.max(0, PAGE_ORDER.indexOf(page as (typeof PAGE_ORDER)[number]));
  return photoFile(PHOTO_DECK[i % PHOTO_DECK.length]!);
}

/**
 * ⚠️ 一枚画框的**几何**。几何**不随机** —— 它决定版面，
 *    而随机的是「长什么样」（`style`）和「里面是哪张」（`photo`）。
 *    ⚠️ 这两件事必须分开：几何一随机，正文就可能被推到屏幕外
 *      （这个项目真的干过一次，整页空白而断言全绿）。
 */
export interface FrameSpec {
  key: string;
  style: FrameStyle;
  side: 'left' | 'right';
  /** 竖直中心，视口百分比。 */
  anchor: number;
  w: number;
  h: number;
  inset: number;
  /** ⚠️ 静态倾角（度）—— 「这枚画当初就挂歪了」。和指针跟随的 tx/ty 是两回事。 */
  rotate: number;
  /** 这一枚里放哪张（已洗过，同一页里不重样）。 */
  photo: string;
  narrow: { w: number; h: number; inset: number };
}

/**
 * ⚠️⚠️ 读者 2026-09-30 定的：
 *   ① **COOF 不放画框** ② **主页放三枚** ③ **不怕内容压住**（不为画框让位）
 *   ④ **每次刷新随机** ⑤ **CNSR 和主页的画框不许一样**（⇒ 全局不重样）
 *   ⑥ **不许出现没有画框的**
 *
 * 几何（`anchor`/`w`/`h`/`inset`/`rotate`）是**手挑的**，做法和照片是洗出来的。
 */
interface FrameGeo {
  /** ⚠️ 内页的 key 就是页名 —— 验证器靠它点名。 */
  key: string;
  anchor: number;
  w: number;
  h: number;
  inset: number;
  rotate: number;
  narrow: { w: number; h: number; inset: number };
}

const HOME_GEO: FrameGeo[] = [
  { key: 'home-a', anchor: 18, w: 200, h: 210, inset: 200, rotate: -1.8, narrow: { w: 104, h: 118, inset: 60 } },
  { key: 'home-b', anchor: 50, w: 288, h: 320, inset: 330, rotate: 1.3, narrow: { w: 132, h: 158, inset: 150 } },
  { key: 'home-c', anchor: 83, w: 216, h: 230, inset: 160, rotate: -0.9, narrow: { w: 110, h: 128, inset: 150 } },
];

const PAGE_GEO: Record<string, FrameGeo> = {
  cnsr: { key: 'cnsr', anchor: 57, w: 304, h: 380, inset: 46, rotate: -1.4, narrow: { w: 156, h: 195, inset: -62 } },
  paperr: { key: 'paperr', anchor: 46, w: 300, h: 375, inset: 48, rotate: 1.7, narrow: { w: 156, h: 195, inset: -62 } },
  chealth: { key: 'chealth', anchor: 38, w: 300, h: 375, inset: 52, rotate: -2.2, narrow: { w: 156, h: 195, inset: -62 } },
};

const PAGE_SIDE: Record<string, 'left' | 'right'> = { home: 'right', cnsr: 'left', paperr: 'left', chealth: 'left' };

/**
 * 这一页要挂哪几枚画框。**空数组 = 这页不挂**（COOF 就是这样）。
 *
 * ⚠️⚠️ 「做法」和「照片」**从洗好的牌里依次抽**，于是：
 *      · 同一页里几枚**不重样**（依次抽，不重复）
 *      · **跨页也不重样** —— 全局第一条从这里开始数
 *        ⇒ 读者那条「CNSR 和主页的画框是一样的，这种不允许出现」自动成立。
 *      ⚠️ 牌堆有 11 张做法、9 张照片，而全站一共 6 枚 ⇒ 抽得开。
 */
export function frames(page: string): FrameSpec[] {
  // ⚠️ 读者 2026-09-30：「COOF 这个页面的不放画框，其余的都放」。
  if (page === 'coof') return [];

  const pageIdx = Math.max(0, PAGE_ORDER.indexOf(page as (typeof PAGE_ORDER)[number]));
  // 几何的偏移：前几页各用掉几枚，做法/照片就从那一格往后数
  const used = PAGE_ORDER.slice(0, pageIdx).reduce((a, p) => a + (p === 'coof' ? 0 : p === 'home' ? 3 : 1), 0);
  const bg = galleryFile(page).split('/').pop()!.replace('.jpg', '');

  const geo: FrameGeo[] = page === 'home' ? HOME_GEO : [PAGE_GEO[page] ?? PAGE_GEO.paperr!];
  return geo.map((g, i) => {
    const n = used + i;
    // ⚠️ 照片要跳过「这一页背景那张」—— 画框和壁纸同一张时，
    //    无框的那几枚会和壁纸糊成一整块（上一轮的真 bug）。
    // ⚠️ 索引里**只有 `n`**，不能加 `pageIdx` —— 加了之后模 9 会绕回去撞上
    //    已经用过的那张（实测 home-a 和 chealth 都拿到 g09）。
    //    `n` 是**全局第几枚**（0..5），而池子有 9 张 ⇒ `(n + k) % 9` 在 0..5 上
    //    是**单射**的，不重复。这正是「依次抽牌」比「随机抽、撞了重抽」稳的地方。
    let photo = PHOTO_DECK[(n + 1) % PHOTO_DECK.length]!;
    if (photo === bg) photo = PHOTO_DECK[(n + 2) % PHOTO_DECK.length]!;
    return {
      key: g.key,
      style: STYLE_DECK[n % STYLE_DECK.length]!,
      side: (PAGE_SIDE[page] ?? 'left') as 'left' | 'right',
      anchor: g.anchor,
      w: g.w,
      h: g.h,
      inset: g.inset,
      rotate: g.rotate,
      photo,
      narrow: g.narrow,
    } as FrameSpec;
  });
}

/**
 * ⚠️⚠️ **没有让位量**（读者 2026-09-30：「每页的所有的画框都应该是
 *    可以跟内容重叠着的，而不是占据了很多版面」）。
 *    留着这个函数只是为了让「为什么没有」有个能写注释的地方。
 */
export function gutterFor(): number {
  return 0;
}
