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

### P2 — 功能

- **Notion 式 calendar/timeline 视角切换** —— 一行没写
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

## 未提交

工作区是脏的，**本轮没有擅自 commit 任何东西**。
建议分批：**代码一个 commit、数据（海报 + library.json）另一个**。
⚠️ `dataVersion` 算法本会话改过 ⇒ **所有 `library.json` 的版本号变了一次**，属预期的一次性影响。

新增文件：
```
pipeline/src/cli/{notion-posters,migrate-calendars,split-multi-select,local-posters,relink-posters}.ts
pipeline/src/sources/coof/version.ts
scripts/{shots.mjs,coof-schema-audit.ts,deploy-pages.sh}
backups/dropped-columns-2026-09-23.json   ← 删旧列前的全量备份，别删
```

## 数据备份（恢复用）

| 位置 | 内容 |
|---|---|
| `/tmp/cevtuo-bak` | 本会话最早的全量 `data/`（海报补全之前） |
| `/tmp/pre-verify/COOF*.json` | **迁移前的 library.json**，本轮两次数据恢复都靠它 |
| `backups/dropped-columns-2026-09-23.json` | 被删掉的旧列全量值（704 行） |

## 新会话怎么开始

> 读 `~/Documents/CEVTUO-Z/HANDOFF.md`。列结构统一、海报入 Notion、站点上线都已完成。
> 先跑一次 sync 确认幂等，再 `bun scripts/shots.mjs` 看视觉 —— 记住 `bg=` 是假的、要量对元素。
> 面板填充、整块点击、大屏适配、片单年份切换都已做完并实测。
> ⚠️ 改完记得 `bash scripts/deploy-pages.sh` —— 否则用户在线上看到的是旧版。
> 下一步是 CNSR / PAPERR / CHEALTH 的数据源，以及 Notion 式 calendar/timeline 视角切换。
