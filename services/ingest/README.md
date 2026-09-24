# services/ingest — Kindle 阅读统计的接收端

跑在**阿里云轻量服务器**上（`120.77.27.128`，地域 cn-shenzhen）。
Kindle 连上任何 WiFi 之后把导出 POST 到这里，这里再把它提交进仓库。

```
Kindle ──POST──▶ 这台服务器 ──commit──▶ GitHub ──workflow──▶ 站点
```

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

```bash
# 1. Bun
curl -fsSL https://bun.sh/install | bash && sudo mv ~/.bun/bin/bun /usr/local/bin/

# 2. 代码（只取这一个服务 + 它依赖的两个 workspace 包）
sudo git clone --depth 1 https://github.com/cevtuocjw/CEVTUO-Z /opt/cevtuo-ingest
sudo useradd --system --shell /usr/sbin/nologin cevtuo
sudo chown -R cevtuo:cevtuo /opt/cevtuo-ingest

# 3. 环境变量
sudo -u cevtuo tee /opt/cevtuo-ingest/.env >/dev/null <<'ENV'
CEVTUO_DEVICE_TOKEN=<随机长串，等下要抄进 Kindle>
CEVTUO_GITHUB_TOKEN=<fine-grained PAT>
CEVTUO_ADMIN_PASSWORD=<网页的密码>
CEVTUO_PORT=8789
ENV
sudo chmod 600 /opt/cevtuo-ingest/.env

# 4. 起服务
sudo cp /opt/cevtuo-ingest/services/ingest/systemd/cevtuo-ingest.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cevtuo-ingest
curl -s http://127.0.0.1:8789/health     # {"ok":true,...}
```

### PAT 只需要一个权限

- **Contents: Read and write** —— 提交原始导出和生成的 index

⚠️ **不需要 Actions 权限，也不需要仓库里有 workflow 文件。**
转换器跑在**这台服务器上**（`src/converter.ts` 调用 `pipeline/src/cli/sync-paperr.ts`），
不是跑在 GitHub Actions 里。最初的设计是提交原始文件然后由工作流转换，那要求
推送用的 token 有 `workflow` scope、服务器的 PAT 有 `Actions: write` —— 两个都不必要。

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
| GET | `/api/status` | Basic | 最后导出时间、书的数量 |
| POST | `/api/rebuild` | Basic | 重新生成 index.json（本机跑转换器） |

### `/api/paperr` 的三种结果

| 状态 | `status` | 含义 |
|---|---|---|
| 202 | `committed` | 阅读数据变了，提交了 |
| 200 | `unchanged` | 数据合法，但和已存的完全一样 —— **不提交** |
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
  "minIntervalMinutes": 30
}
```

## 验证

```bash
bun run services/ingest/verify.ts     # 39 项
```

拿**真实的设备导出**当 fixture，驱动真实的 `handleIngest`，GitHub 那侧是内存里的
假实现。覆盖凭据、体积（按**字节**算，不是字符）、各种畸形输入、以及
**「同样的阅读、晚一点的导出 ⇒ 零提交」**这条决定这个服务会不会淹掉仓库的规则。

真机发包之后再补一次 curl：

```bash
curl -s -H "Authorization: Bearer $TOKEN" --data-binary @data/paperr/raw-koreader.json \
     http://120.77.27.128:8789/api/paperr
```
