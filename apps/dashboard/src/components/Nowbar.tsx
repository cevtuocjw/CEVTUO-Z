import { Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';

import {
  assetUrl,
  fetchChealthIndex,
  fetchCoofIndex,
  fetchPaperrIndex,
  formatRuntime,
} from '../platform/data';
import { readPass } from '../platform/health-pass';
import { tv,useT } from '../platform/prefs';
import { Icon, typeIcon } from './ChealthIcons';

import './Nowbar.scss';

/**
 * 点底部条那个 **UO** 之后长出来的那一簇东西（读者 2026-10-07）。
 *
 * ── 版面 ────────────────────────────────────────────────────
 *   · 一行 = **左边胶囊 + 右边卡尺刻度**，两者在**同一个 flex 行**里
 *     ⇒ 对齐由结构保证，不靠测量。
 *   · 胶囊**占一半宽**（读者：「只能窄屏占据一半的宽度」）。
 *   · 视口**最多同时 6 行**，上下两条边**都会折叠**
 *     （读者：「上下都可以折叠」「一直只展示最多 6 个胶囊」）。
 *   · 拖动/滚动时，每一行按**离视口中心的距离**缩放+淡出 ——
 *     这就是「感觉是在波动的感觉」的来源（`--d`，见 `onScroll`）。
 *   · 设备状态（手机/手表/网络）**竖排贴在卡尺右边、靠下部**。
 *
 * ── 图标，不是文字 ──────────────────────────────────────────
 *   · 读 → `book` · 运动 → `typeIcon()`（和 CHEALTH 页同一份映射）
 *   · 电影 → **海报缩略图**（读者：「电影应该显示名字和时长以及海报是最好的」），
 *            没有海报才退回 `film` 图标。
 *
 * ⚠️ 它**不是弹窗**，也必须是 `.cnowbar` 的**兄弟** —— 那条有 `backdrop-filter`，
 *    会让它成为 fixed 后代的包含块（`CornerMenu` / `Cnowbar` 都栽过）。
 */

interface FeedItem {
  key: string;
  /** ISO 或日期串 */
  at: string;
  kind: 'move' | 'read' | 'movie' | 'sleep';
  title: string;
  sub: string;
  /** 运动类型（原始机器名）—— 只有 `move` 有。 */
  sport?: string;
  /** 海报相对路径 —— 只有 `movie` 有。 */
  poster?: string | null;
  /**
   * ⚠️⚠️ 这条的 `at` **只有日期，没有时刻**（`"2026-10-07"` 这种）。
   *
   * 实测 2026-10-07（COOF `watchedAt`）：它**一律**是日期形式。
   * 而 `new Date("2026-10-07")` = UTC 零点 = **东八区 08:00** ——
   * 于是卡尺上三部片子**全都印着 `08:00`**，读起来像"早上八点看了三部电影"。
   *
   * ⚠️ 那是一个**被算出来的假时间**：源数据里根本没有"几点"这个信息。
   *    ⇒ 这种条目卡尺上印**日期**（`10-07`），不印时刻。
   *      这个项目的规矩：**占位符必须长得像占位符**，不许拿一个看起来精确
   *      的数字去填一个其实不知道的量。
   */
  atDateOnly?: boolean;
  /**
   * 点这条泡泡去**哪个页面的详情**（读者 2026-10-07：「如果是 UO 的点击，
   * 直接落进 COOF 页面里面去并且打开那个电影的详情」）。
   *
   * ⚠️ 路径在**造这条 item 的时候**就拼好，不在渲染时拼 —— 渲染时拼的话
   *    每一帧都在做同一个字符串连接的判断，而且"哪一类去哪"会散在 JSX 里。
   */
  route?: string;
  /**
   * `at` 打平之后的**次级**排序键 —— 现在只有 COOF 用得上。
   *
   * ⚠️⚠️ 存在的理由：`watchedAt` **只有日期**（实测全是 `"2026-09-26"`），
   *    同一天看的几部片子 `Date.parse` 出来**完全相等** ⇒ `sort` 保持数组原序，
   *    而那个原序是 `recent` 的序（**最新在前**）⇒ 结果**整个是反的**。
   *    Notion 的登记号越大越新，升序排正好把最后看的放最后。
   *
   *    ⚠️ 这就是「退化的数据骗过排序」：一堆相等的键看上去"排过了"，其实等于没排。
   */
  order?: number;
}

/**
 * 窗口：**一周**（读者 2026-10-07：「把 UO 功能补充到一个星期」）。
 *
 * ⚠️ 原来是 24 小时。一个 24 小时的窗口有个静默的毛病：读者上一个小时没动，
 *    那一列就只剩睡眠和电影 —— 看起来像"别的都没了"，其实是**窗口太窄**。
 * ⚠️ 用**当次打开的时刻**算，不是模块加载时算一次。
 */
const WINDOW_MS = 7 * 24 * 3600 * 1000;

/** ⚠️ 视口里**最多同时看到几行**（读者定的数）。CSS 里的舞台高度按它算。 */
const VISIBLE_ROWS = 6;

/** ⚠️ 只列**确定知道**的；**没映射到的一律原样显示机器名**（项目规矩：不要猜）。 */
const MOVE_LABEL: Record<string, string> = {
  /*
   * ⚠️⚠️ **必须是 getter，不能是普通属性值。**
   *
   * 这个对象是**模块级常量** ⇒ 在 import 时求值一次 ⇒ 写成普通属性的话
   * `tv()` 会被**冻在导入时的语言**（这个坑在这个项目里栽过：主页四块面板的
   * `lede`、`WEEKDAYS` / `FILTERS` / `PAPERR_NAV` / `PANELS`）。
   * 页面后来切语言**它一个字都不会变**，而且看起来只是"没翻干净"。
   *
   * ⇒ `get` 让它在**每次取值**时重新问一遍当前语言。消费方（`MOVE_LABEL[k]`）
   *    一个字都不用改。
   */
  get BIKING() { return tv("骑行", "Cycling"); },
  get RUNNING() { return tv("跑步", "Running"); },
  get WALKING() { return tv("走路", "Walking"); },
  get HIKING() { return tv("徒步", "Hiking"); },
  get SWIMMING() { return tv("游泳", "Swimming"); },
  get STRENGTH_TRAINING() { return tv("力量训练", "Strength"); },
  get OTHER_WORKOUT() { return tv("其他运动", "Other"); },
};

/** 卡尺上的读数：只要 `HH:MM` —— 它是一把 24 小时的尺，不是日历。 */
function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 跨天时在刻度上打一个 `M-D` 的记号 —— 只在换日那一行出现。 */
function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 只用来兜底「网络」那一格：没有手机上报时才读本机。 */
function localNet(): string | null {
  try {
    const nav = navigator as unknown as {
      onLine?: boolean;
      connection?: { effectiveType?: string };
    };
    if (nav.onLine === false) return tv("离线", "Offline");
    return nav.connection?.effectiveType ?? tv("在线", "Online");
  } catch {
    return null;
  }
}

export function Nowbar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phone, setPhone] = useState<{
    batteryPct?: number;
    charging?: boolean;
    net?: string;
    watchBatteryPct?: number;
    watchCharging?: boolean;
    at?: string;
  } | null>(null);
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const stageRef = useRef<HTMLElement | null>(null);
  /**
   * ⚠️ 上次**成功取到**数据的时刻 —— 打开时用它判断"值不值得再取一次"。
   * ⚠️⚠️ **只在 `setFeed` 之后才允许写它。** 写早了的后果见下面那段长注释。
   */
  const loadedAt = useRef(0);
  /** ⚠️ 手上到底有没有内容 —— 判断"能不能跳过重取"的是**它**，不是时间。 */
  const hasData = useRef(false);
  /** ⚠️ 已经有一次在飞了就别叠 —— 不然打开时会重复取两份。 */
  const inflight = useRef(false);
  /**
   * ⚠️⚠️ **只有真卸载才置 false —— 依赖变化（`open` 翻转）不许杀在飞的那次。**
   *
   * 这个 ref 就是那个线上 bug 的修复点，见下面 `useEffect` 里的说明。
   */
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  /** ⚠️ `Escape` 关闭 —— 自绘之后得自己挂；只在打开时挂，关掉就摘。 */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    /*
     * ⚠️⚠️ **不在 `open` 时才去取 —— 那几百毫秒正好是读者盯着屏幕等的那一下。**
     *
     * 读者 2026-10-07：「UO 这里点击之后出来的时间有点慢」。
     * 真因不是动画：这个面板要**先取两份数据**才画得出内容 ——
     *   · `fetchChealthIndex` —— 一次网络 + 一次**纯 JS 的 AES-GCM 解密**
     *     （站点常常跑在 http 上，`crypto.subtle` 是 undefined，只能用 @noble 逐块算）
     *   · `fetchPaperrIndex` —— 再一次网络
     * 两样都发生在点击**之后**，所以慢的每一毫秒都算在"点了没反应"上。
     *
     * ⇒ 改成**挂载就预热**（组件一直挂着，所以这一跑就是"页面打开时"），
     *   点开时数据已经在手里；打开时再跑一次只是为了拿最新的。
     *   ⚠️ 重跑**不清空** `feed` —— 清空会把预热白费掉，面板又会闪一下骨架。
     */
    /*
     * ⚠️⚠️ **打开时不要重新取数据 —— 那会让内容"晚一步出现"。**
     *
     * 实测（线上，每 70ms 采 `.nowb__line` 的 opacity，已经把错峰封顶到 88ms 之后）：
     *     前 700ms 末行一直是 0.00，**770ms 起才 0.40 → 0.87 → 910ms 到 1.00**。
     *
     * 88ms 的错峰解释不了 770ms。真因是：`open` 在依赖里 ⇒ 一打开就重取一次
     * （chealth + paperr，实测 600ms 上下）⇒ `setFeed` 换了个**新数组** ⇒
     * React 把那些行**重新挂载** ⇒ 它们的入场过渡从那一刻**从头再跑一遍**。
     * ⇒ 读者看到的是"点开之后先空一下、再长出来"。
     *
     * ⚠️ 而这个重取**本来就没有必要**：挂载时的预热已经把数据取回来了
     *    （实测 178ms 就在手里）。打开时刷新只值 2 分钟以内 ——
     *    超过这个间隔才值得再取一次，否则就是拿"晚一步"换"新一点"。
     */
    /*
     * ⚠️⚠️⚠️ **"在飞的那次预热被打开动作杀掉，而守卫又不肯重取" —— 线上 bug（2026-10-07）。**
     *
     * 读者原话：
     *   「在主页直接点击 UO 非常快速就可以看到内容，但是如果在其他页面例如点击进入
     *     CHEALTH 等页面，打开 UO 就一直在读取中完全加载不出来内容，返回主页也是的」。
     *
     * 旧代码的两处错：
     *   ① `loadedAt.current = openedAt` 写在**开始取**的时候 ——
     *      于是"取过"和"取到了"变成同一件事，取失败/被丢掉也算数；
     *   ② cleanup 无条件 `alive = false`，而依赖里就有 `open` ⇒
     *      **一打开就杀死挂载时那次的 `setFeed`**（`if (!alive) return`）。
     * 两者相乘：挂载预热被打断 ⇒ 没内容；打开时守卫看到"120 秒内取过" ⇒
     * **return，不再取** ⇒ **永远"读取中"**。
     *
     * 主页为什么好的：它挂载早，你点的时候预热早就在手里了。
     * CHEALTH 慢（纯 JS 解 AES-GCM），一点就正好撞在在飞的那次上。
     * 「返回主页也是的」—— Taro 把上一页留在 DOM 里，回去的是**同一个坏实例**。
     *
     * ⇒ 契约改成三条：
     *   · 跳不跳过，看的是**手上有没有内容**（`hasData`），不是时间；
     *   · `loadedAt` **只在 `setFeed` 之后**才写；
     *   · **依赖变化不许杀在飞的那次**（`aliveRef` 只在卸载时翻），
     *     再加 `inflight` 去重，免得改完之后变成取两遍。
     */
    const openedAt = Date.now();
    if (open && hasData.current && openedAt - loadedAt.current < 120_000) return undefined;
    if (inflight.current) return undefined;
    inflight.current = true;

    void (async () => {
      const items: FeedItem[] = [];
      const miss: string[] = [];
      const since = openedAt - WINDOW_MS;
      const inWindow = (iso: string | null | undefined) => {
        if (!iso) return false;
        const t = Date.parse(iso);
        return Number.isFinite(t) && t >= since;
      };

      try {
        const idx = await fetchChealthIndex(readPass());
        if (!aliveRef.current) return;
        setPhone(idx.deviceStatus ?? null);
        for (const s of idx.sessions ?? []) {
          if (!inWindow(s.start)) continue;
          const bits: string[] = [tv(`${Math.round(s.minutes)} 分钟`, `${Math.round(s.minutes)} min`)];
          if (typeof s.activeCalories === 'number') bits.push(tv(`${Math.round(s.activeCalories)} 千卡`, `${Math.round(s.activeCalories)} kcal`));
          if (typeof s.distanceM === 'number' && s.distanceM > 0) {
            bits.push(tv(`${(s.distanceM / 1000).toFixed(2)} 公里`, `${(s.distanceM / 1000).toFixed(2)} km`));
          }
          if (typeof s.hrAvg === 'number') bits.push(tv(`均心率 ${Math.round(s.hrAvg)}`, `avg HR ${Math.round(s.hrAvg)}`));
          items.push({
            key: 'move-' + s.start,
            at: s.start,
            kind: 'move',
            // ⚠️⚠️ **带上这一场的 `start`**（读者 2026-10-07：「如果是运动例如骑行，
            //    点击胶囊之后没有直接跳转到这次的没有把这运动的弹窗打开，
            //    只是到了 CHEALTH 页面」）。
            //    ⇒ CHEALTH 读 `?session=` 并直接把那一场的弹窗打开
            //      （见 `pages/chealth` 的 `sessionKeyFromRoute`）。
            //  ⚠️ `start` 是 ISO（带 `+08:00`），**必须 encodeURIComponent** ——
            //     `+` 在查询串里会被解成空格，解出来的时刻就错了，而"时刻错了"
            //     的表现是**静默地打不开**（找不到那一场）。
            route: `/pages/chealth/index?session=${encodeURIComponent(s.start)}`,
            title: MOVE_LABEL[s.type] ?? s.type,
            sub: bits.join(' · '),
            sport: s.type,
          });
        }

        /*
         * ── 睡眠段也进这条流（读者 2026-10-07：「把睡眠的时间段也要加进去」）──
         *
         * ⚠️ 加的是**段**（`sleepStart → sleepEnd`），不是"一个钟点"：睡觉本来就是
         *    一段区间，把 23:55 单独印在尺上会读成"那时候醒了一下"。
         *    ⇒ 尺上给**起点**，副标题写 `X 小时 · 到 HH:MM`（终点）。
         *
         * ⚠️ 时长**必须过 24 小时这道闸**：实测 `2026-09-07` 的 `sleepSeconds`
         *    是 657000（182.5 小时），而它自己的起止时间只有 1 小时 ——
         *    那是设备侧重叠重复计入的坏值。拿不到可信时长就**只显示区间**，
         *    绝不印一个 182.5 h 出来。
         */
        for (const d of idx.days ?? []) {
          const start = d.sleepStart;
          const end = d.sleepEnd;
          if (!start || !end || !inWindow(start)) continue;
          const secs = d.sleepSeconds;
          const ok = typeof secs === 'number' && secs > 0 && secs <= 24 * 3600;
          items.push({
            key: 'sleep-' + start,
            at: start,
            kind: 'sleep',
            route: '/pages/chealth/index',
            title: tv("睡眠", "sleep"),
            sub: [ok ? tv(`${(secs / 3600).toFixed(1)} 小时`, `${(secs / 3600).toFixed(1)} h`) : null, tv(`到 ${clockOf(end)}`, `to ${clockOf(end)}`)]
              .filter(Boolean)
              .join(' · '),
          });
        }
      } catch {
        miss.push(tv("健康数据（没解开或还没同步）", "health data (locked or not synced yet)"));
      }

      try {
        const idx = await fetchPaperrIndex();
        if (!aliveRef.current) return;
        for (const b of idx.books ?? []) {
          if (!inWindow(b.lastOpen)) continue;
          items.push({
            key: 'read-' + b.id,
            at: b.lastOpen,
            kind: 'read',
            route: '/pages/paperr/index',
            title: `《${b.title}》`,
            // ⚠️ **不再显示「进度 X%」**（读者 2026-10-07：「笔记和电影就不要过程了」）。
            //    进度是"读到一半"这个**中间状态**；这条时间线回答的是
            //    「什么时候动过它」，不是「动了多少」——而那个数在 CAPPERR 页上有。
            sub: '',
          });
        }
      } catch {
        miss.push(tv("阅读数据", "reading data"));
      }

      try {
        const idx = await fetchCoofIndex('COOF2026');
        if (!aliveRef.current) return;
        for (const m of idx.recent ?? []) {
          // ⚠️ 先取到局部再判 —— `watchedAt` 是 `string | null`，
          //    直接 `inWindow(m.watchedAt)` 不会收窄，下面赋值就报错。
          const at = m.watchedAt;
          if (!at || !inWindow(at)) continue;
          const bits: string[] = [];
          // ⚠️ `formatRuntime` 对"没时长"返回的是 **`null`**，不是空串 ——
          //    直接 push 进 `string[]` 会被类型挡下来（挡得对：那一格会印出 "null"）。
          const rt = formatRuntime(m.runtimeMin ?? null);
          if (rt) bits.push(rt);
          if (m.year) bits.push(String(m.year));
          items.push({
            key: 'movie-' + m.id,
            at,
            kind: 'movie',
            // ⚠️ COOF 的 `watchedAt` 是**只有日期**的字符串 —— 见 `atDateOnly` 那段。
            atDateOnly: /^\d{4}-\d{2}-\d{2}$/.test(at),
            // ⚠️ 带 `?movie=<id>` —— COOF 页读它并直接打开这部片子的详情
            //    （见 `pages/coof` 的 `movieIdFromRoute`）。
            route: `/pages/coof/index?movie=${encodeURIComponent(m.id)}`,
            title: m.title,
            sub: bits.join(' · ') || tv("看过", "watched"),
            poster: m.poster ?? null,
            // ⚠️ 次级排序键 —— 同一天看的几部靠它分出先后（见 `FeedItem.order`）。
            //    ⚠️ 源类型是 `number | null`（Notion 那个字段可能空着），
            //    而 `FeedItem.order` 是 `number | undefined` —— 不收敛的话
            //    `tsc` 报 TS2322，而构建**是**跑 tsc 的。
            order: m.order ?? undefined,
          });
        }
      } catch {
        miss.push(tv("观影", "film log"));
      }

      if (!aliveRef.current) return;
      /*
       * ⚠️ **正序**：最旧的在上，**最新的在最下边**（离底部条最近）。
       *
       * ⚠️⚠️ **同一天的要按 `order` 再排一次**（读者 2026-10-07：
       *    「今天的不是按照我的观影顺序排列的，应该最晚看的（最后添加的是最晚看的）
       *      在下边，这个顺序现在的是反的」）。
       *
       *    真因：COOF 的 `watchedAt` 是**只有日期**的 ⇒ 同一天看的几部
       *    `Date.parse` 出来**完全相等**，`sort` 于是保持数组原序 ——
       *    而那个原序是 `recent` 的序（**最新在前**）⇒ 结果是**反的**。
       *    `order` 是 Notion 里的登记序号，越大越新 ⇒ 升序排正好把最新的放最后。
       *
       *    ⚠️ 这正是「退化的数据骗过排序」：一部一部的电影时间戳全都一样，
       *       看上去"排过了"，其实等于没排。
       */
      items.sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.order ?? 0) - (b.order ?? 0),
      );
      setFeed(items);
      setMissing(miss);
      // ⚠️ 这两行必须在 `setFeed` **之后** —— 它们记的是"手上真有内容了"。
      hasData.current = true;
      loadedAt.current = openedAt;
    })()
      /*
       * ⚠️⚠️ **`inflight` 必须在 `finally` 里落，不能在成功分支里落。**
       *
       * 它只要有一次没走到，就永远是 `true` ⇒ 以后每次打开都是 `return undefined`
       * ⇒ **又是"永远读取中"**，只是换了个位置复发 —— 和旧 bug 同一个形状。
       */
      .catch(() => {
        /* 不该发生；真发生了也不能把 `inflight` 锁死 */
      })
      .finally(() => {
        inflight.current = false;
      });

    /*
     * ⚠️⚠️ **这里故意什么都不返回 —— 没有 cleanup。**
     *
     * 卸载由上面那个空依赖的 effect 负责（`aliveRef`）。这个 effect 依赖 `open`，
     * 而"打开"不应该是"放弃上一次加载"的意思。
     */
  }, [open]);

  /**
   * ⚠️ 舞台的滚动 → 每一行的 `--d`（离视口中心的归一化距离）。
   *
   * 这就是「波动」：离中心越远，缩得越小、越淡。上下两条边因此自然**折起来**，
   * 而拖动时整列像一条波。**每一行的读数（卡尺）也跟着一起折** ——
   * 它们在同一行里，天然同步。
   *
   * ⚠️ 用 `requestAnimationFrame` 合帧：`scroll` 每次触发都写十几个元素的样式，
   *    不合并会在低端机上把滚动拖成幻灯片。
   */
  useEffect(() => {
    if (!open) return undefined;
    const stage = stageRef.current;
    if (!stage) return undefined;

    // ⚠️ 默认**从"现在"开始**（读者：「默认从现在开始」）——
    //    最新的那条在最下边，所以一打开就贴底。
    const jumpToNow = () => {
      stage.scrollTop = stage.scrollHeight;
    };
    const raf = requestAnimationFrame(() => {
      jumpToNow();
      paint();
    });

    let queued = false;
    function paint() {
      queued = false;
      const s = stageRef.current;
      if (!s) return;
      const box = s.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      const half = box.height / 2 || 1;
      for (const el of s.querySelectorAll<HTMLElement>('.nowb__line')) {
        const r = el.getBoundingClientRect();
        const d = Math.min(1, Math.abs(r.top + r.height / 2 - mid) / half);
        el.style.setProperty('--d', d.toFixed(3));
      }
    }
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(paint);
    }

    stage.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      stage.removeEventListener('scroll', onScroll);
    };
  }, [open, feed]);

  const T = useT();
  const net = phone?.net ?? localNet();
  const netIsWifi = !!net && /wifi|wi-?fi|无线/i.test(net);
  const rows = feed?.length ?? 0;

  return (
    <>
    {/*
      ⚠️⚠️ **压暗的底，必须放在 `.nowb` 外面**（读者 2026-10-07：右下角打架、
      「整个都会不太清晰」）。

      ⚠️ 为什么不能塞进 `.nowb`：`.nowb` 在宽屏上是 `transform: translateX(-50%)`
         —— 而**带 transform 的元素会成为 `position: fixed` 后代的包含块**，
         它里面那个 `inset: 0` 的底就只会盖住面板本身，盖不到整屏。
         （同一个形状：`.cnowbar` 的 `backdrop-filter`、`CornerMenu` 的 portal，
           这个项目已经栽过三次。）

      ⚠️ `pointer-events: none`：这一层是**为了看清**，不是为了挡住 ——
         底部条要照常能点，页面也照常能滚。读者要的是"清晰"，不是"模态"。
    */}
    <View className="nowb__scrim" data-open={open ? 'true' : 'false'} aria-hidden="true" />
    <View
      className="nowb"
      data-open={open ? 'true' : 'false'}
      aria-hidden={open ? undefined : 'true'}
      style={{ '--nowb-n': String(Math.max(rows, 1)), '--nowb-rows': String(VISIBLE_ROWS) } as never}
    >
      {/*
        ⚠️ 舞台**自己滚**（`overflow-y: auto`），不是整个面板滚 ——
           因为「最多同时 6 行」要求视口高度是固定的，而上下折叠正是
           视口边界裁出来的效果。
      */}
      <View className="nowb__stage" ref={stageRef as never}>
        {feed == null ? (
          <View className="nowb__line" style={{ '--i': 0 } as never}>
            <View className="nowb__bub nowb__bub--note">
              <Text className="nowb__empty">{T('读取中…', 'Loading…')}</Text>
            </View>
            <Ruler at="" day="" newest={false} micro={false} />
          </View>
        ) : rows === 0 ? (
          <View className="nowb__line" style={{ '--i': 0 } as never}>
            <View className="nowb__bub nowb__bub--note">
              <Text className="nowb__empty">{T('最近一周还没有记录', 'Nothing in the past week')}</Text>
            </View>
            <Ruler at="" day="" newest={false} micro={false} />
          </View>
        ) : (
          feed.map((f, i) => (
            <View className="nowb__line" key={f.key} style={{ '--i': i } as never}>
              <View
                className="nowb__bub nowb__bub--feed"
                role="button"
                aria-label={tv(`打开 ${f.title}`, `Open ${f.title}`)}
                onClick={() => {
                  if (!f.route) return;
                  // ⚠️ 先收面板再跳 —— 不收的话返回时它还是敞着的，
                  //    而读者刚"从它里面点进了一个详情"，回来看到它还在会以为没跳成功。
                  onClose();
                  // ⚠️ `navigateTo`（**压栈**），不是 `redirectTo` ——
                  //    读者要的正是「点返回回到 cnowbar 这里」（他选的就是这个）。
                  Taro.navigateTo({ url: f.route });
                }}
              >
                {/*
                  ⚠️ 电影优先用**海报**（读者：「电影应该显示名字和时长以及海报是最好的」）；
                      没有海报才退回胶片图标 —— 绝不为了"好看"画一个占位图。
                */}
                {f.kind === 'movie' && f.poster ? (
                  <Image className="nowb__thumb" src={assetUrl(f.poster)} mode="aspectFill" />
                ) : (
                  <View className={`nowb__ico nowb__ico--${f.kind}`}>
                    {f.kind === 'move' ? (
                      <Icon name={typeIcon(f.sport ?? '')} />
                    ) : f.kind === 'movie' ? (
                      <Icon name="film" />
                    ) : f.kind === 'sleep' ? (
                      <Icon name="moon" />
                    ) : (
                      <Icon name="book" />
                    )}
                  </View>
                )}
                <View className="nowb__body">
                  <Text className="nowb__title">{f.title}</Text>
                  {/* ⚠️ 空副标题**不渲染**，不是渲染一个空 Text ——
                      后者会占掉一整行高度，把标题顶偏（书那条现在就只有书名）。 */}
                  {f.sub ? <Text className="nowb__sub">{f.sub}</Text> : null}
                </View>
              </View>
              <Ruler
                // ⚠️ 只有日期的条目印**日期**（`10-07`），不印那个算出来的 `08:00` ——
                //    见 `FeedItem.atDateOnly` 那段。
                at={f.atDateOnly ? dayOf(f.at) : clockOf(f.at)}
                // ⚠️ 只在**换日那一行**打日历记号，不然每行都挂个日期，尺就读不出来了。
                //    ⚠️ 日期已经印在 `at` 位上的条目**不再重复**一次。
                day={
                  f.atDateOnly
                    ? ''
                    : i === 0 || dayOf(f.at) !== dayOf(feed[i - 1]!.at)
                      ? dayOf(f.at)
                      : ''
                }
                newest={i === feed.length - 1}
                micro={i > 0}
              />
            </View>
          ))
        )}
      </View>

      {/*
        设备状态：**竖排**，贴在卡尺右边、**靠下部**（读者原话）。
        ⚠️ 绝对定位在面板右下角，不参与上面那条滚动 —— 它是"现在"，不是历史。
      */}
      <View className="nowb__side">
        <View className="nowb__stat">
          {/* ⚠️ 用的是**手机**字形（折叠屏），不是电池 —— 见 `ChealthIcons` 里那段。
              充电时换成闪电，电量数字照留（充电中也要知道充到多少了）。 */}
          <Icon name={phone?.charging ? 'bolt' : 'phone'} className="nowb__ico" />
          <Text className="nowb__v">{phone?.batteryPct == null ? '—' : `${phone.batteryPct}%`}</Text>
        </View>
        {/*
          ⚠️⚠️ **手表那一格已删**（读者 2026-10-07：「把手表这一个删去，
              不要在 UO 里面显示」）。

          它一直只显示 `—`，因为**这块表的电量从技术上就读不到**：真机上把每条路
          都走完了 —— 三星健康 SDK 的 `Device` 没有 battery 字段（`javap` 读过 aar）、
          Android 公开 API 没有、GATT `0x180F` 被拒（status=147）、隐藏 API
          `BluetoothDevice.getBatteryLevel()` 恒返回 -1、隐藏广播 90 秒一次没来。
          详见 `cevtuo-health` 的 `WatchBattery.kt` 和清单里那段注释。

          ⇒ 一格**永远填不上的读数**比没有这一格更糟：读者会读成"表没电了"
            或者"我的表是不是没连上"，而真相是"这个数据源不存在"。
        */}
        <View className="nowb__stat">
          <Icon name={netIsWifi ? 'wifi' : 'signal'} className="nowb__ico" />
          <Text className="nowb__v">{netIsWifi ? 'WiFi' : (net ?? '—')}</Text>
        </View>
      </View>

      {missing.length > 0 && open && (
        <View className="nowb__note">
          {T('没接上的：', 'Not connected: ')}
          {missing.join('；')}
        </View>
      )}
    </View>
    </>
  );
}

/**
 * 时间卡尺的一格 —— 和它那一行的胶囊**在同一个 flex 行里**，对齐不需要测量。
 *
 * 质感走**奢侈表的分钟轨**：细竖轨 + 刻点 + 刻线 + 微刻度，读数用等宽数字。
 * ⚠️ 不是 Rolex（没有金、没有齿圈、没有皇冠），也不是航海风（没有罗盘、没有圆盘），
 *    只有「细、准、安静」。
 */
function Ruler({
  at,
  day,
  newest,
  micro,
}: {
  at: string;
  day: string;
  newest: boolean;
  micro: boolean;
}) {
  return (
    <View className="nowb__ruler" data-new={newest ? 'true' : 'false'} aria-hidden="true">
      {/* ⚠️ 微刻度：**它们的疏密才是"尺"的质感**。没有它们就只剩一排孤零零的点。 */}
      {micro && (
        <>
          <View className="nowb__micro" style={{ top: '14%' }} />
          <View className="nowb__micro" style={{ top: '38%' }} />
          <View className="nowb__micro nowb__micro--mid" style={{ top: '62%' }} />
          <View className="nowb__micro" style={{ top: '86%' }} />
        </>
      )}
      <View className="nowb__rail" />
      <View className="nowb__needle" />
      <View className="nowb__line-mark" />
      {at ? (
        <View className="nowb__read">
          {day ? <Text className="nowb__day">{day}</Text> : null}
          <Text className="nowb__clock">{at}</Text>
        </View>
      ) : null}
    </View>
  );
}
