# CEVTUO CAPPERR — KOReader 插件

把 KOReader 自己的 `statistics.sqlite3` 导出成 JSON，供 CEVTUO-Z 的 CAPPERR 页面使用。

## 为什么是插件，而不是从电脑上 SFTP 拉数据库

⚠️ **统计库是 WAL 模式。** 只把 `statistics.sqlite3` 拷出来，很可能读到**旧快照** ——
最近的阅读还在 `-wal` 文件里，要等一次 checkpoint 才会合并进主库。

在 KOReader **进程内部**用 sqlite3 读，是唯一能保证数字是当前的办法。
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

输出文件按设备类型落在这几个位置之一：

| 设备 | 路径 |
|---|---|
| Kindle | `/mnt/onboard/cevtuo-capperr.json` |
| 部分 Kindle 固件 | `/mnt/us/cevtuo-capperr.json` |
| Kobo（SD 卡） | `/mnt/sdcard/cevtuo-capperr.json` |
| 都找不到时 | KOReader 设置目录下 |

USB 插上电脑就能直接拿走 —— 这是"备用路径"存在的意义。

## 直接推送到服务器（可选）

建一个 `cevtuo-capperr.conf.json`，放在 KOReader 的**设置目录**里
（和 `statistics.sqlite3` 同一个目录）：

```json
{ "url": "https://你的域名/api/paperr", "token": "你的-device-token" }
```

⚠️ **URL 和 token 放在这个文件里，不写进插件源码。** 插件是躺在 USB 可见分区上的
纯文本 Lua 文件，硬编码在里面等于谁拿到设备谁就能读到。

⚠️ 推送**只在 WiFi 已经连着的时候**尝试。为了推送去主动拉起 WiFi，会让一台
本来能撑几周的设备掉电飞快 —— 而且文件无论如何都已经写好了。

## 它读什么、不读什么

**只读** `statistics.sqlite3`，**只 SELECT**，不写统计库、不碰 Reading Insight、
不碰任何别的插件的存储。

| 字段 | 来源 |
|---|---|
| 书名 / 作者 / 丛书 / 页数 / 最后打开 | `book` 表 |
| 累计时长 / 累计页数 | `book.total_read_time` / `total_read_pages` |
| 划线数 / 笔记数 | `book.highlights` / `book.notes` |
| 进度 | `page_stat_data` 里**最后读的那一页** ÷ 总页数 |
| 每日时长与翻页 | `page_stat_data` 按天聚合 |

⚠️ **进度没有现成字段**，统计库里不存百分比 —— 是从最后读的那一页算出来的。

⚠️ **每日聚合在 SQL 里做**，不是在 Lua 里。重度读者 `page_stat_data` 有几十万行，
全读进内存是让设备因 OOM 被杀掉的经典方式。

⚠️ **列会先探测再选。** `highlights` / `notes` 是后来版本才加的列，
在旧库上直接 SELECT 会硬报错、整个导出失败。探测过之后，旧设备照样能导出，
只是少那两个字段。

## ⚠️ 未在真机上跑过

这个插件是照着 KOReader 的插件 API 文档和 Statistics 插件建的表结构写的，
**手上没有 Kindle 可以实测**。所以里面每一步都包了 `pcall`，
失败会**明确弹消息说失败**，而不是写一个看起来像"最近没读书"的半空文件。

第一次跑如果报错，把弹出的那条消息发我 —— 里面有具体的失败点和路径。
