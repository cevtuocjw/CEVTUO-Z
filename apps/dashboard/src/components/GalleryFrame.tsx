/**
 * 画框 —— 每一页**一张**照片，装在画框里。
 *
 * ⚠️ 读者 2026-09-29：「把这些做成画框……分散到网站上，每个页面最多 1 张图，
 *    但是也必须有一张图，但是每张图都有一个画框。主页上的要排在右边，
 *    如果在页面里面的都排在左边」「当不论鼠标点击还是触摸的时候，
 *    这些画框要有一些动画反馈，要那种高级感的动画，而不是很假的动画」。
 *
 * ── 为什么是「真画框」而不是「加了个 border 的图」 ──────────────
 *
 *    画框由**三层**叠出来，缺一层就不像框：
 *      ① 外框（moulding）—— 一圈有厚度的深色边
 *      ② 卡纸（mat）—— 框里那圈米白色的纸，照片压在它上面
 *      ③ 照片自己 —— 比卡纸小一圈，所以卡纸才看得见
 *    ⚠️ 少了卡纸那层，它就只是一张「描了边的图片」，而描边在深色壁纸上
 *      和阴影糊在一起，读不出「这是挂在墙上的东西」。
 *
 * ── 动画：为什么不是 `:active { transform: scale(0.96) }` ────────
 *
 *    ⚠️ 「假的动画」的特征是**瞬时**和**均匀**：按下立刻缩、松开立刻回，
 *      全程没有方向感。真人按下一张挂在墙上的画框时：
 *        · 画框会**朝手指那一点轻微倾倒**（哪边按得重，哪边陷下去）
 *        · 边框的**反光**会跟着动（玻璃面的高光随视角移动）
 *        · 松手时**回弹**一下，不是匀速回到原位
 *      ⇒ 所以这里用指针位置驱动 `--tx/--ty`（倾斜）、`--mx/--my`（高光位置），
 *        过渡曲线是 `cubic-bezier(0.34, 1.56, 0.5, 1)`（回弹）。
 *
 *    ⚠️ 触摸和鼠标**走同一条路径**（pointer 事件），不写两套 ——
 *      两套的结果是手机上有效果、桌面上没有（或者反过来）。
 */
import { useEffect, useRef } from 'react';
import { View } from '@tarojs/components';

import { assetUrl, currentPage } from '../platform/background';
import { galleryAnchor, galleryFile, gallerySide } from '../platform/gallery';
import './GalleryFrame.scss';

export function GalleryFrame() {
  const ref = useRef<HTMLElement | null>(null);

  const page = currentPage();
  const src = assetUrl(galleryFile(page));
  const side = gallerySide(page);
  // ⚠️ 竖直位置**按页给**（读者：「位置太固定」）。值都落在这一侧的中段。
  const anchor = galleryAnchor(page);

  /**
   * ⚠️⚠️ 事件**不走 JSX 的 `onPointerDown`**，走原生的 `addEventListener`。
   *    两个原因，第二个才是主要的：
   *
   *      ① Taro 的 `ViewProps` 里**没有** pointer 事件（类型就报错）。
   *      ② 更要紧的是**性能**：`pointermove` 一秒能来 100+ 次，
   *         走 React 就是 100 次重渲染 —— 而渲染和浏览器的合成抢时间，
   *         结果就是掉帧。**掉帧正是「廉价动画」的来源**，比动画本身写得好不好
   *         影响还大。
   *    ⇒ 监听器直接写 CSS 变量、直接切 class，一次渲染都不触发。
   *
   *    ⚠️ 鼠标和触摸**走同一条路**（都是 pointer 事件）——
   *      分两套写的结果是手机上有效果、桌面上没有（或者反过来）。
   */
  useEffect(() => {
    const el = ref.current;
    // ⚠️ 小程序端 ref 不是 DOM 节点（没有 addEventListener），直接跳过 ——
    //    和 `applyBackground` 同一条约定：拿不到 DOM 就什么都不做，不抛。
    if (!el || typeof el.addEventListener !== 'function') return undefined;

    const track = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // -0.5 … 0.5，相对画框中心
      const dx = (e.clientX - r.left) / r.width - 0.5;
      const dy = (e.clientY - r.top) / r.height - 0.5;
      // ⚠️ 倾角**刻意很小**（±3.5°）。转到 10° 以上就变成「卡片翻面」，
      //    那是玩具感；真东西的形变是**几乎看不出来、但感觉得到**。
      el.style.setProperty('--tx', `${(dy * -7).toFixed(2)}deg`);
      el.style.setProperty('--ty', `${(dx * 7).toFixed(2)}deg`);
      el.style.setProperty('--mx', `${((dx + 0.5) * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${((dy + 0.5) * 100).toFixed(1)}%`);
    };

    const reset = () => {
      el.classList.remove('gal--press');
      el.style.setProperty('--tx', '0deg');
      el.style.setProperty('--ty', '0deg');
      el.style.setProperty('--mx', '50%');
      el.style.setProperty('--my', '50%');
    };

    const down = (e: PointerEvent) => {
      el.classList.add('gal--press');
      track(e);
    };

    el.addEventListener('pointerdown', down);
    // ⚠️ 悬停就跟随（不必按着）—— 鼠标用户先看到「它能动」，才想点。
    el.addEventListener('pointermove', track);
    el.addEventListener('pointerup', reset);
    el.addEventListener('pointerleave', reset);
    el.addEventListener('pointercancel', reset);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', track);
      el.removeEventListener('pointerup', reset);
      el.removeEventListener('pointerleave', reset);
      el.removeEventListener('pointercancel', reset);
    };
  }, []);

  return (
    // ⚠️ `top` 走**行内样式**（按页不同），不是 CSS —— `.gal` 里那个 `top: 50%`
    //    只是没拿到页名时的兜底。
    <View className={`gal gal--${side}`} style={{ top: `${anchor}%` }} ref={ref as never}>
      {/* ① 外框 + ② 卡纸 + ③ 照片 —— 三层，见文件抬头 */}
      <View className="gal__frame">
        <View className="gal__mat">
          {/* ⚠️ 原生 `<img>`，不是 Taro 的 `<Image>` —— 这里要的是
              `object-fit: cover` 的精确控制和 `draggable={false}`，
              而 Taro 的 Image 在 H5 上会包一层自己的容器。 */}
          <img className="gal__photo" src={src} alt="" draggable={false} />
          {/* 玻璃面的高光：跟着指针走的一道斜光 */}
          <View className="gal__sheen" />
        </View>
      </View>
    </View>
  );
}
