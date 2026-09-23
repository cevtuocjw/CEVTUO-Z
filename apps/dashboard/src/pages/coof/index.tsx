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

import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
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

import './index.scss';

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
  const [scroll, setScroll] = useState({ ratio: 0, thumb: 0 });
  const gridRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
    setScroll({ ratio: 0, thumb: Math.min(1, el.clientHeight / el.scrollHeight) });
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

  const onSelect = useCallback((key: string) => setCollection(key), []);

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
      <TopBar title="COOF" />

      <PageStack count={2}>
        <Section
          index={0}
          title="COOF"
          hero={<PageHero brand="COOF" />}
          compact
          lede="CEVTUO's 观影记录"
          stats={[
            { value: `${calendars.length}`, label: '个年历', note: '2020–2026' },
            { value: `${archiveTotal}`, label: '条记录', note: '全部年历' },
          ]}
          cueText="下滑到下一页查看具体观影记录"
          updatedAt={updatedAt}
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
                  onClick={() => onSelect(key)}
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
                setScroll({ ratio, thumb: Math.min(1, view / Math.max(1, d.scrollHeight)) });
              }}
            >
              {view === 'grid' ? (
              <View className="grid">
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
