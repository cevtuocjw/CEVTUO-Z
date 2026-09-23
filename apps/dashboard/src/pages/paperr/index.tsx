import { Text, View } from '@tarojs/components';

import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
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
 *
 * ⚠️ The figures below are placeholders. There is no pipeline for this brand
 * yet; they are the same invented numbers the old card carried.
 */
export default function Paperr() {
  const bp = useBreakpoint();

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CE-PAPERR" />

      <PageStack count={2}>
        <Section
          index={0}
          title="PAPERR"
          hero={<PageHero brand="PAPERR" />}
          compact
          lede="Kindle 阅读统计。只取 KOReader 自己的统计库，不碰 Reading Insight —— 它怎么更新都不影响。"
          stats={[
            { value: '36h', label: '本月', note: '在读 3 本' },
            { value: '12', label: '已读完', note: '本 · 本年度' },
          ]}
        />

        <Section
          index={1}
          title="同步"
          lede="两条独立路径互为备份：设备联网时由插件推送，否则由本机定时拉取。"
          stats={[
            { value: 'WiFi', label: '主路径', note: '插件主动上报' },
            { value: '2222', label: '备路径', note: 'SFTP 端口' },
          ]}
          showCue={false}
        >
          <View className="card">
            <Text className="card__label">PHASE 3 · 待接入</Text>
            <Text className="card__label">{bp.columns} 列</Text>
          </View>
        </Section>
      </PageStack>
    </View>
  );
}
