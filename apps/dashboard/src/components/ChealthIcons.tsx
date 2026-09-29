/**
 * CHEALTH 的图标集 —— **内联 SVG，颜色走 `currentColor`**。
 *
 * ⚠️ 为什么不用 emoji / Unicode 符号（`🚴 ▦ ≋ ▤ ↑ ↓`）：
 *   它们长什么样**完全取决于机器上装了什么字体**。这个项目已经踩过：
 *   侧边栏用 `▦ ≋ ▤` 时，不同设备上有的显示成方块、有的变成两个字符宽。
 *   emoji 更糟 —— 彩色、风格不可控，和页面的黑白排版完全不是一套语言。
 *
 * ⚠️ 也不从图标库里抄 path。抄来的 path 一旦有笔误，渲染出来是**一坨看不出
 *    是错的形状**，而且没人会去逐个核对。这里全部用**基本图形**（圆、线、
 *    矩形、折线）拼出来 —— 每个都能一眼看出对不对。
 *
 * ⚠️ 尺寸走 `1em`，所以图标跟着字号走，不需要在每个调用点传 size。
 */

type Name =
  | 'steps' | 'heart' | 'flame' | 'moon' | 'route' | 'bolt' | 'clock'
  | 'power' | 'cadence' | 'bike' | 'run' | 'gym' | 'swim' | 'walk'
  | 'up' | 'down' | 'flat' | 'trophy' | 'signal' | 'watch' | 'spark' | 'chev' | 'arrow'
  /** ⚠️ 关闭。见 `Body` 里 `x` 那段 —— 关闭按钮**不该**用 `chev`。 */
  | 'x';

const S = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none' } as const;
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Body({ name }: { name: Name }) {
  switch (name) {
    // 脚印：两个椭圆 + 两个脚趾点
    case 'steps':
      return (
        <g fill="currentColor">
          <ellipse cx="8" cy="15" rx="3" ry="4.2" />
          <circle cx="6.4" cy="9.2" r="1.5" />
          <ellipse cx="16" cy="12.4" rx="3" ry="4.2" />
          <circle cx="14.4" cy="6.4" r="1.5" />
        </g>
      );
    case 'heart':
      return <path d="M12 20.5S4 15.2 4 9.8A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 8 2.6c0 5.4-8 10.7-8 10.7z" {...stroke} />;
    // 火苗：一条外轮廓 + 内焰
    case 'flame':
      return (
        <g {...stroke}>
          <path d="M12 3c3.4 3.2 5.4 6 5.4 9a5.4 5.4 0 1 1-10.8 0c0-1.6.7-3.2 2-4.8.3 1.2 1 2 1.9 2.3C10.2 7.4 10.9 5.2 12 3z" />
        </g>
      );
    // 月牙：大圆挖小圆（用两段弧）
    case 'moon':
      return <path d="M20 14.4A8.4 8.4 0 0 1 9.6 4 8.4 8.4 0 1 0 20 14.4z" {...stroke} />;
    // 路线：一条折线 + 两端点
    case 'route':
      return (
        <g {...stroke}>
          <circle cx="5.5" cy="18.5" r="2.3" />
          <circle cx="18.5" cy="5.5" r="2.3" />
          <path d="M7.6 17.1c3-1.2 2.2-4 4.4-5.6 2-1.5 2.4-3.9 4.3-4.9" />
        </g>
      );
    // 闪电：实心多边形，一眼可辨
    case 'bolt':
      return <path d="M13.2 2 5 13.4h5.2L9.6 22 18 10.6h-5.3z" fill="currentColor" />;
    case 'clock':
      return (
        <g {...stroke}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.2V12l3.2 2" />
        </g>
      );
    // 功率：闪电装进圆里，和纯闪电区分开
    case 'power':
      return (
        <g {...stroke}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12.8 7.4 9.4 12.4h3l-.6 4.2 3.6-5.1h-3z" fill="currentColor" />
        </g>
      );
    // 踏频：一圈箭头
    case 'cadence':
      return (
        <g {...stroke}>
          <path d="M20 12a8 8 0 1 1-2.6-5.9" />
          <path d="M20 4v3.4h-3.4" />
        </g>
      );
    // 骑行：两个轮 + 车架
    case 'bike':
      return (
        <g {...stroke}>
          <circle cx="6" cy="16.5" r="3.6" />
          <circle cx="18" cy="16.5" r="3.6" />
          <path d="M6 16.5 10 8h4l2 8.5M9 8h4.5M14 8l2.5 4" />
        </g>
      );
    // 跑步：跑动的人形
    case 'run':
      return (
        <g {...stroke}>
          <circle cx="14.5" cy="4.6" r="2.1" />
          <path d="M13.4 8.2 10 10.6l1.6 3.2-1.4 6.6M10 10.6 4.6 12M11.6 13.8l4.8 1.4 2.4 4.4" />
        </g>
      );
    // 力量训练：杠铃
    case 'gym':
      return (
        <g {...stroke}>
          <path d="M4 9v6M7 7.5v9M17 7.5v9M20 9v6M7 12h10" />
        </g>
      );
    case 'swim':
      return (
        <g {...stroke}>
          <circle cx="7" cy="7.6" r="2" />
          <path d="M3 16c2-1.6 3.4-1.6 5.4 0s3.4 1.6 5.4 0 3.4-1.6 5.4 0M4.6 12.4 11 10l3.4 2.2" />
        </g>
      );
    case 'walk':
      return (
        <g {...stroke}>
          <circle cx="13" cy="4.6" r="2" />
          <path d="M12.4 8 10 16l-2 5M12.4 8l2.6 3.6.4 9M10 16h5" />
        </g>
      );
    // 趋势箭头：三条都是同一个视觉重量，方向不同
    // ⚠️⚠️ 这两个的趋势箭头**原来在圆底里是偏的**（读者 2026-09-29：
    //    「周对比里面的 logo 不居中」），原因是字形本身不在 viewBox 正中：
    //      原 `up`：`M5 15.5 …V20` ⇒ 纵向占 8.5–20，中心 **14.25**（viewBox 中心是 12）
    //      ⇒ 整个箭头往下偏 2.25 个单位。18px 的字号下约 1.7px —— 小，但**看得出来**。
    //    ⚠️ 而 'trophy' / 'signal' 那些占 4–20（中心正好 12），所以只有这两个偏。
    //    ⇒ 整体上移 2.25：占 6.25–17.75，中心回到 12。
    case 'up':
      return <path d="M5 13.25 12 6.25l7 7M12 6.25V17.75" {...stroke} />;
    case 'down':
      return <path d="M5 10.75 12 17.75l7-7M12 17.75V6.25" {...stroke} />;
    case 'flat':
      return <path d="M4 12h16M16 8.5 19.5 12 16 15.5" {...stroke} />;
    case 'trophy':
      return (
        <g {...stroke}>
          <path d="M8 4h8v5a4 4 0 0 1-8 0z" />
          <path d="M8 5.5H5.5A2.5 2.5 0 0 0 8 10M16 5.5h2.5A2.5 2.5 0 0 1 16 10M11 13v3.5h2V13M8.5 20h7" />
        </g>
      );
    // 心电/信号：折线
    case 'signal':
      return <path d="M2 12h3.5l2-5 3 10 2.5-7 2 4H22" {...stroke} />;
    case 'watch':
      return (
        <g {...stroke}>
          <rect x="7" y="6.5" width="10" height="11" rx="3" />
          <path d="M9.5 6.5 10 2.5h4l.5 4M10 17.5l.5 4h3l.5-4" />
        </g>
      );
    case 'spark':
      return <path d="M12 2.5 13.9 9l6.6 2-6.6 2-1.9 6.5L10.1 13 3.5 11l6.6-2z" {...stroke} />;
    // 展开/收起。⚠️ 用 SVG 而不是 `▾` 字符 —— 那个字形取决于装的字体。
    case 'chev':
      return <path d="M6 9.5 12 15.5l6-6" {...stroke} />;
    /*
     * ⚠️⚠️ 关闭用**叉**，不是 `chev`。
     *
     * 2026-09-29 读者的原话：「那个正方形的关闭按钮画的有问题」。
     * 弹窗右上角原来画的是 `chev`（一个向下的宽浅 V），
     * 在 16px 上那两道细笔画糊成一个**圆角方块**的样子 ——
     * 而它本该是一个叉。
     *
     * ⚠️ 而且就算画清楚了，**向下的 V 也不是「关闭」**：
     *    V 的意思是「展开/收起」，读者会以为点它是折起这张卡。
     *    叉是唯一没有第二种读法的。
     */
    case 'x':
      // 两笔交叉，端点各缩进一点 —— 画满 4→20 的话，圆头端点会在
      // 四角戳出圆底的外轮廓。
      return <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" {...stroke} />;
    // ↗ —— 「这里可以点」。参考图（Depo Studio）里统一的交互符号。
    case 'arrow':
      return <path d="M7 17 17 7M9.5 7H17v7.5" {...stroke} />;
    default:
      return null;
  }
}

export function Icon({ name, className }: { name: Name; className?: string }) {
  return (
    <svg {...S} className={className} aria-hidden="true" focusable="false">
      <Body name={name} />
    </svg>
  );
}

/** 运动类型 → 图标。未知类型给一个中性的折线图标，不是空白。 */
export function typeIcon(type: string): Name {
  switch (type) {
    case 'BIKING': case 'BIKING_STATIONARY': return 'bike';
    case 'RUNNING': case 'RUNNING_TREADMILL': return 'run';
    case 'WALKING': case 'HIKING': return 'walk';
    case 'SWIMMING_POOL': case 'SWIMMING_OPEN_WATER': return 'swim';
    case 'STRENGTH_TRAINING': case 'ELLIPTICAL': case 'ROWING_MACHINE': return 'gym';
    case 'YOGA': case 'PILATES': case 'STRETCHING': return 'spark';
    default: return 'signal';
  }
}

export type IconName = Name;
