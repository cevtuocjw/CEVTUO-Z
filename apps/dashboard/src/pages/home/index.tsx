import { useEffect, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
import {
  assetUrl,
  fetchCoofIndex,
  fetchSyncMeta,
  formatUpdatedAt,
  type CoofTitle,
} from '../../platform/data';

import '../../styles/demo.scss';

/**
 * Home — the index of the four brands.
 *
 * ⚠️ One panel per brand, each filling the viewport. This replaced a grid of
 * four small cards. The cards were the wrong unit: at four-up on the cover
 * screen each had ~150px of width, which is not enough to show a number and its
 * label without shrinking the type below the size the design depends on. A
 * panel per capability gives each one the full screen and makes the page a
 * sequence you move through rather than a dashboard you squint at.
 *
 * ⚠️ The numbers below are still placeholders. COOF is the only brand with a
 * real pipeline; the other three have no data source yet, and the counts here
 * are the same invented ones this page has always shown. They are visibly
 * labelled as such on COOF (which opens) and are inert elsewhere.
 */

interface BrandPanel {
  key: string;
  /** Panel title, set vertically in the margin. Short — it must not wrap. */
  title: string;
  lede: string;
  stats: { value: string; label: string; note?: string }[];
  /** Route to open on tap, or null while the brand is still a shell. */
  route: string | null;
}

const PANELS: BrandPanel[] = [
  {
    key: 'coof',
    title: 'COOF',
    lede: "CEVTUO's 观影记录",
    // ⚠️ Placeholders replaced at render time by the live counts (see `stats`).
    stats: [
      { value: '—', label: '个年历', note: '2020–2026' },
      { value: '—', label: '条记录', note: '全部年历' },
    ],
    route: '/pages/coof/index',
  },
  {
    key: 'cnsr',
    title: 'CNSR',
    lede: '笔记与摘录。按 @date 归档，四个来源汇聚到一处。',
    stats: [
      { value: '1,024', label: '总条目', note: '条 · 4 个来源' },
      { value: '180', label: '单条摘要', note: '字 · 上限' },
    ],
    route: null,
  },
  {
    key: 'paperr',
    title: 'PAPERR',
    lede: 'Kindle 阅读。阅读时长、在读书目与划线，从设备同步。',
    stats: [
      { value: '36h', label: '本月', note: '在读 3 本' },
      { value: '12', label: '已读完', note: '本 · 本年度' },
    ],
    route: null,
  },
  {
    key: 'chealth',
    title: 'CHEALTH',
    lede: '健康数据。步数、心率与睡眠，不进入公开仓库，走鉴权接口。',
    stats: [
      { value: '8,412', label: '今日步数', note: '步' },
      { value: '7h12', label: '昨夜睡眠', note: '时 · 分' },
    ],
    route: null,
  },
];

export default function Home() {
  // ⚠️ Only COOF has a pipeline, so only COOF gets a preview strip. The strip is
  // decoration and must never be load-blocking: a failure here leaves the panel
  // exactly as it was before, rather than showing an error on an index page
  // whose job is to offer four doors.
  const [recent, setRecent] = useState<CoofTitle[]>([]);
  const [totals, setTotals] = useState<{ years: number; items: number } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchCoofIndex('COOF2026')
      .then((idx) => {
        if (!alive) return;
        setRecent(idx.recent.filter((t) => t.poster).slice(0, 10));
        setTotals({
          years: idx.collections.length,
          // ⚠️ The count of the WHOLE archive, not this calendar's — summed
          // from the per-collection counts the index already carries, so no
          // extra request and no chance of disagreeing with the COOF page.
          items: idx.collections.reduce((n, c) => n + c.count, 0),
        });
      })
      .catch(() => {});
    fetchSyncMeta()
      .then((m) => alive && setUpdatedAt(formatUpdatedAt(m.generatedAt)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const open = (route: string | null, title: string) => {
    // ⚠️ The other three brands have no page content yet. Rather than navigate
    // into a blank route — which reads as a crash — say so and stay put.
    if (!route) {
      Taro.showToast({ title: `${title} 尚未接入`, icon: 'none' });
      return;
    }
    Taro.navigateTo({ url: route });
  };

  return (
    <View className="page">
      <Wallpaper />
      <TopBar title="CEVTUO-Z" />

      <PageStack count={PANELS.length}>
        {PANELS.map((p, i) => (
          <Section
            key={p.key}
            index={i}
            title={p.title}
            lede={p.lede}
            // ⚠️ Live numbers for COOF, the still-invented placeholders for the
            // three brands with no pipeline. Showing a hardcoded "1209" beside a
            // live one is how a page starts lying after the next sync.
            stats={
              p.key === 'coof' && totals
                ? [
                    { value: `${totals.years}`, label: '个年历', note: '2020–2026' },
                    { value: `${totals.items}`, label: '条记录', note: '全部年历' },
                  ]
                : p.stats
            }
            updatedAt={p.key === 'coof' ? updatedAt : null}
            // The last panel gets no chevron: there is nothing below it, and a
            // cue there promises content that does not exist.
            showCue={i < PANELS.length - 1}
            // ⚠️ The handler belongs HERE, on the whole panel body — not on the
            // `card` below. Tapping the numbers, their labels, or the empty space
            // beside them all mean "open this brand" to the person doing it, and
            // a 10px label with a hairline rule is a target you have to aim at.
            // The card stays as the visible affordance; it no longer owns the tap.
            onPress={() => open(p.route, p.title)}
          >
            {p.key === 'coof' && recent.length ? (
              <ScrollView className="recent__scroll" scrollX showScrollbar={false}>
                <View className="recent__row">
                  {recent.map((t) => (
                    <View
                      key={t.id}
                      className="recent__item"
                      onClick={() => open(p.route, p.title)}
                    >
                      <Image
                        className="recent__img"
                        src={assetUrl(t.poster as string)}
                        mode="aspectFill"
                        lazyLoad
                      />
                      <Text className="recent__title">{t.title}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}

            <View className="card">
              <Text className="card__label">{p.route ? '打开' : '尚未接入'}</Text>
              <Text className="card__label">{p.route ? '→' : '—'}</Text>
            </View>
          </Section>
        ))}
      </PageStack>
    </View>
  );
}
