# CHEALTH 交接 —— 2026-09-28 收尾

> 给下一个窗口的自己/助手看。**先读「一句话现状」和「开场白」，其余按需查。**
> 上一版（09-24）里有一条**错的**，见下面「⚠️ 上一版交接里错的那条」——别再照它做。

---

## 一句话现状

**手机端的自动同步修好并验证通过**（09-28 12:29，后台推 16,502 字节、HTTP 202 committed、0 次读取失败）。
**阿里云的 HTTPS 已经打通**（`https://api.cevtuogrnd.com:8443`，实测 200）。
**网站 HTTPS 已开通并实测**（09-28 下午：`https_enforced: true`，HTTP 全部 301 跳转；
两个心跳从真实 HTTPS 页面拿到 200，无混合内容）。
**仪表盘当晚搬到了自己的域名 `https://z.cevtuogrnd.com/`**（根路径），
旧地址两条都仍然可用。⚠️ 搬域名踩的坑见「域名：两个域名，两回事」一节 ——
**必须做的有两处**：`ALLOWED_ORIGINS` 加新域名、`deploy-pages.sh` 写 CNAME。

⚠️⚠️ **开通 HTTPS 时踩到了一次真实的站点中断（约 20 分钟）** —— 根因是
gh-pages 里一个躺了六天的 `CNAME` 文件在抢域名。**动手前先读下面「域名归属」一节。**

```
Galaxy Watch8 ─┐
               ├─→ 三星健康 ─┐
MyWhoosh→Strava ┘            │
                             ├─→ Health Sync ─→ Health Connect ─→ CEVTUO Health (v2.4)
               手机传感器 ────┘                                          │ POST
                                                                        ▼
                                          阿里云 120.77.27.128:8789 (HTTP) ←手机/Kindle
                                                    │         :8443 (HTTPS，新)
                                                    │ AES-GCM
                                                    ▼
                                          gh-pages 密文 ──→ 浏览器用口令解开
```

---

## 开场白（直接复制给新窗口）

```
继续 CEVTUO-Z 的 CHEALTH 部分。先读 docs/CHEALTH-交接.md（2026-09-28 版）。
手机用 adb 操作（无线调试已开，别用 MCP —— 那条被 Cherry Studio 的工具清单卡住）。
  D="adb-RFCY71VRZKJ-r2l6Vm._adb-tls-connect._tcp"
  adb -s "$D" shell ...        # ⚠️ 必须带 -s，否则「多于一个设备」失败

当前可用的验证命令：
  bun run typecheck
  bun run services/ingest/verify-chealth.ts        # 76 条
  bun scripts/verify-cnsr-ui.mjs                   # 122 条，需先起本地服务
  bun scripts/verify-coof-ui.mjs                   # 97 条，同上
  bun scripts/verify-paperr-ui.mjs                 # 168 条，同上
  bun scripts/verify-https-live.mjs                # 9 条，打线上真实域名

我这轮想让你做：
  [在这里写你要做的事]

⚠️ 工作树已清空（2026-09-28）。但**推 main 之前先 `git fetch`** ——
   远端有定时 Actions 在写 `sync: coof data` 提交。
```

---

## ⚠️ 上一版交接（09-24）里错的那条 —— 别再照它做

上一版说「**CNSR / COOF 两个页面一直没做审计，是欠得最久的**」。

**审计早就做了**，`scripts/verify-cnsr-ui.mjs`（110 条）和 `scripts/verify-coof-ui.mjs`（97 条）
都是 2026-09-23 提交的（`930dd9a`），09-28 实测全绿。**没有任何东西要做。**
（这一版里 CNSR 套件已经从 110 涨到 **122**，见下。）

这是这个项目**第三次**出现交接记录与事实不符。**照着交接做之前，先花一分钟验一下它说的还在不在。**

---

## ✅ 2026-09-28 做完并验证的事

### 1. CNSR 两个 bug（已发布到线上，跑的是线上 URL）

| bug | 根因 | 修法 |
|---|---|---|
| 页面显示「N 天」比树里画的多 | `counts.days = st.segs.length`（`@日期` **标记**数），而树按**去重日期**画节点。Learn 有两条 09-20、TECH-AI 有两条 09-20 和两条 09-08 ⇒ 表头 7 天压 5 个节点 | 改成 `st.days.size` |
| `imagesSeen` 永远 0 | 从没被赋值；旁边的 `imagesSkipped` 也被 `st.cur = {}` 丢掉 | 在 push 段时算 `images.length + imagesSkipped` |

改完后 Shopping **正好顶满 5 图上限**，09-18 那张被挤掉 ⇒ 载荷里现在真实存在 `images:0 / imagesSeen:1`。

**CNSR 套件 110 → 122 条**，两条新断言都做了负向对照：
- 把 `days` 改回 6 → 三个视口全红
- 把 `imagesSeen` 置 0 → 「空转护栏」全红（这条护栏很值：它证明了另一条断言会空转通过）

⚠️ 「日标题里不出现负数」那条**当前不可能失败**（clamp 使其结构性成立），已改名标注为**哨兵**，别拿它当证据。

### 2. 阿里云 HTTPS —— `https://api.cevtuogrnd.com:8443` 已实测可用

```
https://api.cevtuogrnd.com:8443/health              → 200
证书 subject=CN = api.cevtuogrnd.com · Let's Encrypt · notAfter=Dec 27
```

完整链路，**全部绕开 yum**（CentOS 8.2 已 EOL，`yum install nginx certbot` 必失败）：

| 步骤 | 关键点 |
|---|---|
| DNS | 阿里云 hichina。`api.cevtuogrnd.com A → 120.77.27.128` |
| acme.sh | ⚠️ 服务器上 **`raw.githubusercontent.com` 超时**，但 **`codeload.github.com` 通** ⇒ `curl -sL https://codeload.github.com/acmesh-official/acme.sh/tar.gz/refs/heads/master \| tar xz -C /opt` |
| 证书 | **DNS-01 不需要 80 端口**：`acme.sh --issue --dns dns_ali -d api.cevtuogrnd.com --server letsencrypt --home /opt/acme-home --keylength ec-256` |
| 续期 | cron 每天 4 次；`--reloadcmd` 里**必须带 chown**（见坑） |
| TLS | **Bun 自己终结**，不装 nginx：`server.ts` 里加了 **8443 → 127.0.0.1:8789 的转发器** |
| 防火墙 | 轻量应用服务器 SWAS-OPEN API：`swas.cn-shenzhen.aliyuncs.com` / `2020-06-01`，**参数名是 `RuleProtocol` 不是 `Protocol`** |

阿里云凭据在 **`~/.aliyun/`**（`config.json` 600 权限 + 自写的 `rpc.mjs` 签名器，不进仓库）。

### 3. ⭐⭐ 手机自动同步为什么四天不动 —— 三层套娃，已修并验证

**症状**：心跳每 15 分钟更新，数据从 09-24 起四天不动。页面把两个时间戳并排显示，不置一词。

| 层 | 是什么 | 怎么发现的 |
|---|---|---|
| **1** | **manifest 缺 `android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND`** ⇒ 后台读 Health Connect 抛 `SecurityException: Caller does not have permission to read data … from other applications` | 前后台对照 |
| **2** | 每次同步 **450 次 `readRecords`**（30 天 × 15 类型）撑爆 Health Connect 配额 ⇒ `API call quota exceeded`（一次同步 451 次） | logcat |
| 3 | ~~Health Sync 漏天~~ / ~~手机没数据~~ | **两个都是错的**，别再往这两个方向查 |

**决定性证据是 app 自己打的字节数**（比任何截图都值钱）：

```
后台 12:14   同步 HTTP 200    157 字节   读取失败 46   ← 空载荷 ⇒ 服务器正确地回 unchanged
前台 12:17   同步 HTTP 200  18003 字节   读取失败 0
后台 12:29   同步 HTTP 202  16502 字节   读取失败 0   ← 修好之后
```

**修法**：
1. `SyncWorker.kt`：`for (i in DAYS - REFRESH_DAYS until DAYS)`，每次只回读 **3 天**（服务器按日期 merge，本来只需填缺口）⇒ 450 次降到 ~45 次
2. `AndroidManifest.xml`：加 `READ_HEALTH_DATA_IN_BACKGROUND`，然后 `adb shell pm grant` 授上

⚠️ 这两条**必须一起**：只修 #2 不修 #1，配额照样爆；只修 #1 不修 #2，后台读照样全拒。

---

## ⭐ 域名：两个域名，两回事（2026-09-28 晚定案）

| 域名 | 归谁 | 服务什么 |
|---|---|---|
| **`z.cevtuogrnd.com`** | **`cevtuocjw/CEVTUO-Z`** | **仪表盘，根路径** ← 真实站点 |
| `apps.cevtuogrnd.com` | **`cevtuocjw.github.io` 用户站** | 根 = CEVTUOGRND 落地页；`/CEVTUO-RWP/` = RWP |

**真实站点 = `https://z.cevtuogrnd.com/`**（`https_enforced: true`）。
旧地址两条**都仍然可用**：`apps.cevtuogrnd.com/CEVTUO-Z/` 直接服务同一份内容
（GitHub 按路径服务），`cevtuocjw.github.io/CEVTUO-Z/` 301 过去。
实测两边 HTML 与数据 md5 一致 —— 是同一份，不是副本。

### ⚠️⚠️ CNAME 规则（这是这份交接里最容易做错的一处）

⭐ **gh-pages 上必须有 `CNAME` 文件，内容必须是这个仓库真正拥有的域名。**

- ✅ **`z.cevtuogrnd.com`** —— 本仓库自己的域名
- ❌ **绝不能写 `apps.cevtuogrnd.com`** —— 那是**用户站**的域名。
  项目站声明了别人的域名，GitHub 就把它搬到那个域名的根路径、顶掉落地页、
  两个仓库打架（后设置的报 `Invalid cname: already taken by another
  repository in your account`）。
  ⚠️ **这个冲突不会自己暴露**：只要用户站那边也持有同一域名，两边能共存、
  站点看起来完全正常；只有当有人按文档「移除再重新添加自定义域名」去触发
  HTTPS 签发时才会炸出来 —— **而那一刻站点已经断了**（2026-09-28 实际发生过，
  中断约 20 分钟）。**恢复顺序**：删 gh-pages 的 CNAME →
  `PUT CEVTUO-Z/pages {cname:null}` → 再 `PUT 用户站/pages {cname:"apps.cevtuogrnd.com"}`。

⚠️⚠️ **`deploy-pages.sh` 是「新建舞台目录 → force-push」，舞台上没有的东西在
gh-pages 上就不存在了。** 所以它**必须自己写 CNAME** —— 我漏了这一步，GitHub
在设置自定义域名时写下的 CNAME 被 force-push 删掉，后果是 **`z.cevtuogrnd.com`
整站 404**（GitHub 的「Site not found」页），**而 API 里的 `cname` 字段仍然显示
正确** —— 一个只在真实域名的真实页面上才看得见的故障。
**换域名时 `deploy-pages.sh` 里那一行必须跟着改。**

### ⚠️⚠️ 换域名/开 HTTPS 时，「守卫 URL」会静默失效（咬过两次）

`deploy-pages.sh` 里那两个「取线上已发布版本」的 URL（paperr / chealth）
指向站点当前地址。站点一旦 301，而 `curl -fsS` **不带 `-L`**
⇒ 拿到空 body ⇒ JSON 校验失败 ⇒ **守卫静默失效**：

- 第一次（开 Enforce HTTPS）：**`data/chealth/index.json` 被从 gh-pages 删掉**
- 第二次（搬域名）：提前想到，拦住了

现已改成新域名**并且加了 `-L`**；chealth 那段取不到时**直接 `exit 1` 中止发布**
（paperr 能退回本地副本，chealth 退回不了 —— Mac 上根本没有那个目录）。

---

## 下一步（按顺序）

### ① 开网站 HTTPS 之前的两处改动 —— ✅ 已完成并实测

实测（Playwright）：HTTPS 页面 fetch `http://120.77.27.128:8789/…` 会
`requestfailed: mixed-content`，Chrome 直接拦。而 `fetchPaperrHeartbeat` /
`fetchChealthHeartbeat` 都是 `catch { return null }` ⇒ **页面显示一个「—」，零报错**。

1. `services/ingest/src/server.ts:97` 的 `ALLOWED_ORIGINS` 目前**只有 `http://apps.cevtuogrnd.com`**。
   站点变 HTTPS 后 Origin 是 `https://…`，**不在白名单 ⇒ CORS 照样拦死**。
   （服务器 `.env` 里没有 origin 覆盖，所以是代码默认值。）
2. `apps/dashboard/src/platform/data.ts` 的 `CHEALTH_HEARTBEAT_URL` / `PARRER_HEARTBEAT_URL`
   改成 `https://api.cevtuogrnd.com:8443/…`。

⚠️ 改完**必须在真实 HTTPS 上下文里验**。本地 `127.0.0.1` 是安全上下文，**这个坑已经骗过一次**。

### ② 开 GitHub Pages 的 HTTPS —— ✅ 已完成

```
https_enforced: true     http://  →  301  https://
证书实测 subject = apps.cevtuogrnd.com
https://apps.cevtuogrnd.com/{,CEVTUO-Z/,CEVTUO-RWP/}  全部 200
```

⚠️ **旧版这一节的两条判断都是错的，别再照着推理：**

| 旧版说 | 实际 |
|---|---|
| 「证书从来没签过」 | GitHub 一直拿 **`*.github.io` 兜底证书**（SAN 里没有该域名）⇒ 浏览器报 `ERR_TLS_CERT_ALTNAME_INVALID`。**是「签错」不是「没签」** |
| 「缺 GitHub 的 TXT 校验记录」 | **官方文档明确：域名校验不是 HTTPS 的前提**（只在域名被占用时才要）。`pending_domain_unverified_at` 和 `protected_domain_state` 都是 `null` |

**真根因就是上面那个 CNAME 冲突。** 清除后按官方文档做「移除再重新添加自定义域名」，
**一次成功**（`https_certificate.state = "approved"`）。

⭐ 两个操作要点：
- 「**移除再重新添加**」才是触发器；`PUT` **同一个值**回去是**空操作**。
- 判断证书**不要用 macOS 自带的 curl**（LibreSSL 3.3.6，打 8443 直接
  `Connection reset by peer`）。用 `node:tls` 看 `getPeerCertificate()` 或用 `bun` 的 fetch。

### ③ 提交 —— ✅ 已完成

6 个提交已推送到 `main`（`70b8c44`）。⚠️ **推之前先 `git fetch`** —— 远端有定时
Actions 在写 `sync: coof data` 提交，直接 push 会被拒。见「未提交清单」。

---

## ⚠️ 坑（每条都会复发；标 🆕 的是这次新踩的）

### 🆕 这次新踩的

- ⚠️⚠️ **`adb install -r` 会重置 Health Connect 授权？—— 实测：不会。**
  我一度这么以为并写进了结论。`dumpsys package` 显示普通 health 权限全是 `granted=true`，
  只有后台那条是 false。**先查 `dumpsys`，别猜。**
- ⚠️ **`adb exec-out screencap -p > x.png` 在 macOS 上产出坏 PNG**（`sips` 读不出尺寸）。
  用 `shell screencap -p /sdcard/x.png` + `pull`。
- ⚠️⚠️ **一台手机会同时出现两条 adb 连接**（一条带 ` (2)`），不带 `-s` 必失败。固定用一个名字。
- ⚠️ **`~/.aliyun/rpc.mjs` 里不能 slice 输出** —— 我 slice 2500 把 19 条记录的 JSON 截断，
  报错却是「Property name must be a string literal」，指向调用方而不指向那一刀。
- ⚠️ **调阿里云 API 要 `NO_PROXY=aliyuncs.com`**，否则走代理。
- ⚠️⚠️ **`acme.sh --install-cert` 写出的私钥属主是 root**，而 systemd 服务以 `cevtuo` 跑
  ⇒ `EACCES`，TLS 起不来。**chown 必须写进 `--reloadcmd`**，否则每次续期后又会静默挂掉。
  （和记忆里 `ln -sf /root/.bun/bin/bun` 那个 203/EXEC 是同一形状。）
- ⚠️ **`rg` 在阿里云那台机器上不存在**，用 `grep`。
- ⚠️⚠️ **一次失败的 `rg` 让 `&&` 链短路**，于是 typecheck/build 根本没跑，而我拿旧 bundle 探测
  然后奇怪为什么新代码没生效。**看到「没生效」先确认构建真的跑了。**
- ⚠️ **`rg --glob '*.scss'` 静默匹配 0 个文件**时，我据此误报「`chc__stale` 没定义」。
  它其实在 `ChealthComponents.scss:77`。**rg 返回空 ≠ 不存在，先换一种查法。**
- ⚠️⚠️ **判断 HTTPS / 证书不要用 macOS 自带的 curl。** 它是 **LibreSSL 3.3.6**，
  打 `api.cevtuogrnd.com:8443` 时握手阶段直接 `Connection reset by peer`（**exit 35**），
  而服务器**完全正常**。Chrome 和 bun 都没问题。
  ⭐ **改用 `node:tls` 取 `getPeerCertificate()`，或用 `bun` 的 fetch。**
- ⚠️⭐ **`ERR_TLS_CERT_ALTNAME_INVALID` 说明证书存在但名字不对，不是「没有证书」。**
  这两者症状完全不同 —— 我一度把前者读成后者，差点往「证书没签发过」的方向查。
- ⚠️ **`gh api "...?ref=gh-pages"` 在 zsh 里 `?` 会被当通配符**，不加引号整条命令失败
  （报 `no matches found`）。**URL 里带 `?` 一律加引号。**

### 测试方法本身会骗人

- ⚠️⚠️ **localhost 是「安全上下文」，线上 HTTP 不是。** `crypto.subtle` 在本地永远可用、
  在线上永远是 `undefined`。测加密、剪贴板、地理位置、Service Worker —— **本地跑通什么都不说明**。
- ⚠️ **CDN 10 分钟缓存**。`?t=` **没用**（GitHub Pages 的 CDN 忽略查询串）；用 `cache: 'no-store'`。
- ⚠️ **构建通过什么都说明不了，断言全绿也说明不了，截图也骗人。**
  唯一可靠的是：驱动真实页面、读事件前后的 DOM、然后**亲眼看图（而且要放大看）**。

### 静默失败（本项目高发区）

- ⚠️⚠️ **「回执是成功、数据没动」** —— 这是本项目最贵的形状，已经出现**至少四次**：
  `handleRebuild` 返回 202 被判成 200；CAPPERR 的 `unchanged`；CHEALTH 的
  `200 unchanged` 携带空载荷；以及这次手机报「同步成功」而服务器什么都没收到。
  **看到成功码不等于数据动了。**
- ⚠️ **`changed` 只看 days** → 运动明细变了却回 200「数据没有变化」。已修（会话变了也算）。
- ⚠️ **单类选择器之间胜负由样式表引入顺序决定**。`.chc__stack` 干不过 `.card`，因为 `demo.scss` 在后面。用两个类。
- ⚠️ **`&.card#{&}__stack` 会编译成 `.chc.card.chc__stack`**，要求三个类同时存在，**sass 不报错**。
- ⚠️ **属于组件的样式不能住在页面里**（图表 CSS 曾在 `pages/paperr/index.scss`，主页没 import 它）。
- ⚠️ **`deploy-pages.sh` 是「新舞台目录 + force-push」** ⇒ 舞台上没有的东西在 gh-pages 上就**不存在了**。
  已加保护（paperr / chealth 都取线上那份），输出里会打印「保留线上已发布的 …」。

### 数据类

- ⚠️ **Health Connect 载荷是 30 天滑窗** ⇒ 服务端必须按日期 merge。
- ⚠️ **`readRecords` 必须跟进 `pageToken`**，单页会少报 33 倍。
- ⚠️ **步数有三个写入方**（healthsync / fitness / android），直接 sum = 三倍。
- ⚠️ **保留期按「最新数据日期」算，不按墙上时钟**。
- ⚠️ **`TotalCaloriesBurnedRecord` 含基础代谢**（恒定 ~1662/天），必须和活动消耗分开显示。

### 手机操作类

- ⚠️ **不要用 adb 点三星健康那个「关于」页** —— 它会在两次 `uiautomator dump` 之间**重排**。这类页面让用户点。
- ⚠️ 版本号行下面紧挨着「京ICP备05068163号-86A」**链接**，点偏就跳浏览器。

---

## 验证套件（都要保持全绿）

| 命令 | 条数 | 覆盖 |
|---|---|---|
| `bun run typecheck` | — | `tsc -b` + dashboard 单独一遍（根 tsconfig **排除 apps**） |
| `bun run services/ingest/verify-chealth.ts` | **76** | 滑窗累积、0 不是缺失、密文不含明文、保留期不按墙上时钟 |
| `bun scripts/verify-cnsr-ui.mjs` | **122** | 「N 天」= 树里日数、图片上限有说明、裸链接、热力图 |
| `bun scripts/verify-coof-ui.mjs` | **97** | 年轮弹窗、波浪图、海报网格 |
| `bun scripts/verify-paperr-ui.mjs` | **168** | 书架、图表、CHEALTH 停摆判决（**夹具从索引的 `to` 推导**） |
| `bun scripts/verify-https-live.mjs` | **9** | **真实 HTTPS 域名**：页面自己发出的心跳请求拿到 200 且是 https |

### 本地起服务

```bash
cd ~/Documents/CEVTUO-Z
(cd apps/dashboard && bun run build:h5)
rm -rf /tmp/cevtuo-serve && mkdir -p /tmp/cevtuo-serve/data/chealth
cp -R apps/dashboard/dist/. /tmp/cevtuo-serve/
cp -R data/coof data/cnsr data/paperr /tmp/cevtuo-serve/data/
cp data/sync-meta.json /tmp/cevtuo-serve/data/
curl -sL --noproxy '*' -o /tmp/cevtuo-serve/data/chealth/index.json \
  "https://z.cevtuogrnd.com/data/chealth/index.json"
# ⚠️ `https://` 和 `-L` 都要 —— 站点开 HTTPS 后明文地址 301，
#    不带 `-L` 会拿到空 body，而后面的 JSON 校验会静默失败。
# 再起一个把 /z 映射到 /tmp/cevtuo-serve 的静态服务在 8096
```

---

## 常用命令

```bash
# ── 手机（adb 在 /opt/homebrew/bin，⚠️ 必须 -s）──
export PATH=/opt/homebrew/bin:$PATH
D="adb-RFCY71VRZKJ-r2l6Vm._adb-tls-connect._tcp"
adb -s "$D" shell input keyevent KEYCODE_WAKEUP
adb -s "$D" shell screencap -p /sdcard/_c.png && adb -s "$D" pull /sdcard/_c.png /tmp/p.png
adb -s "$D" shell uiautomator dump /sdcard/ui.xml && adb -s "$D" pull /sdcard/ui.xml /tmp/ui.xml
adb -s "$D" logcat -c ; adb -s "$D" logcat -d | grep CevtuoHealth

# 构建 + 装 app（~/cevtuo-health，⚠️ 不在 git 下）
export JAVA_HOME=~/android-toolchain/jdk/Contents/Home ANDROID_HOME=~/android-toolchain/sdk
TOK=$(grep '^CEVTUO_HEALTH_TOKEN=' ~/Documents/CEVTUO-Z/services/ingest/.env.server-backup | cut -d= -f2-)
~/android-toolchain/gradle/gradle-8.11.1/bin/gradle :app:assembleDebug --no-daemon -PcevtuoDeviceToken="$TOK"
adb -s "$D" install -r app/build/outputs/apk/debug/app-debug.apk

# ── 服务端 ──
bash scripts/deploy-ingest.sh          # 只传代码，不碰 .env

# ── 网站 ──
(cd apps/dashboard && bun run build:h5) && bash scripts/deploy-pages.sh

# ── 状态 ──
curl -s --noproxy '*' http://120.77.27.128:8789/api/chealth/heartbeat.json
curl -s --noproxy '*' https://api.cevtuogrnd.com:8443/api/chealth/heartbeat.json
bash scripts/chealth-phone-setup.sh status
```

⚠️ 宿主机有代理 ⇒ **脚本里的 curl 必须加 `--noproxy '*'`**（阿里云 API 走 `NO_PROXY=aliyuncs.com`）。

⚠️⚠️ **上面那两条 `curl https://…:8443/…` 在本机永远失败** —— macOS 自带 curl 是
LibreSSL 3.3.6，握手中就被 reset。**别把它读成「服务器坏了」**。改用：

```bash
bun -e "console.log(await (await fetch('https://api.cevtuogrnd.com:8443/api/chealth/heartbeat.json')).text())"
```

---

## ✅ 未提交清单 —— 已清空（2026-09-28）

工作树干净，6 个提交已推送到 `main`（`70b8c44`）：
CHEALTH 密文链路 / CNSR 两处修复 / 验证脚本重写 / 部署脚本去 CNAME /
线上 HTTPS 实测脚本 / 合并远端自动提交。

⚠️⚠️ **推 `main` 之前先 `git fetch`**：远端有**定时 Actions 在写**
`sync: coof data …` 提交，直接 push 会被拒。

⚠️⚠️ **那些自动提交可能是用旧提取器生成的。** 2026-09-28 实测：远端
`data/cnsr/techai.json` 的 `counts.days = 7`（旧 bug），本地是 `5`（修复版）。
- 但比对 `generatedAt` 和两边最新笔记日期后确认**两边数据一样新**，
  远端只是晚 53 分钟重跑一遍却带着 bug ⇒ **留本地的**。
- 合并用 `git merge origin/main`（不用 rebase，`ours` 语义更直观），
  冲突只在 `data/cnsr/*.json`，`git checkout --ours data/cnsr` 解决。

⭐ **`~/cevtuo-health`（手机 app 源码）已 `git init` 并首次提交**（11 文件）。
在此之前它一直是**裸目录** —— 修自动同步时改的 `SyncWorker.kt` 和
`AndroidManifest.xml` 没有任何备份。⚠️ **它没有远端仓库**，要单独备份。

---

## 手机上那个 App 的按钮

`CEVTUO Health`（`com.cevtuo.health`）不是产品，是诊断工具：

| 按钮 | 作用 |
|---|---|
| ①② | 授权 / 看库里有什么 |
| **②B 新鲜度** | 每个指标「数据是什么时候的」vs「什么时候被写进来的」 |
| **②C 各类型的写入方** | 按 `dataOrigin` 拆开九个类型。**最有用的一个** |
| ②D 全量盘点 | 34 个类型哪些有数据 |
| ②E 运动明细 | 每条运动的来源、段、圈、路线 |
| ③ 立即上报 | 手动推一次（**前台**，配额更高） |
| ④ | 打开每 15 分钟自动上报 |

⭐ **logcat 里 app 自己打的字节数是判据**：正常 1.6–2.4 万字节；**157 字节 = 读全失败了**。

---

## 一些数字（免得下次重新量）

- 手机：**SM-F9660**，国行 CSC=CHC，三星健康 7.00.6.012，**Android 16**，adb serial `RFCY71VRZKJ`
- 手机局域网 IP `192.168.8.37`（ARP 里叫 `jingwei-de-z-fold7`）
- Health Connect 支持 50+ 类型；App 申请 **31 个 READ 权限**
- **有数据的 11 类**：步数、距离、步频、总消耗、活动消耗、心率、静息心率、血氧、睡眠、运动、速度
- 09-23 那次骑行：36.92 km / 63 分钟 / 273W 均 / 470W 峰 / 76rpm / 心率 143 均 182 峰 / 1612 kcal
- 阿里云：**CentOS 8.2 EOL**、2 核 769MB、30G 盘用 3.2G、只监听 8789 + 8443
- 轻量服务器 InstanceId `3c48961bcca24df58794261b164faf71`；防火墙 80/443/22/ICMP/8789/8443
- **AndroMeld 免费版**：镜像启动 30 次/周（周一 00:00 GMT+8 重置）—— 有了 adb 就别开镜像了
