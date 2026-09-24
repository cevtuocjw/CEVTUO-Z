# CEVTUO CAPPERR — KOReader 插件

把 KOReader 自己的 `statistics.sqlite3` 导出成 JSON，供 CEVTUO-Z 的 CAPPERR 页面使用。

## 为什么是插件，而不是从电脑上 SFTP 拉数据库

⚠️ **统计库是 WAL 模式。** 只把 `statistics.sqlite3` 拷出来，很可能读到**旧快照** ——
最近的阅读还在 `-wal` 文件里，要等一次 checkpoint 才会合并进主库。

在 KOReader **进程内部**用 ljsqlite3 读，是唯一能保证数字是当前的办法。
SFTP 那条路保留作备用，给跑不了插件的设备用。

## 安装

KOReader 的插件就是 `koreader/plugins/` 下的一个 `.koplugin` 文件夹。

**Kindle**（USB 连上电脑后，`koreader` 目录在可见分区根目录）：

```bash
cp -R koreader-plugin/cevtuo-capperr.koplugin /Volumes/Kindle/koreader/plugins/
```

**Kobo / 其他**：把 `cevtuo-capperr.koplugin` 整个文件夹放进设备的 `koreader/plugins/`。

然后**重启 KOReader**（插件只在启动时扫描）。

## 使用

菜单 → **工具** → **导出阅读统计（CEVTUO）**

成功会弹一条消息，告诉你导出了几本书、文件写到了哪里。

输出文件落在**用户可见分区**的根目录 —— 也就是 `Device.home_dir`：
Kindle 是 `/mnt/us/`，Kobo 是 `/mnt/onboard/`。这个值由 KOReader 按机型自己维护，
插件不猜。USB 插上电脑就能直接拿走。

⚠️ 只有在 `Device.home_dir` 为空或那个目录不存在时，才退回到 `/mnt/us`、
`/mnt/onboard`、`/mnt/sd`、`/mnt/ext1` 这个列表去逐个探测，最后才落到 KOReader 设置目录。

> 第一版这里是**写死的列表，而且认错了设备**：把 `/mnt/onboard` 标成 Kindle
> （那其实是 Kobo），Kobo 的 SD 卡也写成了 `/mnt/sdcard`（实际是 `/mnt/sd`）。
> 列表本身能靠探测蒙对，但对着一张错的对照表去排查问题，会查错方向。

## 自动同步：一连上 WiFi 就推送

配好 `cevtuo-capperr.conf.json`（放在 KOReader **设置目录**，和 `statistics.sqlite3` 同一个目录）：

```json
{
  "url": "https://你的域名/api/paperr",
  "token": "你的-device-token",
  "autoOnWifi": true,
  "minIntervalMinutes": 30
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | — | **必填**。没有它 = 不自动同步，只写文件（这是合法模式，不是错误） |
| `token` | — | 以 `Authorization: Bearer <token>` 发出 |
| `autoOnWifi` | `true` | 显式写 `false` 才关掉 |
| `minIntervalMinutes` | `30` | 两次自动推送的最小间隔 |

之后**WiFi 一连上就自动导出并推送**，不用碰菜单，也不弹任何消息。
把 conf 文件丢进设备即可生效，**不用重启** —— 事件是常驻注册的，开关在处理器内部读。

⚠️ **URL 和 token 放在这个文件里，不写进插件源码。** 插件是躺在 USB 可见分区上的
纯文本 Lua 文件，硬编码在里面等于谁拿到设备谁就能读到。

### 为什么挂在「网络连上」而不是「关书」

关书就推送，会逼 KOReader 主动去拉起 WiFi —— 一台本来能撑几周的设备会掉电飞快。
挂在 `NetworkConnected` 之后，网络是**别人已经拉起来的**，我们不欠这份电费。

事件用 `UIManager:scheduleIn` 延后 3 秒才动手：`NetworkConnected` 触发时连接还在
收尾，而且推送请求是阻塞的，在处理器里直接发会让界面卡在连接动画上。

### 三个刻意的选择

- **静默。** 自动推送不弹消息 —— 读者没要求它发生，弹窗就是打扰。
  失败只写日志，下次连上会重试；想要明确答复就用菜单里的手动项。
- **失败不推进时间戳。** 只有推送**成功**才记 `lastPushAt`。
  否则服务器抽风一分钟，会让后面半小时都不再尝试。
- **时间戳落盘**（`cevtuo-capperr.state.json`）。Kindle 上关一本书可能就是一个新的
  KOReader 进程，内存里的防抖会不断归零 —— 那「连 WiFi 就同步」就悄悄变成了
  「每次连 WiFi 都同步」，正好是防抖要挡的事。

### ⚠️ 请求会阻塞界面

`pushPayload` 走 luasocket **同步**请求，跑在 KOReader 的 UI 线程上。所以
`http.TIMEOUT = 20` 是必须的：没有它，一个「接了连接然后不吭声」的服务器会让设备
**看起来像死机**，而不是像同步失败。几十 KB 的 payload 没问题；将来 payload 变大，
正确的做法是挪进后台任务。

## 它读什么、不读什么

**只读** `statistics.sqlite3`，只发 SELECT 和 PRAGMA，不改任何一条阅读统计，
不碰 Reading Insight、不碰任何别的插件的存储。

| 字段 | 来源 |
|---|---|
| 书名 / 作者 / 丛书 / 页数 / 最后打开 | `book` 表 |
| 累计时长 / 累计页数 | `book.total_read_time` / `total_read_pages` |
| 划线数 / 笔记数 | `book.highlights` / `book.notes` |
| 进度 | `page_stat_data` 里**最后读的那一页** ÷ 总页数 |
| 每日时长与翻页 | `page_stat_data` 按天聚合 |

⚠️ **进度没有现成字段**，统计库里不存百分比 —— 是从最后读的那一页算出来的。
且只认 `page > 0` 的行：`page` 列的默认值是 0，一条没落到实页上的记录如果
start_time 最新，会把一本快读完的书报成 0%。

⚠️ **每日聚合在 SQL 里做**，不是在 Lua 里。重度读者 `page_stat_data` 有几十万行，
全读进内存是让设备因 OOM 被杀掉的经典方式。

⚠️ **列会先探测再选。** `highlights` / `notes` / `total_read_pages` 都是后来版本才加的列，
在旧库上直接 SELECT 会硬报错、整个导出失败。探测过之后，旧设备照样能导出，
只是少那几个字段。

⚠️ 关于"绝不写库"的准确说法：连接是**读写模式**打开的，因为 WAL 库在无法创建
`-shm` 文件时**根本不允许只读打开** —— 而那正是这台设备的情况。SQLite 关闭时
可能自己做一次 WAL checkpoint，那是它自己的簿记，不是数据改动。

## ⚠️ 第一版的两个硬伤（已修）

第一版是照着记忆里的 lsqlite3 API 写的，**装上必定弹错**。两个都验过：

1. **`db:nrows()` 这个方法不存在。** KOReader 用的不是通用 lsqlite3，是 stepelu 的
   ljsqlite3，全部查询接口只有 `exec`（按**列**返回）/ `rowexec` / `prepare`+`step`。
   （出处：<http://scilua.org/ljsqlite3.html>，以及 KOReader 自己的 `statistics.koplugin`
   和 `vocabbuilder.koplugin` —— 两者都用 `prepare`/`step` 遍历行。）
2. **模块名写错。** 第一版 `require("ljsqlite3")`；KOReader 里是
   **`require("lua-ljsqlite3/init")`**。

⚠️ 真正危险的不是报错，是**报错的内容是假的**：模块名错了会弹「这个 KOReader 没有带
ljsqlite3」，方法名错了会弹「统计库里没有 book 表」—— 两条都会把人引到错误的排查方向。
两个假消息都在 `test/` 里被复现过（见下）。

⚠️ 还有一个只在真机上才会咬人的：ljsqlite3 把 SQLite 的 INTEGER 读成
**`cdata<int64_t>`**，不是 Lua number。直接 `tostring` 会得到 `"7LL"` 而不是 `"7"` ——
书 id 会全带 LL 后缀。所有数字都过一遍 `num()`（就是 KOReader 自己用的 `tonumber()` 包装）。

## 测试：不用真机也能跑

```bash
cd koreader-plugin/test && ./test.sh
```

它拿**真实的 sqlite3 库**（表结构抄自 KOReader 的 Statistics 插件）跑插件**真实的
`buildPayload()`**，在 LuaJIT 下。假的只有周围环境：KOReader 的 UI 模块，
以及 ljsqlite3 本身（用 sqlite3 命令行做的 shim，**INTEGER 照旧返回 cdata<int64_t>**，
所以数字处理这条路径是真的被测了）。

五个分支共 **112 条断言**：

| 模式 | 覆盖 |
|---|---|
| `main` | 5 本书；NULL 列、无页数书、空 last_open、书名里的单引号/换行/中文；进度与每日聚合 |
| `legacy` | 老版本库（没有 `notes`/`highlights`/`total_read_pages`）照样能导出 |
| `notime` | 连 `total_read_time` 都没有时，报的必须是那句明确的错 |
| `nopagestat` | **没有 `page_stat_data` 表**时，书单照常导出，只有进度和每日为空（并写日志） |
| `auto` | 自动同步的接线：配置开关、防抖、失败不推进时间戳、`minIntervalMinutes` |

⚠️ 它**证明不了**插件在 Kindle 上能用。它证明的是真正咬过人的那一层：SQL、
行遍历 API、数字处理，以及「功能写完有没有接线」。

## 真机结果（2026-09-24）

在 Kindle 上跑通了：菜单项出现，弹出「已导出 41 本书的阅读统计」，
文件落在 **`/mnt/us/cevtuo-capperr.json`** —— 正是 `Device.home_dir` 预测的那条路径。

| 部分 | 状态 |
|---|---|
| 数据层（SQL / 行遍历 / 数字处理） | ✅ 测试台 112 条断言全过 + 真机导出成功 |
| 菜单接线、`Device.home_dir` 输出路径 | ✅ 真机确认 |
| **网络推送 / 自动同步** | ⚠️ **仍未在真机上验证** —— 目前还没有可推送的接收端 |

自动同步的代码路径由测试台的 `auto` 分支驱动验证（模拟设备发出的
`NetworkConnected` 事件），但**没有一次真实的 HTTP 请求离开过这台 Kindle**。
接收端做好之后再补这一次真机验证。
