import { Text, View } from '@tarojs/components';

import { useBreakpoint } from '../../hooks/useBreakpoint';

import '../../styles/demo.scss';

/**
 * CNSR — notes and clippings.
 *
 * Phase 2 fills this in: the most recent @date entries from each of
 * Learn / tech-learn 23.8.22-now / TECH AI / Shopping, newest first, tap → sheet.
 *
 * Notion structure confirmed: the content unit is a `toggle` block whose text is
 * a date (e.g. "2025-11-18"), sometimes nested under `heading_1` range headers.
 */
export default function Cnsr() {
  const bp = useBreakpoint();

  return (
    <View className="page">
      <View className="cevtuo-wallpaper" />

      <View className="nav">
        <View className="nav__brand">
          <View className="nav__mark">
            <Text>Z</Text>
          </View>
          <Text className="nav__title">CNSR</Text>
        </View>
        <View className="nav__meta">
          <Text className="nav__stamp">
            {bp.columns} 列 · {bp.width}px
          </Text>
        </View>
      </View>

      <View className="page__head">
        <Text className="page__title">CNSR</Text>
        <Text className="page__sub">笔记与摘录 · 4 个 Notion 来源</Text>
      </View>

      <View className="grid">
        <View className="block">
          <View className="card">
            <Text className="card__label">PHASE 2</Text>
            <Text className="card__value">待接入</Text>
            <Text className="card__note">
              Learn (45 块) · tech-learn 23.8.22-now (20 块) · TECH AI (30 块) ·
              Shopping (100+ 块)
            </Text>
          </View>
        </View>
      </View>

      <View className="block__spacer" />
    </View>
  );
}
