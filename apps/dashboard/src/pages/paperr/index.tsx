import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';

import {
  CompositionDonut,
  HourGrid,
  MonthBars,
  MonthCalendar,
  PeriodStats,
  ProgressBands,
  ReadingCurve,
  Records,
  WeekdayBars,
  type PeriodRow,
} from '../../components/PaperrCharts';
import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { homePanelUrl } from '../../platform/panels';
import { Wallpaper } from '../../components/Wallpaper';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  fetchPaperrIndex,
  formatAgo,
  formatDayMonth,
  formatReadingTime,
  type PaperrBook,
  type PaperrIndex,
} from '../../platform/data';

// ⚠️ `demo.scss` is imported by every page. A page that forgets it silently
// loses the whole design system — this exact omission once shipped COOF with no
// styles at all, and the build succeeded anyway.
import '../../styles/demo.scss';
import './index.scss';

/**
 * CAPPERR — Kindle reading statistics.
 *
 * ⚠️ The top bar says CAPPERR, not CE-CAPPERR. Every other brand here is COOF,
 * CNSR, Chealth — a lone `CE-` prefix on one of four is not a style, it is a
 * typo that survived because nobody compared them side by side.
 *
 * ⚠️ The internal key, the route and `data/paperr/` all stay `paperr`. Renaming
 * a route means every shared URL breaks, and the data path is pinned by
 * `packages/schema/src/paths.ts` behind a drift guard — a rename that reaches
 * that far is a migration, not a relabel.
 *
 * ── Where the numbers come from ────────────────────────────────
 * KOReader's own `statistics.sqlite3`, read in-process by the plugin
 * (`koreader-plugin/cevtuo-capperr.koplugin/`) and POSTed when the device joins
 * WiFi. The pipeline converts the export — see `pipeline/src/sources/paperr/`.
 *
 * ⚠️ The aggregation happens ON THE DEVICE, in SQL. A heavy reader's
 * `page_stat_data` runs to hundreds of thousands of rows, and building that in
 * Lua is how a plugin gets a Kindle killed for OOM.
 *
 * ⚠️ Everything here is public. The dashboard was briefly split so that "which
 * book is open right now" stayed behind a password; the reader decided the whole
 * thing is fine to publish, so there is no gate and no private fetch.
 *
 * ── Two panels, on every screen size ───────────────────────────
 * ⚠️ It was five. Five full-height panels is four swipes between "what am I
 * reading" and "what have I read", and a chart nobody scrolls to is a chart
 * nobody sees. The overview scrolls WITHIN its panel instead — one swipe, then
 * scroll, which is the gesture people already have.
 */

/** A book counts as read at 70% — the reader's rule, not KOReader's 99%. */
const DONE_PCT = 70;
/** Below this it was opened and put down: 待看, not 在读. */
const TODO_PCT = 10;

type Bucket = 'reading' | 'done' | 'todo';

function bucketOf(b: PaperrBook): Bucket {
  const p = b.progressPct;
  if (p != null && p >= DONE_PCT) return 'done';
  if (p != null && p < TODO_PCT) return 'todo';
  // No page count means KOReader never learned how long the book is; any
  // reading at all is all we can go on.
  return b.totalReadPages > 0 ? 'reading' : 'todo';
}

type Filter = 'all' | Bucket | 'books';

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'done', label: '读完' },
  { key: 'todo', label: '待看' },
  // ⚠️ "只看书" was the old label and it was wrong: with almost every row
  // relabelled, this filter does not show "books", it shows the rows that were
  // NOT machine-generated. `Books` matches what the donut calls them.
  { key: 'books', label: 'Books' },
];

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A generated label rather than a name. */
const isRelabelled = (b: PaperrBook): boolean => b.originalTitle != null;

/** The three buckets the donut and the filter both use. */
function categoryOf(b: PaperrBook): string {
  if (!b.originalTitle) return 'Books';
  return b.title.startsWith('news') ? 'News' : 'Unnamed';
}

/**
 * One chart cell in the overview grid.
 *
 * ⚠️ Module level, not defined inside the render. A component declared in the
 * render body is a NEW type on every pass, so React unmounts and remounts the
 * whole subtree — which throws away the `picked` state of every chart the moment
 * anything else on the page re-renders.
 */
function Cell({
  title,
  sub,
  half,
  children,
}: {
  title: string;
  sub?: string;
  /** Narrow enough to share a row even on a phone. */
  half?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View className={`pc-reveal ${half ? 'pr-grid__cell pr-grid__cell--half' : 'pr-grid__cell'}`}>
      <Text className="pr-h">{title}</Text>
      {sub && <Text className="pr-sub">{sub}</Text>}
      {children}
    </View>
  );
}

/** Longest run of consecutive days with any reading. */
function bestStreak(days: { d: string; s: number }[]): number {
  const read = days.filter((x) => x.s > 0).map((x) => x.d).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of read) {
    if (prev) {
      const gap = (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86_400_000;
      run = gap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export default function Paperr() {
  const bp = useBreakpoint();
  const [index, setIndex] = useState<PaperrIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let alive = true;
    fetchPaperrIndex()
      .then((d) => {
        if (alive) {
          setIndex(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Start each chart's entrance when it scrolls into view.
   *
   * ⚠️ Driven from the DOM, with the observers registered AFTER the data
   * arrives. Every element this targets only exists once the fetch resolves, so
   * an effect keyed on mount would query an empty document and nothing would
   * ever animate — the page would look identical to one with no animation at
   * all, which is the failure mode this whole block is easiest to have.
   *
   * ⚠️ `root: null` (the viewport) is correct even though the scroller is an
   * inner element: intersection accounts for clipping by ancestors, so a cell
   * below the fold of its ScrollView is correctly reported as not intersecting.
   */
  useEffect(() => {
    if (!index || typeof document === 'undefined') return undefined;

    const targets = Array.from(document.querySelectorAll('.pc-reveal'));
    if (!targets.length) return undefined;

    // Older targets or the mini program: show everything rather than nothing.
    // A missing animation is a disappointment; a permanently invisible chart
    // is a bug.
    if (typeof IntersectionObserver === 'undefined') {
      for (const el of targets) el.classList.add('pc-reveal--in');
      return undefined;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          // ⚠️ Stagger only within a batch that arrives together. A fixed
          // per-element delay would make the sixth chart wait 400ms after the
          // reader reached it.
          const batch = targets.filter((t) => !t.classList.contains('pc-reveal--in'));
          el.style.animationDelay = `${Math.min(batch.indexOf(el), 4) * 70}ms`;
          el.classList.add('pc-reveal--in');
          io.unobserve(el);
        }
      },
      { threshold: 0.12 },
    );
    for (const el of targets) io.observe(el);
    return () => io.disconnect();
  }, [index]);

  const books = index?.books ?? [];

  const counts = useMemo(() => {
    const c = { reading: 0, done: 0, todo: 0 } as Record<Bucket, number>;
    for (const b of books) c[bucketOf(b)] += 1;
    return c;
  }, [books]);

  /**
   * ⚠️ 待看 sorts LAST, always. The shelf's job is to show what is being read;
   * a book that was opened once and abandoned is the least interesting thing on
   * it, and putting it wherever its date lands buries the ones that matter.
   */
  const shown = useMemo(() => {
    const filtered = (() => {
      if (filter === 'all') return books;
      if (filter === 'books') return books.filter((b) => !isRelabelled(b));
      return books.filter((b) => bucketOf(b) === filter);
    })();
    return [...filtered].sort((a, b) => {
      const at = bucketOf(a) === 'todo' ? 1 : 0;
      const bt = bucketOf(b) === 'todo' ? 1 : 0;
      if (at !== bt) return at - bt;
      return b.lastOpen.localeCompare(a.lastOpen);
    });
  }, [books, filter]);

  /** Composition, by reading TIME — counting rows would let 28 short digests
   *  outweigh the handful of things actually read at length. */
  const slices = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const b of books) {
      const k = categoryOf(b);
      byCat.set(k, (byCat.get(k) ?? 0) + b.totalReadTime);
    }
    return [...byCat.entries()]
      .filter(([, v]) => v > 0)
      // Fixed order, so the donut's colours do not shuffle between renders.
      .sort((a, b) => ['Books', 'News', 'Unnamed'].indexOf(a[0]) - ['Books', 'News', 'Unnamed'].indexOf(b[0]))
      .map(([label, value]) => ({ key: label, label, value }));
  }, [books]);

  const allDays = index?.daily ?? [];
  const daily = useMemo(() => allDays.slice(-30), [allDays]);

  /**
   * The day every window is measured from.
   *
   * ⚠️ The LAST DAY IN THE DATA, not `new Date()`. The export is the device's
   * and the device may not have synced for days. Anchoring on today would make
   * "今天" zero, "本周" mostly empty and the calendar blank — a page that looks
   * broken when the only thing wrong is that nobody has opened the Kindle.
   */
  const anchor = allDays.length ? allDays[allDays.length - 1]!.d : null;

  const daySum = useCallback(
    (from: string, to: string) => {
      let s = 0;
      let pg = 0;
      for (const d of allDays) {
        if (d.d >= from && d.d <= to) {
          s += d.s;
          pg += d.p;
        }
      }
      return { s, pg };
    },
    [allDays],
  );

  const shift = (key: string, days: number): string => {
    const [y, m, d] = key.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  };

  /** Monday of the week containing `key`. */
  const weekStartOf = (key: string): string => {
    const [y, m, d] = key.split('-').map(Number) as [number, number, number];
    return shift(key, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
  };

  /**
   * Today / this week / this month, each against the window before it.
   *
   * ⚠️ Every other figure on this page is a running total, and a running total
   * only ever goes up — which makes it silent about the only question worth
   * asking at the end of a day. These three carry a delta for exactly that
   * reason.
   */
  const periods: PeriodRow[] = useMemo(() => {
    if (!anchor) return [];
    const ws = weekStartOf(anchor);
    const ms = `${anchor.slice(0, 7)}-01`;
    const prevMsEnd = shift(ms, -1);
    const prevMs = `${prevMsEnd.slice(0, 7)}-01`;

    const mk = (key: string, label: string, from: string, to: string, pFrom: string, pTo: string, prevLabel: string): PeriodRow => {
        const cur = daySum(from, to);
        // ⚠️ `null`, not 0, when the previous window predates the data. Zero
        // would render as "+100%" for a reader who simply has no history.
        const has = allDays.some((d) => d.d >= pFrom && d.d <= pTo);
        return {
          key,
          label,
          seconds: cur.s,
          pages: cur.pg,
          prevSeconds: has ? daySum(pFrom, pTo).s : null,
          prevLabel,
        };
      };

    return [
      mk('today', '今天', anchor, anchor, shift(anchor, -1), shift(anchor, -1), '昨天'),
      mk('week', '本周', ws, shift(ws, 6), shift(ws, -7), shift(ws, -1), '上周'),
      mk('month', '本月', ms, `${anchor.slice(0, 7)}-31`, prevMs, prevMsEnd, '上个月'),
    ];
  }, [anchor, allDays, daySum]);

  /** This week, Monday to Sunday, with today marked. */
  const weekBars = useMemo(() => {
    if (!anchor) return [];
    const ws = weekStartOf(anchor);
    return WEEKDAYS.map((label, i) => {
      const key = shift(ws, i);
      return { key, label, value: daySum(key, key).s, isNow: key === anchor };
    });
  }, [anchor, daySum]);

  const calPeak = useMemo(() => {
    if (!anchor) return 1;
    const mk = anchor.slice(0, 7);
    return Math.max(1, ...allDays.filter((d) => d.d.startsWith(mk)).map((d) => d.s));
  }, [anchor, allDays]);


  /**
   * ⚠️ THIS month only, at the reader's request. The all-time weekday totals
   * answered "which day of the week do I read most, ever" — a question with one
   * answer that never changes. The current month answers "how is this month
   * going", which is what someone opening the page actually wants.
   */
  /** Consecutive days with reading, counting back from the last one that has any. */
  const streakEndingAt = useCallback(
    (endKey: string): { days: number; last: string } => {
      let n = 0;
      let cur = endKey;
      for (;;) {
        const hit = allDays.find((d) => d.d === cur);
        if (!hit || hit.s <= 0) break;
        n += 1;
        cur = shift(cur, -1);
      }
      return { days: n, last: endKey };
    },
    [allDays],
  );

  /**
   * Bests, scoped to the windows a reader is actually living in.
   *
   * ⚠️ All four were all-time before: "最长的一天 2.33h" is a number that can
   * only be beaten, so after a few months it stops moving and stops meaning
   * anything. "本周最好" answers the same question at a scale where the answer
   * can still change before the week is out.
   */
  const records = useMemo(() => {
    const best = (from: string, to: string) =>
      allDays.filter((d) => d.d >= from && d.d <= to).reduce((a, b) => (b.s > a.s ? b : a), { d: '', s: 0, p: 0 });
    const empty = { d: '', s: 0, p: 0 };

    const ws = anchor ? weekStartOf(anchor) : '';
    const ms = anchor ? `${anchor.slice(0, 7)}-01` : '';
    const wk = anchor ? best(ws, shift(ws, 6)) : empty;
    const mo = anchor ? best(ms, `${anchor.slice(0, 7)}-31`) : empty;

    // ⚠️ The streak ends at the last day WITH reading, not at `anchor`. The
    // device may not have synced today, and reporting "0 天" because of that
    // would be reporting a sync gap as a reading habit.
    const lastRead = [...allDays].reverse().find((d) => d.s > 0)?.d;
    const cur = lastRead ? streakEndingAt(lastRead) : { days: 0, last: '' };

    return [
      {
        label: '本周最好',
        value: wk.s > 0 ? formatReadingTime(wk.s) : '—',
        note: wk.d ? formatDayMonth(wk.d) : '这周还没读',
      },
      {
        label: '本月最好',
        value: mo.s > 0 ? formatReadingTime(mo.s) : '—',
        note: mo.d ? formatDayMonth(mo.d) : '这个月还没读',
      },
      {
        label: '连续到',
        value: `${cur.days} 天`,
        note: cur.last ? formatDayMonth(cur.last) : '还没有记录',
      },
      {
        label: '最长连续',
        value: `${bestStreak(allDays)} 天`,
        note: '有记录以来',
      },
    ];
  }, [allDays, anchor, streakEndingAt]);

  /**
   * Books bucketed by how far in they are, in tens.
   *
   * ⚠️ A book with no page count has no percentage and cannot be placed on this
   * axis at all — inventing a bucket for it would make the chart claim a
   * precision the data does not have. It is counted and reported separately.
   */
  const bands = useMemo(() => {
    const buckets = new Array<number>(10).fill(0);
    for (const b of books) {
      if (b.progressPct == null) continue;
      const i = Math.min(9, Math.max(0, Math.floor(b.progressPct / 10)));
      buckets[i] = (buckets[i] ?? 0) + 1;
    }
    return buckets.map((count, i) => ({ label: `${i * 10}`, count }));
  }, [books]);


  if (error || !index) {
    return (
      <View className="page">
        <Wallpaper />
        <TopBar title="CAPPERR" backTo={homePanelUrl('paperr')} />
        <PageStack count={1}>
          <Section index={0} title="CAPPERR" hero={<PageHero brand="CAPPERR" />} compact>
            <View className="card">
              <Text className="card__label">{error ? '读不到数据' : '读取中…'}</Text>
              {error && <Text className="card__note">{error}</Text>}
            </View>
          </Section>
        </PageStack>
      </View>
    );
  }

  const current = index.current;
  const finishNote = current?.estFinishedAt
    ? `预计 ${formatDayMonth(current.estFinishedAt)} 读完`
    : '还看不出读完时间';

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CAPPERR" backTo={homePanelUrl('paperr')} />

      <PageStack count={2}>
        <Section
          index={0}
          title="概览"
          hero={<PageHero brand="CAPPERR" />}
          compact
          // ⚠️ NO all-time stat block. It said "15.7h 累计阅读 / 29 读完" — two
          // figures that only ever go up, sitting directly above a block that
          // already reports today, this week and this month. The reader asked
          // for the current windows in both places; showing both meant the
          // loudest numbers on the page were the least actionable ones.
        >
          {/* ⚠️ Same load-bearing wrapper as the shelf below: Taro renders a
              ScrollView as an inline element, so `flex: 1` on it does nothing
              and it grows to its content instead of scrolling. */}
          <View className="pr-scrollwrap">
            <ScrollView className="pr-scroll" scrollY>
              {current && (
                <View className="pr-current">
                  <Text className="pr-current__kicker">在读</Text>
                  <Text className="pr-current__title">{current.title}</Text>
                  <View className="pr-bar">
                    <View
                      className="pr-bar__fill"
                      style={`width:${current.progressPct == null ? 0 : Math.min(100, current.progressPct)}%`}
                    />
                  </View>
                  <View className="pr-current__meta">
                    <Text className="pr-current__pct">
                      {current.progressPct == null ? '进度未知' : `${current.progressPct.toFixed(1)}%`}
                    </Text>
                    <Text className="pr-current__note">{finishNote}</Text>
                  </View>
                </View>
              )}

              {/* ⚠️ Above the grid, not in it. These three are the page's
                  headline — "how much have I read today" is the question that
                  brought someone here — and a headline that can be scrolled
                  past or wrapped into a column is not a headline. */}
              <PeriodStats periods={periods} format={formatReadingTime} />

              {/* ⚠️ A wrap grid, not a stack. Every chart used to be full width on
                  every screen, which on a 900px viewport left half the panel empty
                  — and even on a phone the donut, the records and the weekday bars
                  are narrow enough to pair up. `--half` marks the ones that can
                  share a row at ANY width; the rest pair up above 600px. */}
              <View className="pr-grid">
                {/* ⚠️ NOT `half`. The donut is a fixed 116px plot plus a legend
                    with a 52px floor — about 240px of unshrinkable width. In a
                    140px cell it overflows and paints over its neighbour. */}
                <Cell title="构成" sub="按阅读时长切分。点图例可以选中。">
                  <CompositionDonut slices={slices} format={formatReadingTime} />
                </Cell>

                <Cell title="记录" sub="个人最好成绩。" half>
                  <Records items={records} />
                </Cell>

                {/* ⚠️ THIS week, not the month's weekday totals. "Which weekday
                    do I read most" is a question with one answer that barely
                    moves; "how is this week going" is the one someone has at
                    the end of a day. Today's column is marked. */}
                <Cell title="本周" sub="周一到周日，标出的是今天。" half>
                  <WeekdayBars
                    bars={weekBars}
                    unit="本周"
                    activeKey={weekBars.find((b) => b.isNow)?.key}
                  />
                </Cell>

                <Cell title="趋势" sub="最近 30 天每天的时长。">
                  <ReadingCurve days={daily} />
                </Cell>

                {/* ⚠️ Replaced the rolling 12-week heatmap. That one answered
                    "what does the last quarter look like" — an answer that
                    barely changes day to day. A calendar answers "how is this
                    month going", and it shows the days that have not happened
                    yet as empty rather than as missing data. */}
                <Cell title="本月" sub="每天一格，点开看当天。">
                  <MonthCalendar days={allDays} peak={calPeak} />
                </Cell>

                <Cell title="时段" sub="一天里每个小时读了多少。">
                  <HourGrid hours={index.hourly} />
                </Cell>

                {/* ⚠️ Full width, both of them, and not `half` like 记录.
                    A half cell is ~140px on a phone and ~163px on a desktop
                    panel. Ten band labels ("10" "20" …) need ~24px each before
                    they touch, and an author name needs more than the ~48px a
                    half cell leaves after the bar and the value — at which
                    point the chart is a row of ellipses. The charts that
                    survive a half cell are the ones whose labels are a single
                    glyph: 记录's two-column values, 本月节奏's 一…日. */}
                <Cell title="进度分布" sub="每本书读到哪儿了。">
                  <ProgressBands bands={bands} doneFrom={DONE_PCT} />
                </Cell>


                {/* ⚠️ Heading hidden with the chart. `MonthBars` returns null below
                    two months — one bar is not a trend — and a heading with
                    nothing under it reads as a chart that failed to load. */}
                {index.monthly.length >= 2 && (
                  <Cell title="月份">
                    <MonthBars months={index.monthly} />
                  </Cell>
                )}
              </View>

              <Text className="pr-foot">
                数据源 KOReader statistics.sqlite3 · {bp.columns} 列布局
              </Text>
            </ScrollView>
          </View>
        </Section>

        <Section
          index={1}
          title="书架"
          lede={`${shown.length} / ${books.length} 条 · 待看排在最后`}
          stats={[
            { value: `${counts.reading}`, label: '在读' },
            { value: `${counts.todo}`, label: '待看' },
          ]}
          showCue={false}
        >
          <View className="pr-filters">
            {FILTERS.map((f) => (
              <View
                key={f.key}
                className={filter === f.key ? 'pr-chip pr-chip--on' : 'pr-chip'}
                onClick={() => setFilter(f.key)}
              >
                <Text className="pr-chip__text">{f.label}</Text>
              </View>
            ))}
          </View>

          <View className="pr-listwrap">
            <ScrollView className="pr-list" scrollY>
              {shown.map((b) => {
                const bucket = bucketOf(b);
                const pct = b.progressPct;
                const meta = [
                  b.authors && b.authors !== 'N/A' && !b.authors.includes('\n') ? b.authors.slice(0, 24) : null,
                  b.series,
                  b.pages ? `${b.pages} 页` : null,
                  formatReadingTime(b.totalReadTime),
                  formatAgo(b.lastOpen),
                ]
                  .filter(Boolean)
                  .join(' · ');

                return (
                  <View key={b.id} className="pr-row">
                    <View className="pr-row__main">
                      <Text className="pr-row__title">{b.title}</Text>
                      <Text className="pr-row__meta">{meta}</Text>
                    </View>

                    <View className="pr-row__side">
                      <Text
                        className={
                          bucket === 'done' ? 'pr-row__pct pr-row__pct--done' : bucket === 'todo' ? 'pr-row__pct pr-row__pct--todo' : 'pr-row__pct'
                        }
                      >
                        {bucket === 'todo' ? '待看' : bucket === 'done' ? '读完' : pct == null ? '—' : `${Math.round(pct)}%`}
                      </Text>
                      {b.estFinishedAt && bucket === 'reading' && (
                        <Text className="pr-row__eta">{formatDayMonth(b.estFinishedAt)}</Text>
                      )}
                    </View>
                  </View>
                );
              })}

              <Text className="pr-foot">
                {counts.reading} 在读 · {counts.done} 读完 · {counts.todo} 待看 · {bp.columns} 列布局
              </Text>
            </ScrollView>
          </View>
        </Section>
      </PageStack>
    </View>
  );
}
