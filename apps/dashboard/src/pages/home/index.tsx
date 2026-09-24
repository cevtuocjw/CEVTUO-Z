import { useEffect, useState } from 'react';
import { Image, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { PageStack, Section } from '../../components/Section';
import { TopBar } from '../../components/TopBar';
import { Wallpaper } from '../../components/Wallpaper';
import { CnsrStrips } from '../../components/CnsrStrips';
// ⚠️ The CAPPERR block on this page draws two real charts. These two imports
// were MISSING when that block was written — the page threw
// `ReferenceError: CompositionDonut is not defined` the moment the fetch
// resolved, so the whole brand panel rendered blank and the reader reported
// "主页上的 capperr 这里记得有一些图表展示" twice.
//
// ⚠️ `tsc -b` did NOT catch it — the build succeeded. Nothing in this repo
// type-checks the H5 app as part of `build:h5`. scripts/verify-back.mjs and
// verify-paperr-ui.mjs now assert on console errors instead.
import { CompositionDonut, ReadingCurve } from '../../components/PaperrCharts';
import {
  assetUrl,
  fetchCoofIndex,
  fetchPaperrIndex,
  fetchSyncMeta,
  formatReadingTime,
  formatUpdatedAt,
  type CoofTitle,
} from '../../platform/data';

import '../../styles/demo.scss';
import './index.scss';

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
    // ⚠️ Says what it IS, including the part that is unflattering. These four
    // sources are read a few days deep, not archived in full — calling it
    // "最近的笔记" without the caveat would promise a completeness the page
    // does not have, and the page itself says so one tap away.
    // ⚠️ The wording is the user's, verbatim, including "不完整同步" — the
    // caveat is the point, not padding. And "some of them" replaces "滚动快照",
    // which described the mechanism rather than what the reader gets.
    // ⚠️ `\n` with `white-space: pre-line` on `.section__lede` — the trailing
    // aside goes on its own line. A second element would have been the other
    // way, but `lede` is typed as a string and widening it for one page's
    // wording is the tail wagging the dog.
    lede: "CEVTUO's 最近笔记，摘取最近 5 天次内的不完整同步\n· SOME OF THEM",
    // ⚠️ Deliberately no stats. The invented "1,024 总条目 / 180 字摘要" pair
    // that stood here was never a measurement, and on a panel whose real
    // content is a live feed the numbers were the least informative thing on
    // it. The four strips below say more than two counters did.
    stats: [],
    route: '/pages/cnsr/index',
  },
  {
    key: 'paperr',
    title: 'CAPPERR',
    lede: 'Kindle 阅读 · 阅读时长、在读书目与划线，从设备同步',
    // ⚠️ Placeholders. Replaced at render time by the live counts, like COOF's.
    stats: [
      { value: '—', label: '累计阅读', note: '' },
      { value: '—', label: '读完', note: '' },
    ],
    route: '/pages/paperr/index',
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
  // ⚠️ Fetched here rather than on the CAPPERR page only, because this panel
  // now SHOWS charts instead of a placeholder pair of numbers. An index page
  // that says "36h · 本月" about a brand whose page says 15.7h is a page lying
  // quietly — the two read the same payload now.
  const [paperr, setPaperr] = useState<PaperrIndex | null>(null);
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
    fetchPaperrIndex()
      .then((d) => alive && setPaperr(d))
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
      <TopBar title="CEVTUO-Z" root />

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
                : p.key === 'paperr' && paperr
                  ? [
                      {
                        value: formatReadingTime(paperr.totals.readSeconds),
                        label: '累计阅读',
                        note: `${paperr.totals.pagesTurned} 页`,
                      },
                      {
                        value: `${paperr.books.filter((b) => (b.progressPct ?? 0) >= 70).length}`,
                        label: '读完',
                        note: `共 ${paperr.books.length} 条`,
                      },
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
            {/* The live feed for CNSR: four glass strips, one per source,
                cycling through that source's note lines. */}
            {p.key === 'cnsr' ? <CnsrStrips onOpen={() => open(p.route, p.title)} /> : null}

            {/* The CAPPERR panel shows real charts, not a pair of numbers. The
                whole point of the index page is to say what is behind each door
                — and for this brand the answer is a shape, not a figure. */}
            {p.key === 'paperr' && paperr ? (
              <View className="home-paperr">
                <CompositionDonut
                  slices={(() => {
                    const by = new Map<string, number>();
                    for (const b of paperr.books) {
                      const k = !b.originalTitle ? 'Books' : b.title.startsWith('news') ? 'News' : 'Unnamed';
                      by.set(k, (by.get(k) ?? 0) + b.totalReadTime);
                    }
                    return [...by.entries()]
                      .filter(([, v]) => v > 0)
                      .sort((a, b) => ['Books', 'News', 'Unnamed'].indexOf(a[0]) - ['Books', 'News', 'Unnamed'].indexOf(b[0]))
                      .map(([label, value]) => ({ key: label, label, value }));
                  })()}
                  format={formatReadingTime}
                />
                <View className="pc-gap" />
                <ReadingCurve days={paperr.daily.slice(-30)} />
              </View>
            ) : null}

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
