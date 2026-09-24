#!/usr/bin/env bash
# CEVTUO CAPPERR ingest — one-shot deploy for the Aliyun lightweight server.
#
#   CEVTUO_DEVICE_TOKEN=... CEVTUO_GITHUB_TOKEN=... CEVTUO_ADMIN_PASSWORD=... \
#     bash deploy.sh
#
# Idempotent: re-running it updates the code and restarts the service. Secrets
# are read from the environment, never from argv — argv shows up in `ps` and in
# the shell's history file.
#
# ⚠️ Run as root. The Aliyun console's Workbench opens as `Admin`; prefix with
# `sudo bash deploy.sh` or switch user first.
set -euo pipefail

REPO_URL="${CEVTUO_REPO_URL:-https://github.com/cevtuocjw/CEVTUO-Z}"
APP_DIR="${CEVTUO_APP_DIR:-/opt/cevtuo-ingest}"
RUN_USER="${CEVTUO_USER:-cevtuo}"
PORT="${CEVTUO_PORT:-8789}"

die() { echo "✗ $*" >&2; exit 1; }
say() { echo "▸ $*"; }

[ "$(id -u)" = "0" ] || die "需要 root：sudo bash deploy.sh"

: "${CEVTUO_DEVICE_TOKEN:?请设置 CEVTUO_DEVICE_TOKEN（Kindle 上要抄这个）}"
: "${CEVTUO_GITHUB_TOKEN:?请设置 CEVTUO_GITHUB_TOKEN（fine-grained PAT，Contents + Actions）}"
: "${CEVTUO_ADMIN_PASSWORD:?请设置 CEVTUO_ADMIN_PASSWORD（管理页密码）}"

# ── 1. Bun ──────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  say "安装 Bun"
  # ⚠️ The installer writes to ~/.bun/bin. Symlink rather than move, so the
  # in-place updater (`bun upgrade`) keeps working.
  curl -fsSL https://bun.sh/install | bash >/dev/null
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi
say "bun $(bun --version)"

# ── 2. Code ─────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  say "更新代码"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  say "克隆代码"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
say "安装依赖（整个 workspace，服务依赖 @cevtuo/schema 与 pipeline-core）"
bun install --frozen-lockfile >/dev/null

# ── 3. Service user ─────────────────────────────────────────
# ⚠️ Not root. This process holds a token that can write to the repository, and
# running it as root buys nothing but a larger blast radius.
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin "$RUN_USER"

# ── 4. Secrets ──────────────────────────────────────────────
say "写入 $APP_DIR/.env"
umask 077
cat > "$APP_DIR/.env" <<ENV
CEVTUO_DEVICE_TOKEN=$CEVTUO_DEVICE_TOKEN
CEVTUO_GITHUB_TOKEN=$CEVTUO_GITHUB_TOKEN
CEVTUO_ADMIN_PASSWORD=$CEVTUO_ADMIN_PASSWORD
CEVTUO_PORT=$PORT
ENV
chmod 600 "$APP_DIR/.env"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ── 5. systemd ──────────────────────────────────────────────
say "安装 systemd 单元"
sed -e "s#^User=.*#User=$RUN_USER#" \
    -e "s#^Group=.*#Group=$RUN_USER#" \
    -e "s#^ExecStart=.*#ExecStart=/usr/local/bin/bun run src/server.ts#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR/services/ingest#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=$APP_DIR/.env#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=$APP_DIR#" \
    "$APP_DIR/services/ingest/systemd/cevtuo-ingest.service" > /etc/systemd/system/cevtuo-ingest.service

systemctl daemon-reload
systemctl enable cevtuo-ingest >/dev/null
systemctl restart cevtuo-ingest
sleep 2

# ── 6. Verify ───────────────────────────────────────────────
say "自检"
systemctl is-active --quiet cevtuo-ingest || { journalctl -u cevtuo-ingest -n 30 --no-pager; die "服务没起来"; }
curl -fsS "http://127.0.0.1:$PORT/health" && echo

echo
echo "✅ 部署完成"
echo
echo "接下来还有两步，都在阿里云控制台："
echo "  1. 防火墙放行 TCP $PORT（入方向，来源 0.0.0.0/0）"
echo "  2. 浏览器打开  http://120.77.27.128:$PORT/   用 CEVTUO_ADMIN_PASSWORD 登录"
echo
echo "Kindle 的 cevtuo-capperr.conf.json:"
echo "  { \"url\": \"http://120.77.27.128:$PORT/api/paperr\","
echo "    \"token\": \"<上面那个 CEVTUO_DEVICE_TOKEN>\","
echo "    \"autoOnWifi\": true, \"minIntervalMinutes\": 30 }"
