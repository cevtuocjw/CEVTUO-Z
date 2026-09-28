/**
 * CHEALTH 的口令从哪儿来 —— **唯一一份实现**。
 *
 * ⚠️ 为什么要把这段从 `pages/chealth/index.tsx` 里搬出来。
 *
 * 主页索引卡现在也要显示 CHEALTH 的实时数字（最新一天的步数和睡眠），
 * 而它和 CHEALTH 页**必须读同一个键**。各写一份的结果是：在 CHEALTH 页
 * 输入过口令之后，主页那两格仍然是「—」，而且**没有任何报错** ——
 * 看起来像「主页还没接」，实际是两份实现读了两个键。
 *
 * 这个项目已经因为「同一件事两处实现」吃过亏：CAPPERR 的字数统计有两个数
 * （127 对 109），两边都不报错，是读者发现的。
 */

export const PASS_KEY = 'cevtuo.chealth.pass';

/**
 * 顺序有讲究。
 *
 * ⚠️ `location.hash` 在前：`#/pages/chealth/index?k=...` 里的片段
 *    **浏览器根本不会发给服务器**（请求发出去之前就被剥掉了），所以一个收藏
 *    链接可以直接用，而密钥不会进任何日志。之后才是 localStorage，
 *    这样一台设备只需要输一次，而不是每次访问都输。
 *
 * ⚠️「没有口令」是**正常状态**，不是错误。页面渲染一个输入框，密封文件保持
 *    密封 —— 而不是在这里抛异常。所以两个分支都返回 `''`，由调用方决定
 *    怎么表达「还没解锁」。
 */
export function readPass(): string {
  try {
    const m = /[?&]k=([^&]+)/.exec(window.location.hash);
    if (m?.[1]) {
      const v = decodeURIComponent(m[1]);
      window.localStorage.setItem(PASS_KEY, v);
      return v;
    }
    return window.localStorage.getItem(PASS_KEY) ?? '';
  } catch {
    // ⚠️ 小程序构建里没有 `window`。那边口令只能靠输入框 ——
    //    但也不能在「准备说这件事」的路上先抛异常。
    return '';
  }
}

/**
 * 记住口令。
 *
 * ⚠️⚠️ **只在确认它能解开索引之后才调用。**
 *
 * 记住一个错的口令比不记住更糟：下次打开页面，它不会提示「口令不对」，
 * 而是直接渲染成一个**没有数据的 CHEALTH 页** —— 看起来像管道断了，
 * 实际只是存了一串没用的字符。读者会去查手机、查服务器，不会想到
 * 问题在自己这台设备的 localStorage 里。
 *
 * ⇒ 所以调用点在页面里，而且是 `await fetchChealthIndex(v)` 成功之后。
 *    这个文件只管存取，不管判断。
 */
export function savePass(v: string): void {
  try {
    window.localStorage.setItem(PASS_KEY, v);
  } catch {
    // ⚠️ 隐私模式下 localStorage 会抛。这一轮口令照样能用（在内存里），
    //    只是不会被记住 —— 不该因此让整个页面失败。
  }
}
