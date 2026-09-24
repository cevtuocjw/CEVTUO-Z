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

# ⚠️⚠️ `cp -R data` copies EVERYTHING, including the files that are gitignored
# precisely because they must not be published. .gitignore protects `main`; it
# does NOTHING here, because this script builds the site from the filesystem, not
# from the index.
#
# The failure this prevents is not hypothetical: `data/paperr/current.json` is
# which book the reader has open right now, and a Pages site is world-readable
# regardless of repository visibility. Publishing it would be silent — the site
# would simply serve it, at a guessable URL, forever.
#
# ⚠️ Add to this list in the same commit that gitignores anything new under
# `data/`. The check below is what makes forgetting loud instead of silent.
PRIVATE=(
  "data/paperr/raw-koreader.json"
  "data/paperr/current.json"
  "data/chealth"
)
for rel in "${PRIVATE[@]}"; do
  rm -rf "${STAGE:?}/$rel"
  if [[ -e "$STAGE/$rel" ]]; then
    echo "✗ 私有文件没删掉：$rel —— 中止发布" >&2
    exit 1
  fi
  echo "  ▸ 已排除私有路径 $rel"
done

# GitHub Pages runs Jekyll unless told not to, and Jekyll silently drops paths
# beginning with `_` — which would take build assets with it.
touch "$STAGE"/.nojekyll
if [[ -f site/CNAME ]]; then
  cp site/CNAME "$STAGE"/CNAME
fi

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
