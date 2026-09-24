#!/usr/bin/env bash
# Print the KOReader config file, ready to copy onto the Kindle.
#
#   bash scripts/cevtuo-device-config.sh
#
# ⚠️ Why this exists. Restoring a Kindle means getting one small JSON file back,
# and the one value in it that cannot be guessed — the device token — lives in
# three places, none of them obvious:
#
#   1. koreader-plugin/cevtuo-capperr.conf.json   (gitignored, this machine)
#   2. services/ingest/.env.server-backup         (gitignored, this machine)
#   3. /opt/cevtuo-ingest/.env                    (the Aliyun box)
#
# Reading the token out of a dotfile by hand at the moment you have just wiped a
# Kindle is exactly when you get it wrong. See docs/CAPPERR-恢复清单.md.
#
# ⚠️ The output contains the device token. Do not paste it anywhere public — it
# is the only thing standing between a stranger and the ability to append fake
# reading statistics. It cannot read anything back and it cannot touch the repo.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

CONF="$ROOT/koreader-plugin/cevtuo-capperr.conf.json"
BACKUP="$ROOT/services/ingest/.env.server-backup"

say() { printf '%s\n' "$*" >&2; }

read_token() {
  # Prefer the config file itself: it is what the device already had, so a
  # restore that uses it cannot drift from what was working.
  if [[ -f "$CONF" ]]; then
    local t
    t=$(bun -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONF','utf8')).token||'')}catch(e){console.log('')}" 2>/dev/null || true)
    if [[ -n "$t" ]]; then printf '%s' "$t"; return 0; fi
  fi
  if [[ -f "$BACKUP" ]]; then
    local t
    t=$(grep -E '^CEVTUO_DEVICE_TOKEN=' "$BACKUP" | head -1 | cut -d= -f2- || true)
    if [[ -n "$t" ]]; then printf '%s' "$t"; return 0; fi
  fi
  return 1
}

URL="${CEVTUO_URL:-http://120.77.27.128:8789/api/paperr}"

if ! TOKEN="$(read_token)"; then
  say ""
  say "✗ 本机找不到 device token。"
  say ""
  say "  找过这两处："
  say "    $CONF"
  say "    $BACKUP"
  say ""
  say "  还可以去服务器上取："
  say "    ssh root@120.77.27.128 'grep CEVTUO_DEVICE_TOKEN /opt/cevtuo-ingest/.env'"
  say ""
  exit 1
fi

say ""
say "放成 Kindle 上的  koreader/settings/cevtuo-capperr.conf.json"
say "（⚠️ settings 目录，不是插件目录。插件在 plugins/ 下，两回事。）"
say ""
cat <<JSON
{
  "url": "$URL",
  "token": "$TOKEN",
  "autoOnWifi": true,
  "minIntervalMinutes": 30
}
JSON
say ""
say "放好之后重启 KOReader，等 12 秒 —— 插件会自己补推一次，不用手动点。"
say "想立刻确认：工具菜单 →「导出阅读统计（CEVTUO）」，弹窗会告诉你结果。"
say ""
