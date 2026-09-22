import { Text, View } from '@tarojs/components';

import { useBreakpoint } from '../../hooks/useBreakpoint';

import '../../styles/demo.scss';

/**
 * Chealth — health data.
 *
 * Phase 4 fills this in. Unlike the other three brands this page is NOT served
 * from the static site: GitHub Pages is world-readable even for a private repo,
 * so weight / sleep / heart-rate payloads are gated behind a bearer token at
 * /api/chealth/*.
 *
 * Data path 4a (preferred, zero native code): Health Sync → Google Drive export
 * → pipeline. Samsung Health writes steps to Health Connect as ONE DAILY
 * AGGREGATE with no intraday timestamps, so the page needs a coverage panel that
 * annotates gaps rather than rendering them as zeros.
 */
export default function Chealth() {
  const bp = useBreakpoint();

  return (
    <View className="page">
      <View className="cevtuo-wallpaper" />

      <View className="nav">
        <View className="nav__brand">
          <View className="nav__mark">
            <Text>Z</Text>
          </View>
          <Text className="nav__title">Chealth</Text>
        </View>
        <View className="nav__meta">
          <Text className="nav__stamp">
            {bp.columns} 列 · {bp.width}px
          </Text>
        </View>
      </View>

      <View className="page__head">
        <Text className="page__title">Chealth</Text>
        <Text className="page__sub">健康数据 · 需鉴权</Text>
      </View>

      <View className="grid">
        <View className="block">
          <View className="card">
            <Text className="card__label">PHASE 4</Text>
            <Text className="card__value">待接入</Text>
            <Text className="card__note">
              数据由 Samsung Health · Strava · MyWhoosh · Health Sync · Google
              Health · Health Connect · Galaxy Watch 同步
            </Text>
          </View>
        </View>
      </View>

      <View className="block__spacer" />
    </View>
  );
}
