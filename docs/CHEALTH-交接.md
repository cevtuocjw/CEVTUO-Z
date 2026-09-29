# CHEALTH 交接 —— 2026-09-28 晚

> 给下一个窗口的助手看。**先读「一句话现状」和「开场白」，其余按需查。**
> 这份是**当晚重写的**，替换了当天早上那版（那版里「搬域名 / 开 HTTPS」那些待办都做完了）。

---

## 一句话现状

**线上是好的、可用的、且经过验证的。**

```
网站          https://z.cevtuogrnd.com/
CHEALTH 页    https://z.cevtuogrnd.com/#/pages/chealth/index
主页 CHEALTH  https://z.cevtuogrnd.com/#/pages/home/index?panel=3
口令          在 services/ingest/.env.server-backup 里，键名 CEVTUO_HEALTH_PASSPHRASE
              取它：
                grep '^CEVTUO_HEALTH_PASSPHRASE=' services/ingest/.env.server-backup | cut -d= -f2-

              ⚠️⚠️ **口令的明文绝不写进这个文件，也绝不写进任何被跟踪的文件。**
                 这个仓库是**公开**的，写了就等于把健康数据的解密密钥公开发布。
                 我 2026-09-28 晚差一点就这么干了 —— 写完交接文档时顺手把口令抄了进去，
                 幸亏在 push 之前查了一下 `git log -S`。那个 commit 还没推，已 amend 掉。
                 **往文档里写密钥是个肌肉记忆式的动作，而它在这里的代价是全局的。**
```

四个验证器全绿（**每次部署后都要跑**）—— 2026-09-29 线上实测 58/58：

```
bun scripts/verify-https-live.mjs    9/9    全站 HTTPS + 混合内容
bun scripts/verify-copy.mjs          6/6    渲染出来的字（星号/NaN/undefined）—— **含弹窗**
bun scripts/verify-home-stats.mjs    7/7    主页数字截断
bun scripts/verify-chealth-ui.mjs   36/36   CHEALTH 三屏 / 七个弹窗 / 目标线 / 三星卡片 /
                                            天周月切换 / 达标日历 / 心率区间着色 / 解锁入口
```

还有一个**探针**（不是断言，是量数据的）：

```bash
bun scripts/chealth-coverage.ts   # 解密线上索引，逐字段统计「到底哪些字段有数」
```

⚠️⚠️ **做新功能之前先跑它。** `ChealthDay` 的类型几乎每个字段都是可选的 ——
那是诚实的（不同来源写不同指标），但意味着**类型检查完全不能告诉你某一项有没有数据**。
2026-09-29 实测：`floors` **0/31 天**、HRV/呼吸率/皮温**一条都没有**、体重 1/31。
按「拿不到数据的功能就不做」，这三个都没做。

⚠️⚠️ **跑之前先把代理摘掉**，否则会间歇性 `ERR_CONNECTION_CLOSED` 白跑三轮：

```bash
env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
    NO_PROXY='*' no_proxy='*' bun scripts/verify-chealth-ui.mjs
```

⚠️ 宿主机 `HTTPS_PROXY=http://127.0.0.1:7890` 而 `NO_PROXY` 不含本站域名，
Chromium 会走那个代理 —— 它**通得了 bun 的 fetch，却会掐掉浏览器的连接**。
`verify-https-live` 那次 9/9 是摘了代理跑的。

⚠️ 同理，`bash scripts/deploy-pages.sh` 推 GitHub 要用 **HTTP/1.1**：

```bash
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1
bash scripts/deploy-pages.sh
```

不加的话走的是 `LibreSSL SSL_connect: SSL_ERROR_SYSCALL`；
**而且它是一阵一阵的**（同一条命令连失败 4 次、第 5 次成功），所以脚本外面套重试。

⚠️⚠️ **部署前必须删掉本地预览的软链** `apps/dashboard/dist/data`。
`deploy-pages.sh` 第 65 行 `cp -R dist/.` 会把它拷进暂存目录，
第 66 行 `cp -R data` 于是撞上 `cp: .../data: File exists` ——
而 `set -euo pipefail` 让**整个部署中止**。报错只有一行 cp，很容易看漏成「推完了」。

```bash
rm -f apps/dashboard/dist/data     # 部署前
ln -sfn ../../../data apps/dashboard/dist/data   # 要本地预览时再建
```

⚠️ **别只看构建通过**。这个项目里「构建全绿、页面白屏」发生过三次，
「断言全绿、数据没动」发生过两次。**唯一可靠的是驱动真实页面 + 读 DOM + 亲眼看图。**

---

## 开场白（直接粘给下一个窗口）

> 继续 CEVTUO-Z 的 CHEALTH。先读 `docs/CHEALTH-交接.md`（2026-09-28 晚这版，别找早上的）。
>
> 三件事，按顺序：
>
> 1. **把十屏收进三屏**：`components/Sheet.tsx` + `Sheet.scss` 已经写好并提交
>    （`42c4a49`），但**还没接到页面上**。接线方案见交手里的「下一步 A」。
>    ⚠️ 我上一次尝试用脚本搬 JSX 把文件改崩了（9 处语法错误），已回退 ——
>    **别再用脚本跨 300 行搬 JSX**，改用「把每个弹窗内容抽成局部组件」的做法。
>
> 2. **三星那套视觉全面改造**：柱状图的配色做了（每指标一色、今天满色、过去 42% 淡版），
>    但**目标线 / 达标进度 / 字重层级 / 卡片圆角间距**都还没动。读者原话：
>    「现在完全 CSS 看起来不像三星的 APP 那个界面，太不像了」。
>
> 3. 做完上面两件再跑四个验证器 + `bun run typecheck` + 部署。
>
> 手机用 adb（`export PATH=/opt/homebrew/bin:$PATH`，设备 `adb-RFCY71VRZKJ-r2l6Vm._adb-tls-connect._tcp`）。
> **别用 AndroMeld 的 MCP**（Cherry Studio 只转发 19 个工具里的 9 个，缺的正好是读屏和输入）。

---

## 今晚做完的事（都已部署 + 验证 + 提交）

| commit | 做了什么 |
|---|---|
| `2357c5d` | **修「09-26 之后没有过程数据」** —— 见下面「今晚最大的坑」 |
| `42c4a49` | 弹窗 + 图标格组件（**地基，未接线**） |
| `d9358c3` | 六屏拆成十屏 + 翻页提示说实话 |
| `2b9f870` | CHEALTH 加解锁输入框（**之前根本没有入口**） |
| `d4c6af7` | 柱状图用每个指标自己的颜色 |
| `f89498f` | 「默认选中今天」从来没生效过 + 缺数据被画成横线 |
| `73b8a6a` | 页面上渲染出 Markdown 星号（全站 5 处） |
| `6056bd3` | 主页 CHEALTH 接上数据 + 修数字压数字 |
| `c217b16` | 服务端按 start 合并会话 ⇒ 删不掉旧记录 |

⚠️ CEVTUO-Z 的 commit 都在本地，**没有 push 到 GitHub**。要推的话先 `git fetch`
（远端有定时 Actions 在写数据），而且本机 token **没有 `workflow` 权限**。

---

## ⚠️⚠️ 今晚最大的坑：过滤加错了层

**症状**：读者问「为什么 9 月 26 日开始的数据就没有任何过程和详细数据」。
解封线上索引逐场看：

```
09-23 18:44 BIKING   hr=64 功率=60 踏频=60 速度=60   ✓
09-24 19:04 RUNNING  hr=29 速度=29
09-26 19:49 BIKING   hr=0  功率=0  踏频=0  速度=0    ✗ 全空
```

**根因**：我上一轮为了排除 Google Fit 的重复活动，把过滤加进了
`SyncWorker.records()` —— 那个函数是**全同步唯一的读取入口**。
放在那里看起来正是「只写一处、不会漏」的典范，于是它把**测量值**一起滤掉了。
会话本身还活着（另一条路径读的），所以症状是**有活动、没有曲线**。

**修法**：过滤只用在 `collectSessions` 挑会话那一处。
- 会话**会**重复（同一场骑行两条记录）⇒ 要滤
- 测量值只是被镜像 ⇒ 不该滤

⚠️ **「唯一入口」听起来安全，但入口里做掉的判断会影响它下面所有的用途。**

⚠️ 我当时还走错一次：看到 09-26 没有心率，而探针显示**心率只有 healthsync 在写**，
就断言「不是 fitness 的问题」。那个推论只证明了**心率**不是 fitness 写的 ——
**用一条记录类型否证了一整类**。

⚠️ 另一个教训：我拿「上报负载字节数」当判据（13899 → 14163），而**只差 264，
根本不足以证明修好了**（真正修好后也是 14163）。判据必须是**逐场看 `hrSeries` 的长度**。

手机端改动**不在 CEVTUO-Z 仓库里**，在 `~/cevtuo-health`（独立 git 仓库，已提交 `2357c5d`）。
远端是 `github.com/cevtuocjw/cevtuo-health`。

⚠️ 这条我第一版写成了「没有远端仓库」—— **是错的**，`git remote -v` 一查就有。
（上一份交接里也有这条错的，我照抄了没核。**交接文档里的每条事实都要当场验一遍**，
它最大的风险不是漏，是**把上一版的错抄下来**，而抄下来的错看起来最权威。）

---

## 今晚挖出的五个 bug —— 有四个是同一个形状

| # | 症状 | 真相 |
|---|---|---|
| 1 | 主页 CHEALTH 那格永远是「— / 未解锁」 | `route: null`，索引页根本没接线 |
| 2 | `9686` 压在 `5.78h` 上 | `.stats__item` 固定 118px 且不裁剪，字号写死 62.4px |
| 3 | 睡眠块标签是「睡.」 | 四块字号同一个 30px，而可用宽度是 144/98/53px |
| 4 | 柱状图「默认选中今天」 | `useState` 初值在 `days` 为空时求值 ⇒ 永远停在第 0 根 |
| 5 | 缺数据显示成一根横线 | `—` 在 21px 粗体下**就是一条分隔线** |

**共同点：都不是崩溃，都过了类型检查，都能截出一张「看着还行」的图。**
⇒ 只能靠**量出来的数**（`scrollWidth` / `clientWidth` / 第几根 / 计算出来的颜色）抓住。

⚠️ 还有一条元教训：**占位符比真数据短，就替真数据挡了一整类 bug。**
那四格数字以前永远是「—」（一个字符），所以「固定宽度 + 不收缩字号」的问题
一直没暴露。**占位符必须是「最坏情况」的形状，不只是「长得像占位符」。**

---

## ⚠️ 这个项目里会复发的四个陷阱

**① 幽灵类 `.chc`**
SCSS 里 `.chc { &__rows { … } }` 编译成 `.chc__rows`（真在用），
但**裸的 `.chc` 选择器匹配不到任何东西** —— 挂它上面的自定义属性全部解析为空。
咬了两次（马赛克的 `var(--blue)`、柱状图的 `var(--m)`），症状都是「颜色变灰，别的一切正常」。
**判断方法**：`getComputedStyle(document.querySelector('.chc__rows')).getPropertyValue('--m-steps')`，
空字符串就是没挂上。**类型检查、构建、截图都不会告诉你。**

**② `.card` 的特异性**
`.card` 是单类选择器。任何**单类**的 `.chc__xxx` 和它特异性平手，
胜负由样式表顺序决定 —— 而 demo.scss 在后，`.card` 的 `flex-direction: row` 一直赢。
⇒ 要改布局就得写**两个类**：`.card.chc__stack`、`.card.chc__unlock`。
咬了两次（`.chc__stack`、`.chc__unlock` —— 后者让输入框只剩 4px 宽，手机上打不了字）。

**③ `cqw` 量的是内容盒，不是外框**
按块宽（81px）算成 `24cqw`，字号掉到 12.6px 比标签还小。真正的分母是内容宽 53px。

**④ 服务端 `mergeSessions` 是整表替换**
`incoming` 是**整段窗口的完整列表**（`collectSessions` 每次读 30 天全天窗，
和日期循环那个只重读 `REFRESH_DAYS` 的增量**不是一回事**）。
⚠️ 所以手机端读会话失败时**不能发空数组**，要**不放这个键** ——
`undefined` = 「没读到」（保留旧值），`[]` = 「窗口内真的没有」（清空）。
手机端 `SyncWorker` 已经改成不放了。

---

## ✅ 已完成（2026-09-29，commit `e1fa4c3`）—— 十屏收进三屏

**这一节原来的内容全部做完了。** 下面「目标结构 / 当前文件结构」两段是
动手前的快照，**行号已经全部失效**，留着是为了说明当时的计划。

### 实际落成的结构

```
屏 0「今天」    hero + 马赛克四块（步数那块带达标进度）+ 图标格（六个入口）
屏 1「运动」    筛选 chips + 会话列表（摘要卡，点开是场次弹窗）
屏 2「趋势」    步数（带目标虚线）/ 睡眠 / 活动消耗 三张柱状图

七个 Sheet：zones 心率与体征 / week 周对比 / power 功率与个人记录 /
            streak 连续达标 / kinds 类型分布 / sources 数据来源与同步 /
            session 单场运动（四条曲线）
```

⚠️ 七个 Sheet 全部渲染在 `</PageStack>` **外面**。
`.sheet` 是 `position: fixed`，而 `fixed` 的包含块是最近一个带
transform / filter / backdrop-filter / contain 的祖先 ——
留在栈里就要赌 `.stack`/`.section` 上没有这些属性。赌赢一次，
下次有人加一句 `will-change` 就静默失效（弹窗跑进某一屏里面去，
被那一屏的滚动裁掉）。`verify-chealth-ui` 里有一条断言专门盯这个。

⚠️ 接线手法：**把 `<Section>` 的开闭标签整个换成 `<Sheet>`，children 一个字节都不动。**
上一轮用脚本跨 300 行搬 JSX，typecheck 报了 9 处语法错误。

⚠️ 顺手抓到的真 bug：「正在骑 MyWhoosh」那个徽标原来是 `<PageStack>` 的兄弟节点
（第 0 屏和第 1 屏之间）—— **它就是第 11 屏**。面板栈按
`scrollTop / clientHeight` 算「我在第几屏」，多一个兄弟节点就让所有面板和导轨
对不上，而 `count` 还写着 10。已挪进第 0 屏。

### 当时的计划（历史，行号已失效）

```
屏 0「今天」    hero + 马赛克四块 + 图标格（六个入口）
屏 1「运动」    筛选 chips + 会话列表（卡片要压缩：图标 + 一行 + 关键数）
屏 2「趋势」    步数 / 睡眠 / 消耗 三张柱状图
```

六个入口点开是弹窗：`zones` 心率区间 / `week` 周对比 / `power` 功率 /
`streak` 连续达标 / `kinds` 类型分布 / `sources` 数据来源。
另有 `session` 弹窗放单场运动的四条曲线。

### 当前文件结构（`pages/chealth/index.tsx`）

```
265-298   Section「需要口令」   ← PageStack 外面
308       <PageStack count={10}>
309-392   Section 0 CHEALTH（hero + mosaic + tile-note）
406-554   Section 1 运动
556-579   Section 2 步数与睡眠
581-616   Section 3 消耗
618-721   Section 4 心率与来源    ← 要变成 Sheet('sources')
722-766   Section 5 分析          ← Sheet('zones')
778-839   Section 6 周对比        ← Sheet('week')
841-864   Section 7 功率          ← Sheet('power')
866-885   Section 8 连续达标      ← Sheet('streak')
887-946   Section 9 类型分布      ← Sheet('kinds')
947       </PageStack>
```

（行号是回退后的当前值，动手前先 `grep -n "^        <Section" | head -20` 核一遍。）

### ⚠️⚠️ 怎么做（别再犯我那个错）

**不要写脚本跨几百行搬 JSX。** 我试过，脚本跑完 typecheck 报 9 处语法错误
（打开的 `<Sheet ...>` 没被正确闭合），只能整体回退。

**推荐做法**：在同文件里把每个 Section 的内容抽成**局部组件**，例如

```tsx
function ZonesPanel({ zones, zoneMinutes, refMaxHr }: …) { return (…原样搬过来…); }
```

然后在 `</PageStack>` **外面**渲染：

```tsx
<Sheet open={sheet === 'zones'} title="心率区间" onClose={closeSheet}>
  <ZonesPanel … />
</Sheet>
```

这样**不需要移动任何 JSX**，只是把它包一层函数 —— 搬错了 typecheck 立刻会报。

**每搬一段就跑一次 `bun run typecheck`**，不要搬完六个再跑。

### 已经写好的东西（`components/Sheet.tsx` / `Sheet.scss`，commit `42c4a49`）

```tsx
<Sheet open={boolean} title={string} onClose={() => void}>{children}</Sheet>
<IconGrid items={[{ key, icon, label, value? }]} onPick={(key) => void} />
```

- `max-height: 86vh`（留一截主屏在视野里，全屏面板和「跳走了」没区别）
- 蒙层吃掉点击；面板自己 `stopPropagation`（点内容是想**看**，不是想关）
- 状态用**一个** `sheet: string | null`，不是每个弹窗一个 boolean
  （同时开两个弹窗是用不了的状态，不该能表示出来）
- `IconGrid` 是**三列**（四列在 390px 上每格约 88px，中文标签只能缩到 9px，没法读）

⚠️ 接完线记得把 `PageStack count={10}` 改成 `{3}`，并在屏 0 加：

```tsx
<IconGrid onPick={openSheet} items={[
  { key: 'zones',  icon: 'heart',  label: '心率区间', value: zoneMinutes > 0 ? `${Math.round(zoneMinutes)}分` : undefined },
  { key: 'week',   icon: 'up',     label: '周对比' },
  { key: 'power',  icon: 'power',  label: '功率' },
  { key: 'streak', icon: 'trophy', label: '连续达标', value: streak > 0 ? `${streak}天` : undefined },
  { key: 'kinds',  icon: 'bike',   label: '类型分布' },
  { key: 'sources',icon: 'watch',  label: '数据来源' },
]} />
```

（`zoneMinutes` / `streak` 都是页面里已有的 `useMemo`。）

---

## ✅ 已完成（2026-09-29）—— 三星视觉

**读者 2026-09-29 直接给了七张三星健康真机截图**，所以这一轮是**照着真机抄的**，
不是凭「简洁」「现代」这类词猜的。从截图里读出来的硬事实：

| 截图上看到的 | 落到了哪里 |
|---|---|
| 「每日活动量」三块砖的**标签各是各的色**（步数绿/活动时间青/活动卡路里紫），数字是白的 | `.chc__mlabel { color: var(--m) }`，`--m` 挂在整块砖上 |
| 大数字下面一条**发丝线**，线下面写 `/9,000` | `.chc__tile-rule` + `.chc__tile-goal` |
| 卡片是**20px 圆角 + 1px 亮边**的深色块 | `.card.chc__card`（圆角 20px + `box-shadow: inset … 1px`） |
| 柱子是**胶囊形**，不是直角 | `.chc__bar { border-radius: 999px 999px 0 0 }` |
| 运动详情每行的标签都染成该指标的颜色（心率粉/卡路里紫/时长青/海拔绿） | 同理，走 `--m` |

⚠️⚠️ **蓝色实底那一块的标签必须是白的** —— 步数的绿在蓝底上几乎看不见。
`.chc__tile--blue .chc__mlabel { color: #fff }` 是故意覆盖的，不是漏改。

⚠️ 睡眠口径也改了：原来是「7 天累计 37.7h」——**37.7 小时不是任何人理解睡眠的方式**。
现在那块砖是**最近一晚**（带日期），说明里给精确到分钟的 `5h47m` 和 14 晚均值。

⚠️ 窄块（53px 可用宽）里放不下 `7h32m`（3.2em ≈ 63px，会切字）——
所以砖上写 `5.8h`，精确值写在下面的说明行里。

---

## ✅ 已完成（2026-09-29 第二轮，commit `367cb72`）—— 照三星补齐「有数据的部分」

读者的话：「跟着三星健康一样的把它做到的那些对于数据的部分补齐全功能，
**如果我们拿不到数据的就不做这个功能了**」。

**做的**（数据都有）：
- 运动屏：天/周/月 三段胶囊 + 大字总时长 `H:MM:SS` + 次数/消耗/距离小计
  + 每天运动时长柱状图 + **按天分组**的列表（日期头右边带那天的合计）
- 达标弹窗：`目标已实现 X/Y 天` + **达标日历** + 本月步数/距离/消耗
- 心率曲线**按区间着色**（灰→蓝→绿→黄→红）+ 图例

**没做的**（拿不到数据，逐条量过）：楼层 0/31 天、HRV/呼吸率/皮温 0 条、
体重 1/31 天、海拔/饮食无字段、**能量得分 / 睡眠得分是三星专有评分，不编**、
「活动时间」我们没有这个独立指标。

⚠️ 两个设计决定值得记住：
- **运动屏默认「周」不默认「天」**。三星默认天，是因为它一天常有好几场；
  我们 31 天只有 8 场 —— 默认值该按**这份数据的密度**挑，不是照抄别人的。
- **达标日历的分母是「有记录的天数」**，不是三星那个「这个月过了几天」。
  后者会把手机没同步的日子记成「没达标」，也就是**把「我们不知道」算成「他没做到」**。
  日历上「没记录」还有自己的形状（淡描边），不是一档灰。

---

## 🚧 下一步（2026-09-29 时点还没做）

1. **主页 CHEALTH 卡和 CHEALTH 页的睡眠口径是两份实现**。主页那份已修
   （取最后一条真的有睡眠记录的那天），但两处逻辑没有共享 —— 迟早漂移。
2. 「类型分布」弹窗里 `.chc__zone-bar` 的各行还没按运动类型分色
   （心率区间那张已经是红的了）。
3. 运动屏内容高 **1074px**（面板 844px），要滚一屏多才看到列表。
   三星那屏更长，所以不算错，但 `本屏还有内容` 那句提示会压在卡片上。
   要缩的话，优先砍筛选 chips（它和 天/周/月 有点重复）。

---

## 原来的「下一步 B」（历史）

**已经做了**：柱状图每指标一色（步数绿 `#3ecf8e` / 睡眠紫 `#8b7cf6` / 消耗橙
`#ff9f43`），今天满色、过去 42% 淡版、空白保持灰。色值只在
`ChealthCharts.scss` 的 `--m-*` 定义一次，`tone` 传的是**名字**不是色值。

**还没做**：
1. **目标线 / 达标进度** —— 三星另一半辨识度来自「9,686 / 目标 10,000」那种进度感。
   现在只有裸数字。步数目标 8000（`stepStreak` 里已经用了这个数）。
2. **睡眠口径** —— hero 上显示 **7 天累计 37.7h**。三星展示**昨夜**或**每晚均值**。
   「37.7h」不是任何人理解睡眠的方式，**这个数值口径本身该改**。
3. **运动卡片标题折行**（「50 分/钟」被拆开、类型图标跟着错位）
4. **来源表里的 ⚠️ 独占一行**；心率区间「118 分」的「分」折行
5. 字重层级、卡片圆角与间距、图标格和弹窗的视觉细化

⚠️ 改视觉之前先看一眼**真实的三星健康截图**。不要凭「编辑风格」这种模糊描述猜 ——
这个项目已经在 Liquid Glass 上因为「看着合理」被骗过一次。

---

## 常用命令

```bash
export PATH=/opt/homebrew/bin:$PATH
cd ~/Documents/CEVTUO-Z

bun run typecheck          # ⚠️ 改任何 dashboard 代码后都要跑（根 tsconfig 排除了 apps）
bun run app:build:h5       # H5 构建
bash scripts/deploy-pages.sh   # 发布到 gh-pages
bash scripts/deploy-ingest.sh  # 发布 services/ingest 到阿里云

# 本地预览（⚠️ 每次构建都会清掉 dist/data，要重新链）
mkdir -p /tmp/sv && ln -sfn ~/Documents/CEVTUO-Z/apps/dashboard/dist /tmp/sv/z
ln -sfn ../../../data apps/dashboard/dist/data
(cd /tmp/sv && python3 -m http.server 8125 &)
bun scripts/shot-panel.mjs "http://127.0.0.1:8125/z/#/pages/chealth/index?k=<口令>" /tmp/out 10

# 手机（⚠️ 必须带 -s，⚠️ 别用 AndroMeld 的 MCP）
D="adb-RFCY71VRZKJ-r2l6Vm._adb-tls-connect._tcp"
adb -s "$D" shell monkey -p com.cevtuo.health -c android.intent.category.LAUNCHER 1
#   按钮：① 授权 ② 探针 ②B 新鲜度 ②C 写入方 ②D 全量盘点 ②E 运动明细
#         ③ 立即上报一次（app 重启后 y≈1525） ④ 开自动上报
cd ~/cevtuo-health
JAVA_HOME="$HOME/android-toolchain/jdk/Contents/Home" \
  ~/android-toolchain/gradle/gradle-8.11.1/bin/gradle assembleDebug
adb -s "$D" install -r app/build/outputs/apk/debug/app-debug.apk
```

⚠️ **开本地预览前先 `lsof -nP -i :8096` 看一眼** —— 那里曾经有一个上次会话遗留的
bun 服务，我差点截到它的旧页面当成结果。

---

## 数据链路（别搞混）

```
Galaxy Watch8 ─▶ Samsung Health ─▶ Health Connect ─▶ CEVTUO Health(手机)
                                                          │ 每 15 分钟 POST
                                                          ▼
                                         阿里云 120.77.27.128:8789
                                                          │ GitHub API
                                                          ▼
                                                    gh-pages ─▶ CDN ─▶ 浏览器
```

⚠️ 服务端 → CDN 最多 **10 分钟**。刚推完就红，先看心跳的 `lastPushAt`，别急着改代码。

⚠️ Health Connect 里有**五个写入方**：`healthsync`（三星健康过桥）、
`com.google.android.apps.fitness`（**已排除，只排会话不排测量值**）、
`com.sec.android.app.shealth`、`android`（手机裸传感器）、`com.fitbit.FitbitMobile`。
**心率只有 healthsync 在写**；步数三家都写，绝不能相加。

⚠️ 小米那边（`com.mi.health` 跳绳 / `com.tangramfactory.smartrope`）在 Health Connect 里
**零条记录** —— 国产版「三方数据管理」里没有 Health Connect 入口（国际版有，
但拿不到米家设备的数据）。可行的路是**小米官方数据导出**（隐私中心 → 管理您的数据），
拿到 CSV 之后由 CEVTUO Health 的写权限写进 Health Connect。
写权限**已授**：`WRITE_EXERCISE` / `WRITE_DISTANCE` / `WRITE_ACTIVE_CALORIES_BURNED`。
⚠️ `READ_EXERCISE_ROUTES` **授不上**（系统里 `granted=false` 且没有 `USER_SET` 标记，
点授权也不弹对话框），所以**所有会话都没有 GPS 轨迹**。
