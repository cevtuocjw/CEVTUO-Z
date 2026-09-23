/**
 * The non-grid views of a calendar: timeline and month calendar.
 *
 * ⚠️ Why these exist at all. The poster grid answers "what did I watch" and
 * nothing else — 236 tiles for COOF2022 is a wall with no shape to it, and the
 * only way to find a date is to scroll and read every caption. The two views
 * here answer the questions the grid cannot:
 *
 *   · timeline — "what was I watching in March", in order, with the dates on
 *     screen rather than implied by the sort.
 *   · calendar — "which days did I watch something", as a shape you can see at
 *     a glance, including the gaps.
 *
 * ⚠️ Both are driven by `watchedAt`, which is nullable. Rows without a date
 * cannot be placed on either axis, so they are counted and REPORTED rather than
 * dropped silently — a view that quietly shows 210 of 236 films is worse than
 * one that says it is showing 210.
 */

import { useMemo, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';

import { assetUrl, type CoofTitle } from '../../platform/data';

/** "2025-03" → "2025 年 3 月" */
function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${y} 年 ${Number(m)} 月`;
}

/** "2025-03-14" → "14" */
function dayOf(iso: string): string {
  return String(Number(iso.slice(8, 10)));
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export interface MonthBucket {
  key: string;
  items: CoofTitle[];
}

/** Films grouped by month, newest month first, undated ones excluded. */
export function bucketByMonth(titles: CoofTitle[]): { months: MonthBucket[]; undated: number } {
  const map = new Map<string, CoofTitle[]>();
  let undated = 0;
  for (const t of titles) {
    if (!t.watchedAt) {
      undated++;
      continue;
    }
    const key = t.watchedAt.slice(0, 7);
    const bucket = map.get(key);
    if (bucket) bucket.push(t);
    else map.set(key, [t]);
  }
  for (const items of map.values()) {
    // Newest first inside the month too — the pipeline sorts by sequence
    // number, which is not the same order as the dates.
    items.sort((a, b) => (b.watchedAt ?? '').localeCompare(a.watchedAt ?? ''));
  }
  return { months: [...map.entries()].map(([key, items]) => ({ key, items })).sort((a, b) => b.key.localeCompare(a.key)), undated };
}

interface ViewProps {
  titles: CoofTitle[];
  onOpen: (t: CoofTitle) => void;
}

// ─────────────────────────────────────────────────────────────

export function TimelineView({ titles, onOpen }: ViewProps) {
  const { months, undated } = useMemo(() => bucketByMonth(titles), [titles]);

  return (
    <View className="tl">
      {undated > 0 ? (
        <Text className="tl__gap">
          另有 {undated} 条没有观看日期，无法排在时间线上
        </Text>
      ) : null}

      {months.map((m) => (
        <View className="tl__month" key={m.key}>
          <View className="tl__head">
            <Text className="tl__month-label">{monthLabel(m.key)}</Text>
            <Text className="tl__count">{m.items.length}</Text>
          </View>

          {m.items.map((t) => (
            <View className="tl__row" key={t.id} onClick={() => onOpen(t)}>
              {t.poster ? (
                <Image className="tl__thumb" src={assetUrl(t.poster)} mode="aspectFill" lazyLoad />
              ) : (
                <View className="tl__thumb tl__thumb--empty">
                  <Text className="tl__thumb-letter">{t.title.slice(0, 1)}</Text>
                </View>
              )}
              <View className="tl__text">
                <Text className="tl__title">{t.title}</Text>
                <Text className="tl__meta">
                  {[t.watchedAt, t.year, t.genres[0]].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Text className="tl__day">{dayOf(t.watchedAt as string)}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────

export function CalendarView({ titles, onOpen }: ViewProps) {
  const { months, undated } = useMemo(() => bucketByMonth(titles), [titles]);
  /** The day whose films are open in the sheet, if any. */
  const [day, setDay] = useState<{ iso: string; films: CoofTitle[] } | null>(null);

  return (
    <View className="cal2">
      {undated > 0 ? (
        <Text className="tl__gap">另有 {undated} 条没有观看日期，不在月历上</Text>
      ) : null}

      {months.map((m) => {
        const byDay = new Map<string, CoofTitle[]>();
        for (const t of m.items) {
          const d = t.watchedAt as string;
          const list = byDay.get(d);
          if (list) list.push(t);
          else byDay.set(d, [t]);
        }

        const [yy, mm] = m.key.split('-').map(Number);
        // ⚠️ `new Date(y, m, 0).getDate()` — day 0 of the NEXT month is the last
        // day of this one, which handles February and leap years without a table.
        const daysInMonth = new Date(yy as number, mm as number, 0).getDate();
        // getDay() is 0=Sunday; the grid starts on Monday.
        const firstWeekday = (new Date(yy as number, (mm as number) - 1, 1).getDay() + 6) % 7;

        const cells: Array<string | null> = [
          ...Array.from({ length: firstWeekday }, () => null),
          ...Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, '0')),
        ];

        return (
          <View className="cal2__month" key={m.key}>
            <View className="tl__head">
              <Text className="tl__month-label">{monthLabel(m.key)}</Text>
              <Text className="tl__count">{m.items.length}</Text>
            </View>

            <View className="cal2__weekdays">
              {WEEKDAYS.map((w) => (
                <Text className="cal2__weekday" key={w}>
                  {w}
                </Text>
              ))}
            </View>

            <View className="cal2__grid">
              {cells.map((d, i) => {
                if (!d) return <View className="cal2__cell cal2__cell--void" key={`v${i}`} />;
                const iso = `${m.key}-${d}`;
                const films = byDay.get(iso);
                return (
                  <View
                    className={`cal2__cell${films ? ' cal2__cell--on' : ''}`}
                    key={iso}
                    onClick={() => films && setDay({ iso, films })}
                  >
                    {/* ⚠️ A thumbnail ONLY at wide viewports. A cell is 1/7 of the
                        panel: ~48px on a phone, where a poster is an unreadable
                        smudge, and ~180px on a laptop, where it is recognisable.
                        Same markup, two treatments — see `.cal2__thumb`. */}
                    {films && (films[0] as CoofTitle).poster ? (
                      <Image
                        className="cal2__thumb"
                        src={assetUrl((films[0] as CoofTitle).poster as string)}
                        mode="aspectFill"
                        lazyLoad
                      />
                    ) : null}
                    <Text className="cal2__day">{Number(d)}</Text>
                    {films && films.length > 1 ? (
                      <Text className="cal2__multi">{films.length}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}

      {/* ⚠️ A sheet, not an inline expansion. Expanding inside the month would
          shift every grid below it, so the thing you tapped moves — and on a
          phone the day cells are 48px, far too small to grow a list into. */}
      {day ? (
        <View className="daysheet" onClick={() => setDay(null)}>
          <View className="daysheet__panel" onClick={(e) => e.stopPropagation()}>
            <Text className="daysheet__head">
              {day.iso} · {day.films.length} 部
            </Text>
            <ScrollView className="daysheet__scroll" scrollX showScrollbar={false}>
              <View className="daysheet__row">
                {day.films.map((t) => (
                  <View
                    className="daysheet__item"
                    key={t.id}
                    onClick={() => {
                      setDay(null);
                      onOpen(t);
                    }}
                  >
                    {t.poster ? (
                      <Image
                        className="daysheet__img"
                        src={assetUrl(t.poster)}
                        mode="aspectFill"
                        lazyLoad
                      />
                    ) : (
                      <View className="daysheet__img daysheet__img--empty" />
                    )}
                    <Text className="daysheet__title">{t.title}</Text>
                  </View>
                ))}
              </View>
            </ScrollView>
            <View className="daysheet__close" onClick={() => setDay(null)}>
              <Text>关闭</Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
