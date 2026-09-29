#!/usr/bin/env bash
#
# Publish the H5 build + `data/` to GitHub Pages.
#
#   bash scripts/deploy-pages.sh            # publish
#   bash scripts/deploy-pages.sh --dry-run  # show what would be published
#
# ⚠️ Why a `gh-pages` branch and not `main:/docs`.
#
# GitHub Pages serves the configured folder as the SITE ROOT. With the source at
# `main:/docs`, only the contents of `docs/` are reachable — the repo-root
# `data/` is NOT, and every poster URL of the form
# `<site>/data/coof/posters/<id>.jpg` 404s. The layout the app and the pipeline
# both assume is the one HANDOFF documents for local testing: build output at the
# root, `data/` beside it. A branch whose root *is* that layout is the only
# arrangement that serves both.
#
# ⚠️ This is manual on purpose. Automating it needs a step in
# `.github/workflows/`, and pushing anything under that path requires the
# `workflow` token scope — the credential in this machine's keychain has only
# `gist, read:org, repo`. See HANDOFF "未提交" for the consequence: `data/` is
# still committed to `main` by `sync.yml`, but publishing it is this script.
#
# ⚠️ `data/` becomes PUBLIC. The repo and the Pages site are both public, and a
# Pages site is readable by anyone regardless of repo visibility. COOF data is
# fine; health data must never land here — that is what the Worker auth path in
# `services/` exists for. Re-read docs/HOSTING.md before adding a brand.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

BRANCH="gh-pages"
DIST="apps/dashboard/dist"

if [[ ! -d "$DIST" ]]; then
  echo "✗ 找不到 $DIST —— 先跑：cd apps/dashboard && bun run build:h5" >&2
  exit 1
fi
if [[ ! -d data ]]; then
  echo "✗ 找不到 data/ —— 先跑一次 sync" >&2
  exit 1
fi

echo "▸ 构建产物  $(du -sh "$DIST" | cut -f1)"
echo "▸ 数据目录  $(du -sh data    | cut -f1)"
echo "▸ 目标分支  $BRANCH"

if $DRY_RUN; then
  echo
  echo "  (dry-run，未做任何改动)"
  exit 0
fi

# Stage the exact site layout in a scratch worktree so the publish never touches
# the working tree — a stray `git add -A` on `main` here would sweep the ~500
# untracked posters into a commit.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$DIST"/. "$STAGE"/
cp -R data "$STAGE"/data

# ── ⚠️⚠️ data/coof 和 data/cnsr 的写入方是 GitHub Action，**不是这台机器** ──
#
# 这是同一个 bug 的第三个和第四个实例（paperr、chealth 各有一个，都在下面
# 各自打了补丁）。这一次不再逐个目录打补丁，而是说清楚**机制**：
#
#   5 小时一次的 `sync` workflow 把新数据 commit 到 **main**，
#   而站点读的是 **gh-pages**。workflow 里**没有任何 gh-pages 步骤** ——
#   `grep -nE "gh-pages|deploy|pages" .github/workflows/sync.yml` 只返回
#   一行 `git push`。
#
#   ⇒ 两个后果，第二个才是真正伤人的：
#     1. 自动同步的数据**从来不会自己到达读者**，唯一的桥是这个脚本
#     2. 而这个脚本 `cp` 的是**本地工作区** —— 于是每次手动部署都会
#        把线上已经同步好的数据**覆盖回本地那份旧的**
#
#   ⚠️⚠️ 2026-09-29 实测（就是发现它的那次）：
#      `git diff --stat origin/main -- data/` 显示本地**缺**
#      `data/cnsr/img/3e909462….jpg`（1.4 MB，origin/main 上有），
#      而 `data/cnsr/index.json` / `learn.json` 都是旧的。
#      ⇒ 我之前每一次部署都在删那张图。
#
#   修法：这两棵树从 **origin/main** 取，不从工作区取。
#   ⚠️ 取不到就**大声失败**，绝不退回本地那份 ——
#      静默地用旧数据覆盖，正是这个 bug 能活这么久的原因。
if git fetch -q origin main 2>/dev/null; then
  for d in data/coof data/cnsr; do
    rm -rf "${STAGE:?}/$d"
    mkdir -p "$STAGE/$d"
    if ! git archive origin/main "$d" | tar -x -C "$STAGE"; then
      echo "✗ 从 origin/main 取 $d 失败" >&2
      exit 1
    fi
  done
  echo "  ✓ coof / cnsr 取自 origin/main（不是本地工作区）"
else
  echo "✗ git fetch origin main 失败 —— 拒绝用本地那份 coof/cnsr 覆盖线上" >&2
  echo "  本地可能是旧的；用旧数据强推正是这个脚本此前的 bug。" >&2
  echo "  网络恢复后重跑即可。" >&2
  exit 1
fi

# ⚠️⚠️ `cp -R data` copies EVERYTHING, including the files that are gitignored
# precisely because they must not be published. .gitignore protects `main`; it
# does NOTHING here, because this script builds the site from the filesystem, not
# from the index.
#
# The failure this prevents is not hypothetical: `data/chealth/` is health data
# and the site is world-readable regardless of repository visibility.
# ⚠️ `data/paperr/` used to be listed here too, while the reading history was
# private. It is public by the reader's decision now, and the only file in it
# that must never be published is the device's raw export — handled above.

# ── ⚠️⚠️ `data/paperr/` has TWO writers, and this script is the wrong one ──
#
# The Aliyun ingest publishes `data/paperr/index.json` itself via the GitHub
# API, every time the Kindle syncs. This script copies the whole `data/` tree
# from the development machine and force-pushes gh-pages.
#
# Those two met on 2026-09-24 and the result was silent: the server published a
# fresh index at 12:31:20 carrying the first real `hourly` data, and this script
# replaced it 77 seconds later with the Mac's copy from before that sync. The
# site showed stale numbers, the server's log said "已更新网站", and the only
# way to find it was to diff the three copies field by field.
#
# So: the live index wins. Fetch what is actually published and use that. The
# local file is only a fallback for a first-ever deploy or an offline machine.
# ⚠️⚠️ 这个 URL 必须指向**站点当前的**地址，而且 curl 必须带 `-L`。
#
# 它被重定向咬过**两次**：
#   1. 站点开 Enforce HTTPS 后，`http://` 全部 301 ⇒ 不带 `-L` 拿到空 body
#      ⇒ JSON 校验失败 ⇒ 守卫静默失效（那次把 chealth 索引删掉了）。
#   2. 仪表盘搬到 `z.cevtuogrnd.com` 后，`apps.cevtuogrnd.com/CEVTUO-Z/`
#      整条路径也变成 301 ⇒ 同样的失效方式，只是原因换了一个。
#
# 所以这里同时做两件事：URL 跟着站点走，**并且加 `-L`** ——
# 下一个搬地址的人不会再因为忘记改这里而删掉数据。
# ⚠️⚠️⚠️ 从这里取「服务器拥有的文件」，**不能从站点取** —— 站点前面有 CDN。
#
# 2026-09-29 实测（同一天里第二次栽在同一个形状上）：
#
#     06:24:27Z  本脚本 force-push 完（它取到的是 CDN 的旧副本）
#     06:25:37Z  服务器自己发布了一次，把带 09-29 的索引写回 gh-pages
#     06:28      从站点取到的**仍然是旧的那一版**（没有 09-29）
#
# 也就是说：站点那份可以比分支头**旧十分钟**（`max-age=600`），而这个脚本
# 是拿它当「线上权威副本」往回推的 —— 读者看到的 09-29 就是这样消失的。
# 2026-09-24 那次是「本地旧副本」冲掉服务器的发布，这次换成了「CDN 旧副本」，
# 同一个 bug 换了张脸。
#
# ⇒ `raw.githubusercontent.com` 没有 CDN，它给的就是**分支头**。
#   ⚠️ 但这也是「推之前那一刻」的状态，不是「推的时候」的 —— 所以下面
#      推送前还要再核一次（见 `推之前再核一次` 那段）。
server_owned() { # $1 = 仓库内路径（如 data/paperr/index.json）；stdout = 内容
  curl -fsSL --noproxy '*' -m 20 \
    "https://raw.githubusercontent.com/cevtuocjw/CEVTUO-Z/${BRANCH}/${1}" 2>/dev/null
}

PAPERR_LIVE="https://raw.githubusercontent.com/cevtuocjw/CEVTUO-Z/${BRANCH}/data/paperr/index.json"
if server_owned data/paperr/index.json > "$STAGE/data/paperr/index.json.tmp" 2>/dev/null \
   && bun -e "JSON.parse(require('fs').readFileSync('$STAGE/data/paperr/index.json.tmp','utf8'))" 2>/dev/null; then
  mv "$STAGE/data/paperr/index.json.tmp" "$STAGE/data/paperr/index.json"
  echo "  ▸ 保留线上已发布的 index.json（服务器拥有它，本脚本不覆盖）"
else
  rm -f "$STAGE/data/paperr/index.json.tmp"
  echo "  ⚠️ 取不到线上 index.json —— 用本地副本。如果服务器刚发布过，这次发布会把它冲掉。" >&2
fi

# ── ⚠️⚠️ `data/chealth/` 有同样的问题，而且更严重：不是覆盖，是**抹掉** ──
#
# 那个文件由阿里云的 ingest 加密后发布，Mac 上**根本没有** `data/chealth/`
# 目录（它在 .gitignore 里，从来不在工作树里）。
#
# ⚠️ 而这个脚本是「新建一个舞台目录 → 拷进去 → force-push」，所以**舞台上没有
#    的东西在 gh-pages 上就不存在了**。也就是说：跑一次 deploy-pages，线上那份
#    健康索引会被静默删除 —— 手机再推一次才会回来。
#
# ⚠️ 这比 paperr 那次（被旧版本覆盖）更坏：覆盖留下的是旧数据，删除留下的是
#    404，而页面读不到会显示「没有数据」—— 一个看起来完全正常的空状态。
#
# 所以同样处理：线上那份赢。密文信封本身是合法 JSON，所以校验方式和 paperr 一样。
# ⚠️⚠️ 同样必须是 `https://`，理由见上面 paperr 那段。
#
# ⚠️⚠️⚠️ 而且这一段**取不到就必须中止发布**，不能只是警告。
#
# 原来写的是「警告一句然后继续」，2026-09-28 实测后果：站点的 http 地址被
# Enforce HTTPS 301 掉之后守卫失效，于是**这一版真的把 lines 里的
# `data/chealth/index.json` 从 gh-pages 上删掉了** —— 页面读不到会显示
# 「没有数据」，一个看起来完全正常的空状态，而数据其实好端端躺在阿里云上。
#
# paperr 那段可以退回本地副本（最坏是旧数据）；这一段退回不了，因为
# **Mac 上根本没有 `data/chealth/` 目录**。所以「拿不到线上的」等于
# 「这次发布会删掉它」——那是不可接受的副作用，宁可不发布。
CHEALTH_LIVE="https://raw.githubusercontent.com/cevtuocjw/CEVTUO-Z/${BRANCH}/data/chealth/index.json"
mkdir -p "$STAGE/data/chealth"
if server_owned data/chealth/index.json > "$STAGE/data/chealth/index.json.tmp" 2>/dev/null \
   && bun -e "JSON.parse(require('fs').readFileSync('$STAGE/data/chealth/index.json.tmp','utf8'))" 2>/dev/null; then
  mv "$STAGE/data/chealth/index.json.tmp" "$STAGE/data/chealth/index.json"
  echo "  ▸ 保留线上已发布的 chealth/index.json（服务器拥有它，本脚本不覆盖也不删除）"
else
  rm -f "$STAGE/data/chealth/index.json.tmp"
  {
    echo "✗ 取不到线上 chealth/index.json，**中止发布**。"
    echo "  继续下去会把这份健康索引从 gh-pages 上删掉，而 Mac 上没有它的副本。"
    echo "  先确认:$CHEALTH_LIVE 能取到且是合法 JSON 信封。"
    echo "  （服务器上的权威副本:/opt/cevtuo-ingest/data/chealth/index.json）"
  } >&2
  exit 1
fi

# ⚠️ The device's raw export is server-only, per the ingest README. `cp -R data`
# has been putting it on the public site, where it sat as a stale duplicate of
# a file nothing reads.
rm -f "$STAGE/data/paperr/raw-koreader.json"

# GitHub Pages runs Jekyll unless told not to, and Jekyll silently drops paths
# beginning with `_` — which would take build assets with it.
touch "$STAGE"/.nojekyll

# ── ⚠️⚠️ CNAME：必须写，而且必须写对 ────────────────────────────────
#
# 这里有一个来回，两边都是真的，别只记住其中一半。
#
# **曾经是错的**：`cp site/CNAME "$STAGE"/CNAME`，内容 `apps.cevtuogrnd.com`。
# 那个域名**归 `cevtuocjw.github.io` 用户站所有**（根路径上那个 CEVTUOGRND
# 落地页），CEVTUO-Z 只是挂在它下面的项目路径 `/CEVTUO-Z/`。项目站声明了
# 别人的域名，GitHub 就把它搬到那个域名的根路径、顶掉落地页、两个仓库打架。
# 更阴的是它**不会自己暴露** —— 只要用户站那边也持有同一域名，两边能共存、
# 站点看起来完全正常；只有当有人按文档「移除再重新添加自定义域名」去触发
# HTTPS 签发时才会炸出来，而那一刻站点已经断了。（2026-09-28 实际发生过。）
# 所以当时**删掉了 site/CNAME**，这是对的。
#
# ⚠️⚠️ **但「删掉」不是结论，只是当时那个值错了。** 2026-09-28 晚些时候仪表盘
# 搬到了自己的域名 `z.cevtuogrnd.com`（与用户站无关，不冲突），于是 CNAME
# 文件**必须回来** —— 而这个脚本是「新建舞台目录 → force-push」，舞台上没有
# 的东西在 gh-pages 上就不存在了。我漏了这一步，GitHub 在我设置域名时写下的
# CNAME 被这次 force-push 删掉，后果是 **`z.cevtuogrnd.com` 整站 404**
# （GitHub 的「Site not found」页），而 API 里的 `cname` 字段仍然显示正确 ——
# 一个只在真实域名的真实页面上才看得见的故障。
#
# ⭐ 所以规则是：**CNAME 文件必须存在，且内容必须是这个仓库真正拥有的域名。**
#    - ✅ `z.cevtuogrnd.com` —— 本仓库的域名
#    - ❌ `apps.cevtuogrnd.com` —— 用户站的域名，写了就是抢
#
# ⚠️ 换域名时**这一行必须跟着改**，否则站点会静默消失。
CEVTUO_SITE_DOMAIN="${CEVTUO_SITE_DOMAIN:-z.cevtuogrnd.com}"
printf '%s\n' "$CEVTUO_SITE_DOMAIN" > "$STAGE/CNAME"
echo "  ▸ CNAME → $CEVTUO_SITE_DOMAIN"

# The publish branch is generated output only — it shares no history with `main`
# and never gets merged back, so an orphan root keeps its log readable instead of
# interleaving with source commits.
(
  cd "$STAGE"
  git init --quiet
  git checkout --quiet -b "$BRANCH"
  git add -A
  git -c user.name="cevtuo-deploy" -c user.email="deploy@cevtuogrnd.com" \
      commit --quiet -m "publish: H5 build + data ($(date -u +%Y-%m-%dT%H:%MZ))"
)

# ── ⚠️⚠️ 推之前再核一次：服务器可能就在这几十秒里发布过 ──────────────
#
# 上面取那几个文件到这里的推送之间隔着「构建 + 提交」，实测 20~40 秒；
# 而服务器是**每次 Kindle 同步就发布一次**。2026-09-29 那天它的两次发布
# 分别落在我那次部署的前后一分钟里 —— 也就是说「取一次就够了」这个假设
# 在这条链路上根本不成立。
#
# ⇒ 推之前再取一次（从 raw），**变了就把新的装进舞台并重新提交**；
#   连着三轮还在变就**中止发布**。宁可这次不发，也不要再冲掉别人的数据。
#   ⚠️ 中止而不是「警告后继续」：这个项目里「警告后继续」已经删过文件了
#      （见上面 chealth 那段）。
moved=1
for i in 1 2 3; do
  moved=0
  for p in data/paperr/index.json data/chealth/index.json; do
    server_owned "$p" > "$STAGE/$p.tmp" 2>/dev/null || { rm -f "$STAGE/$p.tmp"; continue; }
    if ! cmp -s "$STAGE/$p.tmp" "$STAGE/$p"; then
      mv "$STAGE/$p.tmp" "$STAGE/$p"
      moved=1
    fi
    rm -f "$STAGE/$p.tmp"
  done
  [ "$moved" = 0 ] && break
  git -C "$STAGE" add -A
  git -C "$STAGE" -c user.name="cevtuo-deploy" -c user.email="deploy@cevtuogrnd.com" \
      commit --quiet --amend --no-edit
  echo "  ▸ 线上索引在构建期间又更新了，已重新装进这一版（第 $i 次）"
  sleep 3
done
if [ "$moved" != 0 ]; then
  echo "✗ 线上索引一直在这几十秒里变 —— **中止发布**，避免覆盖服务器刚发布的数据。" >&2
  echo "  稍等一分钟再跑一次即可（服务器每次同步都会发布，这个窗口不常有）。" >&2
  exit 1
fi

echo "▸ 推送…"
git -C "$STAGE" push --force "https://github.com/cevtuocjw/CEVTUO-Z.git" "$BRANCH"

echo
echo "✓ 已发布到 ${BRANCH}"
# ⚠️ Braces are load-bearing: a full-width colon immediately after an unbraced
# `$BRANCH` is swallowed into the variable name and the script dies on `set -u`.
echo "  ⚠️ 若 Pages 源仍指向 main:/docs，要改成 ${BRANCH}:"
echo "     curl -X PUT -H 'Authorization: token <TOK>' \\"
echo "       https://api.github.com/repos/cevtuocjw/CEVTUO-Z/pages \\"
echo "       -d '{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/\"}}'"
