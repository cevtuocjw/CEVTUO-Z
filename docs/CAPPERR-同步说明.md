# CAPPERR 同步说明

Kindle 上的阅读统计怎么走到网站上，以及什么时候需要你动手。

## 一句话

**正常情况下你什么都不用做。** Kindle 连上 WiFi 就自己推，推完自动发布到网站。

---

## 数据是怎么走的

```
Kindle（KOReader 插件）
   │  ① 读 statistics.sqlite3，在设备上算好日/月/时聚合
   │  ② POST 一份 JSON 到阿里云
   ▼
阿里云 120.77.27.128:8789
   │  ③ 存下原始导出（只在这儿，不入库）
   │  ④ 跑转换器，算出公开的 index.json
   │  ⑤ 用 GitHub API 推到 gh-pages 分支
   ▼
GitHub Pages
   │  ⑥ 网站读 data/paperr/index.json
   ▼
http://apps.cevtuogrnd.com/CEVTUO-Z/#/pages/paperr/index
```

⚠️ 中间**没有你的电脑**。这就是当初把服务放到阿里云的全部理由 —— 读书发生在
通勤路上，而 Mac 那时候在包里合着盖。

---

## 什么时候会自动推

插件挂了三个钩子，都在后台静默执行（不弹窗）：

| 时机 | 延迟 | 说明 |
|---|---|---|
| **WiFi 连上** | 3 秒 | 最常见的情况。飞机落地、回到家、开热点 |
| **合上一本书** | 1 秒 | 一直在网时，读完一章就知道 |
| **设备休眠前** | 8 秒 | 一直在网、直接合盖时兜底 |

⚠️ 三者共用 **30 分钟的最小间隔**（`minIntervalMinutes`）。这是故意的：不合盖、
不开飞行模式的话，上面三个钩子会疯狂触发，而 Kindle 的电池是靠「几周」计的。

⚠️ 这个间隔**只在推送成功后才计时**。服务器临时挂了不会导致接下来 30 分钟沉默。

---

## 一键手动推

**KOReader 菜单 → 工具 → 导出阅读统计（CEVTUO）**

- 导出**并推送**，然后弹一个窗口告诉你结果（几本书、推到没有、路径）
- ⚠️ **不受 30 分钟间隔限制**。你按了就是「现在推」，不是「等冷却」
- 离线时也会导出，只是不推 —— 弹窗会说明

想确认同步到底通没通，就点这个，看弹窗。

---

## 每次更新 KOReader 之后要做什么

**先花 30 秒确认一下**：打开 KOReader → 工具菜单 → 看有没有「导出阅读统计（CEVTUO）」。

| 情况 | 要做什么 |
|---|---|
| 菜单里有 | **什么都不用做** |
| 菜单里没有 | 重新装插件（见下） |

**为什么一般是「有」**：KOReader 的更新是解压覆盖，只会动安装包里带的文件，
用户自己放的插件目录不在其中，所以会保留下来。同理，你的配置和 token 在
`koreader/settings/` 下，也不受影响。

**什么时候会丢**：如果你做的是「完全重装」（把整个 koreader 目录删掉再解压新的），
插件和配置都会没。这时候要重装插件，配置也得重新放一次。

### 重装插件

把 `cevtuo-capperr.koplugin/` 整个文件夹（或直接解压
`koreader-plugin/dist/cevtuo-capperr.koplugin.zip`）放到 Kindle 的：

```
koreader/plugins/cevtuo-capperr.koplugin/
```

⚠️ 是**这个层级**，不要多套一层变成
`koreader/plugins/cevtuo-capperr.koplugin/cevtuo-capperr.koplugin/`。

然后重启 KOReader。

### 配置还在不在

配置在 `koreader/settings/cevtuo-capperr.conf.json`（就是这个路径，不在插件目录里）：

```json
{
  "url": "http://120.77.27.128:8789/api/paperr",
  "token": "<设备 token>",
  "autoOnWifi": true,
  "minIntervalMinutes": 30
}
```

丢了的话找我要一份 —— token 在服务器的 `/opt/cevtuo-ingest/.env` 里，
**不要**发到任何公开的地方。

---

## 常见情况

**推了但网站没变**
先看管理页 `http://120.77.27.128:8789/`（密码在服务器 `.env` 的
`CEVTUO_ADMIN_PASSWORD`）里的「最后导出时间」。如果时间更新了但网站没变，
那是发布那一步的问题，告诉我。

**「阅读数据没有变化」是正常的**
插件每次连 WiFi 都推，服务器会逐字段比对（忽略 `exportedAt` 这个每次都会变的时间戳）。
没变化就不写、不提交。指示灯式的日志里会写 `unchanged`。

**换了 WiFi / 飞行模式**
不用管。下次连上自动推。

**Kindle 一直不推**
在工具菜单手动点一次，弹窗会告诉你原因（没配 URL、离线、服务器拒绝）。
如果弹窗说凭据不对，就是 token 配错了。

**服务器换了 IP**
配置文件里的 `url` 要改，插件不用动。

---

## 服务器的两个秘密

| 变量 | 放在哪 | 能干什么 |
|---|---|---|
| `CEVTUO_DEVICE_TOKEN` | **Kindle 上**（U 盘可见分区的明文文件） | 只能 POST 一份阅读统计 |
| `CEVTUO_GITHUB_TOKEN` | **只在阿里云上** | 只能写仓库里的一个文件 |

Kindle 上的东西是公开的 —— 插件文件躺在 U 盘可见分区，谁拿到设备都读得到。
所以设备拿的这个 token 没有别的权限：它不能读回数据，也碰不到仓库。

**中间那台服务器存在的全部理由，就是这个不对称。**
