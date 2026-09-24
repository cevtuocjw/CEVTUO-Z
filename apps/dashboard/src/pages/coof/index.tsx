/**
 * COOF — movie records.
 *
 * Two panels: the calendar switcher, then the poster grid. The grid panel owns
 * its own scroller.
 *
 * ⚠️ The grid is NOT part of the outer snap stack. A 149-entry grid inside a
 * `scroll-snap-type: y mandatory` container would snap the outer stack while you
 * are trying to scroll the grid, and every flick would jump back to the panel's
 * top. The outer stack snaps between the two panels; the grid scrolls freely
 * within the second one.
 *
 * ⚠️ Posters are the reason this page needs the network at all. The pipeline
 * re-hosts them because Notion's own S3 URLs expire in ~1h (see HANDOFF); paths
 * are origin-relative and resolved in `platform/data.ts`.
 *
 * ⚠️ `Image` uses `mode="aspectFill"` — posters have mixed aspect ratios and
 * `aspectFit` would letterbox them into inconsistent heights, which breaks the
 * grid rhythm on the unfolded screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';

import { MonthlyWave } from '../../components/MonthlyWave';
import { PageHero, PageStack, Section, type PageStackApi } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { homePanelUrl } from '../../platform/panels';
import { YearDonuts } from '../../components/YearDonuts';
import { Wallpaper } from '../../components/Wallpaper';
import {
  assetUrl,
  calendarKeys,
  fetchCoofIndex,
  fetchCoofLibrary,
  fetchSyncMeta,
  formatRuntime,
  formatUpdatedAt,
  type CoofIndex,
  type CoofTitle,
} from '../../platform/data';

import { CalendarView, TimelineView } from './views';

// ⚠️ Required, exactly like the other four pages. `.page` (the page padding and
// the flex column) and `.chip` / `.chips` live in here, NOT in index.scss.
//
// This went unnoticed because Taro only bundles a stylesheet that some module
// imports, and the COOF page was the only one that did not — so anything
// arriving from the home page already had demo.scss in the bundle and looked
// correct, while opening a COOF URL directly got no page padding and chips
// reduced to bare text. Measured on the live site: `border-width: 0px`,
// `background-color: rgba(0,0,0,0)`, chip height 21px instead of 34px.
import '../../styles/demo.scss';
import './index.scss';

/**
 * The watch month of the tile at `index`, as "2026 年 9 月", or '' if unknown.
 *
 * ⚠️ Approximate by construction — the grid is uniform per row, so a scroll
 * ratio maps to an index well, but a row whose titles wrap to two lines is
 * taller than one that does not, so the readout can lead or lag by a row. That
 * is acceptable for a position indicator; it would not be for anything that
 * changes what is shown.
 */
function monthAt(titles: CoofTitle[], index: number): string {
  const t = titles[Math.min(Math.max(0, index), titles.length - 1)];
  const d = t?.watchedAt;
  if (!d) return '';
  return `${d.slice(0, 4)} 年 ${Number(d.slice(5, 7))} 月`;
}

export default function Coof() {
  const [collection, setCollection] = useState<string>('');
  const [index, setIndex] = useState<CoofIndex | null>(null);
  const [titles, setTitles] = useState<CoofTitle[]>([]);
  const [detail, setDetail] = useState<CoofTitle | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * Which reading of the same data is on screen.
   *
   * ⚠️ All three read the SAME `titles` array. Switching never refetches — the
   * views are three presentations of one payload, which is the whole reason the
   * switcher can be instant.
   */
  const [view, setView] = useState<'grid' | 'timeline' | 'calendar'>('grid');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  /** 0..1 down the poster list, plus the thumb's size — drives the scroll bar. */
  const [scroll, setScroll] = useState({ ratio: 0, thumb: 0, month: '' });
  const gridRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Which calendar the breakdown sheet is showing, or null when it is closed.
   *
   * ⚠️ Deliberately NOT the same state as `collection`. Tapping a chip used to
   * switch the page outright; it now opens a question about that year, and the
   * reader may well close the sheet without going there. Switching `collection`
   * on open would leave the poster list under the sheet showing a year the
   * reader never asked to see.
   */
  const [yearKey, setYearKey] = useState<string | null>(null);
  const [yearTitles, setYearTitles] = useState<CoofTitle[]>([]);
  const [yearLoading, setYearLoading] = useState(false);
  const [yearError, setYearError] = useState<string | null>(null);
  const stackApi = useRef<PageStackApi | null>(null);

  /**
   * Calendars already fetched, keyed by name.
   *
   * ⚠️ A ref, not state. It is a cache, so writing it must not re-render — and
   * opening the same chip twice must not refetch. The index payload carries
   * genre TOTALS but no country column at all, so the sheet's numbers can only
   * come from a library fetch; seven of them on one panel would be seven
   * requests a reader never asked for.
   */
  const libs = useRef<Map<string, CoofTitle[]>>(new Map());

  // Load the index first — it carries the calendar list the switcher needs.
  useEffect(() => {
    let alive = true;
    fetchCoofIndex('COOF2026')
      .then((idx) => {
        if (!alive) return;
        setIndex(idx);
        setCollection((c) => c || calendarKeys(idx)[0] || idx.collection);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // ⚠️ Size the thumb once the grid has actually laid out.
  //
  // `onScroll` only fires when the reader scrolls, so before that the thumb sat
  // at whatever the initial state said. Measured: a hardcoded 0.2 rendered a
  // 138px thumb on a 692px track for a grid that is 28 screens tall and whose
  // real ratio is 3.5% — six times too long, and it snapped to the truth on the
  // first flick. The bar's whole job is telling you where you are; being wrong
  // until you move defeats it.
  //
  // H5-only (the mini program has no `clientHeight` here); there the first
  // scroll remedies it, which is a far smaller lie than a wrong resting state.
  useEffect(() => {
    const el = gridRef.current as unknown as HTMLElement | null;
    if (!el || !el.scrollHeight) return;
    // ⚠️ Back to the TOP, not to wherever the previous year was parked.
    //
    // The ScrollView keeps its `scrollTop` across a data swap — the element is
    // never unmounted, only its children change — so changing year from
    // COOF2026 (149 films) to COOF2022 (236) kept the reader at the old offset.
    // Measured: the list stayed part-way down with no explanation, which reads
    // as the new year simply starting somewhere in the middle.
    el.scrollTop = 0;
    setScroll({
      ratio: 0,
      thumb: Math.min(1, el.clientHeight / el.scrollHeight),
      month: monthAt(titles, 0),
    });
  }, [titles]);

  // Provenance line. Independent of the other fetches so a failure here can
  // never take the page down with it.
  useEffect(() => {
    let alive = true;
    fetchSyncMeta()
      .then((m) => alive && setUpdatedAt(formatUpdatedAt(m.generatedAt)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Full list for whichever calendar is selected.
  useEffect(() => {
    if (!collection) return;
    let alive = true;
    setLoading(true);
    fetchCoofLibrary(collection)
      .then((lib) => alive && setTitles(lib.titles))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [collection]);

  const calendars = useMemo(() => (index ? calendarKeys(index) : []), [index]);

  // ⚠️ Only rows that actually have a poster. A tile with no image in a strip
  // whose whole point is the images is worse than a shorter strip — 25 of the
  // 1209 rows have no poster and they cluster in the older calendars.
  const recent = useMemo(
    () => (index?.recent ?? []).filter((t) => t.poster).slice(0, 12),
    [index],
  );

  // Seed the cache with whatever the poster panel already loaded, so opening
  // the current year's chip is instant and costs nothing.
  useEffect(() => {
    if (collection && titles.length) libs.current.set(collection, titles);
  }, [collection, titles]);

  // The sheet's own fetch. Cached hits are synchronous, so a revisit does not
  // flash "载入中" over data that is already in memory.
  useEffect(() => {
    if (!yearKey) return undefined;
    const cached = libs.current.get(yearKey);
    if (cached) {
      setYearTitles(cached);
      setYearError(null);
      return undefined;
    }

    let alive = true;
    setYearLoading(true);
    setYearError(null);
    setYearTitles([]);
    fetchCoofLibrary(yearKey)
      .then((lib) => {
        libs.current.set(yearKey, lib.titles);
        if (alive) setYearTitles(lib.titles);
      })
      .catch((e: Error) => alive && setYearError(`载入失败：${e.message}`))
      .finally(() => alive && setYearLoading(false));
    return () => {
      alive = false;
    };
  }, [yearKey]);

  const onSelect = useCallback((key: string) => setCollection(key), []);

  // ⚠️ The chips open the sheet instead of switching year. Both readings were
  // tried: switching outright made the overview a control panel with no
  // content, and the request is explicit that a chip tap is a question ("what
  // was this year made of") whose answer is the rings. The jump button inside
  // the sheet is what goes to the list.
  const openYear = useCallback((key: string) => setYearKey(key), []);

  // ⚠️ The WHOLE archive, not this calendar's count. `index.counts.total` is
  // one calendar's size (149 for COOF2026); the panel claims "条记录 · 全部年历",
  // and showing 149 under that label is the page contradicting itself. Summed
  // from the per-collection counts the index already carries, so no extra fetch.
  const archiveTotal = useMemo(
    () => (index ? index.collections.reduce((n, c) => n + c.count, 0) : 0),
    [index],
  );

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="COOF" backTo={homePanelUrl('coof')} />

      <PageStack count={2} apiRef={stackApi}>
        <Section
          index={0}
          title="COOF"
          hero={<PageHero brand="COOF" />}
          // ⚠️ `compact` AND `dense`. `compact` is what separates this page from
          // the home index, whose whole job is the giant numerals; `dense` is
          // what makes room on this row for the chart beside them.
          compact
          dense
          lede="CEVTUO's 观影记录"
          stats={[
            { value: `${calendars.length}`, label: '个年历', note: '2020–2026' },
            { value: `${archiveTotal}`, label: '条记录', note: '全部年历' },
          ]}
          // ⚠️ Rendered even before the year is known. Mounting it late would
          // move the numbers into a different layout a frame after paint, which
          // reads as the page flinching. An empty chart is the honest state.
          statsAside={
            <MonthlyWave titles={titles} year={collection.replace(/^COOF/, '')} />
          }
          cueText="下滑到下一页查看具体观影记录"
          footnote={updatedAt ? `更新于 ${updatedAt}` : null}
        >
          {/* Calendar switcher.
              ⚠️ Kept ALONGSIDE the margin picker on the poster panel rather than
              replaced by it. They answer different questions: these chips are
              "move me to another year" from the overview, the margin label is
              "which year am I looking at, and change it" while reading the grid.
              Removing these was a mistake — the overview then had no way to
              change year at all without scrolling first. */}
          <ScrollView className="cal" scrollX showScrollbar={false}>
            <View className="cal__row">
              {calendars.map((key) => (
                <View
                  key={key}
                  className={`chip ${key === collection ? 'chip--on' : ''}`}
                  onClick={() => openYear(key)}
                >
                  <Text>{key}</Text>
                </View>
              ))}
            </View>
          </ScrollView>

          {/* ⚠️ Fills the panel's lower half, which measured 70% empty without it
              (252px of content in an 844px panel). The index already carries the
              20 most recent titles with their poster paths, so this costs no
              request — and it gives the first panel something to be about,
              instead of a paragraph and two numbers floating in whitespace. */}
          {recent.length ? (
            <View className="recent">
              <Text className="recent__label">最近看过</Text>
              <ScrollView className="recent__scroll" scrollX showScrollbar={false}>
                <View className="recent__row">
                  {recent.map((t) => (
                    <View key={t.id} className="recent__item" onClick={() => setDetail(t)}>
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
            </View>
          ) : null}
        </Section>

        {/* ⚠️ The year lives in the MARGIN, under the title, not in a row above
            the grid — on a phone the margin is the only band where it costs no
            content width, so the grid keeps every pixel.

            ⚠️ And it is behind a tap. Seven chips laid out permanently (what
            this replaced) spent a whole row of the panel on a control used once
            per visit, and showed all seven when the answer to "which one am I
            looking at" is a single year. */}
        <Section
          index={1}
          title="片单"
          subtitle={collection ? collection.replace(/^COOF/, "") : ""}
          onSubtitlePress={() => setPicking(true)}
          showCue={false}
          wide
        >
          <View className="views">
            {(
              [
                ['grid', '片单'],
                ['timeline', '时间线'],
                ['calendar', '日历'],
              ] as const
            ).map(([key, label]) => (
              <View
                key={key}
                className={`views__tab${view === key ? ' views__tab--on' : ''}`}
                onClick={() => setView(key)}
              >
                <Text>{label}</Text>
              </View>
            ))}
          </View>

          {error ? (
            <View className="state state--error">
              <Text className="state__title">加载失败</Text>
              <Text className="state__body">{error}</Text>
            </View>
          ) : loading && !titles.length ? (
            <View className="state">
              <Text className="state__body">载入中…</Text>
            </View>
          ) : (
            /* ⚠️ Tracked so the bar can exist at all. A 149-tile grid is many
               screens tall with nothing on the panel edge to say how many — the
               rail on the right tracks PANELS, not position within one. */
            <View className="posters__wrap">
            <ScrollView
              className="posters"
              scrollY
              ref={gridRef as never}
              onScroll={(e) => {
                const d = e.detail as unknown as { scrollTop: number; scrollHeight: number };
                const view = (gridRef.current as unknown as HTMLElement | null)?.clientHeight ?? 0;
                if (!d || !view) return;
                const max = Math.max(1, d.scrollHeight - view);
                // ⚠️ Clamped. Rubber-band scrolling on iOS reports a negative
                // scrollTop and an over-scroll past `max`, which would push the
                // thumb off both ends of its track.
                const ratio = Math.min(1, Math.max(0, d.scrollTop / max));
                setScroll({
                  ratio,
                  thumb: Math.min(1, view / Math.max(1, d.scrollHeight)),
                  // ⚠️ Which month you are looking at, not which month you
                  // started at. Tiles are uniform per row, so the scroll ratio
                  // maps to a tile index closely enough for a position readout.
                  month: monthAt(titles, Math.floor(ratio * titles.length)),
                });
              }}
            >
              {view === 'grid' ? (
              <View className="pgrid">
                {titles.map((t) => (
                  <View key={t.id} className="tile" onClick={() => setDetail(t)}>
                    <View className="tile__art">
                      {t.poster ? (
                        <Image
                          className="tile__img"
                          src={assetUrl(t.poster)}
                          mode="aspectFill"
                          lazyLoad
                        />
                      ) : (
                        // ⚠️ 856 rows predate the POSTER field entirely, so a
                        // missing poster is expected data, not a failure. Show a
                        // placeholder rather than hiding the tile — the title
                        // still matters.
                        <View className="tile__placeholder">
                          <Text className="tile__placeholder-text">{t.title.slice(0, 1)}</Text>
                        </View>
                      )}
                      {t.rating ? (
                        <View className="tile__badge">
                          <Text className="tile__badge-text">{t.rating.toFixed(1)}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text className="tile__title">{t.title}</Text>
                    <Text className="tile__meta">
                      {[t.year, t.genres[0]].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ))}
              </View>
              ) : view === 'timeline' ? (
                <TimelineView titles={titles} onOpen={setDetail} />
              ) : (
                <CalendarView titles={titles} onOpen={setDetail} />
              )}
            </ScrollView>
            {view === 'grid' && scroll.month ? (
              <Text className="posters__month">{scroll.month}</Text>
            ) : null}
            <View className="posters__bar">
              <View
                className="posters__thumb"
                style={{
                  height: `${scroll.thumb * 100}%`,
                  // The thumb's travel is the track minus its own length, so a
                  // long thumb moves less than the ratio alone would suggest.
                  top: `${scroll.ratio * (1 - scroll.thumb) * 100}%`,
                }}
              />
            </View>
            </View>
          )}
        </Section>
      </PageStack>

      {yearKey ? (
        <YearDonuts
          year={yearKey}
          titles={yearTitles}
          loading={yearLoading}
          error={yearError}
          onClose={() => setYearKey(null)}
          onJump={() => {
            // ⚠️ Order matters: close first, then switch, then scroll. The
            // sheet is `position: fixed`, so leaving it up while the stack
            // animates underneath both wastes the animation and — because the
            // grid resets its own scrollTop when the year changes — makes the
            // two movements happen where nobody can see them.
            setYearKey(null);
            onSelect(yearKey);
            stackApi.current?.scrollTo(1);
          }}
        />
      ) : null}

      {picking ? (
        <View className="picker" onClick={() => setPicking(false)}>
          <View className="picker__panel" onClick={(e) => e.stopPropagation()}>
            <Text className="picker__head">选择年历</Text>
            {calendars.map((key) => (
              <View
                key={key}
                className={`picker__item ${key === collection ? 'picker__item--on' : ""}`}
                onClick={() => {
                  onSelect(key);
                  setPicking(false);
                }}
              >
                <Text className="picker__year">{key.replace(/^COOF/, "")}</Text>
                <Text className="picker__full">{key}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {detail ? (
        <View className="sheet" onClick={() => setDetail(null)}>
          {/* Stop the tap from reaching the backdrop when clicking the panel. */}
          <View className="sheet__panel" onClick={(e) => e.stopPropagation()}>
            <View className="sheet__head">
              {detail.poster ? (
                <Image className="sheet__poster" src={assetUrl(detail.poster)} mode="aspectFill" />
              ) : (
                <View className="sheet__poster sheet__poster--empty" />
              )}
              <View className="sheet__headtext">
                <Text className="sheet__title">{detail.title}</Text>
                <Text className="sheet__sub">
                  {[detail.year, detail.mediaType, formatRuntime(detail.runtimeMin)]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {detail.rating ? (
                  <Text className="sheet__rating">★ {detail.rating.toFixed(1)}</Text>
                ) : null}
              </View>
            </View>

            <View className="sheet__rows">
              <Row label="观看日期" value={detail.watchedAt} />
              <Row label="类型" value={detail.genres.join(' / ')} />
              <Row label="国家" value={detail.country.join(' / ')} />
              <Row label="导演" value={detail.director.join(' / ')} />
              <Row label="主演" value={detail.cast.slice(0, 4).join(' / ')} />
              <Row label="备注" value={detail.note} />
            </View>

            <View className="sheet__close" onClick={() => setDetail(null)}>
              <Text>关闭</Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Renders nothing when the field is empty — most older rows are sparse. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View className="row">
      <Text className="row__k">{label}</Text>
      <Text className="row__v">{value}</Text>
    </View>
  );
}
