import { Text, View } from '@tarojs/components';

import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
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
 *
 * ⚠️ The counts below are the placeholder figures this page has always carried,
 * not measurements — there is no pipeline for this brand yet.
 */
export default function Cnsr() {
  const bp = useBreakpoint();

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CNSR" />

      <PageStack count={2}>
        <Section
          index={0}
          title="CNSR"
          hero={<PageHero brand="CNSR" />}
          compact
          lede="笔记与摘录。按 @date 归档，四个 Notion 来源汇聚到一处，最新的排在最前。"
          stats={[
            { value: '1,024', label: '总条目', note: '条 · 4 个来源' },
            { value: '180', label: '单条摘要', note: '字 · 上限' },
          ]}
        />

        <Section
          index={1}
          title="来源"
          lede="四个来源各自独立归档，合并后按日期倒序。"
          stats={[
            { value: '45', label: 'Learn', note: '块' },
            { value: '20', label: 'tech-learn', note: '块 · 23.8.22 起' },
            { value: '30', label: 'TECH AI', note: '块' },
            { value: '100+', label: 'Shopping', note: '块' },
          ]}
          showCue={false}
        >
          <View className="card">
            <Text className="card__label">PHASE 2 · 待接入</Text>
            <Text className="card__label">{bp.columns} 列</Text>
          </View>
        </Section>
      </PageStack>
    </View>
  );
}
