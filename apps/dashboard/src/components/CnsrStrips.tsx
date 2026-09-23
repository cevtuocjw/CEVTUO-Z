/**
 * CnsrStrips — the four CNSR sources as glass strips, on the home panel.
 *
 * Each strip is one source. It shows one line of that source's notes at a time:
 * the line scrolls across the strip, and every two seconds the strip moves to
 * the next line. The four run independently, so the panel is always in motion
 * without being a carousel the reader has to operate.
 *
 * ⚠️ Decorative, and load-bearing about it. This is the home page's preview of
 * a brand, like the poster strip on the COOF panel — so a failure here must
 * leave the panel intact rather than showing an error on an index page whose
 * job is to offer four doors. Every fetch is `.catch(() => {})`.
 *
 * ⚠️ The strips do NOT reuse the CNSR page's tree. That page renders a whole
 * day's content in place; this renders one line, because at four-up on a cover
 * screen each strip is ~60px tall and a tree in that space would be illegible.
 */

import { useEffect, useState } from 'react';
import { Text, View } from '@tarojs/components';

import { fetchCnsrIndex, fetchCnsrSource, type CnsrSource } from '../platform/data';

import '../styles/strips.scss';

/** How long each line is shown before the strip moves to the next one. */
const DWELL_MS = 2000;
/**
 * Cap on how many lines a strip will cycle.
 *
 * ⚠️ Not a display limit — the strip shows one at a time either way. It bounds
 * how much is held in memory and how long a full cycle takes; without it a
 * source with 40 kept lines would take 80 seconds to come round again, and the
 * reader would never see the rest.
 */
const MAX_CYCLE = 12;

export function CnsrStrips({ onOpen }: { onOpen: () => void }) {
  const [sources, setSources] = useState<CnsrSource[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchCnsrIndex()
      .then((idx) => {
        for (const s of idx.sources) {
          fetchCnsrSource(s.key)
            .then((data) => alive && setSources((prev) => [...prev, data]))
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // ⚠️ One interval for all four strips, not four. They stay in step, which
  // reads as a single instrument rather than four things competing — and it is
  // one timer to tear down instead of four.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), DWELL_MS);
    return () => clearInterval(id);
  }, []);

  if (!sources.length) return null;

  return (
    <View className="strips" onClick={onOpen}>
      {sources.map((s) => {
        // Flatten to displayable lines, skipping the empty days — a strip that
        // blanks for two seconds reads as broken rather than as sparse.
        const lines = s.entries.flatMap((e) => e.lines.map((l) => ({ date: e.date, t: l.t })));
        if (!lines.length) {
          return (
            <View className="strip" key={s.source}>
              <Text className="strip__k">{s.label}</Text>
              <Text className="strip__empty">最近 5 天没有内容</Text>
            </View>
          );
        }
        const cycle = lines.slice(0, MAX_CYCLE);
        const cur = cycle[tick % cycle.length]!;
        return (
          <View className="strip" key={s.source}>
            <View className="strip__head">
              <Text className="strip__k">{s.label}</Text>
              <Text className="strip__d">{cur.date}</Text>
            </View>
            <View className="strip__window">
              {/* ⚠️ Keyed on the line, so React remounts it and the scroll
                  animation restarts. Reusing the node would leave the text
                  swapped in place with the animation already finished — the
                  strip would go still after the first cycle. */}
              <View
                className={`strip__track${cur.t.length > 26 ? '' : ' strip__track--short'}`}
                key={`${tick % cycle.length}-${s.source}`}
              >
                <Text className="strip__text">{cur.t}</Text>
                {/* Duplicated for the seamless loop: the track translates by
                    exactly -50%, so the second copy arrives where the first
                    began. One copy would jump back to the start. */}
                <Text className="strip__text">{cur.t}</Text>
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}
