import { useEffect, useMemo, useState } from 'react';
import { Input, ScrollView, Text, View } from '@tarojs/components';

import { CompositionDonut, ReadingCurve, ReadingHeat, WeekdayBars } from '../../components/PaperrCharts';
import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  NEED_PASSWORD,
  clearPaperrPassword,
  fetchPaperrCurrent,
  fetchPaperrIndex,
  formatAgo,
  formatDayMonth,
  formatReadingTime,
  setPaperrPassword,
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
 * totals and a daily series — never raw page events.
 *
 * ⚠️ And that is also the ceiling on what can be charted here. There is no
 * per-hour and no per-book-per-day data in the payload, so "reading by time of
 * day" is a chart this data CANNOT support. The four charts below are the ones
 * the daily series genuinely answers.
 *
 * ⚠️ The history, the charts and the shelf are PUBLIC — they come from
 * `data/paperr/index.json` like every other brand. The ONE thing behind a
 * password is the 在读 panel: which book is open right now. It is written to its
 * own file by the pipeline, never committed, and fetched from the sync server.
 * See `fetchPaperrCurrent` in platform/data.ts.
 *
 * ── What the titles mean ───────────────────────────────────────
 * Most rows are not books. The pipeline relabels machine-generated news digests
 * and bare article headlines to `newsN (原名)`, and untitled entries to
 * `unknownN (原名)`. KOReader's own documents are dropped before they get here.
 * Only rows it could not classify keep their original title.
 */

type Filter = 'all' | 'reading' | 'done' | 'books';

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'done', label: '读完' },
  // ⚠️ Not "hide news" but "only books". With almost every row relabelled, the
  // useful view is the one with the generated labels taken out.
  { key: 'books', label: '只看书' },
];

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

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

/** Which bucket a row falls in, for the donut. */
function categoryOf(b: PaperrBook): string {
  if (!b.originalTitle) return '原样保留';
  return b.title.startsWith('news') ? '新闻摘要' : '无标题';
}

export default function Paperr() {
  const bp = useBreakpoint();
  const [index, setIndex] = useState<PaperrIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // ⚠️ The public payload and the private one load INDEPENDENTLY. The shelf must
  // render whether or not the reader has entered a password — gating the whole
  // page on a secret that only protects one panel would make a working
  // deployment look broken to anyone who has not been given the password.
  const [current, setCurrent] = useState<PaperrBook | null>(null);
  const [locked, setLocked] = useState(false);
  const [pwDraft, setPwDraft] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

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

  useEffect(() => {
    let alive = true;
    fetchPaperrCurrent()
      .then((d) => {
        if (!alive) return;
        setCurrent(d.current);
        setLocked(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        // ⚠️ "No password" is not an error — it is the normal state on a new
        // device, and it only affects one panel.
        if (msg === NEED_PASSWORD) setLocked(true);
        else setCurrent(null);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const books = index?.books ?? [];

  const stats = useMemo(() => {
    const done = books.filter(isFinished).length;
    return { done, reading: books.length - done };
  }, [books]);

  const shown = useMemo(() => {
    if (filter === 'reading') return books.filter((b) => !isFinished(b));
    if (filter === 'done') return books.filter(isFinished);
    if (filter === 'books') return books.filter((b) => !isRelabelled(b));
    return books;
  }, [books, filter]);

  /** Composition, by reading TIME — counting rows would let 24 short digests
   *  outweigh the handful of things actually read at length. */
  const slices = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const b of books) {
      const k = categoryOf(b);
      byCat.set(k, (byCat.get(k) ?? 0) + b.totalReadTime);
    }
    return [...byCat.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ key: label, label, value }));
  }, [books]);

  const daily = useMemo(() => (index?.daily ?? []).slice(-30), [index]);

  /** Which weekday the reading lands on. */
  const bars = useMemo(() => {
    const totals = new Array<number>(7).fill(0);
    for (const d of index?.daily ?? []) {
      const [y, m, dd] = d.d.split('-').map(Number) as [number, number, number];
      // ⚠️ UTC throughout. `new Date('2026-09-24')` parses as UTC midnight and
      // then `getDay()` reads it back in the VIEWER's timezone — a reader three
      // hours behind would see every Sunday filed under Saturday.
      const dow = (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7;
      totals[dow] = (totals[dow] ?? 0) + d.s;
    }
    return WEEKDAYS.map((label, i) => ({ key: label, label, value: totals[i] ?? 0 }));
  }, [index]);

  const totalSec = index?.totals.readSeconds ?? 0;

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

  const finishNote = current?.estFinishedAt
    ? `预计 ${formatDayMonth(current.estFinishedAt)} 读完`
    : '还看不出读完时间';
  const busyDay = bars.reduce((a, b) => (b.value > a.value ? b : a), bars[0]!);

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CE-CAPPERR" />

      <PageStack count={5}>
        <Section
          index={0}
          title="CAPPERR"
          hero={<PageHero brand="CAPPERR" />}
          compact
          lede="Kindle 阅读统计 · 只取 KOReader 自己的 statistics.sqlite3，不碰 Reading Insight"
          stats={[
            { value: formatReadingTime(totalSec), label: '累计阅读', note: `${index.totals.pagesTurned} 页` },
            { value: `${stats.done}`, label: '已读完', note: `共 ${books.length} 条` },
          ]}
        />

        <Section
          index={1}
          title="在读"
          lede={locked ? undefined : current ? undefined : '最近没有正在读的东西。'}
        >
          {locked ? (
            // ⚠️ A small gate inside the panel, not a full-page one. The rest of
            // the dashboard is public and has already rendered behind it.
            <View className="pr-gate">
              <Text className="pr-gate__why">「在读」不公开，需要口令才能看。</Text>
              <Input
                className="pr-gate__input"
                password
                value={pwDraft}
                placeholder="同步口令"
                onInput={(e) => setPwDraft(String((e.detail as { value?: string })?.value ?? ''))}
                onConfirm={() => {
                  if (!pwDraft) return;
                  setPaperrPassword(pwDraft);
                  setPwDraft('');
                  setReloadKey((k) => k + 1);
                }}
              />
              <View
                className="pr-gate__btn"
                onClick={() => {
                  if (!pwDraft) return;
                  setPaperrPassword(pwDraft);
                  setPwDraft('');
                  setReloadKey((k) => k + 1);
                }}
              >
                <Text className="pr-gate__btn-t">解锁</Text>
              </View>
              <Text className="pr-gate__hint">只记在这台设备的浏览器里，不上传。</Text>
            </View>
          ) : current ? (
            <View className="pr-current">
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

              <Text className="pr-current__foot">
                已读 {formatReadingTime(current.totalReadTime)} · {current.totalReadPages} 页 ·{' '}
                {formatAgo(current.lastOpen)}
              </Text>

              <View className="pr-gate__btn" onClick={() => { clearPaperrPassword(); setLocked(true); setCurrent(null); }}>
                <Text className="pr-gate__btn-t">锁定</Text>
              </View>
            </View>
          ) : null}
        </Section>

        <Section
          index={2}
          title="构成"
          lede="按阅读时长切分。点图例可以选中，再点一次取消。"
          stats={[
            { value: `${slices.length}`, label: '类别' },
            { value: formatReadingTime(totalSec), label: '合计' },
          ]}
        >
          <CompositionDonut slices={slices} format={formatReadingTime} />
          <View className="pc-gap" />
          <WeekdayBars bars={bars} unit="每个星期几的累计时长" />
        </Section>

        <Section
          index={3}
          title="趋势"
          lede="曲线是每天的时长，日历是同一份数据另一种看法。"
          stats={[
            { value: `${index.daily.length}`, label: '有记录的天数' },
            // ⚠️ NOT `周一` as the value. Stat values render at 40px, and two
            // CJK glyphs there wrap inside the column — measured, it rendered as
            // a bare "周" with the "一" clipped underneath. The weekday belongs
            // in the label, where the type is 10px.
            {
              value: busyDay.value > 0 ? formatReadingTime(busyDay.value) : '—',
              label: `最忙的周${busyDay.label}`,
            },
          ]}
        >
          <ReadingCurve days={daily} />
          <View className="pc-gap" />
          <ReadingHeat days={index.daily} weeks={12} />
        </Section>

        <Section
          index={4}
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
                const done = isFinished(b);
                const meta = [
                  b.authors && b.authors !== 'N/A' && !b.authors.includes('\n')
                    ? b.authors.slice(0, 24)
                    : null,
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
