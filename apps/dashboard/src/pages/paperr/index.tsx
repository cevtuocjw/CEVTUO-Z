import { Text, View } from '@tarojs/components';

import { useBreakpoint } from '../../hooks/useBreakpoint';

import '../../styles/demo.scss';

/**
 * CE-PaperR — Kindle reading statistics.
 *
 * Phase 3 fills this in. Data comes from KOReader's own statistics.sqlite3 on the
 * Kindle, reached two ways:
 *   primary  — a KOReader plugin POSTs aggregates when the device joins WiFi
 *   fallback — a macOS LaunchAgent pulls the DB over SFTP on port 2222
 *
 * ⚠️ Only aggregates cross the wire. The stats DB is WAL-mode, so copying just
 * the main file can read stale data — keeping the DB on the device sidesteps
 * that entirely.
 */
export default function Paperr() {
  const bp = useBreakpoint();

  return (
    <View className="page">
      <View className="cevtuo-wallpaper" />

      <View className="nav">
        <View className="nav__brand">
          <View className="nav__mark">
            <Text>Z</Text>
          </View>
          <Text className="nav__title">CE-PaperR</Text>
        </View>
        <View className="nav__meta">
          <Text className="nav__stamp">
            {bp.columns} 列 · {bp.width}px
          </Text>
        </View>
      </View>

      <View className="page__head">
        <Text className="page__title">CE-PaperR</Text>
        <Text className="page__sub">Kindle 阅读统计 · KOReader</Text>
      </View>

      <View className="grid">
        <View className="block">
          <View className="card">
            <Text className="card__label">PHASE 3</Text>
            <Text className="card__value">待接入</Text>
            <Text className="card__note">
              两条独立路径互为备份，只依赖 KOReader 自己的统计库，不碰 Reading
              Insight —— 它怎么更新都不影响。
            </Text>
          </View>
        </View>
      </View>

      <View className="block__spacer" />
    </View>
  );
}
