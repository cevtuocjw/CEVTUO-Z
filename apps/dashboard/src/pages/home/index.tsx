import { Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useGlassIntensity } from '../../hooks/useGlassIntensity';

import '../../styles/demo.scss';

/**
 * Home — Phase 0 demo.
 *
 * Phase 0 goal is to see the design system and the foldable layout on real
 * hardware before any data is wired up, so every value here is placeholder.
 *
 * The block list below is the contract every brand page will follow: declare
 * blocks with a priority, and the grid places them. On the cover screen only
 * hero/primary blocks exist; unfolding promotes the tier and the rest appear.
 */

interface BrandTile {
  key: string;
  label: string;
  blurb: string;
  value: string;
  note: string;
  /** Rendered on the cover screen. Everything else waits for an unfold. */
  primary: boolean;
}

const BRANDS: BrandTile[] = [
  { key: 'coof', label: 'COOF', blurb: '电影记录', value: '148', note: '部 · 2026 年度', primary: true },
  { key: 'cnsr', label: 'CNSR', blurb: '笔记与摘录', value: '1,024', note: '条 · 4 个来源', primary: true },
  { key: 'paperr', label: 'CE-PaperR', blurb: 'Kindle 阅读', value: '36h', note: '本月 · 在读 3 本', primary: true },
  { key: 'chealth', label: 'Chealth', blurb: '健康数据', value: '8,412', note: '步 · 今日', primary: false },
];

export default function Home() {
  const bp = useBreakpoint();
  const glass = useGlassIntensity();

  const tierLabel =
    bp.tier === 'compact' ? '外屏' : bp.tier === 'medium' ? '内屏展开' : '大屏';

  // Cover screen: primary blocks only. Unfolded: everything.
  const visible = BRANDS.filter((b) => bp.tier !== 'compact' || b.primary);

  return (
    <View className="page">
      {/* Wallpaper lives behind everything; position:fixed + explicit edges. */}
      <View className="cevtuo-wallpaper" />

      <View className="nav">
        <View className="nav__brand">
          <View className="nav__mark">
            <Text>Z</Text>
          </View>
          <Text className="nav__title">CEVTUO-Z</Text>
        </View>
        <View className="nav__meta">
          <Text className="nav__stamp">
            {tierLabel} · {bp.width}×{bp.height}
          </Text>
          <Text className="nav__stamp">玻璃 {glass.percent}%</Text>
        </View>
      </View>

      <View className="page__head">
        <Text className="page__title">下午好</Text>
        <Text className="page__sub">
          {bp.columns} 列布局 · 更新于 14:05 · 下次 18:00
        </Text>
      </View>

      <View className="grid">
        {visible.map((b) => (
          <View className="block" key={b.key}>
            <View
              className="card"
              onClick={() => Taro.showToast({ title: `打开 ${b.label}`, icon: 'none' })}
            >
              <Text className="card__label">{b.label}</Text>
              <Text className="card__value">{b.value}</Text>
              <Text className="card__note">
                {b.note} · {b.blurb}
              </Text>
            </View>
          </View>
        ))}

        {bp.tier !== 'compact' && (
          <View className="block">
            <View className="card glass--raised">
              <Text className="card__label">DEMO · 仅内屏显示</Text>
              <Text className="card__value">{glass.percent}%</Text>
              <Text className="card__note">
                这块在外屏不渲染，所以取数也会被跳过 —— 没渲染的模块绝不请求。
              </Text>

              {/* Glass intensity slider. Mini programs have no <input type=range>,
                  so this is a tap-to-set strip, which works identically on both targets. */}
              <View
                className="chips"
                onClick={(e) => {
                  const x = e.detail?.x ?? 0;
                  const w = bp.width - 64;
                  glass.setPercent(Math.round(Math.min(1, Math.max(0, (x - 16) / w)) * 100));
                }}
              >
                {[20, 40, 60, 80, 100].map((p) => (
                  <View className={`chip ${glass.percent === p ? 'chip--on' : ''}`} key={p}>
                    <Text>{p}%</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}
      </View>

      <View className="block__spacer" />
    </View>
  );
}
