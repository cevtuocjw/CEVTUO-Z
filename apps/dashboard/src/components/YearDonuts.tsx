/**
 * YearDonuts — the breakdown behind a tap on a year chip.
 *
 * Two rings: what the year was made of (genres) and where it came from
 * (countries), each with a legend that carries the numbers. Selecting a slice —
 * by tapping the ring to step through them, or tapping a legend row — moves a
 * highlight wedge onto it and rewrites the readout in the hole.
 *
 * ⚠️ Selection is exposed as *sequential advance* on the ring rather than by
 * hit-testing the angle under the finger. Two reasons, both practical: the
 * slices are a few degrees wide at the tail, which is not a thumb target; and
 * the person using this is usually reading the legend, where the eye already
 * is. Stepping is also the only mode that works identically with a mouse, a
 * finger and a keyboard.
 *
 * ⚠️ H5-only for the same reason as `MonthlyWave` — see the note there.
 */

import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';

import type { CoofTitle } from '../platform/data';

import '../styles/donut.scss';

/** Ring shows this many slices; everything past it is folded into 其他. */
const TOP = 6;

interface Slice {
  name: string;
  count: number;
}

/**
 * Count occurrences of each value in a multi-value column, largest first.
 *
 * ⚠️ Counts are of FILMS, not of labels, so the slices sum to more than the
 * number of rows — a film tagged 剧情 and 犯罪 is counted in both. The share
 * shown on each slice is therefore "of all label occurrences", which is what
 * the legend's own figures add up to. Saying so is cheaper than a reader
 * discovering that the percentages total 240%.
 */
function tally(titles: CoofTitle[], key: 'genres' | 'country'): Slice[] {
  const seen = new Map<string, number>();
  for (const t of titles) {
    for (const v of t[key] ?? []) {
      if (!v) continue;
      seen.set(v, (seen.get(v) ?? 0) + 1);
    }
  }

  const all = [...seen.entries()]
    .map(([name, count]) => ({ name, count }))
    // ⚠️ Ties broken by name, not left to Map order. Two labels with the same
    // count would otherwise swap places between runs, and the ring would
    // reshuffle for no reason a reader could see.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (all.length <= TOP + 1) return all;
  const head = all.slice(0, TOP);
  head.push({ name: '其他', count: all.slice(TOP).reduce((n, s) => n + s.count, 0) });
  return head;
}

function DonutBlock({ label, items }: { label: string; items: Slice[] }) {
  const [sel, setSel] = useState(0);

  const total = items.reduce((n, s) => n + s.count, 0) || 1;

  // Cumulative angles, in degrees clockwise from 12 o'clock.
  const spans = useMemo(() => {
    let acc = 0;
    return items.map((s) => {
      const start = acc;
      acc += (s.count / total) * 360;
      return { start, span: (s.count / total) * 360 };
    });
  }, [items, total]);

  // ⚠️ Clamped. Switching calendars swaps `items` under a selection index that
  // was valid for the previous one; without this, COOF2022 (7 slices) → a year
  // whose 其他 is absent (6) indexes past the end and the ring renders blank.
  const idx = Math.min(Math.max(0, sel), Math.max(0, items.length - 1));
  const cur = items[idx];
  const span = spans[idx];

  // ⚠️ After the hooks, never before. A year whose rows carry no genre labels at
  // all produces an empty list, and bailing out ahead of `useState`/`useMemo`
  // would change the hook count between renders.
  if (!cur || !span) return null;

  const ring = spans
    .map((sp, i) => `var(--chart-${i + 1}) ${sp.start.toFixed(2)}deg ${(sp.start + sp.span).toFixed(2)}deg`)
    .join(', ');

  const hlSpan = span.span.toFixed(2);

  return (
    <View className="dnb">
      <Text className="dnb__label">{label}</Text>

      <View className="dnb__row">
        <View className="dnb__tap" onClick={() => setSel((s) => (s + 1) % items.length)}>
          {/* ⚠️ Keyed on the data, so the assemble animation replays when the
              calendar changes rather than the ring silently swapping colours. */}
          <View
            className="dnb__ring"
            key={`${label}-${items.length}`}
            style={{ backgroundImage: `conic-gradient(from -90deg, ${ring})` }}
          >
            <View
              className="dnb__hl"
              style={{
                backgroundImage: `conic-gradient(from -90deg, var(--accent) 0deg ${hlSpan}deg, rgba(0, 0, 0, 0) ${hlSpan}deg 360deg)`,
                transform: `rotate(${span.start.toFixed(2)}deg)`,
              }}
            />
          </View>

          {/* Keyed on the index so the readout re-animates on every step. */}
          <View className="dnb__center" key={idx}>
            <Text className="dnb__count">{cur.count}</Text>
            <Text className="dnb__name">{cur.name}</Text>
            <Text className="dnb__pct">{Math.round((cur.count / total) * 100)}%</Text>
          </View>
        </View>

        <View className="dnb__legend">
          {items.map((s, i) => (
            <View
              key={s.name}
              className={`dnb__leg${i === idx ? ' dnb__leg--on' : ''}`}
              onClick={() => setSel(i)}
            >
              <View className="dnb__swatch" style={{ backgroundColor: `var(--chart-${i + 1})` }} />
              <Text className="dnb__legname">{s.name}</Text>
              <Text className="dnb__legcount">{s.count}</Text>
            </View>
          ))}
        </View>
      </View>

      <Text className="dnb__hint">点圆环依次查看每一类 · 份额按标签出现次数计</Text>
    </View>
  );
}

export interface YearDonutsProps {
  /** The calendar being broken down, e.g. "COOF2026". */
  year: string;
  titles: CoofTitle[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  /** Jump to this year's list, further down the page. */
  onJump: () => void;
}

export function YearDonuts({ year, titles, loading, error, onClose, onJump }: YearDonutsProps) {
  const genres = useMemo(() => tally(titles, 'genres'), [titles]);
  const countries = useMemo(() => tally(titles, 'country'), [titles]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <View className="ysheet" onClick={onClose}>
      <View className="ysheet__panel" onClick={(e) => e.stopPropagation()}>
        <View className="ysheet__head">
          <Text className="ysheet__title">{year}</Text>
          <Text className="ysheet__sub">这一年看了什么</Text>
        </View>

        {loading && !titles.length ? (
          <Text className="ysheet__state">载入中…</Text>
        ) : error ? (
          <Text className="ysheet__state">{error}</Text>
        ) : !titles.length ? (
          <Text className="ysheet__state">这一年还没有记录</Text>
        ) : (
          <ScrollView className="ysheet__body" scrollY>
            <View className="ysheet__grid">
              <DonutBlock label="类型" items={genres} />
              <DonutBlock label="国家与地区" items={countries} />
            </View>
          </ScrollView>
        )}

        <View className="ysheet__go" onClick={onJump}>
          <Text className="ysheet__go-t">查看 {year}</Text>
          <Text className="ysheet__go-a">↓</Text>
        </View>
      </View>
    </View>
  );
}
