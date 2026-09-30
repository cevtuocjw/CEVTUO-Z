/**
 * 画框 —— 挂在墙上那些照片。
 *
 * ⚠️ 读者 2026-09-29：「把这些做成画框……分散到网站上……主页上的要排在右边，
 *    如果在页面里面的都排在左边」「当不论鼠标点击还是触摸的时候，
 *    这些画框要有一些动画反馈，要那种高级感的动画，而不是很假的动画」。
 *
 * ⚠️⚠️ 读者 2026-09-30 之后，规矩变了两条：
 *
 *    ① **COOF 那页不放画框**，主页放**三枚**（见 `platform/gallery.ts` 的表）。
 *    ② **画框永远在内容之下**（「现在的画框在内容上面，要在内容文字的下面才可以，
 *       以及在边栏这些组件的下面」）—— 靠 `.gal` 的 `z-index: -1`，
 *       见 `GalleryFrame.scss`。**不怕内容压住它。**
 *
 * ── ⚠️⚠️ 而 ② 会**静默地**杀掉动画，这是本轮唯一一个差点溜过去的回归 ──
 *
 *    画框降到 `z-index: -1` 之后，`.section` / `.stack` 这些**铺满视口的容器**
 *    就画在它上面了。指针事件只发给**最上面那个**元素 ⇒ 画框**一个事件都收不到**。
 *
 *    ⚠️ 而它的症状是**零**：画框照样出现在正确的位置、颜色尺寸都对、
 *      截图上看不出任何异常 —— 只是**不会动了**。
 *      而「会不会动」正是这一整件事（「要那种高级感的动画」）的目的。
 *      实测证据（`/tmp/tilt.mjs`）：把鼠标移到画框正中心，`--tx` **一次都没被写过**，
 *      `gal--press` 从来没挂上过，主页和内页一样。
 *
 *    ⇒ 修法不是把 z-index 调回去（那会退回「压住正文」），而是
 *      **把「谁画在上面」和「谁收到事件」解耦**：
 *      监听器挂在 **window** 上，用**几何**判断指针在不在某一枚画框里。
 *      画框是装饰，本来就不该靠 DOM 命中来交互。
 *      ⚠️ 代价是 `.gal` 要 `pointer-events: none`（见 SCSS）——
 *        不然它会在空白处抢走本该给内容的点击。
 *
 * ── 为什么是「真画框」而不是「加了个 border 的图」 ──────────────
 *
 *    画框由**三层**叠出来，缺一层就不像框：外框 / 卡纸 / 照片。
 *    ⚠️ 五种做法（有截面的实框 / 细金线 / 无框画布 / 双层卡纸 / 金属倒角）
 *      **共用这一套 DOM**，差别全在 SCSS 里。
 */
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { View } from '@tarojs/components';

import { assetUrl, currentPage } from '../platform/background';
import { frames, galleryFile, gutterFor, photoFile, type FrameSpec } from '../platform/gallery';
import './GalleryFrame.scss';

/**
 * 把一枚画框推回「没人碰它」的样子。
 * ⚠️ 提取成函数是因为**有三个地方**要复位（松手 / 指针离开 / 窗口失焦），
 *    三处各写一遍的结果是漏掉一处，而漏掉的那次**看起来只是「有点卡住」**。
 */
function rest(el: HTMLElement) {
  el.classList.remove('gal--press');
  el.style.setProperty('--tx', '0deg');
  el.style.setProperty('--ty', '0deg');
  el.style.setProperty('--mx', '50%');
  el.style.setProperty('--my', '50%');
}

export function GalleryFrame() {
  const page = currentPage();
  // ⚠️ `frames()` 每次调用都返回新数组，直接当依赖会让 effect 每渲染都重挂。
  const list = useMemo(() => frames(page), [page]);
  const gutter = gutterFor(page);

  /** ⚠️ 拿不到 DOM 的端（小程序）会是 `null`，下面处处判空。 */
  const refs = useRef<(HTMLElement | null)[]>([]);

  /**
   * ⚠️⚠️ 让位量写在 **`.page` 上**，不能写在 `.gal` 上 ——
   *    自定义属性只往下继承，而 `.page` 是 `.gal` 的**祖先**，
   *    祖先读不到后代身上的变量。
   *    ⇒ 从同一份 spec（`gutterFor`）算出来，一次 `setProperty`，
   *      **只有一个地方有数字**。
   *    ⚠️ 卸载时要摘掉 —— 否则从内页切回主页，主页会莫名其妙左边空掉一条。
   */
  useEffect(() => {
    const p = document.querySelector('.page');
    if (!p || !(p instanceof HTMLElement)) return undefined;
    p.style.setProperty('--gal-gutter-wide', `${gutter}px`);
    // ⚠️ 必须写成块体：`removeProperty` 返回 `string`，
    //    表达式体的箭头函数会把它当成清理函数的返回值 ⇒ 类型错误。
    return () => {
      p.style.removeProperty('--gal-gutter-wide');
    };
  }, [gutter]);

  /**
   * ⚠️⚠️ 指针跟随 —— **挂在 `window` 上，按几何命中**，不挂在画框自己身上。
   *    为什么必须这样，见文件抬头那段（z-index 为负之后事件全被内容吃掉）。
   *
   * ⚠️ 每帧**先读完全部矩形，再写全部样式** —— 读写交替（读一个写一个）
   *    会让浏览器每帧强制同步重排，那正是「掉帧」的来源，
   *    而**掉帧比动画写得好不好影响还大**（掉帧就是廉价感的来源）。
   *
   * ⚠️ 鼠标和触摸**走同一条路**（都是 pointer 事件）——
   *    分两套写的结果是手机上有效果、桌面上没有（或者反过来）。
   */
  useEffect(() => {
    if (!list.length) return undefined;
    const live = () => refs.current.filter((el): el is HTMLElement => !!el);
    if (typeof window === 'undefined') return undefined;

    /** 只读：把每枚的矩形和「命不命中」算出来，不改任何样式。 */
    const probe = (x: number, y: number) =>
      live().map((el) => {
        const r = el.getBoundingClientRect();
        return {
          el,
          r,
          hit: r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
        };
      });

    const track = (e: PointerEvent) => {
      for (const { el, r, hit } of probe(e.clientX, e.clientY)) {
        if (!hit) {
          rest(el);
          continue;
        }
        // -0.5 … 0.5，相对画框中心
        const dx = (e.clientX - r.left) / r.width - 0.5;
        const dy = (e.clientY - r.top) / r.height - 0.5;
        // ⚠️ 倾角**刻意很小**（±3.5°）。转到 10° 以上就变成「卡片翻面」，
        //    那是玩具感；真东西的形变是**几乎看不出来、但感觉得到**。
        el.style.setProperty('--tx', `${(dy * -7).toFixed(2)}deg`);
        el.style.setProperty('--ty', `${(dx * 7).toFixed(2)}deg`);
        el.style.setProperty('--mx', `${((dx + 0.5) * 100).toFixed(1)}%`);
        el.style.setProperty('--my', `${((dy + 0.5) * 100).toFixed(1)}%`);
      }
    };

    const down = (e: PointerEvent) => {
      for (const { el, hit } of probe(e.clientX, e.clientY)) {
        el.classList.toggle('gal--press', hit);
      }
    };

    // ⚠️ 松手 / 取消 / 窗口失焦都要复位 —— 少一个，画框就会**卡在倾斜状态**，
    //    而那个看着像「动画坏了」，其实是「少摘了一个状态」。
    const release = () => live().forEach(rest);

    // ⚠️ `passive: true` —— 这些监听器**不阻止滚动**，声明出来浏览器才敢
    //    不等回调返回就滚动，手机上滚起来才跟手。
    window.addEventListener('pointermove', track, { passive: true });
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [list]);

  // ⚠️ COOF 那页返回空数组 ⇒ 一枚都不渲染（读者 2026-09-30）。
  if (!list.length) return null;

  return (
    <>
      {list.map((spec: FrameSpec, i: number) => (
        <View
          key={spec.key}
          className={`gal gal--${spec.side} gal--frame-${spec.style}`}
          /**
           * ⚠️ 尺寸**走行内样式**，因为它是**按枚**给的（主页三枚各不相同）。
           *    宽屏和窄屏两组都给出去，**由 CSS 里的媒体查询挑** ——
           *    断点属于样式表，不该在 JS 里再写一遍 `innerWidth < 700`。
           */
          style={
            {
              '--gal-w': `${spec.w}px`,
              '--gal-h': `${spec.h}px`,
              '--gal-inset': `${spec.inset}px`,
              '--gal-w-n': `${spec.narrow.w}px`,
              '--gal-h-n': `${spec.narrow.h}px`,
              '--gal-inset-n': `${spec.narrow.inset}px`,
              top: `${spec.anchor}%`,
            } as CSSProperties
          }
          // ⚠️ 用块体：表达式体会把赋值结果当返回值，React 19 会当成
          //    「清理函数」而报错。
          ref={(el) => {
            refs.current[i] = el as unknown as HTMLElement | null;
          }}
        >
          {/* ① 外框 + ② 卡纸 + ③ 照片 —— 三层，见文件抬头 */}
          <View className="gal__frame">
            <View className="gal__mat">
              {/* ⚠️ 原生 `<img>`，不是 Taro 的 `<Image>` —— 这里要的是
                  `object-fit: cover` 的精确控制和 `draggable={false}`，
                  而 Taro 的 Image 在 H5 上会包一层自己的容器。 */}
              <img
                className="gal__photo"
                // ⚠️ 每枚**各自取图** —— 默认是这一页背景那一张，但主页那三枚
                //    各给了一张不同的（见 `FrameSpec.photo`）：
                //    三枚都放背景那张时，无框画布那枚和壁纸糊成一整块。
                src={assetUrl(spec.photo ? photoFile(spec.photo) : galleryFile(page))}
                alt=""
                draggable={false}
              />
              {/* 玻璃面的高光：跟着指针走的一道斜光 */}
              <View className="gal__sheen" />
            </View>
          </View>
        </View>
      ))}
    </>
  );
}
