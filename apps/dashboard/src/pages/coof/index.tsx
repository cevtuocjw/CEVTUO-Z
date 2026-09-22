import { Text, View } from '@tarojs/components';

import { useBreakpoint } from '../../hooks/useBreakpoint';

import '../../styles/demo.scss';

/**
 * COOF — movie records.
 *
 * Phase 1 fills this in: a collections switcher (COOF2026 / COOF2025 / …) in the
 * top-left, a newest-first list with the poster on the left, and a detail sheet
 * on tap.
 *
 * Notion structure confirmed against the live API: the COOF2026 database has
 * NAME(title) / NUM / Date / YEAR / FILM / time / COUNTRY / KIND / POSTER / OTHER.
 */
export default function Coof() {
  const bp = useBreakpoint();

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
            {bp.columns} 列 · {bp.width}px
          </Text>
        </View>
      </View>

      <View className="page__head">
        <Text className="page__title">COOF</Text>
        <Text className="page__sub">电影记录 · Notion 同步</Text>
      </View>

      <View className="grid">
        <View className="block">
          <View className="card">
            <Text className="card__label">PHASE 1</Text>
            <Text className="card__value">待接入</Text>
            <Text className="card__note">
              COOF2026 库字段已确认：NAME / NUM / Date / YEAR / FILM / time /
              COUNTRY / KIND / POSTER / OTHER
            </Text>
          </View>
        </View>
      </View>

      <View className="block__spacer" />
    </View>
  );
}
