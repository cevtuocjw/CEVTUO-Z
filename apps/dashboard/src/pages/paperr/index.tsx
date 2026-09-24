import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';

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
 * CE-CAPPERR — Kindle reading statistics.
 *
 * ⚠️ Displayed as CAPPERR; the internal key, the route and `data/paperr/` all
 * stay `paperr`. Renaming a route means every shared URL breaks, and the data
 * path is pinned by `packages/schema/src/paths.ts` behind a drift guard — a
 * rename that reaches that far is a migration, not a relabel.
 *
 * ── Where the numbers come from ────────────────────────────────
 * KOReader's own `statistics.sqlite3`, read in-process by the plugin
 * (`koreader-plugin/cevtuo-capperr.koplugin/`) and POSTed when the device joins
 * WiFi. The pipeline converts the export — see `pipeline/src/sources/paperr/`.
 *
 * ⚠️ The aggregation happens ON THE DEVICE, in SQL. A heavy reader's
 * `page_stat_data` runs to hundreds of thousands of rows, and building that in
 * Lua is how a plugin gets a Kindle killed for OOM. So this page receives
 * totals, never raw page events.
 *
 * ── What the titles mean ───────────────────────────────────────
 * Many rows are not books. The pipeline relabels machine-generated news digests
 * to `news1…N` so real books stand out, and untitled entries to
 * `unknownN (原名)`. KOReader's own documents are dropped before they get here.
 * `originalTitle` carries the device's name for anything relabelled, and is
 * shown underneath whenever the display title alone would say nothing.
 */

type Filter = 'all' | 'reading' | 'done' | 'books';

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'done', label: '读完' },
  // ⚠️ Not "hide news" but "only books": with two dozen digests the default
  // list is mostly `newsN`, so the useful view is the one without them.
  { key: 'books', label: '只看书' },
];

/**
 * KOReader's own rule, mirrored from the pipeline — finished at 99%+, and any
 * reading at all counts when it never learned the page count.
 */
function isFinished(b: PaperrBook): boolean {
  if (b.pages != null && b.pages > 0) return b.totalReadPages >= b.pages - 1;
  return b.totalReadPages > 0;
}

/** A generated label rather than a name. */
const isRelabelled = (b: PaperrBook): boolean => b.originalTitle != null;

/**
 * The device's own title, when the display title does not already contain it.
 *
 * ⚠️ Skipped for `unknownN (原名)` — the original is already right there in the
 * parentheses, and repeating it would print the same string twice.
 */
function subtitleOf(b: PaperrBook): string | null {
  if (!b.originalTitle) return null;
  return b.title.includes(b.originalTitle) ? null : b.originalTitle;
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
        if (alive) setIndex(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const books = index?.books ?? [];

  const stats = useMemo(() => {
    const done = books.filter(isFinished).length;
    return { done, reading: books.length - done, days: index?.daily.length ?? 0 };
  }, [books, index]);

  const shown = useMemo(() => {
    if (filter === 'reading') return books.filter((b) => !isFinished(b));
    if (filter === 'done') return books.filter(isFinished);
    if (filter === 'books') return books.filter((b) => !isRelabelled(b));
    return books;
  }, [books, filter]);

  /**
   * The daily strip.
   *
   * ⚠️ Scaled to the window's own maximum, not to a fixed ceiling. Reading
   * volume varies by an order of magnitude between a commute week and a holiday,
   * and a fixed scale would render one of those two as a flat line.
   */
  const daily = useMemo(() => {
    const window = (index?.daily ?? []).slice(-30);
    const peak = window.reduce((n, d) => Math.max(n, d.s), 0);
    return window.map((d) => ({ ...d, pct: peak > 0 ? Math.max(2, (d.s / peak) * 100) : 2 }));
  }, [index]);

  if (error || !index) {
    return (
      <View className="page">
        <Wallpaper />
        <TopBar title="CE-CAPPERR" />
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
  const peak = daily.reduce((n, d) => Math.max(n, d.s), 0);

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CE-CAPPERR" />

      <PageStack count={4}>
        <Section
          index={0}
          title="CAPPERR"
          hero={<PageHero brand="CAPPERR" />}
          compact
          lede="Kindle 阅读统计 · 只取 KOReader 自己的 statistics.sqlite3，不碰 Reading Insight"
          stats={[
            {
              value: formatReadingTime(index.totals.readSeconds),
              label: '累计阅读',
              note: `${index.totals.pagesTurned} 页`,
            },
            { value: `${stats.done}`, label: '已读完', note: `共 ${books.length} 本` },
          ]}
        />

        <Section index={1} title="在读" lede={current ? undefined : '最近没有正在读的书。'}>
          {current && (
            <View className="pr-current">
              <Text className="pr-current__title">{current.title}</Text>
              {subtitleOf(current) && (
                <Text className="pr-current__orig">{subtitleOf(current)}</Text>
              )}

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
        </Section>

        <Section
          index={2}
          title="每日"
          lede={`最近 ${daily.length} 天的阅读时长 · 峰值 ${formatReadingTime(peak)}`}
          stats={[
            { value: `${stats.days}`, label: '有记录的天数' },
            { value: formatReadingTime(index.totals.readSeconds), label: '合计' },
          ]}
        >
          <View className="pr-days">
            {daily.map((d) => (
              <View key={d.d} className="pr-days__col">
                <View className="pr-days__track">
                  <View className="pr-days__bar" style={`height:${d.pct}%`} />
                </View>
                <Text className="pr-days__label">{formatDayMonth(d.d)}</Text>
              </View>
            ))}
          </View>
        </Section>

        <Section
          index={3}
          title="书架"
          lede={`${shown.length} / ${books.length} 条`}
          stats={[
            { value: `${stats.reading}`, label: '在读' },
            { value: `${stats.done}`, label: '读完' },
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

          {/* ⚠️ The wrapper is load-bearing. Taro renders a ScrollView as
              `<taro-scroll-view-core>`, which the browser treats as
              `display: inline` — a `flex: 1` on it does nothing, so it grows to
              its content instead of scrolling. Measured on this page before the
              fix: the section's scrollHeight was 2077px inside a 1000px panel
              with `overflow: visible`, so two thirds of the shelf spilled past
              the panel and could not be reached.

              ⚠️ And NOTHING in verify-paperr-ui.mjs could see it — every DOM
              assertion passed against the broken layout. It took looking at a
              screenshot. */}
          <View className="pr-listwrap">
            <ScrollView className="pr-list" scrollY>
            {shown.map((b) => {
              const sub = subtitleOf(b);
              const done = isFinished(b);
              const meta = [
                b.authors && b.authors !== 'N/A' ? b.authors : null,
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
                    {sub && <Text className="pr-row__orig">{sub}</Text>}
                    <Text className="pr-row__meta">{meta}</Text>
                  </View>

                  <View className="pr-row__side">
                    <Text className={done ? 'pr-row__pct pr-row__pct--done' : 'pr-row__pct'}>
                      {done ? '读完' : b.progressPct == null ? '—' : `${Math.round(b.progressPct)}%`}
                    </Text>
                    {b.estFinishedAt && !done && (
                      <Text className="pr-row__eta">{formatDayMonth(b.estFinishedAt)}</Text>
                    )}
                  </View>
                </View>
              );
            })}

            <Text className="pr-foot">
              数据源 KOReader statistics.sqlite3 · {bp.columns} 列布局
            </Text>
            </ScrollView>
          </View>
        </Section>
      </PageStack>
    </View>
  );
}
