#!/usr/bin/env bash
# Redeploy the CAPPERR ingest service to the Aliyun box.
#
#   bash scripts/deploy-ingest.sh [ssh-target]
#
# ⚠️ CODE ONLY. It does not touch `.env`, does not create the service user and
# does not install the unit file. Those are one-time setup and they hold the
# secrets — a redeploy that rewrote `.env` would be a redeploy that could lose
# the device token and silently lock the Kindle out.
#
# ── Why the code is BUILT here and COPIED there
#
# The server is CentOS 8, which is EOL: its mirrors are gone, so there is no
# `git` and no way to install one. It has 769MB of RAM, which is not enough for
# a workspace-wide dependency install either.
#
# So this machine does the building and ships two ~150KB files. The server needs
# Bun and nothing else — no checkout, no node_modules, no data it did not
# receive.
#
# ⚠️ Both bundles, every time. `server.js` is obvious; `sync-paperr.js` is the
# converter the server shells out to on every push, and shipping one without the
# other is how the service ends up generating an index with last month's rules.
set -euo pipefail

TARGET="${1:-root@120.77.27.128}"
APP_DIR="${CEVTUO_APP_DIR:-/opt/cevtuo-ingest}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cd "$(dirname "$0")/.."

say() { echo "▸ $*"; }

say "打包"
bun build pipeline/src/cli/sync-paperr.ts --target=bun --outfile="$OUT/sync-paperr.js" >/dev/null
bun build services/ingest/src/server.ts    --target=bun --outfile="$OUT/server.js"      >/dev/null
ls -la "$OUT" | tail -2

# ⚠️ A bundle that fails to parse is worse than one that fails to upload — the
# service restarts, dies, and the only evidence is a 203/EXEC in the journal
# with no explanation. Refuse to ship one.
for f in server.js sync-paperr.js; do
  node --check "$OUT/$f" 2>/dev/null || bun build --target=bun "$OUT/$f" >/dev/null 2>&1 || {
    echo "✗ $f 语法不通过，不部署" >&2
    exit 1
  }
done

say "上传到 $TARGET:$APP_DIR"
scp -q "$OUT/server.js" "$OUT/sync-paperr.js" "$TARGET:$APP_DIR/"

say "重启并自检"
ssh -o BatchMode=yes "$TARGET" "bash -s" <<EOF
set -e
chown cevtuo:cevtuo $APP_DIR/server.js $APP_DIR/sync-paperr.js
systemctl restart cevtuo-ingest
sleep 3
systemctl is-active --quiet cevtuo-ingest || {
  echo "✗ 服务没起来："
  journalctl -u cevtuo-ingest -n 25 --no-pager
  exit 1
}
echo "  health: \$(curl -s -m 5 http://127.0.0.1:8789/health)"
echo "  数据:   \$(ls $APP_DIR/data/paperr/ | tr '\n' ' ')"
EOF

echo
echo "✓ 已部署"
echo
echo "⚠️ 部署完记得确认发布链路还通 —— /health 只证明进程活着："
echo "   curl -s http://120.77.27.128:8789/api/status -u \"x:<管理密码>\""
