/**
 * CNSR — notes, from the four Notion sources.
 *
 * Four modules (Shopping / Learn / tech-learn / TECH-AI), each its own
 * year → month → day tree of everything filed under an `@date` marker.
 *
 * ⚠️ Wide and narrow are two DIFFERENT layouts of the same data, not one
 * layout that reflows.
 *
 * Four independently-scrolling columns only work when there is width for four
 * columns. On a phone each would be ~90px — narrower than the dates it holds —
 * so the narrow layout shows four header cards and opens ONE source at a time
 * in a glass sheet. That branch is decided in JS (`useWide`) rather than by a
 * media query hiding one of two rendered copies: rendering both would put
 * Learn's 4896 lines into the DOM twice.
 *
 * ⚠️ The four sources refresh on a STAGGERED schedule — one per run, four runs
 * to a cycle, so each is at most ~2 days old. That is why every module shows
 * its OWN sync time; a single page-level timestamp would be a lie about three
 * of the four.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { homePanelUrl } from '../../platform/panels';
import { Wallpaper } from '../../components/Wallpaper';
import {
  assetUrl,
  fetchCnsrIndex,
  fetchCnsrSource,
  formatUpdatedAt,
  type CnsrEntry,
  type CnsrLine,
  type CnsrSource,
  type CnsrSourcesIndex,
} from '../../platform/data';

// ⚠️ Required, like every other page. `.page` lives in demo.scss and Taro only
// bundles a stylesheet some module imports — the COOF page lost a whole design
// pass to missing this line (see HANDOFF).
import '../../styles/demo.scss';
import './index.scss';

/**
 * How many of the newest DAYS start expanded.
 *
 * ⚠️ Days, not nodes. Two expanded tree nodes would usually be two entries
 * under the same date plus a bare month header, which is not what "最近的 2 天
 * 展开" asks for.
 */
const OPEN_DAYS = 2;

interface DayNode {
  date: string;
  entries: CnsrEntry[];
}
interface MonthNode {
  month: string;
  days: DayNode[];
  lines: number;
}
interface YearNode {
  year: string;
  months: MonthNode[];
  lines: number;
}

/**
 * Fold the flat newest-first entry list into year → month → day.
 *
 * ⚠️ Years and months that do not exist are simply absent — no empty headers.
 * The sources are sparse and uneven (Shopping has 10 entries over 6 months,
 * Learn 192 days over 3.5 years), so rendering a fixed calendar would be
 * mostly blank rows.
 */
function buildTree(entries: CnsrEntry[]): YearNode[] {
  const years: YearNode[] = [];
  for (const e of entries) {
    const year = e.date.slice(0, 4);
    const month = e.date.slice(5, 7);
    let y = years[years.length - 1];
    if (!y || y.year !== year) {
      y = { year, months: [], lines: 0 };
      years.push(y);
    }
    let m = y.months[y.months.length - 1];
    if (!m || m.month !== month) {
      m = { month, days: [], lines: 0 };
      y.months.push(m);
    }
    let d = m.days[m.days.length - 1];
    if (!d || d.date !== e.date) {
      d = { date: e.date, entries: [] };
      m.days.push(d);
    }
    d.entries.push(e);
    m.lines += e.lines.length;
    y.lines += e.lines.length;
  }
  return years;
}

const monthLabel = (m: string) => `${Number(m)} 月`;

/**
 * `matchMedia`, not a resize listener: this is a one-bit question, and the
 * media query encodes the same 840px breakpoint the stylesheet uses so the two
 * cannot drift apart.
 */
function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(min-width: 840px)');
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return wide;
}

/**
 * Open a link, with feedback either way.
 *
 * ⚠️ `window.open` first, clipboard second — NOT `location.href`. These are
 * pasted research links and following one must not navigate the dashboard away;
 * on the mini-program (no `window`) the address goes to the clipboard and says
 * so, which is the only affordance available there.
 */
/** `https://www.example.com/x` → `example.com`, for the logo and the caption. */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function openLink(href: string) {
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  Taro.setClipboardData({ data: href });
}

/**
 * One line of a note, with its links carrying a name.
 *
 * ⚠️ The requirement is that a link is never shown as `https://…`. The
 * extractor has already written the NAME into `line.t`; this only has to find
 * each link's text inside it and wrap that span, so the reader sees and taps a
 * word rather than an address.
 *
 * ⚠️ Matched sequentially and consuming as it goes, so a line containing the
 * same link text twice wraps the first occurrence first rather than both at
 * once — `indexOf` from the head would otherwise map both runs onto the first.
 */
function LineText({ line }: { line: CnsrLine }) {
  const cls = `cn__line cn__line--${line.k}`;
  const links = line.links ?? [];
  if (!links.length) return <Text className={cls}>{line.t}</Text>;

  // ⚠️ A line that IS a link gets its own row, so the site's logo can sit in
  // front of the name. The logo is an <Image>, and an <Image> cannot be nested
  // inside a <Text> — which is where the inline branch below would have to put
  // it. This is also the common case: a pasted URL becomes its own line.
  if (links.length === 1 && links[0]!.t === line.t) {
    const host = hostOf(links[0]!.href);
    return (
      <View className={`cn__linkrow${line.k === 'bookmark' ? ' cn__linkrow--bm' : ''}`}>
        {host ? (
          // ⚠️ A favicon service rather than a stored logo. Storing one per site
          // would mean fetching and re-hosting images for every link in the
          // notes, which is most of what the 5-day window exists to avoid. The
          // letter badge behind it is the fallback for a host with no icon.
          <View className="cn__fav">
            <Text className="cn__fav-letter">{host.slice(0, 1).toUpperCase()}</Text>
            <Image
              className="cn__fav-img"
              src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
              mode="aspectFit"
              lazyLoad
            />
          </View>
        ) : null}
        <View className="cn__linktext">
          <Text className="cn__a cn__a--block" onClick={() => openLink(links[0]!.href)}>
            {line.t}
          </Text>
          {/* ⚠️ The target page's own summary. Without it a link row is a name
              and a domain — which is what the user reported as "the link's
              content was never fetched". Absent whenever the fetch failed, and
              the row still works. */}
          {links[0]!.desc ? <Text className="cn__desc">{links[0]!.desc}</Text> : null}
        </View>
        <Text className="cn__host">{host}</Text>
      </View>
    );
  }

  const parts: React.ReactNode[] = [];
  let rest = line.t;
  let k = 0;
  for (const link of links) {
    const i = rest.indexOf(link.t);
    if (i < 0) continue;
    if (i > 0) parts.push(rest.slice(0, i));
    parts.push(
      <Text
        className="cn__a"
        key={`a${k}`}
        onClick={(e) => {
          e.stopPropagation();
          openLink(link.href);
        }}
      >
        {link.t}
      </Text>,
    );
    k += 1;
    rest = rest.slice(i + link.t.length);
  }
  if (rest) parts.push(rest);
  return <Text className={cls}>{parts}</Text>;
}

/** The year → month → day tree. Shared by the wide column and the narrow sheet. */
function CnsrTree({ source }: { source: CnsrSource }) {
  const years = useMemo(() => buildTree(source.entries), [source.entries]);

  const seed = useMemo(() => {
    const open = new Set<string>();
    const newest = new Set<string>();
    for (const e of source.entries) {
      if (newest.size >= OPEN_DAYS && !newest.has(e.date)) break;
      newest.add(e.date);
    }
    for (const y of years) {
      for (const m of y.months) {
        for (const d of m.days) {
          if (!newest.has(d.date)) continue;
          open.add(`d:${d.date}`);
          open.add(`m:${y.year}-${m.month}`);
          open.add(`y:${y.year}`);
        }
      }
    }
    return open;
  }, [years, source.entries]);

  const [open, setOpen] = useState<Set<string>>(seed);

  // ⚠️ Re-seed when the SOURCE changes, not on every render. Without this,
  // opening a different source keeps the previous one's open keys — which are
  // absent from the new tree, so everything renders collapsed and the panel
  // looks empty. Keyed on `updatedAt` too, so a re-sync that adds entries
  // re-opens the newly newest day.
  const seedKey = `${source.source}:${source.updatedAt}`;
  const lastSeed = useRef(seedKey);
  useEffect(() => {
    if (lastSeed.current !== seedKey) {
      lastSeed.current = seedKey;
      setOpen(seed);
    }
  }, [seedKey, seed]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!source.entries.length) {
    return <Text className="cn__empty">这个来源还没有带日期的条目</Text>;
  }

  return (
    <View className="cn__tree">
      {years.map((y) => {
        const yKey = `y:${y.year}`;
        const yOpen = open.has(yKey);
        return (
          <View className="cn__year" key={y.year}>
            <View className="cn__node cn__node--year" onClick={() => toggle(yKey)}>
              <View className={`cn__caret${yOpen ? ' cn__caret--on' : ''}`} />
              <Text className="cn__year-t">{y.year}</Text>
              <Text className="cn__node-n">{y.lines} 行</Text>
            </View>

            {yOpen
              ? y.months.map((m) => {
                  const mKey = `m:${y.year}-${m.month}`;
                  const mOpen = open.has(mKey);
                  return (
                    <View className="cn__month" key={mKey}>
                      <View className="cn__node cn__node--month" onClick={() => toggle(mKey)}>
                        <View className={`cn__caret${mOpen ? ' cn__caret--on' : ''}`} />
                        <Text className="cn__month-t">{monthLabel(m.month)}</Text>
                        <Text className="cn__node-n">{m.lines} 行</Text>
                      </View>

                      {mOpen
                        ? m.days.map((d) => {
                            const dKey = `d:${d.date}`;
                            const dOpen = open.has(dKey);
                            const n = d.entries.reduce((k, e) => k + e.lines.length, 0);
                            const more = d.entries.reduce((k, e) => k + e.more, 0);
                            const imgs = d.entries.reduce((k, e) => k + e.images.length, 0);
                            return (
                              // One glass panel per DAY, not per line — the day
                              // is the unit the reader thinks in, and the panel
                              // edge is what makes ten days scannable at once.
                              <View className={`cn__day${dOpen ? ' cn__day--on' : ''}`} key={dKey}>
                                <View className="cn__node cn__node--day" onClick={() => toggle(dKey)}>
                                  <View className={`cn__caret${dOpen ? ' cn__caret--on' : ''}`} />
                                  <Text className="cn__day-t">{d.date}</Text>
                                  <Text className="cn__node-n">
                                    {n ? `${n} 行` : '无内容'}
                                    {more ? ` +${more}` : ''}
                                    {imgs ? ` · ${imgs} 图` : ''}
                                  </Text>
                                </View>

                                {dOpen ? (
                                  <View className="cn__day-body">
                                    {d.entries.map((e) => (
                                      <View className="cn__entry" key={e.id}>
                                        {e.title ? <Text className="cn__entry-t">{e.title}</Text> : null}
                                        {e.lines.length ? (
                                          e.lines.map((l, i) => <LineText line={l} key={i} />)
                                        ) : (
                                          <Text className="cn__line cn__line--none">
                                            （这个日期下没有内容）
                                          </Text>
                                        )}
                                        {/* Shopping only — every other source drops
                                            images at extraction time, so this is
                                            empty for them rather than hidden here. */}
                                        {e.images.length ? (
                                          <View className="cn__imgs">
                                            {e.images.map((im, i) => (
                                              // ⚠️ `aspectFit`, not `widthFix`.
                                              //
                                              // At full column width a phone
                                              // screenshot or a tall product
                                              // shot became a band taller than
                                              // the notes around it, and
                                              // `widthFix` sizes by width alone
                                              // so a very tall image simply ran
                                              // off the column. `aspectFit`
                                              // inside a capped box keeps the
                                              // whole picture visible whatever
                                              // its shape.
                                              <Image
                                                className="cn__img"
                                                key={i}
                                                src={assetUrl(im.src)}
                                                mode="aspectFit"
                                                lazyLoad
                                              />
                                            ))}
                                          </View>
                                        ) : null}
                                        {/* ⚠️ Stated, not hidden. A day capped at
                                            10 rows otherwise reads as a day that
                                            had exactly 10. */}
                                        {e.more ? <Text className="cn__more">另有 {e.more} 行未显示</Text> : null}
                                      </View>
                                    ))}
                                  </View>
                                ) : null}
                              </View>
                            );
                          })
                        : null}
                    </View>
                  );
                })
              : null}
          </View>
        );
      })}

    </View>
  );
}

/** One source's scrolling column: header, tree, rail, position readout. */
function CnsrColumn({ source, onFull }: { source: CnsrSource | null; onFull: () => void }) {
  const [scroll, setScroll] = useState({ ratio: 0, thumb: 0, date: '' });
  const bodyRef = useRef<HTMLElement | null>(null);

  // Size the thumb once the tree has laid out. `onScroll` only fires when the
  // reader scrolls, so before that the thumb sits at a made-up length — the
  // COOF grid shipped exactly that bug once (see HANDOFF: a hardcoded 0.2 drew
  // a 138px thumb for a grid whose real ratio was 3.5%).
  useEffect(() => {
    const el = bodyRef.current as unknown as HTMLElement | null;
    if (!el || !el.scrollHeight) return;
    el.scrollTop = 0;
    setScroll({ ratio: 0, thumb: Math.min(1, el.clientHeight / el.scrollHeight), date: '' });
  }, [source?.source, source?.updatedAt]);

  if (!source) {
    return (
      <View className="cn__col">
        <Text className="cn__col-state">载入中…</Text>
      </View>
    );
  }

  return (
    <View className="cn__col">
      <View className="cn__col-head">
        <View className="cn__col-headline">
          <Text className="cn__col-t">{source.label}</Text>
          {/* ⚠️ A 44px target. In a four-up column on a laptop this is a mouse
              click, but the same layout runs on a tablet, and the icon alone
              would be a ~16px hit area there. */}
          <View className="cn__full" onClick={onFull}>
            <Text className="cn__full-t">⤢</Text>
          </View>
        </View>
        <Text className="cn__col-m">
          {source.counts.days} 天 · {source.counts.lines} 行
        </Text>
        {/* ⚠️ Labelled a SYNC time, not an update time. These four refresh on a
            stagger, so "更新于" would invite the reader to assume all four are
            current when at most one was refreshed this run. */}
        <Text className="cn__col-sync">同步于 {formatUpdatedAt(source.updatedAt) ?? '—'}</Text>
      </View>

      <View className="cn__col-bodywrap">
        <ScrollView
          className="cn__col-body"
          scrollY
          ref={bodyRef as never}
          onScroll={(e) => {
            const d = e.detail as unknown as { scrollTop: number; scrollHeight: number };
            const view = (bodyRef.current as unknown as HTMLElement | null)?.clientHeight ?? 0;
            if (!d || !view) return;
            const max = Math.max(1, d.scrollHeight - view);
            // Clamped: iOS rubber-banding reports a negative scrollTop and an
            // over-scroll past `max`, which would push the thumb off both ends
            // of its track.
            const ratio = Math.min(1, Math.max(0, d.scrollTop / max));
            // ⚠️ Approximate by construction — a day with 60 lines is many
            // times taller than one with 2, so equal scroll does not mean equal
            // entries. Fine for a position readout; it would not be for
            // anything that changes what is displayed.
            const idx = Math.min(
              source.entries.length - 1,
              Math.floor(ratio * source.entries.length),
            );
            setScroll({
              ratio,
              thumb: Math.min(1, view / Math.max(1, d.scrollHeight)),
              date: source.entries[idx]?.date ?? '',
            });
          }}
        >
          <CnsrTree source={source} />
        </ScrollView>

        {/* The readout sits ABOVE the rail: the rail says how far down you are,
            this says among what. */}
        {scroll.date ? <Text className="cn__col-date">{scroll.date}</Text> : null}
        <View className="cn__rail">
          <View
            className="cn__thumb"
            style={{
              height: `${scroll.thumb * 100}%`,
              top: `${scroll.ratio * (1 - scroll.thumb) * 100}%`,
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Timeline — all four sources merged into one axis.
 *
 * ⚠️ The merge is the point: the four columns answer "what is in Learn", and
 * this answers "what did I write on the 20th", which no single column can. Each
 * entry keeps a chip naming its source, because a merged list without one is
 * unreadable — the reader cannot tell a shopping lead from an AI note.
 *
 * ⚠️ Sorted by DATE, then by source order. Not by `updatedAt`: the sources are
 * refreshed on a stagger, so two entries from the same day can carry sync times
 * days apart and sorting by them would interleave one day's notes across the
 * list.
 */
function Timeline({ sources }: { sources: CnsrSource[] }) {
  const days = useMemo(() => {
    const byDate = new Map<string, { date: string; items: { label: string; src: string; entry: CnsrEntry }[] }>();
    for (const s of sources) {
      for (const e of s.entries) {
        let d = byDate.get(e.date);
        if (!d) {
          d = { date: e.date, items: [] };
          byDate.set(e.date, d);
        }
        d.items.push({ label: s.label, src: s.source, entry: e });
      }
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [sources]);

  const seed = useMemo(() => new Set(days.slice(0, OPEN_DAYS).map((d) => d.date)), [days]);
  const [open, setOpen] = useState<Set<string>>(seed);
  const lastSeed = useRef(seed);
  useEffect(() => {
    lastSeed.current = seed;
    setOpen(seed);
  }, [seed]);

  if (!days.length) return <Text className="cn__empty">还没有带 @日期 的条目</Text>;

  return (
    <View className="cn__timeline">
      {days.map((d) => {
        const isOpen = open.has(d.date);
        const n = d.items.reduce((k, it) => k + it.entry.lines.length, 0);
        return (
          <View className={`cn__day${isOpen ? ' cn__day--on' : ''}`} key={d.date}>
            <View
              className="cn__node cn__node--day"
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(d.date)) next.delete(d.date);
                  else next.add(d.date);
                  return next;
                })
              }
            >
              <View className={`cn__caret${isOpen ? ' cn__caret--on' : ''}`} />
              <Text className="cn__day-t">{d.date}</Text>
              <Text className="cn__node-n">
                {d.items.length} 个来源 · {n ? `${n} 行` : '无内容'}
              </Text>
            </View>

            {isOpen ? (
              <View className="cn__day-body">
                {d.items.map((it) => (
                  <View className="cn__tl-item" key={`${it.src}-${it.entry.id}`}>
                    <View className={`cn__tl-chip cn__tl-chip--${it.src}`}>
                      <Text className="cn__tl-chip-t">{it.label}</Text>
                    </View>
                    {it.entry.lines.length ? (
                      it.entry.lines.map((l, i) => <LineText line={l} key={i} />)
                    ) : (
                      <Text className="cn__line cn__line--none">（这个日期下没有内容）</Text>
                    )}
                    {it.entry.more ? (
                      <Text className="cn__more">另有 {it.entry.more} 行未显示</Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Heatmap — one cell per day, shaded by how much was written.
 *
 * ⚠️ Shaded by LINES + LINKS, not by character count. The user's rule, and the
 * right one: a day holding one 800-character paragraph and a day holding eight
 * separate notes are not the same amount of noting, and a character total calls
 * the first one busier. Links count triple because a saved link is a deliberate
 * act, where a long paste is often just a long paste.
 *
 * ⚠️ One row, not a month grid. The reference the user pointed at groups by
 * month across a year; this window is five days per source, so month grouping
 * would draw one almost-empty column per month and say nothing. Height is also
 * a constraint — the columns and the timeline have to fit below it.
 */
function Heatmap({ sources }: { sources: CnsrSource[] }) {
  const [pick, setPick] = useState<string>('all');

  // Union of every date any source holds, newest first.
  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const s of sources) for (const e of s.entries) set.add(e.date);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [sources]);

  const value = useCallback(
    (date: string) => {
      let n = 0;
      for (const s of sources) {
        if (pick !== 'all' && s.source !== pick) continue;
        for (const e of s.entries) {
          if (e.date !== date) continue;
          n += e.lines.length + e.lines.reduce((k, l) => k + (l.links?.length ?? 0) * 3, 0);
        }
      }
      return n;
    },
    [sources, pick],
  );

  const max = Math.max(1, ...dates.map(value));
  /** 0–5, so a quiet day still shows a faint cell rather than nothing at all. */
  const level = (n: number) => (n === 0 ? 0 : Math.min(5, 1 + Math.round((n / max) * 4)));

  if (!dates.length) return null;

  return (
    <View className="hm">
      <View className="hm__tabs">
        {[{ key: 'all', label: '全部' }, ...sources.map((s) => ({ key: s.source, label: s.label }))].map((t) => (
          <View
            key={t.key}
            className={`hm__tab${pick === t.key ? ' hm__tab--on' : ''}`}
            onClick={() => setPick(t.key)}
          >
            <Text>{t.label}</Text>
          </View>
        ))}
      </View>

      <View className="hm__row">
        {dates.map((d) => {
          const n = value(d);
          return (
            <View className="hm__cellwrap" key={d}>
              <View className={`hm__cell hm__cell--${level(n)}`} />
              <Text className="hm__d">{d.slice(5)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default function Cnsr() {
  const [index, setIndex] = useState<CnsrSourcesIndex | null>(null);
  const [loaded, setLoaded] = useState<Record<string, CnsrSource>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Which source's sheet is open. Narrow layout only. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Which source is open WIDE. The per-column ⤢ key, wide layout only. */
  const [fullKey, setFullKey] = useState<string | null>(null);
  /**
   * Four columns, or one merged axis.
   *
   * ⚠️ Both read the SAME loaded payloads and switching never refetches — the
   * two are presentations of one fetch, which is why the switch is instant.
   */
  const [view, setView] = useState<'sources' | 'timeline'>('sources');
  const wide = useWide();

  useEffect(() => {
    let alive = true;
    fetchCnsrIndex()
      .then((idx) => {
        if (!alive) return;
        setIndex(idx);
        // ⚠️ In PARALLEL, each column rendering as its own payload lands.
        // Serially, the fourth column would wait on ~500KB of Learn before it
        // even started.
        for (const s of idx.sources) {
          fetchCnsrSource(s.key)
            .then((data) => alive && setLoaded((prev) => ({ ...prev, [s.key]: data })))
            .catch((e: Error) => alive && setError(e.message));
        }
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const sources = index?.sources ?? [];
  // ⚠️ Summed from the LOADED payloads, not from the index's counts. The index
  // stores a copy of each count from the run that last refreshed that source,
  // so a page-level total built from it would mix cycles — three of the four
  // entries would be a full stagger behind.
  const live = sources.map((s) => loaded[s.key]).filter(Boolean) as CnsrSource[];
  const newestSync = sources
    .map((s) => s.updatedAt)
    .sort()
    .reverse()[0];

  const openSource = openKey ? loaded[openKey] ?? null : null;
  const openMeta = openKey ? sources.find((s) => s.key === openKey) ?? null : null;
  const fullSource = fullKey ? loaded[fullKey] ?? null : null;
  const fullMeta = fullKey ? sources.find((s) => s.key === fullKey) ?? null : null;

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CNSR" backTo={homePanelUrl('cnsr')} />

      <PageStack count={1}>
        <Section
          index={0}
          title="CNSR"
          // ⚠️ No masthead on a wide screen. The panel has to hold a heatmap,
          // a switcher, and four scrolling columns, and on a 900px-tall window
          // the giant CNSR wordmark was spending ~150px of it on a word the tab
          // already says. Dropping it lifts the tabs and the columns right up
          // under the title bar, which is the point.
          hero={wide ? undefined : <PageHero brand="CNSR" />}
          compact
          lede="欢迎阅读 CEVTUO 的一些笔记～"
          // The two counters are gone, replaced by the heatmap below — they
          // were a total and a total is not a shape.
          stats={[]}
          // ⚠️ There is nothing below this panel (`count={1}`), so a down cue
          // would promise content that does not exist.
          showCue={false}
          // ⚠️ The NEWEST of the four, and the label reads 更新于 — this is the
          // page's own freshness, which genuinely is the newest source. Each
          // module carries its own time for the honest per-source answer.
          updatedAt={newestSync ? formatUpdatedAt(newestSync) : null}
          wide
        >
          {error ? (
            <View className="state state--error">
              <Text className="state__title">加载失败</Text>
              <Text className="state__body">{error}</Text>
            </View>
          ) : loading ? (
            <View className="state">
              <Text className="state__body">载入中…</Text>
            </View>
          ) : (
            <>
              <Heatmap sources={live} />

              {/* ⚠️ Always rendered, wide or narrow. The timeline is the only
                  view that spans sources, and on a phone the four cards each
                  open their own sheet — without this control the merged axis
                  would be unreachable there. */}
              <View className="cnview">
                {(
                  [
                    ['sources', '来源'],
                    ['timeline', '时间线'],
                  ] as const
                ).map(([k, label]) => (
                  <View
                    key={k}
                    className={`cnview__tab${view === k ? ' cnview__tab--on' : ''}`}
                    onClick={() => setView(k)}
                  >
                    <Text>{label}</Text>
                  </View>
                ))}
              </View>

              {view === 'timeline' ? (
                // Same wrapper, same reason as the sheet above.
                <View className="cn__tlwrap">
                  <ScrollView className="cn__tlscroll" scrollY>
                    <Timeline sources={live} />
                  </ScrollView>
                </View>
              ) : (
            <View className="cn__cols">
              {sources.map((s) => (
                <View className="cn__colwrap" key={s.key}>
                  {/* Narrow: the card is the button that opens the sheet, and
                      the tree is deliberately NOT rendered here — see the note
                      on `useWide`. */}
                  {wide ? (
                    <CnsrColumn source={loaded[s.key] ?? null} onFull={() => setFullKey(s.key)} />
                  ) : (
                    <View className="cn__card" onClick={() => setOpenKey(s.key)}>
                      <View className="cn__card-line">
                        <Text className="cn__card-t">{s.label}</Text>
                        <Text className="cn__card-go">展开 →</Text>
                      </View>
                      <Text className="cn__card-m">
                        {s.counts.days} 天 · {s.counts.lines} 行
                      </Text>
                      <Text className="cn__card-sync">同步于 {formatUpdatedAt(s.updatedAt) ?? '—'}</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
              )}
            </>
          )}
        </Section>
      </PageStack>

      {/* The sheet. ⚠️ Rendered only when narrow AND open — a `display: none`
          copy would still build Learn's 199 day nodes and 4896 text lines. */}
      {!wide && openKey && openMeta ? (
        <View className="cnsr-sheet" onClick={() => setOpenKey(null)}>
          <View className="cnsr-sheet__panel" onClick={(e) => e.stopPropagation()}>
            <View className="cnsr-sheet__head">
              <View className="cnsr-sheet__titles">
                <Text className="cnsr-sheet__t">{openMeta.label}</Text>
                <Text className="cnsr-sheet__m">
                  {openMeta.counts.days} 天 · {openMeta.counts.lines} 行 · 同步于{' '}
                  {formatUpdatedAt(openMeta.updatedAt) ?? '—'}
                </Text>
              </View>
              <View className="cnsr-sheet__x" onClick={() => setOpenKey(null)}>
                <Text className="cnsr-sheet__x-t">✕</Text>
              </View>
            </View>

            {/* ⚠️ The wrapper is load-bearing. Taro renders a ScrollView as
                `<taro-scroll-view-core>`, which the browser treats as
                `display: inline` — a `flex: 1` on it does nothing, so it grows
                to its content. Measured: after expanding a few days its
                content covered the sheet's own ✕ button and the click was
                intercepted by a text node. Anchoring all four edges inside a
                positioned wrapper is what actually clips it. */}
            <View className="cnsr-sheet__bodywrap">
              <ScrollView className="cnsr-sheet__body" scrollY>
                {openSource ? (
                  <CnsrTree source={openSource} />
                ) : (
                  <Text className="cn__col-state">载入中…</Text>
                )}
              </ScrollView>
            </View>
          </View>
        </View>
      ) : null}

      {/* The wide-screen fullscreen key's target.
          ⚠️ A SEPARATE overlay from the narrow one, not the same one reused.
          They differ in what "full" means: on a phone the sheet is the only way
          to see any source at all, while here it is an enlargement of a column
          already on screen — so this one is a centred dialog at a fixed width,
          and the narrow one is a bottom sheet across the whole viewport. */}
      {wide && fullKey && fullMeta ? (
        <View className="cnsr-sheet cnsr-sheet--wide" onClick={() => setFullKey(null)}>
          <View className="cnsr-sheet__panel" onClick={(e) => e.stopPropagation()}>
            <View className="cnsr-sheet__head">
              <View className="cnsr-sheet__titles">
                <Text className="cnsr-sheet__t">{fullMeta.label}</Text>
                <Text className="cnsr-sheet__m">
                  {fullMeta.counts.days} 天 · {fullMeta.counts.lines} 行 · 同步于{' '}
                  {formatUpdatedAt(fullMeta.updatedAt) ?? '—'}
                </Text>
              </View>
              <View className="cnsr-sheet__x" onClick={() => setFullKey(null)}>
                <Text className="cnsr-sheet__x-t">✕</Text>
              </View>
            </View>
            <View className="cnsr-sheet__bodywrap">
              <ScrollView className="cnsr-sheet__body" scrollY>
                {fullSource ? (
                  <CnsrTree source={fullSource} />
                ) : (
                  <Text className="cn__col-state">载入中…</Text>
                )}
              </ScrollView>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
