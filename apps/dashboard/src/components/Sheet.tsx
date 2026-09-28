import { ScrollView, Text, View } from '@tarojs/components';

import { Icon } from './ChealthIcons';

import './Sheet.scss';

/**
 * 从底部升起的面板 —— 把「细节」从主屏挪走用的。
 *
 * 读者 2026-09-28 的原话：
 *   「把 10 屏尽量处理进 3 屏，可以通过弹窗的形式来归并，
 *     但是要尽量展示多的是在外边的是图标，而文字尽量缩减和折叠，大小也减小」
 *
 * ⚠️⚠️ 为什么不是「再拆几屏」而是弹窗。
 *
 * 这一页原来是一摞 scroll-snap 的面板 —— 一屏一个话题。那在**只有四五个话题**
 * 时是对的，但话题涨到十个之后：
 *   · 读者要翻十次才看得完一遍，而其中八屏他每次都不看
 *   · 侧边的进度条变成十个小方块，密集到分不出「我在第几屏」
 *   · 每一屏都自带一段 lede 和一堆说明文字，**翻页的成本被文字吃掉了**
 *
 * ⇒ 主屏只留**一眼要看的**（今天怎么样、趋势什么样、动了什么），
 *   细节（心率区间、周对比、功率、数据来源…）点图标再展开。
 *   **图标在明处，文字在暗处** —— 这样一屏能放下的东西多得多。
 *
 * ⚠️ 用 `<View>` 固定定位而不是 Taro 的 `<Portal>`：这个项目跑在 H5 上，
 *    而小程序构建里没有真正的 portal。固定定位两边都能用。
 *
 * ⚠️ `catchMove`：蒙层要吃掉滚动，否则手指在弹窗里滑会**穿透**到底下的
 *    面板栈上，弹窗没动而页面翻了一屏。
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <View className="sheet" onClick={onClose}>
      {/* ⚠️ 面板自己吃掉点击，否则点内容也会关掉 —— 而读者点内容是想**看**，
          不是想关。 */}
      <View className="sheet__panel" onClick={(e) => e.stopPropagation?.()}>
        <View className="sheet__head">
          <Text className="sheet__title">{title}</Text>
          <View className="sheet__close" onClick={onClose}>
            <Icon name="chev" />
          </View>
        </View>
        {/*
          ⚠️ 内容区**自己滚**，而且高度封顶。不封顶的话一张长表会把面板顶到
             屏幕外面去，而弹窗**没有第二个滚动容器能救它** ——
             它不像 Section 那样有面板可以溢出。
        */}
        <ScrollView className="sheet__body" scrollY>
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * 主屏上的图标格 —— 「外面尽量是图标」的落点。
 *
 * ⚠️ 每个格子是**图标 + 极短标签 + 可选的一个数**。不放说明文字 ——
 *    说明在弹窗里。这就是「文字缩减和折叠」具体落在哪。
 */
export function IconGrid({
  items,
  onPick,
}: {
  items: { key: string; icon: Parameters<typeof Icon>[0]['name']; label: string; value?: string }[];
  onPick: (key: string) => void;
}) {
  return (
    <View className="igrid">
      {items.map((it) => (
        <View className="igrid__cell" key={it.key} onClick={() => onPick(it.key)}>
          <View className="igrid__ico">
            <Icon name={it.icon} />
          </View>
          {it.value ? <Text className="igrid__v">{it.value}</Text> : null}
          <Text className="igrid__l">{it.label}</Text>
        </View>
      ))}
    </View>
  );
}
