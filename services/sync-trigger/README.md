# sync-trigger

手动同步按钮的后端。`/api/sync` 触发同步，`/api/status` 回报新鲜度。

## 为什么不在客户端放 token

小程序包可反编译，H5 是明文 JS —— **客户端里的任何凭据都是公开的**。所以：

- GitHub token 只存在这里（`CEVTUO_GITHUB_TOKEN`），且只需要 `Actions: write`
- 客户端只持有 `CEVTUO_CLIENT_TOKEN`，它只能干一件事：请求一次同步
- 用 `Actions: write` 而不是 `contents: write`：泄露时前者只能触发工作流，后者能改写整个仓库

## 为什么有两个适配器

没有 Cloudflare 账号，所以先跑在 Mac 上。逻辑全在 `src/core.ts`，与运行环境无关：

| 文件 | 跑在哪 | 怎么起 |
|---|---|---|
| `src/core.ts` | — | 全部逻辑，纯函数 + 注入的 `GithubApi` |
| `src/server.ts` | 本机 Bun | `bun run trigger` |
| `src/worker.ts` | Cloudflare | `wrangler deploy`（未部署） |

将来有账号了，部署是**加一个适配器，不是重写**。

## 本机运行

```bash
# .env 里补齐 CEVTUO_GITHUB_TOKEN 和 CEVTUO_CLIENT_TOKEN
bun run trigger
```

默认监听 `127.0.0.1:8788`。**不要改成 `0.0.0.0`** —— 那会把这个 GitHub token
的破坏半径扩大到整个局域网。

### 接口

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 存活探测。不需要凭据，否则监控脚本也得持有一个 |
| GET | `/api/status` | Bearer | 返回 `SyncStatusSchema` |
| POST | `/api/sync` | Bearer | 返回 `SyncTriggerResponseSchema` |

```
202 已触发
409 已有同步在跑 / 刚同步过（`retryAfterSeconds` 给出重试间隔）
401 凭据不对
405 方法不对
500 GitHub 出错（错误串已过 scrubError）
```

### 两种"拒绝"都是正常答案，不是错误

- **已有运行在跑** → 409。工作流那边 `concurrency: cancel-in-progress: false`
  本来就会排队，这里提前告诉用户"已经有一个在跑了"，比再排一个空转的 run 更诚实。
- **刚同步过（默认 60s 内）** → 409。防连点。

## 验证

```bash
bun run scripts/verify-sync-trigger.ts   # 47 项
bun run verify                            # core + sync-trigger 一起
```

覆盖三件真出事会疼的事：token 泄进响应体、重复触发烧 Actions 额度、
响应不符合 zod schema（客户端用的是同一批 schema，不符合就是运行时崩溃）。

## ⚠️ 小程序端接不了

微信要求 request 域名白名单 + ICP 备案域名，`127.0.0.1` 和裸 IP 都不行。

- **H5 / Android WebView**：今天就能用，浏览器没有这个限制
- **小程序**：要么给它一个备案 HTTPS 域名（隧道或自有域名），要么那个按钮先不做

小程序那边*有*自动同步兜底 —— 工作流每 5 小时自己跑，手动按钮只是"我现在就想看新的"。
