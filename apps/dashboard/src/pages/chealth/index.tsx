import { Text, View } from '@tarojs/components';

import { PageHero, PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { homePanelUrl } from '../../platform/panels';
import { Wallpaper } from '../../components/Wallpaper';
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
 *
 * ⚠️ The figures below are placeholders, not readings, and this page is the one
 * where that matters most: a wrong step count looks like a data bug, not a
 * missing feature. Nothing here is wired to a source yet.
 */
export default function Chealth() {
  const bp = useBreakpoint();

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CHEALTH" backTo={homePanelUrl('chealth')} />

      <PageStack count={2}>
        <Section
          index={0}
          title="CHEALTH"
          hero={<PageHero brand="CHEALTH" />}
          compact
          lede="健康数据。不进入公开仓库 —— GitHub Pages 即使私有仓库也是公网可读，所以这类数据走鉴权接口。"
          // ⚠️ Dashes, and this file's OWN header already argues why.
          //
          // It says health data is "where that matters most: a wrong step count
          // looks like a data bug, not a missing feature. Nothing here is wired
          // to a source yet." — and then rendered 8,412 steps and 7h12 of sleep
          // anyway. The comment was right and the code did the opposite of what
          // it said, which is the failure a comment cannot catch.
          //
          // ⚠️ A fabricated number here is worse than on any other page: a wrong
          // step count is indistinguishable from a real one, so it sends the
          // reader looking for a bug in a pipeline that does not exist yet.
          stats={[
            { value: '—', label: '今日步数', note: '' },
            { value: '—', label: '昨夜睡眠', note: '' },
          ]}
        />

        <Section
          index={1}
          title="来源"
          lede="多个来源合并，按天聚合。Samsung Health 只写每日汇总，没有日内时间戳，所以缺口要标注而不是渲染成零。"
          // ⚠️ "7 个数据源" was a count of something nobody has connected —
          // a claim with no source at all, on the panel whose whole subject is
          // where the numbers come from.
          stats={[
            { value: '—', label: '数据源', note: '个' },
            { value: '鉴权', label: '访问方式', note: 'Bearer token' },
          ]}
          showCue={false}
        >
          <View className="card">
            <Text className="card__label">PHASE 4 · 待接入</Text>
            <Text className="card__label">{bp.columns} 列</Text>
          </View>
        </Section>
      </PageStack>
    </View>
  );
}
