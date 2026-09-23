import { Text, View } from '@tarojs/components';

import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
import { useBreakpoint } from '../../hooks/useBreakpoint';

import '../../styles/demo.scss';

/**
 * CE-CPAPERR — Kindle reading statistics.
 *
 * ⚠️ Displayed as CPAPERR; the internal key, the route and `data/paperr/` all
 * stay `paperr`. Renaming a route means every shared URL breaks and the data
 * path is pinned by `packages/schema/src/paths.ts` behind a drift guard — a
 * rename that reaches that far is a migration, not a relabel.
 *
 * The plugin now exists: `koreader-plugin/cevtuo-paperr.koplugin/` exports
 * KOReader's own statistics.sqlite3 to a JSON the pipeline consumes. Two paths,
 * as planned:
 *   primary  — the plugin POSTs aggregates when the device joins WiFi
 *   fallback — it also writes a file next to the DB for an SFTP pull
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
      <TopBar title="CE-CPAPERR" />

      <PageStack count={2}>
        <Section
          index={0}
          title="CPAPERR"
          hero={<PageHero brand="CPAPERR" />}
          compact
          lede="Kindle 阅读统计 · 只取 KOReader 自己的 statistics.sqlite3，不碰 Reading Insight"
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
