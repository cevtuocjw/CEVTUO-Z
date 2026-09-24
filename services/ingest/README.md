# services/ingest — Kindle 阅读统计的接收端

跑在**阿里云轻量服务器**上（`120.77.27.128`，地域 cn-shenzhen）。
Kindle 连上任何 WiFi 之后把导出 POST 到这里，这里换算完再把结果发到网站上。

```
Kindle ──POST──▶ 这台服务器 ──GitHub API──▶ gh-pages ──▶ 站点
                     │
                     └─ 原始导出留在服务器上（永不入库）
```

⚠️ 上面这条链路里**没有 workflow**。早先画的是 `commit → GitHub → workflow`，
那条路需要服务器持有能推代码的 token、仓库里放一个 workflow 文件、还要烧
Actions 额度。现在服务器只调两次 REST API 更新 `gh-pages` 上的**一个文件**。

## 为什么不是「推到 Mac 的局域网上」

那是最初的设计，能跑，但形状是错的：**只在 Mac 醒着、且 Kindle 在同一个 WiFi
下才有效**。而读书这件事发生在通勤路上。放到有一台常在线的公网服务器上之后，
设备需要的就只是一个能上网的环境。

## 两个密钥，权限完全不同

| 变量 | 放在哪 | 能干什么 |
|---|---|---|
| `CEVTUO_DEVICE_TOKEN` | **Kindle 上**（明文 Lua 配置） | 只能 POST 一份阅读统计 |
| `CEVTUO_GITHUB_TOKEN` | **只在这台服务器上** | 能写仓库里的一个文件 |

Kindle 上的东西是公开的 —— 插件就是躺在 U 盘可见分区上的纯文本。所以设备拿的那个
token 没有别的权限，而能写仓库的 token 从不出现在设备上。**中间那台服务器存在的
全部理由，就是这个不对称。**

## 部署

⚠️ **跑的是打包好的单文件，不是 clone 仓库。**

这台机器是 **CentOS 8，已 EOL**：官方源全死了，没有 `git`，包管理器也装不上；
769MB 内存更放不下整个 workspace 的依赖安装。所以在开发机上 `bun build` 出两个
~150KB 的文件传过去，这台机器上**除 Bun 本身外不需要安装任何东西**。

⚠️ 打包会打断 `import.meta.url` 往上数三层的路径推导 —— `repoPath()`
(`packages/pipeline-core`) 和 `defaultRepoRoot()` (`src/converter.ts`) 两个都是。
两个都改成优先读 `CEVTUO_REPO_ROOT`。

**漏掉第二个不会报错。** 数据目录会变成 `/data`，被 systemd 的
`ProtectSystem=strict` 拦成 `EROFS: read-only file system`；如果没有那层加固，
服务会正常启动、正常回 200，只是永远找不到数据。

```bash
# 0. 开发机：打包（服务器上没有构建这一步）
bun build pipeline/src/cli/sync-paperr.ts --target=bun --outfile=/tmp/bundle/sync-paperr.js
bun build services/ingest/src/server.ts    --target=bun --outfile=/tmp/bundle/server.js

# 1. 服务器：Bun
curl -fsSL https://bun.sh/install | bash
# ⚠️ 拷真身，不要建符号链接。安装器把 bun 放在 /root/.bun/bin，而 /root 是 0700，
#    服务用户穿不进去 —— systemd 只会给一个没有上下文的 203/EXEC，日志里一个字
#    都不会解释为什么。
cp /root/.bun/bin/bun /usr/local/bin/bun && chmod 755 /usr/local/bin/bun

# 2. 服务器：目录与用户
useradd --system --shell /usr/sbin/nologin cevtuo
mkdir -p /opt/cevtuo-ingest/data/paperr

# 3. 开发机：传两个包 + 现有数据
scp /tmp/bundle/{server,sync-paperr}.js root@120.77.27.128:/opt/cevtuo-ingest/
scp data/paperr/{raw-koreader,index}.json data/sync-meta.json root@120.77.27.128:/opt/cevtuo-ingest/data/paperr/

# 4. 服务器：环境变量（走 stdin，不进 argv / history）
cat > /opt/cevtuo-ingest/.env && chmod 600 /opt/cevtuo-ingest/.env
#   CEVTUO_DEVICE_TOKEN=<随机长串，等下要抄进 Kindle>
#   CEVTUO_ADMIN_PASSWORD=<管理页密码>
#   CEVTUO_GITHUB_TOKEN=<fine-grained PAT>
#   CEVTUO_PORT=8789
#   CEVTUO_REPO_ROOT=/opt/cevtuo-ingest
#   CEVTUO_PIPELINE_CMD=/opt/cevtuo-ingest/sync-paperr.js

# 5. 起服务
chown -R cevtuo:cevtuo /opt/cevtuo-ingest
systemctl daemon-reload && systemctl enable --now cevtuo-ingest
curl -s http://127.0.0.1:8789/health     # {"ok":true,...}
```

### 两个文件，两个去处

| 文件 | 去哪儿 | 为什么 |
|---|---|---|
| `data/paperr/raw-koreader.json` | **只留在服务器上** | 设备原样导出。没有理由公开，而且它是设备所知的唯一一份拷贝 |
| `data/paperr/index.json` | **推到 `gh-pages`** | 页面读的就是它。转换器算出来的公开视图 |

⚠️⚠️ **需要一个 GitHub 凭据，这是绕不开的。**

曾经打算完全不要 —— 让数据只待在服务器上。**那样网站就永远看不到新数据**：页面
读的是 Pages 源，不是这台机器。上一版 README 写着「不需要任何 GitHub 凭据」，那句
话在那时是对的（转换和发布都还在 Mac 上做），但把服务器接进来之后就变成了错的，
而且错得**没有症状** —— 设备推得开心，服务器存得开心，网站一动不动。

用的是 **fine-grained PAT**，范围压到最小（已实测）：

- 只授权 `cevtuocjw/CEVTUO-Z` 一个仓库，其余一律 404
- 权限只给 **Contents: Read and write**
- 实际只能写 `data/paperr/index.json` 这一个路径

`src/publish.ts` 用两次 REST 调用完成，**不装 git**。先 GET 读回远端内容比字节，
**一样就什么都不做** —— 设备每次连 WiFi 都推，无条件 PUT 就是每 30 分钟一个空提交，
正是 `handleIngest` 已经在防的那件事。

⚠️ **备份靠设备**：KOReader 在 `statistics.sqlite3` 里留着完整历史，插件每次都全量
导出，所以服务器丢了，下次同步就恢复了。这是「唯一一份放在这儿」可以接受的原因。

### 公开 / 私有的分界

| 文件 | 谁看得见 | 内容 |
|---|---|---|
| `data/paperr/index.json` | **公开**（提交 + Pages） | 历史、图表、书架、总计 |
| `data/paperr/raw-koreader.json` | 服务器本地 | 设备原样导出 |

⚠️ 这里**曾经**还有一行「需要口令」的 `current.json`（只有正在读的那一本）。
读者决定整个阅读面板都公开之后，没有任何东西再写它，路由只能永远回 404 ——
已删除。同一本书在 `index.json` 的 `current` 字段里，公开，页面直接渲染。

`CEVTUO_ADMIN_PASSWORD` **不设就没有管理页**（`/` 和 `/api/status` 一律 401）。
这是故意的：忘记设变量应该导致「没有页面」，而不是「页面把书房公之于众」。

## ⚠️ 阿里云这一台在深圳，所以没有 HTTPS

大陆地域的服务器，**域名绑 80/443 需要 ICP 备案**，而备案必须你本人去办。

所以这里的走法是**裸 IP + 非标准端口，不用域名** —— 不涉及备案，今天就能用。

代价说清楚：**HTTP 是明文，设备 token 在链路上可被嗅探。** 后果的上限是别人能往
你的统计里塞假数据 —— 他拿不到仓库权限、改不了别的东西。可接受，但这是个已知的
取舍，不是疏忽。

> 将来如果你备案了、或者换到香港/海外地域，改成 HTTPS 只是把插件配置里的
> `url` 换成 `https://你的域名/api/paperr`，服务端不用动。

### 安全组只开这一个端口

阿里云控制台 → 安全组 → 入方向：**只放行 8789**。不要为了省事开一段范围。

## 接口

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 存活探测。不需要凭据，否则监控脚本也得持有一个 |
| POST | `/api/paperr` | Bearer `CEVTUO_DEVICE_TOKEN` | Kindle 推数据 |
| GET | `/` | Basic | 管理页 |
| GET | `/api/status` | Basic | 最后同步 / 数据变化 / 设备插件版本 / 书的数量 |
| GET | `/api/paperr/heartbeat.json` | **无** | 页面读的同步心跳。只有时间戳，没有书目 |
| POST | `/api/rebuild` | Basic | 重新生成 index.json（本机跑转换器）并推送到网站 |

⚠️ 心跳端点是**公开**的，这是故意的：页面用它回答「Kindle 还在同步吗」，
而把它放到管理口令后面，意味着唯一能看见它的人是那个已经知道怎么查的人。
它不带书名、不带每本书的数据，只有「最后一次推送是什么时候」。

### `/api/paperr` 的三种结果

| 状态 | `status` | 含义 |
|---|---|---|
| 202 | `committed` | 阅读数据变了，提交了 |
| 200 | `unchanged` | 数据合法，但和已存的完全一样 —— **不提交** |

⚠️ ⚠️ `unchanged` **也会更新心跳**。它是读者唯一能看见「设备确实来过」的地方：
不重写原始导出是刻意的（那是不产生空提交的代价），但「设备来了」和「数据变了」
是两件事，而把它们混为一谈，正是让一次正常同步看起来像坏掉的原因。
| 400/401/413 | `rejected` | 格式不对 / 凭据不对 / 太大 |

⚠️ `unchanged` 是**最重要**的一条。插件每次连 WiFi 都推，而设备每次都重新打
`exportedAt` 时间戳 —— 直接比字节的话，**每 30 分钟就是一个空 commit**，
既淹没真实改动，又烧 GitHub Pages 的构建配额。所以比较时忽略 `exportedAt`。

### 「同步」在这边不等于「去设备拿」

⚠️ **拿不了。** Kindle 没有入站地址、大部分时间在睡眠、还在不知道哪个 NAT 后面。
所以管理页上那个按钮**不是**去拉设备数据，而是**拿仓库里已经存着的原始导出重新
跑一次转换器**。修完转换器的 bug 之后，这正是你想要的，而且完全不需要碰设备。

⚠️ 转换失败**不会**影响原始导出。原始文件先提交、且永远保留 —— 它是设备所知的
唯一一份拷贝，而设备可能几天都不再同步。index 随时可以从它重新算出来。

## Kindle 上的配置

放在 KOReader **设置目录**里的 `cevtuo-capperr.conf.json`：

```json
{
  "url": "http://120.77.27.128:8789/api/paperr",
  "token": "和服务器上 CEVTUO_DEVICE_TOKEN 一致",
  "autoOnWifi": true,
  "minIntervalMinutes": 15
}
```

## 验证

```bash
bun run services/ingest/verify.ts     # 63 项
```

拿**真实的设备导出**当 fixture，驱动真实的 `handleIngest`，GitHub 那侧是内存里的
假实现。覆盖凭据、体积（按**字节**算，不是字符）、各种畸形输入、以及
**「同样的阅读、晚一点的导出 ⇒ 零提交」**这条决定这个服务会不会淹掉仓库的规则。

真机发包之后再补一次 curl：

```bash
curl -s -H "Authorization: Bearer $TOKEN" --data-binary @data/paperr/raw-koreader.json \
     http://120.77.27.128:8789/api/paperr
```
