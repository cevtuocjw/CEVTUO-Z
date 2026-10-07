/**
 * ⚠️⚠️ **「这是不是小程序」—— 全站只用这一个判据。**
 *
 * 2026-10-07 一天里撞出**四个**平台差异，每一个都要判一次平台：
 *
 *   ① `fetch` **不存在**（只有 `wx.request`）⇒ 数据层整个静默失效；
 *   ② `background-image` **不渲染网络图片** ⇒ 壁纸和品牌动画全空
 *      （而带画框的图走 `<Image src>` 就正常 —— 同一屏里两类图的差别正是这条）；
 *   ③ `mix-blend-mode` **不生效** ⇒ 字标是纯白，浅底上白字压白底，看不见；
 *   ④ `containerRef.current` **不是 DOM 节点**（是 Taro 组件实例）
 *      ⇒ 命令式滚动（`el.scrollTop = …`）一步都跑不了，点导航跳不动。
 *
 * 四个的症状**全都是"看起来正常但东西不在"**，一句错都不报 ——
 * 所以判据必须只有一份，散着写就一定会漏掉某一处。
 *
 * ⚠️ 判据用 Taro 自己的 `getEnv()`，**不要**用 `typeof fetch` 那种间接特征：
 *    那是 `platform/data.ts` 为「选哪条请求路径」定的判据，是**另一件事**
 *    （哪天 H5 上也能 `wx.request` 了，两个判据会一起错）。
 */
import Taro from '@tarojs/taro';

let cached: boolean | null = null;

export function isMiniProgram(): boolean {
  if (cached !== null) return cached;
  try {
    cached = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  } catch {
    // ⚠️ 取不到就当 H5 —— 那边是主站，退化到它是"少一个特判"，退化到小程序是"整页没有图"。
    cached = false;
  }
  return cached;
}
