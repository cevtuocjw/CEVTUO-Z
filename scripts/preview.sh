#!/usr/bin/env bash
#
# 一条命令：类型检查 → 构建 → 重铺本地预览 →（可选）量一次矩形。
#
# ⚠️ 为什么要有它：这一轮里「改一行 CSS 然后看效果」的循环是四件事
#    （typecheck / build / 拷进 /tmp/sv / 起 playwright 量尺寸），
#    而分开跑就是四次工具调用、四份输出。
#    **慢的不是构建（6 秒），是我自己的往返。**
#
# 用法：
#   bash scripts/preview.sh                 # 只构建 + 重铺
#   bash scripts/preview.sh 1440            # 再量一次主页那几块的矩形
#   bash scripts/preview.sh 390 844         # 量窄屏
#
# ⚠️ 量的那一步走 `scripts/measure.mjs` —— 它是通用工具，
#    选择器直接写命令行：
#       bun scripts/measure.mjs 1440 .home-chealth .chc__rings
#
# ⚠️ 本地预览服务器（`python3 -m http.server 8125`）**不在这个脚本里起** ——
#    它该长期跑着。没跑的话先：
#       mkdir -p /tmp/sv/z && (cd /tmp/sv && python3 -m http.server 8125 &)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "── typecheck ─────────────────────────────"
bun run typecheck 2>&1 | tail -3

echo "── build ─────────────────────────────────"
bun run app:build:h5 2>&1 | grep -iE "error|compiled successfully" | tail -3

# ⚠️⚠️ `/tmp/sv/z` 常常是**指向 dist 的软链**（更快也更省）。那时
#    `cp -R dist/. /tmp/sv/z/` 就是「拷到自己身上」，BSD cp 会报
#    `are identical (not copied)` 并**返回非零** —— 而本脚本是 `set -e`，
#    于是**从此往下的每一行都不执行**。
#    ⇒ 后果是静默的：`ln -sfn .../data` 没跑，预览成了**没数据的空壳**，
#      页面照样打开、HTTP 照样 200，只是所有数字都是空的。
#    2026-09-30 实测代价：探针报「画框底下什么都没有」，
#    我差点读成「画框不压正文」—— 其实是因为**根本没有正文可压**
#    （`verify-chealth-ui` 当时报的是 `0/1 通过 / 页面没解锁`）。
#    ⇒ 和 J/M 那次同一个形状：一组断言全盯着同一个对象，
#      没人问「另一个对象里到底有没有东西」。全绿和全空长得一样。
if [ -L /tmp/sv/z ]; then
  echo "（/tmp/sv/z 是软链，直接指向 dist —— 跳过拷贝）"
else
  cp -R apps/dashboard/dist/. /tmp/sv/z/
fi

# 本地预览这边反过来：**必须**有 data，页面才解锁得到数据。
ln -sfn "$PWD/data" /tmp/sv/z/data

# ⚠️ **断言，不是意图**：「我写了 ln」和「链接真的在」是两回事，
#    而上面那次的失败正是「写了但没跑到」。这里去读结果，读不到就退出。
if [ ! -d /tmp/sv/z/data/chealth ]; then
  echo "✗ data 没挂上（/tmp/sv/z/data/chealth 不存在）—— 页面会是空的，先别信验证器的数" >&2
  exit 1
fi
echo "── 预览已重铺（http://127.0.0.1:8125/z）  ✓ data 挂上了"

if [ "$#" -ge 1 ]; then
  echo "── 量 ${1}×${2:-900} ─────────────────────"
  env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
      NO_PROXY='*' no_proxy='*' \
    bun scripts/measure.mjs "$@"
fi
