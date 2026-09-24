#!/usr/bin/env bash
# Offline test for the CEVTUO CAPPERR KOReader plugin.
#
# Runs the plugin's real buildPayload() against real sqlite3 databases with the
# schema KOReader's Statistics plugin creates, under LuaJIT. No device needed.
#
#   ./test.sh                 # run, clean up after
#   CAPPERR_KEEP=1 ./test.sh  # keep the work dir (incl. the exported JSON)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$HERE/../cevtuo-capperr.koplugin/main.lua"

command -v luajit  >/dev/null 2>&1 || { echo "需要 luajit（Cherry Studio cli_install 配方：conda:luajit）" >&2; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "需要 sqlite3" >&2; exit 2; }
[ -f "$PLUGIN" ] || { echo "找不到插件：$PLUGIN" >&2; exit 2; }

WORK="$(mktemp -d)"
export CAPPERR_SHIM="$HERE/shim"
export CAPPERR_PLUGIN="$PLUGIN"
# ⚠️ Read out of the plugin, NOT written here. A value hardcoded in the test is
# an assertion that can never fail — it checks the test against itself.
export CAPPERR_INTERVAL="$(grep -oE '^local MIN_INTERVAL_DEFAULT = [0-9]+' "$PLUGIN" | grep -oE '[0-9]+$' || echo 0)"
export CAPPERR_WORK="$WORK"
export CAPPERR_HOME="$WORK/visible"
mkdir -p "$CAPPERR_HOME"

status=0
for mode in main legacy nopagestat notime; do
  mkdir -p "$WORK/dbdir_$mode"
  sqlite3 "$WORK/dbdir_$mode/statistics.sqlite3" < "$HERE/fixtures/$mode.sql"
  CAPPERR_SETTINGS="$WORK/dbdir_$mode" luajit "$HERE/run.lua" "$mode" || status=1
done

mkdir -p "$WORK/dbdir_auto"
sqlite3 "$WORK/dbdir_auto/statistics.sqlite3" < "$HERE/fixtures/main.sql"
CAPPERR_SETTINGS="$WORK/dbdir_auto" luajit "$HERE/auto.lua" || status=1

if [ "${CAPPERR_KEEP:-0}" = "1" ]; then
  echo
  echo "工作目录保留在：$WORK"
else
  rm -rf "$WORK"
fi
exit $status
