import { useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { PANEL_INDEX } from '../../platform/panels';
import { PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
import { CnsrStrips } from '../../components/CnsrStrips';
// ⚠️ The CAPPERR block on this page draws two real charts. These two imports
// were MISSING when that block was written — the page threw
// `ReferenceError: CompositionDonut is not defined` the moment the fetch
// resolved, so the whole brand panel rendered blank and the reader reported
// "主页上的 capperr 这里记得有一些图表展示" twice.
//
// ⚠️ `tsc -b` did NOT catch it — the build succeeded. Nothing in this repo
// type-checks the H5 app as part of `build:h5`. scripts/verify-back.mjs and
// verify-paperr-ui.mjs now assert on console errors instead.
import { MonthCalendar, WeekdayBars } from '../../components/PaperrCharts';
import {
  assetUrl,
  fetchChealthIndex,
  fetchCoofIndex,
  fetchPaperrIndex,
  fetchPaperrHeartbeat,
  fetchSyncMeta,
  formatDayMonth,
  formatReadingTime,
  formatUpdatedAt,
  type ChealthIndex,
  type CoofTitle,
  type PaperrHeartbeat,
  type PaperrIndex,
  type SyncMeta,
} from '../../platform/data';
// ⚠️ 和 CHEALTH 页读**同一个键**。见 platform/health-pass.ts 的注释：
//    各写一份 ⇒ 在 CHEALTH 页输过口令之后，主页仍然显示「—」且不报错。
import { readPass } from '../../platform/health-pass';

import '../../styles/demo.scss';
import './index.scss';

/**
 * Home — the index of the four brands.
 *
 * ⚠️ One panel per brand, each filling the viewport. This replaced a grid of
 * four small cards. The cards were the wrong unit: at four-up on the cover
 * screen each had ~150px of width, which is not enough to show a number and its
 * label without shrinking the type below the size the design depends on. A
 * panel per capability gives each one the full screen and makes the page a
 * sequence you move through rather than a dashboard you squint at.
 *
 * ⚠️ The numbers below are still placeholders. COOF is the only brand with a
 * real pipeline; the other three have no data source yet, and the counts here
 * are the same invented ones this page has always shown. They are visibly
 * labelled as such on COOF (which opens) and are inert elsewhere.
 */

interface BrandPanel {
  key: string;
  /** Panel title, set vertically in the margin. Short — it must not wrap. */
  title: string;
  lede: string;
  stats: { value: string; label: string; note?: string }[];
  /** Route to open on tap, or null while the brand is still a shell. */
  route: string | null;
}

const PANELS: BrandPanel[] = [
  {
    key: 'coof',
    title: 'COOF',
    lede: "CEVTUO's 观影记录",
    // ⚠️ Placeholders replaced at render time by the live counts (see `stats`).
    stats: [
      { value: '—', label: '个年历', note: '2020–2026' },
      { value: '—', label: '条记录', note: '全部年历' },
    ],
    route: '/pages/coof/index',
  },
  {
    key: 'cnsr',
    title: 'CNSR',
    // ⚠️ Says what it IS, including the part that is unflattering. These four
    // sources are read a few days deep, not archived in full — calling it
    // "最近的笔记" without the caveat would promise a completeness the page
    // does not have, and the page itself says so one tap away.
    // ⚠️ The wording is the user's, verbatim, including "不完整同步" — the
    // caveat is the point, not padding. And "some of them" replaces "滚动快照",
    // which described the mechanism rather than what the reader gets.
    // ⚠️ `\n` with `white-space: pre-line` on `.section__lede` — the trailing
    // aside goes on its own line. A second element would have been the other
    // way, but `lede` is typed as a string and widening it for one page's
    // wording is the tail wagging the dog.
    lede: "CEVTUO's 最近笔记，摘取最近 5 天次内的不完整同步\n· SOME OF THEM",
    // ⚠️ Deliberately no stats. The invented "1,024 总条目 / 180 字摘要" pair
    // that stood here was never a measurement, and on a panel whose real
    // content is a live feed the numbers were the least informative thing on
    // it. The four strips below say more than two counters did.
    stats: [],
    route: '/pages/cnsr/index',
  },
  {
    key: 'paperr',
    title: 'CAPPERR',
    // ⚠️ NOT "与划线". This promised highlights for months and nothing ever
    // displayed them — `highlights` and `notes` are in the payload and the
    // schema, and the page reads neither. The data agrees: across 37 books the
    // counts are 0 and 0, because KOReader keeps highlights in a separate
    // database and the statistics `book` table's counter is not populated here.
    // A lede is a promise about what is behind the door; this one described a
    // room that does not exist.
    // ⚠️ 2026-09-28 读者改的文案。原文是「Kindle 阅读 · 今天、本周、本月的节奏，
    //    从设备同步」—— 用了具体型号名，而这条链路早就不只 Kindle 了
    //    （KOReader 跑在什么设备上都一样），所以改成按角色称呼。
    //     ⚠️ 读者原话里写的是 `deivce`，是 `device` 的笔误，按正确拼写收的。
    lede: "CEVTUO's e-reader device 阅读记录",
    // ⚠️ Placeholders. Replaced at render time by the live counts, like COOF's.
    stats: [
      { value: '—', label: '累计阅读', note: '' },
      { value: '—', label: '读完', note: '' },
    ],
    route: '/pages/paperr/index',
  },
  {
    key: 'chealth',
    title: 'CHEALTH',
    lede: '健康数据。步数、心率与睡眠，不进入公开仓库，走鉴权接口。',
    // ⚠️ 这两格是**没解锁时**的样子；解锁后会被下面的渲染处换成实时数字。
    //
    // ⚠️ 它们原来是写死的 "8,412" 和 "7h12" —— 编造的数字，而且和同屏那些
    //    真数字格式完全一样。读者扫一眼索引看到六个数，其中两个是编的，
    //    而页面上没有任何东西说明是哪两个。
    //    ⚠️ 卡片上那个「尚未接入」不足以抵消它：那是一个控件上的小标签，
    //    而 8,412 是正文字号。**长得像数据的占位符比一个横杠更糟。**
    //
    // ⚠️⚠️ 2026-09-28 才真的接上。原来这里是 `route: null` —— 门一直存在
    //    （`#/pages/chealth/index` 能开，`verify-https-live.mjs` 一直在驱动它），
    //    只是索引页没接线，于是显示「尚未接入」、点了弹 toast。
    //    **一扇能开的门被标成不存在，是索引页最不该犯的错。**
    stats: [
      { value: '—', label: '步数', note: '未解锁' },
      { value: '—', label: '睡眠', note: '未解锁' },
    ],
    route: '/pages/chealth/index',
  },
];

/**
 * Which panel to open on, from `?panel=N`.
 *
 * ⚠️ Clamped, not trusted. The parameter arrives from a URL that anyone can
 * type, and an out-of-range value would scroll the index past its last panel
 * into blank space with no way back but a reload.
 */
function initialPanelFromRoute(): number {
  try {
    const raw = Taro.getCurrentInstance()?.router?.params?.panel;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export default function Home() {
  // ⚠️ Only COOF has a pipeline, so only COOF gets a preview strip. The strip is
  // decoration and must never be load-blocking: a failure here leaves the panel
  // exactly as it was before, rather than showing an error on an index page
  // whose job is to offer four doors.
  // ⚠️ Fetched here rather than on the CAPPERR page only, because this panel
  // now SHOWS charts instead of a placeholder pair of numbers. An index page
  // that says "36h · 本月" about a brand whose page says 15.7h is a page lying
  // quietly — the two read the same payload now.
  const [paperr, setPaperr] = useState<PaperrIndex | null>(null);
  // ⚠️ Read once, at mount. The route does not change while this page is open,
  // and re-reading it on every render would fight the reader's own scrolling.
  const [initialPanel] = useState(initialPanelFromRoute);
  const [recent, setRecent] = useState<CoofTitle[]>([]);
  const [totals, setTotals] = useState<{ years: number; items: number } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [syncMeta, setSyncMeta] = useState<SyncMeta | null>(null);
  const [heartbeat, setHeartbeat] = useState<PaperrHeartbeat | null>(null);
  // ⚠️ CHEALTH 的索引是**加密的**，所以这里必须先有口令才谈得上数据。
  //    没有口令不是错误 —— 那是「这台设备还没解锁过」，见渲染处。
  const [chealth, setChealth] = useState<ChealthIndex | null>(null);
  useEffect(() => {
    let alive = true;
    fetchCoofIndex('COOF2026')
      .then((idx) => {
        if (!alive) return;
        setRecent(idx.recent.filter((t) => t.poster).slice(0, 10));
        setTotals({
          years: idx.collections.length,
          // ⚠️ The count of the WHOLE archive, not this calendar's — summed
          // from the per-collection counts the index already carries, so no
          // extra request and no chance of disagreeing with the COOF page.
          items: idx.collections.reduce((n, c) => n + c.count, 0),
        });
      })
      .catch(() => {});
    fetchPaperrIndex()
      .then((d) => alive && setPaperr(d))
      .catch(() => {});
    // ⚠️ Fire-and-forget: the heartbeat is diagnostics, and a page that waits
    // on it — or breaks without it — is worse than one that shows nothing.
    fetchPaperrHeartbeat().then((h) => {
      if (alive) setHeartbeat(h);
    });

    // ⚠️ 口令从 platform/health-pass.ts 读 —— 和 CHEALTH 页**同一个键**。
    //    各写一份的结果是：在 CHEALTH 页输过口令之后，主页这两格仍然是「—」，
    //    而且没有任何报错。看起来像「主页还没接」，其实是读错了键。
    const pass = readPass();
    if (pass) {
      fetchChealthIndex(pass)
        .then((d) => alive && setChealth(d))
        // ⚠️ 口令错、或从来没解锁过，都会落到这里。索引页的职责是**提供四扇门**，
        //    不是报告管道故障 —— 失败就保持占位符，和另外三个品牌一致。
        //    ⚠️ 而 CHEALTH 页那边**不能**这样：那里「口令错」和「没有数据」
        //    必须分得开，否则读者会以为管道坏了，而不是自己打错了。
        .catch(() => {});
    }

    fetchSyncMeta()
      .then((m) => {
        if (alive) setSyncMeta(m);
        return m;
      })
      .then((m) => alive && setUpdatedAt(formatUpdatedAt(m.generatedAt)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * This week and this month, for the CAPPERR panel.
   *
   * ⚠️ NOT the all-time totals. "15.7h 累计阅读" is a number that only ever goes
   * up — on an index page whose job is to say what is behind each door, it says
   * nothing about whether the door is currently in use. The reader asked for
   * the current window in both the numbers AND the chart below them.
   *
   * ⚠️ Anchored on the last day in the DATA, not on today: the export is the
   * device's, and a Kindle that has not synced for a week would otherwise show
   * an empty week and look broken.
   */
  const paperrWindow = useMemo(() => {
    const days = paperr?.daily ?? [];
    if (!days.length) return null;
    const anchors = days[days.length - 1]!.d;
    const [y, m, d] = anchors.split('-').map(Number) as [number, number, number];
    const shift = (key: string, n: number) => {
      const [ky, km, kd] = key.split('-').map(Number) as [number, number, number];
      const t = new Date(Date.UTC(ky, km - 1, kd) + n * 86_400_000);
      const p2 = (x: number) => String(x).padStart(2, '0');
      return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
    };
    const ws = shift(anchors, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
    const mk = anchors.slice(0, 7);

    const sum = (from: string, to: string) =>
      days.filter((x) => x.d >= from && x.d <= to).reduce((n, x) => n + x.s, 0);

    return {
      weekSeconds: sum(ws, shift(ws, 6)),
      monthSeconds: sum(`${mk}-01`, `${mk}-31`),
      weekBars: ['一', '二', '三', '四', '五', '六', '日'].map((label, i) => {
        const key = shift(ws, i);
        return { key, label, value: sum(key, key) };
      }),
      calPeak: Math.max(1, ...days.filter((x) => x.d.startsWith(mk)).map((x) => x.s)),
      latest: anchors,
    };
  }, [paperr]);

  /**
   * Two times, and the difference between them is the point.
   *
   * ⚠️ `lastPushAt` is when the Kindle last reached the server — which is what
   * "is it still syncing" means. `lastChangeAt` only moves when the reader
   * actually reads something, so on a quiet week it sits still for days while
   * the sync is perfectly alive. Showing only the second one is what made a
   * working sync look broken.
   */
  const paperrSync = useMemo(() => {
    const push = formatUpdatedAt(heartbeat?.lastPushAt);
    const change = formatUpdatedAt(heartbeat?.lastChangeAt);
    if (!push && !change) return null;
    return [push ? `设备同步 ${push}` : null, change ? `数据更新 ${change}` : null]
      .filter(Boolean)
      .join(' · ');
  }, [heartbeat]);

  /**
   * CHEALTH 那两格：**数据里最后一天**的步数和睡眠。
   *
   * ⚠️ 锚在数据自己的最后一天，不是浏览器的今天 —— 和上面 CAPPERR 同一个理由。
   *    手机一天没推，按「今天」算就会得到一格空白，而那看起来像「坏了」，
   *    实际只是「今天那次同步还没到」。
   *
   * ⚠️⚠️ 所以标签写「步数 / 睡眠」，**不写「今日 / 昨夜」**。
   *    数据落后三天时「今日步数」就是在撒谎 —— 而且撒得和真数字一模一样，
   *    这正是本文件 COOF 那段注释在骂的事。日期放进 note，让读者自己判断新旧，
   *    而不是由页面替他假设一个。
   */
  const chealthDay = useMemo(() => {
    const days = chealth?.days ?? [];
    return days.length ? days[days.length - 1]! : null;
  }, [chealth]);

  /** ⚠️ 有实时数字却**没有时间戳**的面板，和一个同步已经死了一周的面板长得一模一样。 */
  const chealthLine = useMemo(() => {
    if (!chealth) return null;
    const t = formatUpdatedAt(chealth.updatedAt);
    return t ? `更新于 ${t}` : null;
  }, [chealth]);

  const open = (route: string | null, title: string) => {
    // ⚠️ 2026-09-28 起四个品牌**都有** route 了，正常情况走不到这个分支。
    //    留着它是因为 `route` 的类型仍然是 `string | null`，而「未接线」必须
    //    表现为一句说明 —— 跳进一个空白路由看起来就是崩溃。
    if (!route) {
      Taro.showToast({ title: `${title} 尚未接入`, icon: 'none' });
      return;
    }
    Taro.navigateTo({ url: route });
  };

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CEVTUO-Z" root />

      <PageStack count={PANELS.length} initialIndex={initialPanel}>
        {PANELS.map((p, i) => (
          <Section
            key={p.key}
            index={i}
            title={p.title}
            lede={p.lede}
            // ⚠️ Live numbers for COOF, the still-invented placeholders for the
            // three brands with no pipeline. Showing a hardcoded "1209" beside a
            // live one is how a page starts lying after the next sync.
            stats={
              p.key === 'coof' && totals
                ? [
                    { value: `${totals.years}`, label: '个年历', note: '2020–2026' },
                    { value: `${totals.items}`, label: '条记录', note: '全部年历' },
                  ]
                : p.key === 'paperr' && paperrWindow
                  ? [
                      {
                        value: formatReadingTime(paperrWindow.weekSeconds),
                        label: '本周',
                        note: '周一到今天',
                      },
                      {
                        value: formatReadingTime(paperrWindow.monthSeconds),
                        label: '本月',
                        note: `数据到 ${formatDayMonth(paperrWindow.latest)}`,
                      },
                    ]
                  : p.key === 'chealth' && chealthDay
                    ? [
                        {
                          value: chealthDay.steps !== undefined ? `${chealthDay.steps}` : '—',
                          label: '步数',
                          note: formatDayMonth(chealthDay.date),
                        },
                        {
                          // ⚠️ 复用「阅读时长」那个格式化器 —— 它本质就是「秒 → 小时」，
                          //    名字里有 reading 而已。再写一个「秒 → 睡眠时长」就会有两份
                          //    实现，而这两份迟早会不一致（CAPPERR 的字数统计就是 127 对 109）。
                          value:
                            chealthDay.sleepSeconds !== undefined
                              ? formatReadingTime(chealthDay.sleepSeconds)
                              : '—',
                          label: '睡眠',
                          note: formatDayMonth(chealthDay.date),
                        },
                      ]
                    : p.stats
            }
            // ⚠️ Both brands carry a freshness line now. A panel with live
            // numbers and no timestamp cannot be told from one whose sync died
            // a week ago.
            footnote={
              p.key === 'coof' && updatedAt
                ? `更新于 ${updatedAt}`
                : p.key === 'paperr' && paperrSync
                  ? paperrSync
                  : p.key === 'chealth' && chealthLine
                    ? chealthLine
                    : null
            }
            // The last panel gets no chevron: there is nothing below it, and a
            // cue there promises content that does not exist.
            showCue={i < PANELS.length - 1}
            // ⚠️ The handler belongs HERE, on the whole panel body — not on the
            // `card` below. Tapping the numbers, their labels, or the empty space
            // beside them all mean "open this brand" to the person doing it, and
            // a 10px label with a hairline rule is a target you have to aim at.
            // The card stays as the visible affordance; it no longer owns the tap.
            onPress={() => open(p.route, p.title)}
          >
            {/* The live feed for CNSR: four glass strips, one per source,
                cycling through that source's note lines. */}
            {p.key === 'cnsr' ? <CnsrStrips onOpen={() => open(p.route, p.title)} /> : null}

            {/* The CAPPERR panel shows real charts, not a pair of numbers. The
                whole point of the index page is to say what is behind each door
                — and for this brand the answer is a shape, not a figure. */}
            {p.key === 'paperr' && paperrWindow ? (
              <View className="home-paperr">
                {/* ⚠️ This week's seven days and this month's calendar — both
                    current windows. These were a donut and a 30-day curve,
                    both of which are all-time shapes: correct, and useless for
                    telling whether the door is currently in use. */}
                <WeekdayBars bars={paperrWindow.weekBars} unit="本周" />
                <View className="pc-gap" />
                <MonthCalendar days={paperr?.daily ?? []} peak={paperrWindow.calPeak} />
              </View>
            ) : null}

            {p.key === 'coof' && recent.length ? (
              <ScrollView className="recent__scroll" scrollX showScrollbar={false}>
                <View className="recent__row">
                  {recent.map((t) => (
                    <View
                      key={t.id}
                      className="recent__item"
                      onClick={() => open(p.route, p.title)}
                    >
                      <Image
                        className="recent__img"
                        src={assetUrl(t.poster as string)}
                        mode="aspectFill"
                        lazyLoad
                      />
                      <Text className="recent__title">{t.title}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}

            <View className="card">
              <Text className="card__label">{p.route ? '打开' : '尚未接入'}</Text>
              <Text className="card__label">{p.route ? '→' : '—'}</Text>
            </View>
          </Section>
        ))}
      </PageStack>
    </View>
  );
}
