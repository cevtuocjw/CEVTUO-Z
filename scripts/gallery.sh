#!/usr/bin/env bash
#
# 画廊 —— 换照片、加照片、看清单。网站上挂的那些画（背景 + 画框里的）都从这里来。
#
#   bash scripts/gallery.sh add ~/Downloads/照片.jpg          # 自动起名 g11
#   bash scripts/gallery.sh add ~/Downloads/照片.jpg 海边      # 指定名字
#   bash scripts/gallery.sh list                              # 看画廊里有什么、哪些在用
#   bash scripts/gallery.sh rm 海边                            # 从画廊和池子里都拿掉
#
# ⚠️⚠️ **加一张图只有这一条命令。** 它会：
#    ① `sips` 压到长边 1600px（原图 6016×3384、单张 8MB，直接上站首屏要等十几秒）
#    ② 写进 `apps/dashboard/static/gallery/`
#    ③ 把名字**追加进 `platform/gallery.ts` 的 `PHOTOS`**
#    ⚠️ 第 ③ 步是 2026-09-30 补的：在那之前 `add` 只是把文件放进去、
#      让人自己去改代码，而**改了才会有下一张** —— 漏掉那一步的结果是
#      「图放进去了但网站上永远不出现」，而没有任何地方会报错。
#
# ⚠️ 名字别带 `.jpg`（脚本会加），名字里**不要有空格和中文** ——
#    它会变成文件名，而文件名要出现在 URL 里。
#
# ⚠️⚠️ **加进去之后是「随机挂上」，不是「挂到某一页」。**
#    读者 2026-09-30：「所有的画和所有的画框要每次刷新都随机出」。
#    ⇒ 没有「把某张图指定给某页」这回事了（原来有 `use` 子命令，已删）。
#      每一页的背景、每一枚画框里的图，都是**每次刷新从池子里洗牌**抽的，
#    而且**全站不重样**（`verify-gallery.mjs` 的 Q 断言守着）。
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=apps/dashboard/static/gallery
MAP=apps/dashboard/src/platform/gallery.ts

die() { echo "✗ $*" >&2; exit 1; }

# 把名字追加进 PHOTOS（幂等：已经在里面就什么都不做）
pool_add() {
  python3 - "$MAP" "$1" <<'PY'
import io, re, sys
path, name = sys.argv[1], sys.argv[2]
s = io.open(path, encoding='utf-8').read()
m = re.search(r"const PHOTOS = \[(.*?)\];", s, re.S)
if not m:
    print('✗ 在 gallery.ts 里找不到 PHOTOS', file=sys.stderr); sys.exit(1)
if f"'{name}'" in m.group(1):
    print(f'（{name} 已经在池子里了）'); sys.exit(0)
s = s[:m.end(1)] + f", '{name}'" + s[m.end(1):]
io.open(path, 'w', encoding='utf-8').write(s)
print(f'✓ 已加进 PHOTOS：{name}')
PY
}

pool_del() {
  python3 - "$MAP" "$1" <<'PY'
import io, re, sys
path, name = sys.argv[1], sys.argv[2]
s = io.open(path, encoding='utf-8').read()
m = re.search(r"const PHOTOS = \[(.*?)\];", s, re.S)
if not m or f"'{name}'" not in m.group(1):
    print(f'（{name} 不在池子里）'); sys.exit(0)
body = re.sub(r",\s*'" + re.escape(name) + r"'", '', m.group(1))
body = re.sub(r"'" + re.escape(name) + r"'\s*,?", '', body).strip().rstrip(',')
s = s[:m.start(1)] + body + s[m.end(1):]
io.open(path, 'w', encoding='utf-8').write(s)
print(f'✓ 已从 PHOTOS 移除：{name}')
PY
}

case "${1:-list}" in
  add)
    SRC="${2:-}"
    [ -n "$SRC" ] || die "用法：bash scripts/gallery.sh add <图片路径> [名字]"
    [ -f "$SRC" ] || die "找不到文件：$SRC"
    mkdir -p "$DIR"

    if [ -n "${3:-}" ]; then
      NAME="$3"
    else
      LAST=$(ls "$DIR" 2>/dev/null | grep -oE '^g[0-9]+' | sort | tail -1 || true)
      NEXT=1
      [ -n "$LAST" ] && NEXT=$(( 10#${LAST#g} + 1 ))
      NAME=$(printf 'g%02d' "$NEXT")
    fi

    OUT="$DIR/$NAME.jpg"
    [ -e "$OUT" ] && die "$OUT 已存在 —— 换个名字，或者先删掉它"

    sips -Z 1600 -s format jpeg -s formatOptions 72 "$SRC" --out "$OUT" >/dev/null
    SZ=$(du -h "$OUT" | cut -f1)
    PX=$(sips -g pixelWidth -g pixelHeight "$OUT" | awk '/pixel/{printf "%s ", $2}')
    echo "✓ ${OUT}（${PX}· ${SZ}）"

    pool_add "$NAME"
    echo
    echo "下一步：bash scripts/preview.sh      然后刷新页面 —— 它会被随机挂上。"
    echo "（想发布：rm -f apps/dashboard/dist/data && bash scripts/deploy-pages.sh）"
    ;;

  rm)
    NAME="${2:-}"
    [ -n "$NAME" ] || die "用法：bash scripts/gallery.sh rm <名字>"
    pool_del "$NAME"
    [ -e "$DIR/$NAME.jpg" ] && rm -f "$DIR/$NAME.jpg" && echo "✓ 删掉了 $DIR/$NAME.jpg"
    echo "⚠️ 记得跑一次 bash scripts/verify-gallery.mjs —— 池子变小了，"
    echo "   而「全站不重样」（Q 断言）在池子小于画框数时会失败。"
    ;;

  list)
    [ -d "$DIR" ] || die "还没有 $DIR"
    echo "画廊（${DIR}，共 $(ls "$DIR"/*.jpg 2>/dev/null | wc -l | tr -d ' ') 张）："
    INPOOL=$(python3 - "$MAP" <<'PY'
import io, re, sys
s = io.open(sys.argv[1], encoding='utf-8').read()
m = re.search(r"const PHOTOS = \[(.*?)\];", s, re.S)
print(','.join(re.findall(r"'([^']+)'", m.group(1))) if m else '')
PY
)
    for f in "$DIR"/*.jpg; do
      [ -e "$f" ] || continue
      n=$(basename "$f" .jpg)
      mark="  "
      case ",$INPOOL," in *",$n,"*) mark="✓ ";; *) mark="· ";; esac
      printf '  %s%-10s %6s  ' "$mark" "$n" "$(du -h "$f" | cut -f1)"
      sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf "%s ", $2}'
      echo
    done
    echo
    echo "✓ = 在池子里（会被随机挂上）；· = 只在硬盘上、不会被用到"
    echo "池子（gallery.ts 的 PHOTOS）：$INPOOL"
    echo
    echo "⚠️ 挂到哪一页、哪一枚画框，是**每次刷新洗牌**决定的，而且全站不重样。"
    echo "   没有「把某张指定给某页」这回事 —— 那是刻意的（读者 2026-09-30）。"
    ;;

  *) die "未知子命令：$1（可用：add / rm / list）" ;;
esac
