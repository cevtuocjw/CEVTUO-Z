# CEVTUO-Z — 交接清单

> 给新会话里的 AI 助手看的第一份文件。读完这份就能接着干，不用重新调研。

---

## 一句话

个人数据仪表盘。四个品牌页：**COOF**（电影）/ **CNSR**（笔记）/ **CE-PaperR**（Kindle 阅读）/ **Chealth**（健康）。
目标形态：**微信小程序 + Android**，一套 Taro 代码。macOS 端本轮不做。

**仓库根目录自包含**，不引用目录外任何路径。`git` 已初始化。

---

## 怎么跑起来

```bash
cd ~/Documents/CEVTUO-Z
bun install

# 数据管道（需要 .env，见下）
bun run pipeline/src/cli/sync.ts --source coof              # 全量同步 7 个年历
bun run pipeline/src/cli/sync.ts --source coof --dry-run    # 只看会不会产生改动
bun run pipeline/src/cli/sync.ts --source coof --collection COOF2026

# 豆瓣海报补全（1060 条缺海报的）
bun run pipeline/src/cli/enrich-posters.ts --limit 10        # 试跑，不写 Notion
bun run pipeline/src/cli/enrich-posters.ts --write           # 真写

# App
cd apps/dashboard
./node_modules/.bin/taro build --type weapp    # 微信小程序
./node_modules/.bin/taro build --type h5       # Android WebView / 网页

# 自检
./node_modules/.bin/tsc -b                     # 类型检查（必须 0 错误）
bun run scripts/verify-core.ts                 # 28 项核心行为测试
```

`.env`（已 gitignore，权限 600）需要 `NOTION_TOKEN`。
Token 来源：`~/.coof-movie/config.json` 里的 `notion_token`（`ntn_` 开头）。

---

## 目录结构

```
CEVTUO-Z/
├─ packages/
│  ├─ schema/          ← 唯一真源：所有 payload 的 zod 定义
│  │  └─ src/collections.ts  ← 11 个 COO 集合的注册表（含真实数据库 id）
│  └─ pipeline-core/   ← stableJson / contentHash / writeIfChanged / scrubError
├─ pipeline/
│  ├─ src/notion.ts         ← Notion 客户端
│  ├─ src/douban.ts         ← 豆瓣海报查询（带磁盘缓存）
│  ├─ src/sources/coof/     ← normalize + posters（海报重托管）
│  └─ src/cli/{sync,enrich-posters}.ts
├─ apps/dashboard/     ← Taro App（weapp + h5）
│  └─ src/styles/      ← tokens / glass / breakpoints / wallpaper
├─ data/               ← 管道产物，提交进仓库，由 Pages 托管
├─ assets/logo/        ← 玫瑰原图 + 尖锐 Z 标志
├─ assets/icons/       ← 已导出的各平台图标
└─ .github/workflows/  ← ⚠️ 还没建！见「待办」
```

---

## 已完成 ✅

| 项 | 状态 |
|---|---|
| 仓库骨架 + bun workspaces | 完成 |
| `@cevtuo/schema` 全部 payload 定义 | 完成，含 11 集合注册表 |
| `@cevtuo/pipeline-core` | 完成，**28 项测试全过** |
| Taro 工程（weapp + h5 都能构建） | 完成，包体 596K |
| Liquid Glass 设计系统（三档降级） | 完成 |
| 折叠屏断点（600/840px） | 完成，**实测为真 px** |
| Logo：尖锐反向 Z | 完成，渲染确认 |
| 图标套装（Android/小程序/Web） | 完成，玫瑰 SHA-256 未变 |
| COOF 管道：7 个年历 1209 条 | 完成 |
| 海报重托管（Notion URL 1h 过期） | 完成，36KB/张 |
| **幂等性：重复运行零改动** | 完成，**git 独立验证通过** |
| 豆瓣海报补全 | 完成（1060 条缺海报，后台跑） |

## 待办 ⏳

1. **`.github/workflows/sync.yml`** —— 自动同步（cron 每 5 小时 + 手动触发）。**这是"自动同步"功能，必须有。**
2. **Cloudflare Worker** —— `/api/sync`（手动同步按钮）+ `/api/status`（同步状态）。需要 Cloudflare 账号。
3. **COOF 页面** —— 接真实数据、11 集合切换、海报网格、点击弹窗。
4. CNSR / CE-PaperR / Chealth 三个页面。
5. README。

---

## ⚠️ 踩过的坑（**别再踩**）

### 折叠屏断点必须关掉 pxtransform
Taro 的 `postcss-pxtransform` 会把媒体查询里的 px 一起换算。实测产物是 `600rpx`（小程序）和 `15rem`（H5）——**两者都随屏幕宽度缩放**，在 Fold 5 外屏 361dp 上 600rpx 只有约 289 CSS px，**断点会在外屏误触发、展开态永远进不去**。
已在 `apps/dashboard/config/index.ts` 的 mini 和 h5 两侧都设为 `pxtransform: { enable: false }`。**不要打开。**

### 幂等性靠三条，缺一不可
1. `stableJson` 递归排序 key
2. `writeIfChanged` 内容相同就不写（也不碰 mtime）
3. **时间戳只进 `sync-meta.json`，且只在数据真变了时才写它**
第 3 条最容易漏。meta 里有 `generatedAt`，无条件写它 = 每次定时同步都产生提交。

### 验证幂等性要用 git，别信自己的计数器
```bash
git add -A && git commit -qm baseline
bun run pipeline/src/cli/sync.ts --source coof
git add -A && git diff --cached --quiet && echo "零改动 ✓"
```

### 海报相关的三个坑
- **Notion 图片 URL 实测 1 小时过期**（`X-Amz-Expires=3600`）→ 必须重托管
- **`sips -s format webp` 退出码 0 但实际吐 PNG** → 用 JPEG，并**校验魔数**别信扩展名
- **豆瓣图片裸请求返回 418** → 必须带 `User-Agent` + `Referer: https://movie.douban.com/`
- 下载失败**不能写成 `null`** —— 下次跑会翻回路径，每轮产生提交

### Notion 数据侧的坑
- **集合的「页面 id」≠「数据库 id」**。拿页面 id 查数据库返回 404，长得像权限问题。真实 id 在 `packages/schema/src/collections.ts`
- `time`（片长）和 `YEAR` 是 **rich_text 不是 number**，要 parse
- **COOF2020 只有 7 个字段**，2026 有 10 个 → 除 NAME 外全部按可选处理
- **856 行根本没有 POSTER 属性**（早期年历没这个字段），不是下载失败

### 前端侧的坑
- **不要启用 Skyline 渲染器** —— 它只支持 DarkMode 媒体查询，一开宽度媒体查询就静默失效，折叠屏适配直接崩
- 颜色用**旧式 `rgba(r,g,b,a)` 逗号语法**，Skyline 不认 `rgb(r g b / a)`
- 每个容器**显式写 `display:flex; flex-direction:...`**（两个渲染器默认值不同）
- App 只 `import type` 自 schema —— **zod 运行时 60KB，绝不能进小程序包**

---

## 关键设计决策（别推翻）

| 决策 | 理由 |
|---|---|
| 健康数据走 Worker 鉴权，不放 Pages | **GitHub Pages 即使私有仓库也是公网可读** |
| Worker 用 `actions: write` 而非 `contents: write` | 泄露时前者只能触发工作流，后者能改写整个仓库 |
| 抖音式的是 Taro 而非 Flutter/RN | 只有 Taro 能同时出小程序 + Android 且 UI 代码全共享 |
| 海报重托管而非存 Notion URL | URL 1 小时过期，实测 |
| 豆瓣补全是一次性工具，不进 5 小时定时 | 内容是静态的，不该永远骚扰豆瓣 |

---

## 新会话怎么开始

直接说：

> 读 `~/Documents/CEVTUO-Z/HANDOFF.md`，然后继续做待办第 1 项。

这份文件就是为此存在的 —— **把上下文成本从"重新调研一遍"降到"读一个文件"**。
