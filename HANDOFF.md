# CEVTUO-Z — 交接清单

> 给新会话里的 AI 助手看的第一份文件。读完这份就能接着干，不用重新调研。
> 最后更新：2026-09-23（Notion 列结构统一 + 海报入 Notion + 站点上线 + 面板填充 / 整块点击 / 大屏适配 / 年份切换）

---

## 一句话

个人数据仪表盘。四个品牌页：**COOF**（电影）/ **CNSR**（笔记）/ **CE-PaperR**（Kindle）/ **Chealth**（健康）。
目标形态：**微信小程序 + Android**，一套 Taro 代码。仓库根目录自包含。项目域名 `z.cevtuogrnd.com`。

---

## ⚡ 新会话第一件事：跑起来

```bash
cd /Users/cjw/Documents/CEVTUO-Z/apps/dashboard
bun run build:h5

rm -rf /tmp/v && mkdir -p /tmp/v/z
cp -R dist/* /tmp/v/z/
cp -R /Users/cjw/Documents/CEVTUO-Z/data /tmp/v/z/data
cd /tmp/v && python3 -m http.server 8096
```

打开 `http://127.0.0.1:8096/z/#/pages/coof/index`
⚠️ **必须带 `#/pages/<name>/index`**，Taro 是 hash 路由，不带 hash 是空白页。

截图：`bun scripts/shots.mjs http://127.0.0.1:8096/z /tmp/shots` → 2 主题 × 3 视口 × 全页面。

---

## ⭐⭐⭐ 本项目已栽过四次的错：拿指标当真相

1. 靠"测出来对齐了"宣布修好，截图里照样是坏的
2. 用 CDP 截本机 Chrome，**自动暗色反色**让截图是假的，把配色改到错方向
3. `shots.mjs` 的 `bg=` 只检查 style 字符串有没有内容 —— 浅色主题背景被压成一片平色时它照样报 `bg=true`
4. 本轮：测量面板留白时量了 `.section__body`，而它是 `flex: 1` **会撑满面板**，量到的是容器不是内容（得出 724px，实际 252px）

**改完视觉一定截图看。** 指标只能证明"我设的值是对的"，不能证明"用户看到的是对的"。
**测之前先问一句：我量的这个元素，真的是我想量的那个吗？**

---

## ✅ 2026-09-23 这一轮完成的事

### 1. ⭐ Notion 七个年历的列结构已统一到 COOF2026

**这是本轮最大的改动，动的是用户的真实数据。**

原本各年历的列名/类型几乎全不一样（`NAME` vs `name` vs `cou.`、`NUM` vs `NUMBER` vs `num ` vs `n+A2:H161um.`…）。
`cli/migrate-calendars.ts` 把它们全部改名为 2026 的结构，做了类型转换（rich_text→multi_select、
number→rich_text、rich_text→date），并把旧列删除。

**三个必须记住的设计点：**

1. **先对全部行做快照，所有目标值从快照算。** 因为建 `YEAR` 时会和已有的 `year` 在 `normKey`
   下撞名，读哪列就说不清了。
2. **取值直接调用 `normalize.ts` 的 `firstText/firstInt/firstDate/firstList`**（本轮把它们导出了）。
   迁移和 pipeline 必须共用同一套"这列是什么意思"。
3. **分三阶段**：改 schema → 逐行写值 → 删旧列。删列单独 `--drop-old`，且**有行写入失败就拒绝删列**。

**只靠列名会踩的坑（已实测）：**
- COOF2022 的 `kind`[select] 存的是 **「影」** —— 那是 `FILM` 的语义，不是 `KIND`（类型）
- COOF2022/2021 的 `ca`[title]、COOF2020 的 `cou.`[title] 存的是**类型**（"剧情/爱情/奇幻"），不是片名
- COOF2020 的 `cou.` 把类型和国家挤在一格："运动美国" 要拆成 运动 + 美国

### 2. ⚠️ 本轮我造成过一次数据损坏（教训在这里）

给迁移工具加"可重跑"保护时，我只做了 **schema 层**的幂等，**没做取值层**的。
`normKey` 是大小写无关的，第二次跑时 spec 里的 `'other'` 解析到了**已改名的 OTHER 列**，
把 Netflix 写进了 FILM；同时 `TIME`/`LONG`/`from` 找不到而返回 null，**把 Date、time、OTHER 清空了** ——
145 行，全程无报错。

修法：`TargetCol.sources` 按**原文精确名**判断源列是否还在，不在就跳过该列，而不是写 null。

但**同类问题后来又犯了一次**：删列那轮的 phase 2 里，2021 的 `Date` 源写的是 `'time'`，
而 `time` 这个名字**已被 `length` 接管**（`length`→`time` 改名），精确名闸门被名字碰撞骗过，
读到时长 "106" 没有日期 → 写 null → **106 行丢观影日期**（已从快照恢复）。

⇒ **教训：名字会被复用。改名操作之后，"某个名字还在"不等于"还是原来那一列"。**

### 3. 海报已全部上传进 Notion（不再依赖任何外部托管）

`cli/notion-posters.ts` —— 用 Notion 的 File Upload API 把 JPEG 传进用户工作区。

**为什么不是写外链**（原本的方案）：实测 `apps.cevtuogrnd.com` 的 TLS 证书是 **`CN=*.github.io`**，
`https_certificate: null`，**从没签发过** —— 内容只能走 HTTP，而 Notion 页面是 HTTPS，
图片会被按混合内容拦掉。用户站点 `cevtuocjw.github.io` 占着这个自定义域名，所以所有项目页都 301 过去。

**结果：7 个库合计 1184 张自托管 / 0 外链。**
⚠️ 判定条件是「**空 OR 有 external 条目**」—— 只判空会漏掉写了外链的行（COOF2025 曾有 191 条）。

### 4. 站点已上线

`scripts/deploy-pages.sh` 把 `dist/*` + `data/` 发布到 **`gh-pages` 分支**。
⚠️ **不是 `main:/docs`** —— Pages 把配置目录当站点根，`/docs` 之下拿不到仓库根的 `data/`，
而所有海报 URL 都是 `<site>/data/coof/posters/<id>.jpg`。

- 站点源：`gh-pages` / 根目录，已构建成功
- 可达：`https://cevtuocjw.github.io/CEVTUO-Z/index.html` → 200
- ⚠️ **手动发布**：自动化要动 `.github/workflows/`，而 keychain 里的 token 只有 `gist, read:org, repo`，
  **没有 `workflow` scope**，任何碰该目录的 push 会被整条拒绝

### 5. `normalize.ts` 已按统一后的结构简化

删掉了全部"大小写/变体兜底"链。**它们不只是冗余，是有害的**：
`mediaType` 的 `'other'` 兜底在结构统一后会匹配到 OTHER 列（备注），
于是 2020 读出 "Douban"、2022 读出 "Amazon Prime"、2023 读出 "BBC"。

### 6. 粘连选项已拆 / 站点文案已跟上

- `cli/split-multi-select.ts`：全库只有 1 个真粘连（2023 的 `冒险动作`）
- ⚠️ 规则是**完整分解**而非后缀剥离，且有**保护名单** —— `捷克斯洛伐克` 能完美分解成
  捷克+斯洛伐克，但那是历史上真实存在的单一国家，拆了就是篡改史实
- COOF 与首页的 lede 原本写着"海报已全部重托管到本地"，已改为描述新架构

---

## 📊 当前数据完整度（2026-09-23 实测）

```
年历       条目  片名  类型  国家  日期  时长  影剧  海报
COOF2020    216   216   213   209   210   214     0   213
COOF2021    107   107   102   107   106   107    52   106
COOF2022    236   235   235   235   235   235     0   234
COOF2023    145   145   145   144   145   145    94   144
COOF2024    152   146   145   146   146   144   122   145
COOF2025    204   194   194   194   194   194   162   194
COOF2026    149   148   147   148   148   148   144   148
```

`影剧` 为 0 的两年（2020/2022）**源数据里就没有这一列**，不是丢失。

`sync` 幂等成立：连跑两次都是 `写入 0 个文件`。

---

## 🔴 未完成

### ✅ 视觉：面板填充率已修（2026-09-23 下）

**实测**（phone 390×844）：修前首页面板内容 **252px / 844px = 30%**。

先试了加大字号（`clamp(40px, 13vw, 72px)`）→ **只从 30% 到 31%，没用**。
**结论：这是结构性的，加大字号解决不了。**

最终做法是**给面板加内容**：一条「最近看过」海报带（复用 `index.recent` 的前 10~12 条，
零额外请求）。

| 面板 | 修前 | 修后 |
|---|---|---|
| 首页 COOF | 30% | **53%** |
| COOF 页第 1 屏 | 30% | **54%** |

样式在 `styles/recent.scss`，由 COOF 页和首页共用。
⚠️ **partial 不会继承引用方的 `@use`** —— 抽出去时忘了加 `@use 'tokens.scss' as t;`，
构建直接报 "no module with the namespace t"。

**其余三个功能区（CNSR/PAPERR/CHEALTH）仍无数据源，填充率照旧。** 不是不想做，是没数据。

### ✅ 交互：整块面板可点 + 提示加大（2026-09-23 下）

- `Section` 新增 `onPress`，**挂在 `.section__body` 上而不是那个小卡片上**。
  `.section__body` 是 `flex: 1`，所以等于整屏可点。实测通过：
  点统计块、点导语、点面板空白处 —— 三种都跳转
- 未接入的三个品牌：点了停在原页弹 toast，不会跳进空白页（也已实测）
- 「下滑」提示从单个 ▼ 改成 **文字「下滑」+ 30px 大 ▼**（原来 20px 的 ▼ 被当成装饰性字符）
- 「打开」标签从 10px 提到 14px

⚠️ **又一次"加了功能但没接线"**：`onPress` 属性加进了 `Section`，**却忘了在首页传进去**，
第一次点击测试直接失败。和之前 `posters.ts` 里那个 adopt 死代码是同一类错误 ——
**功能写完必须测行为，不能只看代码在不在。**

### ✅ 脏选项已清（2026-09-23 下）

类型列里的脏数据已清零（`剩余可疑类型: 0`）：

```
crime, thriller      → 犯罪, 惊悚
犯罪片剧情片惊悚片     → 犯罪, 剧情, 惊悚
剧情.悬疑             → 剧情, 悬疑     ← 全角/半角分隔符都要认
纪录片之家字幕组       → 移除（是字幕组名，不是类型）
```

⚠️ **用户 Notion 的选项表本身仍有污染**，我没动（那是他的词表，不是行数据）：
COUNTRY 的 75 个选项里混着「传记 运动 动作 历史 奇幻 冒险」和一个粘连的「西班牙比利时」；
KIND 里有「nh」「犯规」。**建议他自己在 Notion 里清。**

影剧列仍有 3 条非「影/剧」的值（`Opera`、`短片`、`双姝 雨女 翻拍版 英版`），
来自源数据本身，量小未处理。

### ✅ 大屏适配 + 片单年份切换（2026-09-23 下 2）

**用户报告：「大屏看标题太小」「片单没标年份」「不该一次列出所有年份」「笔记本想要 6 列」**

- **竖排标题改为流体字号** `clamp(20px, 2.2vw, 34px)`。
  原本锁死 20px 的注释理由是「40px 时 CHEALTH 竖排 450px，会撞下滑提示」——
  **那是高度约束，却被套用到了所有宽度上**，所以笔记本上和手机上一样大。
  实测：390→20px / 673→20px / 1440→31.68px / 1920→34px
- **片单页年份**：竖排在「片单」标题**下方**（`Section` 新增 `subtitle`），带下划线表示可点。
  放在边栏是因为**手机上只有这条带子不占内容宽度**；横着放会吃掉一整行海报
- **年份选择器**：常驻 chips 全部移除，改为点年份弹出 sheet。
  实测 2026→2022：年份变、片数 149→236、选择器自动关
- **笔记本 6 列**：`Section` 新增 `wide`（`max-width: 1280px`，仅 expanded 档）。
  `.section__body` 那个 900px 限制是为**段落不变成全宽长条**设的，海报网格正好相反 ——
  实测 1440px 下 4 列 → **6 列**

⚠️ **同一类错误这个会话犯了三次**：功能写完但没生效。
`Section.onPress` 忘了在首页传；`Section.subtitle` 的点击**被 `.section__head` 的
`pointer-events: none` 继承吞掉**（那条带子为防止满高不可见层吞点击而设的），
标签是死的，第一次测试直接失败。
⇒ **`pointer-events: none` 的子元素想可点，必须显式 `pointer-events: auto`。**
⇒ **写完交互必须用真实点击测，不能看代码在不在。**

### ⚠️ 线上站点会过期 —— 用户看不到新功能先查这个

`gh-pages` 是**手动发布**的（`scripts/deploy-pages.sh`）。这个会话就因为**改完一直没重新部署**，
用户反馈「没看到最近看过海报带」。

排查线上是否为最新：
⚠️ **不要只 grep index.html 引用的 chunk** —— 页面代码是**按需懒加载**的，
index.html 只预载 `app.js`，页面 chunk（`542.*`、`679.*`）根本不在里面。
**用浏览器真实加载线上 URL 再查 DOM**。

### ✅ 文案/交互第二轮（2026-09-23 下 3）

- **chips 补回来了**。上一轮我把常驻 chips 删掉换成边栏选择器，**这是错的** ——
  概览面板从此没有任何换年份的入口，必须先把面板滑下去才行。
  两者回答的是不同问题：chips = 「从概览切到某年」，边栏标签 = 「我正在看哪年，顺便改」
- **数字更大更粗**：`clamp(48px, 16vw, 92px)` + `font-weight: 700`
  （原来 40px / regular，用户反馈在大屏太小、不够突出）
- **文案改为**：「CEVTUO's 观影记录」+ 大数字「N 个年历 / N 条记录」+「更新于 <时间>」
- ⚠️ **数字必须是全库合计**。`index.counts.total` 是**单个年历**的条数（COOF2026 是 149），
  而标签写的是「全部年历」。原来那版就是拿 149 配「全部年历」，页面自相矛盾
- **「更新于」取自 `data/sync-meta.json` 的 `generatedAt`**，切片格式化而非 `new Date()` ——
  时间戳自带 +08:00 偏移，重新解析会按设备时区渲染，伦敦的读者会看到不同的时间
- **下滑提示**：`Section` 新增 `cueText`，COOF 页用「下滑到下一页查看具体观影记录」
  （泛泛的「下滑」只说了手势，没说下去有什么）
- **片单滑动条**：右侧细轨 + 滑块，位置来自 ScrollView 的滚动比例

⚠️ **滑块初值踩的坑**：Taro 的 `onScroll` **只在滚动时触发**，所以没滚动前滑块停在初始值上。
我写死的 `0.2` 在 692px 轨道上渲染出 **138px 的滑块**，而真实比例是 3.5%（≈24px）——
**长了 6 倍，一滚就跳**。改为布局完成后用元素实测回填。实测 25px ✓

### ✅ 页面辨识度 + 切年回首（2026-09-23 下 4）

**用户反馈：「点进去的页面和首页版式太像了」「切年份后没跳到新年份的开头」**

- **每个品牌页顶部加报头**：`PageHero`（`欢迎来到` + 大号品牌名，`clamp(44px, 11vw, 96px)`）。
  起因是首页和品牌页渲染的是**同一个面板形状**（导语 + 两个大数字 + 一条横线），
  点进去像没点一样，"导航坏了"的感觉其实来自**版式没有区分**
- **品牌页数字改紧凑**：62.4px → **31.2px**。巨大的数字是**首页**的手法，
  品牌页有了报头就不该再重复一遍，否则刚拆掉的雷同又回来了
- ⚠️ `stats--compact` **同时缩字号和间距** —— 只缩字号的话，块占的垂直空间没变，
  面板读起来仍是"首页配了小号数字"

- **切年后回到列表顶部**：ScrollView 在换数据时**不会卸载**，只换子节点，
  所以 `scrollTop` 被保留 —— 从 COOF2026(149 部) 切到 COOF2022(236 部) 会停在
  旧偏移上，看起来像新年份"从中间开始"。
  修法是在 `titles` 变化的 effect 里显式 `el.scrollTop = 0`。
  实测：`scrollTop 4000 → 0` ✓

### ✅ Notion 式三视图（2026-09-23 下 5）

片单面板顶部加分段切换：**片单 / 时间线 / 日历**，三者读**同一份 `titles`**，
切换不重新取数（这正是切换能瞬时完成的原因）。

- **片单**：原有海报网格
- **时间线**：按月分组的列表，缩略图 + 片名 + 日期 + 右侧日号
- **日历**：月历网格，有观影的日子打点（不是缩略图 —— 1/7 手机宽度下约 40px，
  认不出是哪部片，**月份的形状才是这里的信息**）

⚠️ 两个视图都**显式报告**没有观看日期的条目（「另有 N 条没有观看日期」），
而不是静默丢弃 —— 一个悄悄少显示 26 部片的视图，比一个说明了的视图更糟。

实测：片单 1 个网格 / 时间线 148 行 / 日历 302 格，零报错。

### ✅ 视图切换 + 两个深链接 bug（2026-09-23 下 7）

**用户报告：「返回键丢了」「chips 没有玻璃框，只有文字」**

两个 bug 是**同一个根因**：**COOF 是唯一没有 `import '../../styles/demo.scss'` 的页面**
（另外四个页面都有），而 `.page`（页面内边距 + flex 列）和 `.chip` / `.chips` 都定义在里面。
Taro 只打包被 import 的样式，所以：

- 从首页点进来 → home 的 chunk 已带该样式 → 看着正常
- **直接打开 COOF 的 URL → chips 退化成纯文字**（实测 `border-width: 0px`、
  `background: rgba(0,0,0,0)`、高 21px 而非 34px），页面也没有左右内边距

⚠️ **这个 bug 之所以一直没被抓到，是因为它只在深链接时出现，而所有截图工具都是直接
打开页面的** —— 截图里 chips 一直没框，只是每次都当成设计如此。**看图和看代码都发现不了，
只有对比"两种进入方式"才暴露。**

顺带修：**返回键原本只在有 Taro 页面栈时出现**，深链接进来只剩 Z 字标，
浏览器返回键成了唯一出路（手机上不在屏幕上）。现在无栈时回首页，首页加 `root` 标记。

### 🔴 CNSR 数据源（用户 2026-09-23 提供）

用户说明：CNSR 的笔记在 Notion 的四个库 —— **Learn / Tech-learn / Tech AI / Shopping**。

**实测集成可见性**（`POST /v1/search` 全量分页）：

| 库 | 集成能否看到 |
|---|---|
| `Shopping timeline` | ✅ `c07be48a-aca9-4277-bdbf-467b2874816a` |
| `notionpagetechlearn` | ✅ `af733153-8a6f-4a0f-9446-275abaeef896` |
| Learn | ❌ 搜不到 |
| Tech AI | ❌ 搜不到 |

⚠️ **Notion 集成只能看到被显式共享的库**。要接 CNSR，用户需要先把缺失的那两个库
在 Notion 里 share 给集成（页面右上角 `⋯` → Connections → 选中集成）。
⚠️ 另外：`POST /v1/search` 带 `query` 时行为不一致 —— 搜「Tech」返回 0，
但不带 query 的全量列表里明明有 `notionpagetechlearn`。**别用带 query 的搜索做存在性判断，用全量分页。**

### 已完成

- **Notion 式 calendar/timeline 视角切换** ✅（片单 / 时间线 / 日历）
- CNSR / CE-PaperR / Chealth 仍是空壳（Phase 2/3/4），页面文案准确，只是没数据源
- Android APK —— 缺 JDK + Android SDK + gradle
- ICP 备案 —— **阿里云操作必须用户本人**（扫码/实名/支付）

### 已完成但用户手动做的

- **gallery 视图**，用户自己在 Notion 里加的。⚠️ **API 做不到** ——
  实测 `GET /v1/databases/{id}/views` → `400 invalid_request_url`，Notion 不暴露视图接口。
  以后别再承诺这个。

---

## ⚠️ 踩过的坑（别再踩）

### Notion / 数据

- **Notion API 改不了属性类型** —— 只能建新列→逐行搬值→删旧列，删列会连值一起没
- **删列不可逆**，所以永远先 `--drop-old` 关着跑一遍、验证过再开
- **改名会释放名字给别的列** —— 见上方数据损坏那节
- **`normKey` 大小写无关**，写"源列名"时要按精确名做存在性判断
- **Notion 不暴露视图接口**
- 值形态：`title` / `rich_text` / `number` / `date` / `select` / `multi_select` 的写入载荷各不相同，
  **读的类型和写的类型不一定一致**（`Date` 读出来是字符串，写进去要 `{date:{start}}`）。
  本轮就因为把两者混成一个 `kind` 字段，让 216 行报了 `Date is expected to be date`

### 站点 / 构建

- **不用 CDP 截本机 Chrome**（自动暗色反色）；**别信 `bg=` 字段**
- **Taro 4 的 webpack5 runner 收了 `copy.patterns` 但 H5 下不接线** ⇒ 用 `build:h5` 里的 `cp -R static/. dist/`
- **Taro 只打包被 import 的样式** —— 忘写 `import '...scss'` 会整页无样式**且零构建报错**
- **Taro 把 ScrollView 渲染成 `<taro-scroll-view-core>`**，浏览器按 `display:inline` ⇒ 必须用 `100vh/100dvh`
- **`env(safe-area-inset-top)` 无 fallback 是非法值**，会让整个 `calc()` 一并非法
- **主题 token 必须在同一元素上按类切换**（后代的自定义属性永远压过祖先）
- 背景图的三种错法（CSS `url()` / CSS 变量存相对 URL / 变量 + 分层 gradient）**全失败**，
  最终解是 `platform/background.ts` 用 JS 独占 `background-image`

### Shell / 工具

- **zsh 无匹配通配符会整条中止** —— `--include=*.ts` 要引号，或直接用 `rg`
- **脚本里 `$VAR：`（全角冒号）会被吞进变量名** → 用 `${VAR}`
- ⚠️ **本机 token 没有 `workflow` scope**，碰 `.github/workflows/` 的 push 会被整条拒绝
- 幂等性验证：**看"第二次跑是否 0 写入"，别信自己的计数器**

---

## 关键设计决策（别推翻）

| 决策 | 理由 |
|---|---|
| 健康数据走 Worker 鉴权 | **GitHub Pages 即使私有仓库也公网可读** |
| GitHub token 只放服务端 | 小程序包可反编译、H5 是明文 JS |
| **海报上传进 Notion，不写外链** | 自己的域名没证书；Notion 页面是 HTTPS，HTTP 图片被拦 |
| 抖音式的是 Taro 而非 Flutter/RN | 只有 Taro 能同时出小程序 + Android 且共享 UI |
| 切片用 `scroll-snap` 而非 JS 劫持 | JS 抢滚动会跟系统手势打架 |
| 三个写入方共用 `coofLibraryVersion()` | 各自内联版本算法 ⇒ 谁后跑谁重写，幂等性崩 |

---

## ✅ 提交状态（2026-09-23 收工）

**工作区干净，本地与远端同步，站点已部署。**

```
6d69500 docs: HANDOFF 交接说明改为可直接开工的形式
e70d04c docs: HANDOFF 记录深链接 bug 根因与 CNSR 数据源可见性
60f927b fix: COOF 页缺 demo.scss + 深链接时没有返回键
8079aca feat(coof): 滚动位置显示月份 + 日历格子改为可点击
15a5d28 docs: HANDOFF 同步三视图与提交流程
bec3cb1 data(coof): 列结构统一后的完整数据 + 1184 张海报
a11a692 feat: COOF 三视图 + 大屏适配 + 七个年历列结构统一
37ad6a7 sync: coof data 2026-09-23T03:26Z   ← 定时任务(旧代码)推的
```

代码与数据分成两个 commit，日后回滚互不牵连。
⚠️ `dataVersion` 算法本会话改过 ⇒ 所有 `library.json` 的版本号变了一次，属预期的一次性影响。

## 数据备份（恢复用）

| 位置 | 内容 |
|---|---|
| `/tmp/cevtuo-bak` | 本会话最早的全量 `data/`（海报补全之前） |
| `/tmp/pre-verify/COOF*.json` | **迁移前的 library.json**，本轮两次数据恢复都靠它 |
| `backups/dropped-columns-2026-09-23.json` | 被删掉的旧列全量值（704 行） |

## 🕐 新会话怎么开始（2026-09-23 下午）

**交接状态：工作区干净，本地与远端同步（`e70d04c`），站点已部署且线上就是最新版。**
不需要再做任何恢复动作，直接从下面挑一件事开始。

### 第一句可以这么说

```
读 ~/Documents/CEVTUO-Z/HANDOFF.md，然后继续。
优先做 CNSR：我已经把 Learn / Tech-learn / Tech AI / Shopping 四个 Notion 库
共享给集成了，你按 COOF 那套做同步管线。
```

### 待办（按价值排）

1. **CNSR（笔记）** —— 页面板式已在，是空壳，占位数字（1,024 / 180）是编的。
   数据源四个 Notion 库：**Learn / Tech-learn / Tech AI / Shopping**
   ⚠️ 上一轮实测只有 `Shopping timeline`(`c07be48a…`) 和
   `notionpagetechlearn`(`af733153…`) 对集成可见，另外两个搜不到 ——
   **用户需先在 Notion 里把缺的两个 share 给集成**（库右上角 `⋯` → Connections）
   做法参照 `pipeline/src/sources/coof/`，schema 里 `CnsrNoteSchema` 已经定义好了
2. **PAPERR（Kindle）** —— 数据源是 KOReader 的 `statistics.sqlite3`，
   页面文案已写清两条同步路径（插件推送 / 本机拉取），但没有实现
3. **CHEALTH（健康）** —— 数据源待定，⚠️ **绝不能进公开仓库**
   （GitHub Pages 即使私有仓库也公网可读），必须走 Worker 鉴权
4. **Android APK** —— 缺 JDK + Android SDK + gradle
5. **ICP 备案** —— **必须用户本人**（阿里云扫码 / 实名 / 支付），我代劳不了

### 几条不要再踩的（详见下方各节）

- ⚠️ **改完一定要 `bash scripts/deploy-pages.sh`** —— gh-pages 是手动发布的。
  这个会话就发生过"改完没部署，用户看不到新功能"
- ⚠️ **判断线上是否最新，要用浏览器真实加载再查 DOM** ——
  grep index.html 引用的 chunk 会得到 0 匹配，因为页面 chunk 是按需懒加载的
- ⚠️ **这个会话同一个错犯了三次：功能写了但没生效**
  （`Section.onPress` 忘了在首页传、`subtitle` 被 `pointer-events: none` 吞、
  COOF 页漏 import `demo.scss`）。**交互写完必须用真实点击测**
- ⚠️ **看图会骗人**：截图里 chips 一直没有边框，我每次都当成设计如此 ——
  真相是深链接时样式压根没加载。**对比两种进入方式才暴露**
- ⚠️ **Notion 集成只能看到被显式共享的库**；`POST /v1/search` 带 query 时行为不一致，
  **存在性判断要用不带 query 的全量分页**

---

## ✅ CNSR 已接入（2026-09-23 下 8）

**四个 Notion 来源接上了**，主页四块玻璃横条 + CNSR 页面（宽屏四列 / 窄屏弹窗）+ 时间线视图。
提交 `bcba278`，已推 main + gh-pages。

### ⭐⭐ 提取模型（改过两次，别再推翻）

1. **`@日期` 是分割标记，不是容器标题。** 一个日期开启一段，直到下一个日期为止。
   段边界与 toggle 嵌套**无关** —— 一段可以从一个 toggle 里开始、在另一个里结束。
2. **从页面末尾往前读。** 内容是新加的，最新的在底部；反向读能读够就停。
   Learn 从 **747 次请求 / 325 秒**降到 **13 次 / 5 秒**，四个源合计约 40 次请求。

`scripts/cnsr-extract.mjs`，用法：
```bash
bun scripts/cnsr-extract.mjs --only shopping          # 试跑
bun scripts/cnsr-extract.mjs --write --only shopping  # 写 data/cnsr/
```

### ⚠️⚠️ 这一轮踩的两个「会静默毁数据」的坑

**1. 反向读 + toggle 标题即日期 ⇒ 每天内容整体错位到前一天。**

用户把每天做成「标题是 `@日期` 的 toggle，内容在里面」。反向遍历时**子块先于
toggle 出现**，所以最新一天的内容在**遇到任何标记之前**就被访问了。当时的代码
把它当页面头部丢掉 —— 结果 5 天读出 **7/1/8/0/0 行**，每天的内容都落到了它前面
那一天。修法：缓冲区从第一块就存在，不再「遇到标记才开始收」。

**指纹：天数对了但行数分布怪异，且最新一天是 0。**

**2. 图片清理只看本次进程的源 ⇒ `--only learn` 删光 shopping 的图。**

`--only` 是独立进程，清理时不知道别的源的图还有用。改成**从磁盘上所有源的 JSON
读引用**。修复后实测 JSON 引用与磁盘文件完全一致。

⇒ **教训：任何「清理/删除」逻辑，判断依据必须来自完整真相，不能来自本次运行的部分视图。**

### 数据结构

`data/cnsr/<key>.json`（shopping/learn/techlearn/techai）+ `index.json`（每源独立 `updatedAt`）。
`data/cnsr/img/` 只有 Shopping 的图（上限 5 张）。

- **图片必须下载进仓库**，不能存 Notion 的 URL —— S3 签名 **1 小时失效**
- **每天最多 10 行**，超出记进 `more` 并在界面写明「另有 N 行未显示」
- **链接一律转成「名字」**，行内 URL 也认；界面上**不允许出现裸 http**

### ⚠️ Taro ScrollView 又咬了一次

`ScrollView` 渲染成 `<taro-scroll-view-core>`，浏览器当 `display: inline` ⇒ **`flex: 1` 对它无效**，
它会撑到内容高度。实测：CNSR 弹层里展开几天后，内容**盖住了自己的 ✕ 按钮**，
点击被文本节点拦截。

**解法固定：外面套一个 `position: relative; flex: 1; min-height: 0` 的 wrapper，
ScrollView 在里面对四边绝对定位。** `.cn__col-body` / `.cnsr-sheet__body` / `.cn__tlscroll` 都是这么做的。

### Notion 限速（查官方文档核实）

- 非 Business 计划 **180 请求/分钟（约 3/s）**，60 秒窗口、窗口内可突发；**另有工作区级共享限额**
- **`withRetry` 退避上限 2 秒，而 `Retry-After` 最长 60 秒** ⇒ 被限速时 3.5 秒内烧完全部重试
  然后整体失败。已改为优先采纳服务端等待 + 350ms 串行间隔 + jitter
- **COOF 默认只同步今年**（`--all` 可全量），实测 3.6 秒完成

### 🔴 还没做

- **「每块隔 2 天同步一次」的调度器。** 数据结构已就绪（`index.json` 每源独立
  `updatedAt`），但**没有任何东西去挑「这次该刷哪个源」**。目前一次跑全刷。
- 验证脚本：`scripts/verify-cnsr-ui.mjs`（84 项）、`scripts/verify-coof-ui.mjs`（97 项），
  **都支持对着线上 URL 跑**。

### ⚠️ 写验证脚本时踩的坑（不是页面的错）

- 宽屏有**四棵树**，「8 天展开」是 4 × 2 = 正确；断言 `=== 2` 是断言自己的 bug
- 切到时间线后**四列会被卸载**，链接检查必须在切换前做
- 弹层是**全屏遮罩**，没关掉就去点后面的卡片，Playwright 会报「被拦截」——
  看着像布局 bug，其实是对话框开着

---

## ⭐⭐ 项目约束：零 LLM 调用，全部免费（2026-09-23 核实）

用户明确要求：**除了服务器和域名，其余都必须免费、自动**。已全仓核实：

**没有任何 LLM API 调用。** 6 个 `package.json` 里没有 openai / anthropic /
langchain / ai-sdk / cohere / ollama 等任何 AI SDK。源码里 `OpenAI`/`Claude`/`GPT`
的命中**全部来自笔记正文**（用户自己记的 AI 笔记）和一条电影名。

**用到的外部服务，全部免费：**

| 服务 | 用途 | 费用 |
|---|---|---|
| Notion API | COOF + CNSR 数据源 | 免费 |
| GitHub Actions | 定时同步（公开仓） | 免费 |
| GitHub Pages | 站点托管 | 免费 |
| Google Drive（服务账号） | Chealth 数据 | 免费额度 |
| Strava API | 骑行数据 | 免费 |
| 自签 token | sync-trigger 鉴权 | 免费 |

密钥只有 `.env` / GitHub secrets 里那几个（`NOTION_TOKEN`、`GDRIVE_SA_JSON`、
`STRAVA_*`、`GH_PAT`、`CEVTUO_CLIENT_TOKEN`），**没有一个是付费 AI 服务**。

⚠️ `services/sync-trigger` **不是** Cloudflare Worker —— 项目没有 Cloudflare 账号，
同一套逻辑跑在 Mac 上（`bun run src/server.ts`，只听 127.0.0.1）。`core.ts` 与宿主无关，
将来要上 Worker 只是加个 adapter。

**改这个项目时不要引入任何需要 API key 的模型服务。**

## ✅ 2026-09-23 下 9：链接预览 / 滚动速度 / 热力图 / 全屏键

- **链接真的去抓目标页的 `<title>` 与 description**（`fetchLinkMeta`）。6 个链接抓到 5 个；
  IMDb 挡爬虫、supernote 失败 —— 失败就退化成「名字 + 站点名」，不报错。
  ⚠️ **改名必须同时改行文本**：`LineText` 靠在 `line.t` 里找链接文字来包一层，
  只改链接的 `t` 而不改 `line.t`，链接会**静默消失只剩纯文本**。
- **滚动横条：滚动与换行解耦。** 固定 **45px/秒**、**只滚一遍**、**装得下就不滚**、
  滚完再等 0.9 秒换行（装得下则固定 2 秒）。旧版把滚动硬塞进 2 秒 ⇒ 行越长越快，不可读。
- **箭头改成 CSS 画的 V 形**（两条边框旋转），不用 `▸` 字形 —— 各平台一致、可调粗细。
- **CNSR 页统计数字 → 热力图**：一格一天，按**行数 + 链接数×3** 着色（不是字数），
  可按来源切换，宽屏 60px / 窄屏 124px 高。**不按月分组**（总共只 5 天）。
- **CNSR 页删掉「下滑」提示**（`count={1}`，下面什么都没有），**宽屏去掉大标题**
  让来源/时间线顶到标题栏下。
- **宽屏每列加 ⤢ 全屏键** → 1100px 居中弹窗（比 296px 的列宽 3.7 倍），带关闭键。

`scripts/verify-cnsr-ui.mjs` 现有 **110 项断言**，三视口全过。

---

## ⚠️⚠️ 2026-09-23 下 10：链接大量丢失的真因（分支顺序）

**症状**：Shopping 里几乎看不到链接，用户点名 2026-09-05 那天一条都没有。

**根因**：`bookmark` 块的 URL 存在 `bookmark.url`、文字存在 `bookmark.caption`，
**两者都不在 `rich_text` 里**。实测 Shopping 深度 ≤3 有 **146 个 bookmark，URL 全有、
caption 全空** ⇒ `textOf()` 返回空串 ⇒ 而 `visit()` 里写的是：

```js
if (!text || IGNORED.has(b.type)) return;   // ← 空文本在这里就 return 了
if (LINK_BLOCK.has(b.type)) { ... }          // ← 永远轮不到
```

**146 个链接只剩 2 个。** 修法：把链接分支提到空文本判断**之前**。
修完链接 6 → 24（shopping 2→7，TECH-AI 3→13，tech-learn 1→4）。

⚠️ 教训：**「这个块有文字吗」和「这个块有内容吗」不是一回事。** 任何
`if (!text) return` 之类的早退，都要先问一句：会不会有哪种块，它的内容根本
不在 text 里？

## ⚠️ 弹窗的「黑板」问题：`.picker__panel` 的背景变量根本不存在

`background-color: var(--surface-raised)` —— **全项目从未定义过 `--surface-raised`**，
只此一处使用。`var()` 无值又无 fallback 会让**整条声明失效**，于是面板完全没有背景，
深色主题下就是一块黑。已改用 `glass-sheet` mixin。

同时把 CNSR / COOF 弹层的 alpha 从 **0.97 降到 `calc(--glass-tint-a * 1.7)`（实测 0.4）**
配更强的 backdrop blur；遮罩从纯黑 0.5 降到 0.3 + 背景模糊。

⭐⭐ **两个验证脚本里都写着「面板 alpha 必须 ≥ 0.94」—— 正是这条断言在逼着弹窗做成黑板。**
已改成断言 0.2–0.8 的玻璃区间。**断言会反过来塑造实现；写"必须不透明"的测试，
就会得到不透明的设计。**

## 图片

从全宽 `widthFix` 改成**居中、限宽 200px、`aspectFit`**。全宽时一张图会主导它所在的
那一天；`widthFix` 只按宽度算高度，竖图直接跑出列外。

## 验证脚本的坑（本轮又踩一个）

控制台 404 的 URL 在 `m.location().url`，**不在 `m.text()` 里** —— text 只有
"Failed to load resource: the server responded with a status of 404 ()"。
第一版过滤器拿 text 去匹配域名，既匹配不到也分不清第三方 favicon 和自己的文件。

### 2026-09-23 下 11：返回键、横条倒滚、玻璃统一

- **返回键有时候要点两次**：`Taro.navigateBack()` 在页面还在过渡、或栈还没建好时
  **会「成功」但不移动**，`fail` 回调也不会触发 —— 用户看到按钮是死的，只好再点一次。
  已加安全网：调用后 500ms 检查 hash 是否还是离开前那个，若是则直接跳首页。
  ⚠️ 500ms 不能更短：太短会让「慢但有效」的 pop 被首页压在头上，那比原 bug 更糟。
  实测 8 轮 × 2 视口（含开着弹窗的情况）**16/16 一击返回**。
- **横条会倒滚一行**：`shift` 是普通 state，换行时新行**带着上一行的位移挂载**，
  测量回来后再滑回去 —— 每行开头都倒着走一段。改成 `{line, shift, dur}`，
  位移只在「属于当前这一行」时才应用。
- **玻璃统一**：所有按钮改用与 chips 同一个 `glass-inset` mixin
  （视图切换、热力图切换、全屏键、关闭键、跳转按钮、卡片、COOF 的视图 tab）。
  两个手搓的玻璃近似值就是设计系统开始分裂的地方。
- **`\n` 换行**：`.section__lede` 加 `white-space: pre-line`，让 «· some of them» 单独一行。

### 2026-09-23 下 12：返回动画、PAPERR→CAPPERR、KOReader 插件

- **返回动画和 COOF 不一样** —— 是我上一轮加的**安全网自己造成的**。CNSR 页面重
  （四棵日期树 + 热力图 + 时间线要拆），pop 在 500ms 内没走完，安全网就抢先
  `navigateTo(首页)` —— **那是前进动画**。改成**重试 pop**（同方向同动画），
  只有第二次也失败才推首页。实测两页现在都是 15–61ms 离开，同一路径同一动画。
  ⚠️ 教训：**安全网如果走的是另一条路，它就会在被触发时改变用户看到的动画。**
- **PAPERR → CAPPERR**：只改**显示名**（TopBar / 页面标题 / 主页面板 / index.config）。
  内部 key、路由 `pages/paperr/`、`data/paperr/` 都**没动** —— 路由改名会让所有分享出去的
  链接失效，数据路径被 `paths.ts` 的 drift guard 钉住，那是迁移不是改标签。
- **KOReader 插件已写好**：`koreader-plugin/cevtuo-capperr.koplugin/`。
  读 `statistics.sqlite3`，导出 JSON 到设备可见分区，可选 POST。
  ⚠️ **统计库是 WAL 模式** —— 从电脑上 SFTP 拷主库会读到旧快照，只有在 KOReader
  进程内读才是当前的，这是插件存在的理由。
  ⚠️ **未在真机跑过**（手上没 Kindle），所以每一步包 pcall、失败明确弹消息。
  用 luaparse 验过语法（并做了负向对照确认检查有效）。
