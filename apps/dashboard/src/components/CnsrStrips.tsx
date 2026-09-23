/**
 * CnsrStrips — the four CNSR sources as glass strips, on the home panel.
 *
 * Each strip is one source and shows one line of it at a time. A line that is
 * too wide for the strip scrolls across ONCE at a fixed, readable speed; the
 * strip then moves on to the next line. A line that fits does not move at all.
 *
 * ⚠️ The scroll and the advance are COUPLED — the strip waits for the scroll to
 * finish before changing lines.
 *
 * The first version ran the scroll as a 2-second marquee and swapped lines on a
 * separate 2-second timer, which forced every line through a full width in two
 * seconds regardless of how long it was. The user's report was exact: the
 * advance speed was fine, but the scroll was far too fast to read, because it
 * was being squeezed to fit the advance.
 *
 * ⚠️ Decorative, and load-bearing about it — a failure here must leave the home
 * panel intact rather than showing an error on an index page whose job is to
 * offer four doors. Every fetch is `.catch(() => {})`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';

import { fetchCnsrIndex, fetchCnsrSource, type CnsrSource } from '../platform/data';

import '../styles/strips.scss';

/**
 * Scroll speed, in pixels per second — CONSTANT for every line.
 *
 * ⚠️ Uniform on purpose. Sizing the duration to a fixed dwell makes a long line
 * race and a short one crawl; a fixed speed makes every line equally readable,
 * and the dwell becomes the thing that varies instead.
 */
const PX_PER_SEC = 45;

/** Minimum time a line stays up, even when it fits and never moves. */
const MIN_DWELL_MS = 2000;
/** Beat between a scroll finishing and the next line arriving. */
const SETTLE_MS = 900;

/** Cap on how many lines a strip cycles, so a full loop stays a reasonable wait. */
const MAX_CYCLE = 12;

function Strip({ source }: { source: CnsrSource }) {
  const lines = useMemo(
    () => source.entries.flatMap((e) => e.lines.map((l) => ({ date: e.date, t: l.t }))).slice(0, MAX_CYCLE),
    [source],
  );

  const [i, setI] = useState(0);
  const boxRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLElement | null>(null);
  const [shift, setShift] = useState(0);
  const [dur, setDur] = useState(0);

  // ⚠️ Measure and schedule in ONE effect, keyed on the line.
  //
  // The widths are not known until after paint, so the scroll cannot be
  // expressed in CSS alone — and the timer must not be set before the duration
  // is known, or it would fire on a stale value. Doing both here is what keeps
  // the two in step.
  useEffect(() => {
    const box = boxRef.current as unknown as HTMLElement | null;
    const txt = textRef.current as unknown as HTMLElement | null;
    if (!box || !txt || !lines.length) return undefined;

    const overflow = Math.max(0, txt.scrollWidth - box.clientWidth);
    const scrollMs = overflow ? Math.round((overflow / PX_PER_SEC) * 1000) : 0;
    setShift(overflow);
    setDur(scrollMs);

    const id = setTimeout(() => setI((v) => v + 1), Math.max(MIN_DWELL_MS, scrollMs + SETTLE_MS));
    return () => clearTimeout(id);
  }, [i, lines]);

  const cur = lines[i % Math.max(1, lines.length)];

  if (!lines.length) {
    return (
      <View className="strip">
        <View className="strip__head">
          <Text className="strip__k">{source.label}</Text>
        </View>
        <Text className="strip__empty">最近 5 天没有内容</Text>
      </View>
    );
  }

  return (
    <View className="strip">
      <View className="strip__head">
        <Text className="strip__k">{source.label}</Text>
        <Text className="strip__d">{cur!.date}</Text>
      </View>

      <View className="strip__window" ref={boxRef as never}>
        {/* ⚠️ Keyed on the index. The node must REMOUNT at translateX(0) and
            then transition, or React would carry the previous line's offset
            into the new one and the scroll would start mid-way. One copy of the
            text — the earlier version duplicated it for a seamless marquee,
            which is exactly the "same line written many times" the user
            objected to. */}
        <Text
          className="strip__text"
          key={i}
          ref={textRef as never}
          style={shift ? { transform: `translateX(${-shift}px)`, transitionDuration: `${dur}ms` } : undefined}
        >
          {cur!.t}
        </Text>
      </View>
    </View>
  );
}

export function CnsrStrips({ onOpen }: { onOpen: () => void }) {
  const [sources, setSources] = useState<CnsrSource[]>([]);

  useEffect(() => {
    let alive = true;
    fetchCnsrIndex()
      .then((idx) => {
        for (const s of idx.sources) {
          fetchCnsrSource(s.key)
            .then((data) => {
              if (!alive) return;
              // ⚠️ In INDEX order, not arrival order. These payloads race, and
              // pushing on arrival makes the four strips reorder themselves
              // whenever the network is uneven — the labels would be in a
              // different place on every load.
              setSources((prev) => {
                const next = [...prev.filter((p) => p.source !== data.source), data];
                return next.sort(
                  (a, b) => idx.sources.findIndex((x) => x.key === a.source) - idx.sources.findIndex((x) => x.key === b.source),
                );
              });
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!sources.length) return null;

  return (
    <View className="strips" onClick={onOpen}>
      {sources.map((s) => (
        <Strip source={s} key={s.source} />
      ))}
    </View>
  );
}
