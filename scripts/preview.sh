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

# ⚠️ 部署脚本会删掉 dist/data（软链会让 cp -R 撞上「File exists」），
#    本地预览这边反过来：**必须**有它，页面才读得到数据。
cp -R apps/dashboard/dist/. /tmp/sv/z/
ln -sfn "$PWD/data" /tmp/sv/z/data
echo "── 预览已重铺（http://127.0.0.1:8125/z）"

if [ "$#" -ge 1 ]; then
  echo "── 量 ${1}×${2:-900} ─────────────────────"
  env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
      NO_PROXY='*' no_proxy='*' \
    bun scripts/measure.mjs "$@"
fi
