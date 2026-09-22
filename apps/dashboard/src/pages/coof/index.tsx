/**
 * COOF — movie records.
 *
 * Reads the committed pipeline output (`data/coof/<collection>/{index,library}.json`)
 * and renders: a calendar switcher, a poster grid, and a detail sheet.
 *
 * ⚠️ Posters are the reason this page needs the network at all. The pipeline
 * re-hosts them because Notion's own S3 URLs expire in ~1h (see HANDOFF); paths
 * are origin-relative and resolved in `platform/data.ts`.
 *
 * ⚠️ `Image` uses `mode="aspectFill"` — posters have mixed aspect ratios and
 * `aspectFit` would letterbox them into inconsistent heights, which breaks the
 * grid rhythm on the unfolded screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';

import {
  assetUrl,
  calendarKeys,
  fetchCoofIndex,
  fetchCoofLibrary,
  formatRuntime,
  type CoofIndex,
  type CoofTitle,
} from '../../platform/data';
import { useBreakpoint } from '../../hooks/useBreakpoint';

import './index.scss';

export default function Coof() {
  const bp = useBreakpoint();
  const [collection, setCollection] = useState<string>('');
  const [index, setIndex] = useState<CoofIndex | null>(null);
  const [titles, setTitles] = useState<CoofTitle[]>([]);
  const [detail, setDetail] = useState<CoofTitle | null>(null);
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

  const onSelect = useCallback((key: string) => setCollection(key), []);

  return (
    <View className="page">
      <View className="cevtuo-wallpaper" />

      <View className="nav">
        <View className="nav__brand">
          <View className="nav__mark">
            <Text>Z</Text>
          </View>
          <Text className="nav__title">COOF</Text>
        </View>
        <View className="nav__meta">
          <Text className="nav__stamp">
            {titles.length ? `${titles.length} 部` : '—'} · {bp.columns} 列
          </Text>
        </View>
      </View>

      {/* Calendar switcher. Horizontally scrollable because seven calendars
          overflow the Fold's cover screen at ~361dp. */}
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
        <View className="grid">
          {titles.map((t) => (
            <View key={t.id} className="tile" onClick={() => setDetail(t)}>
              <View className="tile__art">
                {t.poster ? (
                  <Image className="tile__img" src={assetUrl(t.poster)} mode="aspectFill" lazyLoad />
                ) : (
                  // ⚠️ 856 rows predate the POSTER field entirely, so a missing
                  // poster is expected data, not a failure. Show a placeholder
                  // rather than hiding the tile — the title still matters.
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
      )}

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
