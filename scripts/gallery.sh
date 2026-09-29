#!/usr/bin/env bash
#
# 画廊 —— 换照片、看清单。网站每一页的那张图（背景 + 画框里那张）都从这里来。
#
#   bash scripts/gallery.sh add ~/Downloads/照片.jpg          # 自动起名 g10
#   bash scripts/gallery.sh add ~/Downloads/照片.jpg 海边      # 指定名字
#   bash scripts/gallery.sh list                              # 看现在有哪些
#   bash scripts/gallery.sh use home 海边                     # 把某页换成某张
#
# ⚠️⚠️ 为什么要有这个脚本：这些照片的原图是 **6016×3384、单张 8MB**。
#    直接拷进 `static/` 也能用 —— 而那正是危险的地方：页面**照样能打开**，
#    只是首屏等十几秒，而「加载慢」没人会想到是「图片没压」。
#    ⇒ `add` 一律先 `sips` 压到长边 1600px / 质量 72（实测 ~200KB，差 40 倍）。
#
# ⚠️ 名字别带 `.jpg`，脚本会加。名字里**不要有空格和中文** ——
#    它会变成文件名，而文件名要出现在 URL 里。
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=apps/dashboard/static/gallery
MAP=apps/dashboard/src/platform/gallery.ts

die() { echo "✗ $*" >&2; exit 1; }

case "${1:-list}" in
  add)
    SRC="${2:-}"
    [ -n "$SRC" ] || die "用法：bash scripts/gallery.sh add <图片路径> [名字]"
    [ -f "$SRC" ] || die "找不到文件：$SRC"
    mkdir -p "$DIR"

    if [ -n "${3:-}" ]; then
      NAME="$3"
    else
      # g01、g02… 取现有的最大编号 +1
      LAST=$(ls "$DIR" 2>/dev/null | grep -oE '^g[0-9]+' | sort | tail -1 || true)
      NEXT=$(( 10#${LAST#g} + 1 ))
      [ -n "$LAST" ] || NEXT=1
      NAME=$(printf 'g%02d' "$NEXT")
    fi

    OUT="$DIR/$NAME.jpg"
    [ -e "$OUT" ] && die "$OUT 已存在 —— 换个名字，或者先删掉它"

    sips -Z 1600 -s format jpeg -s formatOptions 72 "$SRC" --out "$OUT" >/dev/null
    SZ=$(du -h "$OUT" | cut -f1)
    PX=$(sips -g pixelWidth -g pixelHeight "$OUT" | awk '/pixel/{printf "%s ", $2}')
    echo "✓ ${OUT}（${PX}· ${SZ}）"
    echo
    echo "接下来把 $MAP 里想要的页面改成 '$NAME'，例如："
    echo "    bash scripts/gallery.sh use home $NAME"
    ;;

  use)
    PAGE="${2:-}"; NAME="${3:-}"
    [ -n "$PAGE" ] && [ -n "$NAME" ] || die "用法：bash scripts/gallery.sh use <页面> <名字>"
    [ -f "$DIR/$NAME.jpg" ] || die "$DIR/$NAME.jpg 不存在（先 add，或 list 看看）"
    # ⚠️ 只改那张表里**已存在**的那一行。用 python 而不是 sed ——
    #    这一行的格式以后可能会变（比如加上注释），而 sed 会**静默地不匹配**，
    #    于是「改了但没生效」，正是这个项目最怕的那种失败。
    python3 - "$MAP" "$PAGE" "$NAME" <<'PY'
import io, re, sys
path, page, name = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(path, encoding='utf-8').read()
pat = re.compile(r"(\n\s*" + re.escape(page) + r":\s*')[^']+(')")
if not pat.search(s):
    print(f'✗ {path} 里找不到页面 "{page}" —— 可用的页面见那张表')
    sys.exit(1)
s2 = pat.sub(lambda m: m.group(1) + name + m.group(2), s, count=1)
io.open(path, 'w', encoding='utf-8').write(s2)
print(f'✓ {page} → {name}')
PY
    ;;

  list)
    [ -d "$DIR" ] || die "还没有 $DIR"
    echo "画廊（${DIR}）："
    for f in "$DIR"/*.jpg; do
      [ -e "$f" ] || continue
      printf '  %-10s %6s  ' "$(basename "$f" .jpg)" "$(du -h "$f" | cut -f1)"
      sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf "%s ", $2}'
      echo
    done
    echo
    echo "现在哪一页用哪张（${MAP}）："
    sed -n '/^export const GALLERY/,/^};/p' "$MAP" | grep -E "^\s+[a-z]+:" | sed 's/^/  /'
    ;;

  *) die "未知子命令：$1（可用：add / use / list）" ;;
esac
