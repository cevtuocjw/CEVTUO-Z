# COOF：为什么 9 月 26 日之后就没有更新

> 调查于 2026-09-29（第二轮，第一轮结论不完整）。分支 `fix/coof-sync-stalled`。

---

## 两句话

1. **COOF 本身没有坏** —— Notion 里 9 月 26 日之后**就没有新条目**，
   Action 每 5 小时读一次都读到了同样的 155 条，正确地判定「无变更」。
2. **但读者的直觉指向了一个真 bug** —— 自动同步的数据**根本到不了站点**，
   而且每次手动部署都会把线上已经同步好的数据**覆盖回旧的**。
   COOF 只是还没被它伤到（因为它这几天本来就没变），**CNSR 已经被伤了**。

---

## 一、COOF 为什么停在 09-26

每一个环节都验过：

| 环节 | 证据 | 结论 |
|---|---|---|
| Notion 里有新片子吗 | 按 `Date` 倒序查数据库 | **最新 = 2026-09-26** |
| 同步读的是哪个库 | `packages/schema/src/collections.ts` | `COOF2026` = `2da09462-a4af-8040-a7dc-fb733cb776c5` |
| 和 `coof-movie.py` 写的是同一个吗 | `~/.coof-movie/config.json` | **是同一个** |
| Action 在跑吗 | `gh run list --workflow=sync.yml` | 每 5 小时一次，最近 `success` |
| Action 读到了什么 | 那次的**运行日志** | `▸ COOF2026 … 155 条` |
| 它为什么没提交 | 同一条日志 | `无数据变更 —— 不提交（这正是预期行为）` |
| `main` 上最后一次 coof 提交 | `git log origin/main -- data/coof` | `928f28c sync: coof data 2026-09-26T09:42Z` |
| 线上 gh-pages 的 coof | 直接下载线上文件 | 155 条，最新 `watchedAt` **09-26** |

⇒ 四份数据（Notion / main / 本地 / 线上）**完全一致**。
`data/sync-meta.json` 的 `generatedAt` 三处都是 `2026-09-26T17:42+08:00`、
`runId` 都是 `36233574590` —— 因为 **sync-meta 只在数据真的变了时才写**。

⚠️ `coof-movie.py` 不是一个同步脚本，是**手动、一部一部记录**的 CLI
（`argv=['贝鲁特酒店']`），而且**没有任何计划任务**。
所以「09-26 之后没更新」= **09-26 之后没有新片子被记录**。

---

## 二、⚠️⚠️ 但真正的问题在这里：自动同步到不了站点

```
GitHub Action (每 5 小时)
      │  git push
      ▼
   main  ──────────✗ 没有任何步骤把它送到 gh-pages
                      
读者看的站点 ←── gh-pages ←── 只有 scripts/deploy-pages.sh（手动）
                                    └── cp -R data  ← **本地工作区**
```

`grep -nE "gh-pages|deploy|pages" .github/workflows/sync.yml` 只返回一行 `git push`。
**workflow 里根本没有 gh-pages 步骤。**

于是有两个后果，第二个才是真正伤人的：

1. 自动同步的数据**从来不会自己到达读者** —— 必须有人手动跑 `deploy-pages.sh`
2. 而那个脚本 `cp` 的是**本地工作区** ⇒
   **每次手动部署都会把线上已经同步好的数据覆盖回本地那份旧的**

### 实测证据（2026-09-29）

```
git diff --stat origin/main -- data/
  data/cnsr/img/3e909462a4af81cdb5cecc534d278efe.jpg | Bin 0 -> 1417433 bytes
  data/cnsr/index.json                               |   6 ++---
  data/cnsr/learn.json                               |  28 +++++-----
```

⚠️ 那张 1.4 MB 的海报**本地根本不存在**，而 `origin/main` 上有。
**我之前每一次部署都在把它从线上删掉。**

### 修法

`deploy-pages.sh` 里新增一段：`data/coof` 和 `data/cnsr` **从 `origin/main` 取**
（`git archive origin/main <dir> | tar -x`），不从工作区取。
⚠️ 取不到就**大声失败**，绝不退回本地那份 ——
**静默地用旧数据覆盖，正是这个 bug 能活这么久的原因。**

⚠️ 这是同一个 bug 的**第三个和第四个实例**（paperr、chealth 各有一个，
那两个是各自打的补丁）。所以这次没有再加一个 per-directory 补丁，
而是在脚本里把**机制**写清楚了。

---

## 三、这次调查里我自己差点被骗的地方

第一版查 Notion 用的是**未排序**的 `page_size: 100` 查询，返回 100 条而
`has_more: true` —— 那是在**任意 100 条**里找最大值。
它和真值长得一模一样：都是一个像模像样的日期，都排在列表顶上。
加服务端排序（`sorts: [{property:'Date', direction:'descending'}]`）才可信。

⚠️ 同一个教训在这个项目里出现过（`/v1/search` 必须全量分页）。
**分页和排序是两件事，漏了排序的分页看起来完全正常。**
