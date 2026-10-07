# 小程序交接 —— 2026-10-07

> 明天处理小程序时先读这一页。**先读第 1、2 节**，那是唯一会卡住你的东西。

---

## 0. 一句话现状

| | 状态 |
|---|---|
| **网站** `z.cevtuo.com` | ✅ 好的，且今天修了两个线上 bug（见 §7） |
| **小程序** | ⚠️ **能渲染、能取数据、底部条在跑**，但 **① 背景不对 ② 导航定位未验证** |

小程序**不是**从零开始的状态 —— 它已经能跑通"渲染 + 网络数据"这条链路，
今天大部分时间花在把它从白屏救回来（§4 那一串平台差异）。
**剩下的两个问题都在 §1 / §2。**

---

## 1. ⚠️ 明天第一件事（按这个顺序，别跳）

### ① 验证那条**已经写好、但一次都没跑过**的改动（5 分钟）

`src/styles/wallpaper.scss` 末尾有一条：

```scss
page { background: transparent; }
```

**它是我排到一半被工具额度截断的**，所以：

```bash
cd ~/Documents/CEVTUO-Z
bun run app:build:weapp          # 产物在 apps/dashboard/dist-weapp
# 等 ~28s 让 DevTools 重编译
osascript -e 'tell application "wechatwebdevtools" to activate'
sleep 2.5 && screencapture -x /tmp/check.png   # 然后看 /tmp/check.png
```

**判据**：主页第一屏的背景应该是**一整张照片铺满**（和网页版一样），
而不是"只在最上面一条"或"整个白掉"。

- ✅ 铺满 ⇒ 这一条就是对的，接着做 §1②
- ❌ 还是不对 ⇒ 直接跳到 **§2**，那里有全部证据和**已被否掉的假设**，别再走一遍

### ② 让人点一下底部条（30 秒，但你做不了）

`Section.tsx` 的 `goTo()` 我已经改成"小程序走受控 `scrollTop`"（见 §5 第 ④ 条），
**但一直没有端到端证据** —— 因为验证它需要在模拟器里**点一下**，而驱动模拟器要点按，
截图又老被前台窗口挡住。

> **点底部条的 `C` / `N` / `P`，看页面跳不跳到对应那一屏。**

- 跳 ⇒ 这条收工
- 不跳 ⇒ 问题在 `Section.tsx` 的 `goTo` / `ScrollView` 的 `scrollTop` 受控属性上，
  那里已经有完整的注释说明为什么走这条路

---

## 2. 🔴 背景 bug —— 全部证据（**别重复我走过的弯路**）

### 现象

模拟器里主页背景**只在最上面露出一条**（约 16:9，全宽），下面全是白的。
网页版是整屏铺满。

### ⚠️ 已经被**实测否掉**的两个假设（我各花了 2–3 轮）

| 假设 | 做法 | 结果 |
|---|---|---|
| `inset: 0` 简写被 WXSS 丢掉 ⇒ 元素没有偏移量，停在静态位置 | 改成 `top/left/right/bottom` 四条 longhand | ❌ 还是贴顶部 |
| `height: 100%` 因为父元素没有确定高度而解析成 `auto` ⇒ 用固有尺寸 | 改成 `position: fixed; width: 100vw; height: 100vh` | ❌ 还是贴顶部 |
| 元素被 `page` 底色盖住 ⇒ 抬层 | `.cevtuo-wallpaper--mini { z-index: -2 }` | ❌ **更坏：整块消失**（−3 时至少有一条） |

⇒ **三次都是"想通了就改、改完用截图才发现错"。**先量，再改。

### ✅ 确定的事实（都是探针实测出来的，不是推理）

1. **`Taro.getEnv()` = `WEAPP`、`isMiniProgram()` = `true`**
   —— 用 `Taro.showModal` 弹出来的。**所以小程序专用分支确实在跑**，
   不是"判据失效导致分支没走到"。
2. **那句话里的 `<Image>` 确实渲染了** —— 我给它加了 `6px solid #00ff00` 荧光边框，
   截图里**一根都没有** ⇒ 它**被盖住了**，不是没画。
   （于是它在哪个位置、多大，至今**没量到**。）
3. **画框在 `z-index: -1` 是看得见的**（截图里带框的照片都在）。
4. ⇒ 夹在 **−3 和 −1 之间**有一层不透明的东西，把壁纸挡了。
   最可能是**小程序 `page` 自带的底色**（网页上这层兜底色在更外面，不挡）。
5. **层叠契约**（网页/小程序共用，**别单独动某一个**）：
   壁纸 `-3` < 画框 `-1` < 内容 `0` < overlay `100` < chrome `130`

### 我正在做的修法（就是 §1① 那条）

**不动任何 z-index**，改让 `page` 的底色透明 —— 露出来的会是 window 底色
（`theme.json` 的 `bgColor`，同一个颜色）+ 负层。这样 **−3/−1/0 的相对关系一个字没改**。

### 下一步可以量什么（如果上面那条不成）

Taro 的 DOM 垫层**没有布局引擎**，`getBoundingClientRect()` 拿不到真值。
小程序里唯一能拿到布局的是**渲染层**：

```js
wx.createSelectorQuery().select('.cevtuo-wallpaper__photo').boundingClientRect().exec(...)
```

⚠️ 我把它写在 `Wallpaper.tsx` 的 `useEffect` 里**没弹出来**（可能要在**页面组件**里调用，
Taro 的组件里未必可用）。**换到 `pages/home/index.tsx` 里试**，或者直接用
`globalThis.wx.createSelectorQuery()` 绕开 Taro 的包装。

---

## 3. 命令速查

```bash
# ── 构建 ──────────────────────────────────────────
bun run app:build:weapp     # 小程序 → apps/dashboard/dist-weapp/  ⭐ 独立目录！
bun run app:build:h5        # 网页   → apps/dashboard/dist/
bun run typecheck           # ⚠️ 根 tsconfig exclude 了 apps，这条必须单独跑

# ⚠️⚠️ 这两个**不再互相覆盖**了（今天改的，见 §5 第 ⑤ 条）。
#    以前共用一个 dist，重建 h5 会把小程序产物冲掉，而症状是"白屏/打不开"。
```

```bash
# ── 开发者工具 ────────────────────────────────────
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
"$CLI" preview       --project "$PWD/apps/dashboard" --port 11900   # 出二维码（真机会校验域名）
"$CLI" auto-preview  --project "$PWD/apps/dashboard" --port 11900   # 真机调试（跟随 urlCheck）

# 服务端口在：~/Library/Application Support/微信开发者工具/<hash>/Default/.ide
#            （⚠️ 不在 Default/ 根下，hash 目录里）
# 项目里的 urlCheck 已经是 false ⇒ **真机调试不需要域名白名单**
```

```bash
# ── 看日志（比 GUI 可靠）──────────────────────────
D=~/Library/Application\ Support/微信开发者工具
ls -t "$D"/*/WeappLog/logs/*.log | head -1              # DevTools 自己的日志
ls -t "$D"/*/WeappSimulator/WeappFileSystem/*/*/usr/miniprogramLog/log1 | head -1
#   ↑ 小程序**自身**的日志：`App onLaunch` / `wx.request success callback … request:ok`
#     ⚠️ 但**用户 console.log 不落盘** —— 探针要用 `Taro.showModal` 弹出来截图读
```

```bash
# ── 截图（顺序很重要）─────────────────────────────
sleep 28                                    # 先等重编译
osascript -e 'tell application "wechatwebdevtools" to activate'
sleep 2.5 && screencapture -x /tmp/x.png    # 再激活、**马上**截
# ⚠️ 写成 activate → sleep → 截，中间会被前台窗口抢走 ⇒ 量到的是**别人**
```

---

## 4. ⚠️ 今天在小程序上撞到的平台差异（**清单，以后每加一个功能都对照一遍**）

全都是「**看起来正常但东西不在**」，一句错都不报：

| # | 差异 | 症状 | 修法 | 判据 |
|---|---|---|---|---|
| ① | **没有 `fetch`**，只有 `wx.request` | 数据层静默失效，每块停在「读取中…」 | `httpGet()` 按能力选路 | `fetch=undefined` 实测 |
| ② | **`background-image` 不渲染网络图片** | 壁纸、品牌动画**整块空** | 改走 `<Image src>` | 同屏对比：画框（`<Image>`）正常、壁纸（`background-image`）空 |
| ③ | **`mix-blend-mode` 不生效** | 字标纯白 + 反色 ⇒ 浅底上**看不见** | 退回普通墨色 | 截图里字标不见了 |
| ④ | **`containerRef.current` 不是 DOM 节点** | `el.scrollTop=…`/`addEventListener` 全无效 ⇒ **点导航跳不动** | `goTo()` 能力自适应 + 受控 `scrollTop` + `onScroll` | 文件里那句注释早写了 "the rail stays on panel 1" |
| ⑤ | **h5 和 weapp 共用 `dist`** | 重建 h5 冲掉小程序 ⇒ DevTools `未找到 app.json` | 小程序改输出 `dist-weapp/` | 两者产物并存 |

**判据只有一份**：`src/platform/env.ts` 的 `isMiniProgram()`（走 `Taro.getEnv()`）。
⚠️ 不要再用 `typeof fetch` 那种间接特征 —— 那是数据层「选哪条请求路」的判据，是另一件事。

---

## 5. 微信后台那边（今天确认的）

| 项 | 值 |
|---|---|
| AppID | `wxacb804a3afd41113` |
| 小程序名 | `cevtuoz` |
| **主体** | **个人** |
| 微信认证 | 已认证（2026-09-22） |
| 服务类目 | 工具 > 备忘录 |
| request 合法域名 | ✅ `https://z.cevtuo.com` **已加**（2026-10-07） |
| 包大小 | **1.6 MB**（1,684,586 B）—— 超 1.5MB **建议值**、低于 2MB **硬上限** ⇒ 能上传 |

### ⚠️⚠️ 主体是「个人」⇒ `<web-view>` **封死**

官方文档原文（`developers.weixin.qq.com/miniprogram/dev/component/web-view.html`）：

> 承载网页的容器。会自动铺满整个小程序页面，**个人类型的小程序暂不支持使用。**

⇒ **"把网页一键封装成小程序"这条路对这个账号不存在**，不是技术难度问题。
以后任何"用 web-view 包一层"的提议**直接排除**，不用再评估。

---

## 6. 交接清单

### 已经做完并**验证过**的
- ✅ 小程序从白屏救回：渲染 + 网络数据都通（§4 的 ①②③④⑤ 全修了）
- ✅ 产物分家（`dist` / `dist-weapp`），重建 h5 不再冲掉小程序
- ✅ 域名白名单（你加的）
- ✅ **网页侧**两个线上 bug（§7）

### 已实现但**没有端到端证据**的
- ⚠️ 底部条跳转（§1②）—— **等你点一下**
- ⚠️ 今天最后一轮改的 `page { background: transparent }`（§1①）

### 未清的账
- ⚠️ `dist-weapp` 里还有 **9 处 `inset` 简写**（`.cevtuo-glass` / `.nowb__scrim` /
  `.cnb__glyph` / `.splash` / `.gal__sheen` …）。已证明**不是**背景那个 bug 的元凶，
  但既然有嫌疑就该逐个验。
- ⚠️ `verify-reel.mjs` 跑出来 30 通过 / 5 失败（我把默认端口和 hash 断言修了，C1 已转绿）；
  剩 N0/W0 是已知假红（`ALLOWED_ORIGINS` 只放行 8096）、N1/W1 跑得太早、W9 悬停疑似抖动
- ⚠️ **`FACT.md` 没更新** —— 今天这一批结论都写在 JOURNAL 里，
  但按项目规矩它们该进 FACT。尤其「主体是个人 ⇒ web-view 排除」这条会影响以后每个决策
- ⚠️ 真机**从没测过**（模拟器 ≠ 真机）

---

## 7. 今天网页侧修了什么（供对照，避免误以为是小程序的问题）

1. **每页背景都一样** —— 路由改 browser 后 `currentPage()` 恒返回 `home`
   （连带 `GalleryFrame` 也挂错页的画框）。修：认 `pathname` + 三个事件都挂
2. **电影海报完全不动、和标题没有对应** —— 特异型打架：
   `.section__body--enter > view :not(...)`（(0,5,1) 的**后代选择器**）
   把 Reel 的十张海报全顶到 `opacity:1`。修：给那 5 条规则加 `:not(.reel__card):not(.reel__t)`
   - ⭐ 破案用的是新工具 **`bun scripts/why-css.mjs <url> <选择器> [属性]`**
     —— 按样式表顺序列出命中该元素、且写了该属性的规则，并指出**最后一条（赢的那条）**。
     **以后遇到 CSS 覆盖直接用它，别猜、别二分。**
3. 线上指纹：`z.cevtuo.com` = `js/app.59656078.js`

---

## 8. 📌 记下来：如果哪天要"网页直接封装成 App"

（今天查实：**小程序这条路被主体类型封死**，所以只有换容器。）

**Capacitor** 或 **Tauri** 出一个 **WebView 壳 App**：

- ✅ **网页一行都不用改** —— 壳里就是 `https://z.cevtuo.com`
- ✅ 开源免费、**无需审核**（Android 直接装 APK）
- ✅ 这台机器已经在发 APK（`cevtuo-health`）⇒ 工具链和习惯都有
- ⚠️ iOS 需要 Apple 开发者账号（$99/年）；Android 免费
- ⚠️ 和"小程序"不是一回事：**这是要下载安装的 App**，不是微信里的入口

**取舍**：小程序赢在"微信里点开就有"；壳 App 赢在"网页原样、零重写、零维护税"。
两者可以并存（小程序的入口页 + 壳 App 的完整体验）。
