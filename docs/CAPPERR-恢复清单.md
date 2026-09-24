# CAPPERR 恢复清单

**Kindle 或 KOReader 出过事之后，照着这张表做。**

先看一眼你属于哪种情况，只做对应那一节。

---

## 三种东西，三个地方

恢复的麻烦全部来自「哪个东西存在哪儿」。先认清：

| 东西 | 存在哪儿 | 丢了会怎样 |
|---|---|---|
| **插件** | Kindle 的 `koreader/plugins/cevtuo-capperr.koplugin/` | 不会自动同步，手动菜单项消失 |
| **设备配置**（含 token） | Kindle 的 `koreader/settings/cevtuo-capperr.conf.json` | 插件在但推不出去 |
| **阅读历史** | Kindle 的 `koreader/settings/statistics.sqlite3` | ⚠️ **真正的损失，见最后一节** |

⚠️ 这三样在 Kindle 上是**分开的三个位置**，所以「插件还在但配置没了」是很常见的
中间状态 —— 表现和「插件坏了」一模一样。

---

## ① 只是更新了 KOReader

**先花 30 秒确认**：KOReader → 工具菜单 → 看有没有「**导出阅读统计（CEVTUO）**」。

| 情况 | 做什么 |
|---|---|
| 有 | **什么都不用做** |
| 没有 | 去第 ② 节 |

**为什么一般是「有」**：KOReader 更新是解压覆盖，只动安装包里的文件。你自己放的
插件目录、以及 `koreader/settings/` 下的配置和历史都不在其中，会保留。

---

## ② 插件没了（KOReader 完全重装）

只有「把整个 koreader 目录删掉再解压」才会这样。

**两步：**

**第一步 —— 装插件**

把 `koreader-plugin/cevtuo-capperr.koplugin/`（或解压
`koreader-plugin/dist/cevtuo-capperr.koplugin.zip`）放到：

```
koreader/plugins/cevtuo-capperr.koplugin/
```

⚠️ 是**这个层级**。多套一层变成
`.../cevtuo-capperr.koplugin/cevtuo-capperr.koplugin/` 就会静默失效。

**第二步 —— 放配置**

配置文件在 **`koreader/settings/cevtuo-capperr.conf.json`**（不在插件目录里）：

```json
{
  "url": "http://120.77.27.128:8789/api/paperr",
  "token": "<设备 token>",
  "autoOnWifi": true,
  "minIntervalMinutes": 30
}
```

**token 去哪找**（三处，任意一处即可）：

1. 本机 `~/Documents/CEVTUO-Z/koreader-plugin/cevtuo-capperr.conf.json`
2. 本机 `~/Documents/CEVTUO-Z/services/ingest/.env.server-backup` 里的 `CEVTUO_DEVICE_TOKEN`
3. 阿里云 `/opt/cevtuo-ingest/.env` 里的 `CEVTUO_DEVICE_TOKEN`

⚠️ 这三处都在**公开仓库之外**（gitignore 挡着）。**不要**把 token 贴到任何公开的地方。

**第三步 —— 重启 KOReader**，然后等 12 秒。

⚠️ 启动后插件会自己补推一次（前提是距上次成功超过 30 分钟）。**不用手动点。**
想立刻确认就点工具菜单那一项，弹窗会告诉你结果。

---

## ③ Kindle 恢复出厂 / 换新机

⚠️ **这一节的代价最大，因为阅读历史会没。** 先看最后一节，如果还能救就先去救。

做完 ② 的全部步骤，另外：

**KOReader 本身要重新装。** Kindle 恢复出厂会清掉 `/mnt/us` 上的所有东西，
KOReader 也在里面。

**阅读历史能不能回来**：
- ✅ **聚合数据在服务器上有**：`/opt/cevtuo-ingest/data/paperr/raw-koreader.json`
  保存着最近一次完整导出（每本书的时长、进度，每天的时长和翻页）。
- ❌ **逐页记录没有**：KOReader 的 `statistics.sqlite3` 里那张 `page_stat_data`
  只有设备有。它是「哪天几点读了多少分钟」的原始来源，没有它就重建不出小时分布。

所以换新机之后：**网站上的历史还在**（服务器有），但**新设备的统计从零开始**，
而且「时段」这张图要等你在这台设备上重新积累。

---

## ④ 阿里云那台没了 / 换了 IP

**换 IP**：改 Kindle 配置里的 `url`，插件不用动。

**整台没了**（重装系统、换机器）：

```bash
# 在 Mac 上
bash scripts/deploy-ingest.sh <新IP>
```

⚠️ 但 `.env` 不在仓库里（**故意如此**），所以要先把这几个值补回去：
`CEVTUO_DEVICE_TOKEN`、`CEVTUO_ADMIN_PASSWORD`、`CEVTUO_GITHUB_TOKEN`。
本地备份在 `services/ingest/.env.server-backup`。

⚠️ **数据要重传**：新服务器上没有历史。把 `services/ingest/.env.server-backup`
同目录下……实际上没有本地副本 —— **服务器上的 `raw-koreader.json` 是唯一一份**。
设备下次同步会全量重传，所以只要 Kindle 还在，就恢复得回来。
**Kindle 和服务器同时没才是真的丢。**

---

## ⑤ Mac 没了

- **代码**：GitHub 上全都有（`cevtuocjw/CEVTUO-Z`），克隆回来即可。
- **密钥**：`~/.ssh/` 和 `.env.server-backup` 不在 GitHub 上 —— 这两个要单独备份。
- **网站的当前数据**：`gh-pages` 分支上有。

---

## 该做的备份（现在还来得及）

| 备份什么 | 怎么备 | 多久一次 |
|---|---|---|
| **`statistics.sqlite3`** | 见下面 ⚠️ | 每月，或读了很多之后 |
| `services/ingest/.env.server-backup` | 复制到你自己的云盘 | 改过密钥之后 |
| Kindle 配置 | 已经在 `koreader-plugin/cevtuo-capperr.conf.json` | 不用管 |

### ⚠️ 备份统计库有个坑

`statistics.sqlite3` 是 **WAL 模式**。**只拷 `statistics.sqlite3` 会读到陈旧快照** ——
最近的阅读还在 `-wal` 文件里，只有检查点时才折回去。

要拷就**三个一起拷**，而且**先退出 KOReader**：

```
/mnt/us/koreader/settings/statistics.sqlite3
/mnt/us/koreader/settings/statistics.sqlite3-wal
/mnt/us/koreader/settings/statistics.sqlite3-shm
```

（路径以你 Kindle 上的为准，`koreader/settings/` 那个目录。）

⚠️ 更好的办法是**根本不用碰这个文件**：服务器上的 `raw-koreader.json` 就是插件
从库里读出来的完整聚合，每次同步都会更新。它不能替代逐页记录，但对「网站还能不能
显示历史」这个问题来说，它就是答案。

---

## 一句话总结

**更新 KOReader → 看一眼工具菜单有没有那一项，有就没事。**

**重装 / 换机 → 插件 + 配置，两样都要放，token 在本地那三个地方。**

**真会丢的只有 Kindle 上的 `statistics.sqlite3`**，而它是否重要取决于你在不在乎
「时段」那张图的历史。
