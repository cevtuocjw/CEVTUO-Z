import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';

import {
  CompositionDonut,
  HourGrid,
  MonthBars,
  ReadingCurve,
  ReadingHeat,
  Records,
  WeekdayBars,
} from '../../components/PaperrCharts';
import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
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

  const daily = useMemo(() => (index?.daily ?? []).slice(-30), [index]);

  /**
   * ⚠️ THIS month only, at the reader's request. The all-time weekday totals
   * answered "which day of the week do I read most, ever" — a question with one
   * answer that never changes. The current month answers "how is this month
   * going", which is what someone opening the page actually wants.
   */
  const monthBars = useMemo(() => {
    const all = index?.daily ?? [];
    const latest = all.length ? all[all.length - 1]!.d.slice(0, 7) : null;
    const totals = new Array<number>(7).fill(0);
    for (const d of all) {
      if (!latest || !d.d.startsWith(latest)) continue;
      const [y, mo, dd] = d.d.split('-').map(Number) as [number, number, number];
      // ⚠️ UTC throughout. `new Date('2026-09-24')` parses as UTC midnight and
      // `getDay()` reads it back in the VIEWER's timezone — a reader three hours
      // behind would see every Sunday filed under Saturday.
      const dow = (new Date(Date.UTC(y, mo - 1, dd)).getUTCDay() + 6) % 7;
      totals[dow] = (totals[dow] ?? 0) + d.s;
    }
    return WEEKDAYS.map((label, i) => ({ key: label, label, value: totals[i] ?? 0 }));
  }, [index]);

  const records = useMemo(() => {
    const all = index?.daily ?? [];
    const topDay = all.reduce((a, b) => (b.s > a.s ? b : a), { d: '', s: 0, p: 0 });
    const topPages = all.reduce((a, b) => (b.p > a.p ? b : a), { d: '', s: 0, p: 0 });
    const month = monthBars.reduce((n, b) => n + b.value, 0);
    return [
      { label: '最长的一天', value: topDay.s > 0 ? formatReadingTime(topDay.s) : '—', note: topDay.d ? formatDayMonth(topDay.d) : undefined },
      { label: '翻页最多', value: topPages.p > 0 ? `${topPages.p} 页` : '—', note: topPages.d ? formatDayMonth(topPages.d) : undefined },
      { label: '最长连续', value: `${bestStreak(all)} 天`, note: '有阅读的日子' },
      { label: '本月', value: month > 0 ? formatReadingTime(month) : '—', note: '累计时长' },
    ];
  }, [index, monthBars]);

  if (error || !index) {
    return (
      <View className="page">
        <Wallpaper />
        <TopBar title="CAPPERR" />
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
      <TopBar title="CAPPERR" />

      <PageStack count={2}>
        <Section
          index={0}
          title="概览"
          hero={<PageHero brand="CAPPERR" />}
          compact
          stats={[
            { value: formatReadingTime(index.totals.readSeconds), label: '累计阅读', note: `${index.totals.pagesTurned} 页` },
            { value: `${counts.done}`, label: '读完', note: `共 ${books.length} 条` },
          ]}
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

              <Text className="pr-h">构成</Text>
              <Text className="pr-sub">按阅读时长切分。点图例可以选中。</Text>
              <CompositionDonut slices={slices} format={formatReadingTime} />

              <Text className="pr-h">趋势</Text>
              <Text className="pr-sub">曲线是每天的时长，日历是同一份数据的另一种看法。</Text>
              <ReadingCurve days={daily} />
              <View className="pc-gap" />
              <ReadingHeat days={index.daily} weeks={12} />

              <Text className="pr-h">本月节奏</Text>
              <Text className="pr-sub">这个月每个星期几的累计时长。点柱子看数值。</Text>
              <WeekdayBars bars={monthBars} unit="这个月，按星期几" />

              <Text className="pr-h">时段</Text>
              <Text className="pr-sub">一天里每个小时读了多少。</Text>
              <HourGrid hours={index.hourly} />

              {/* ⚠️ The HEADING is hidden with the chart, not just the chart.
                  `MonthBars` returns null below two months — one bar is not a
                  trend — and a section heading with nothing under it reads as
                  a chart that failed to load. */}
              {index.monthly.length >= 2 && (
                <>
                  <Text className="pr-h">月份</Text>
                  <MonthBars months={index.monthly} />
                </>
              )}

              <Text className="pr-h">记录</Text>
              <Records items={records} />

              <Text className="pr-foot">数据源 KOReader statistics.sqlite3 · {bp.columns} 列布局</Text>
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
