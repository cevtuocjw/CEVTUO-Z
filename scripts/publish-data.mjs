#!/usr/bin/env bun
/**
 * publish-data.mjs — 把 `main` 上「自动同步」的数据发布到 `gh-pages`。
 *
 *   bun scripts/publish-data.mjs            # 发布（没有变化就什么都不做）
 *   bun scripts/publish-data.mjs --dry-run  # 只报告会改什么
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 站点读的是 **gh-pages**，而 5 小时一次的 `sync` workflow 把数据 commit 到
 * **main**。这两条分支之间**从来没有人搭桥**：`sync.yml` 里没有一个 gh-pages
 * 步骤。唯一的桥一直是**手工**跑 `deploy-pages.sh`。
 *
 * ⇒ 后果（2026-10-07 实测，就是写这个脚本的那次）：
 *     `main:data/cnsr/learn.json`    = 2026-10-07T03:59+08:00（当天）
 *     `gh-pages:data/cnsr/learn.json` = 2026-10-05T02:31+08:00（两天前）
 *   于是主页 COOF 那格的「更新于」停在 10-04，而 sync 明明每 5 小时都成功。
 *
 * ⚠️ 而 CHEALTH / CAPPERR 是**好的** —— 因为它们的写入方是阿里云的接入服务，
 *    它**直接**用 GitHub API 写 gh-pages，绕过了这一跳。
 *    「只有这两个是新的」这个症状，本身就把故障定位到了这座缺失的桥。
 *
 * ── 为什么用 Git Data API 而不是 `git push` ──────────────────
 *
 * · **原子**：9 个文件一次 commit。逐个文件 PUT 会产生 9 个 commit
 *   ⇒ 9 次 Pages 构建，而 Pages 的构建配额是**每小时 10 次**。
 * · **不用克隆 gh-pages**：那棵树带着 1200 张海报，`git fetch` 实测 ~35 KB/s。
 * · blob 是**仓库级**的：main 上的 blob sha 可以直接被 gh-pages 的新树引用，
 *   不需要把内容搬一遍。
 * · **不 force**：gh-pages 上还有别的写入方（阿里云的接入服务每 15 分钟写一次
 *   `data/paperr` / `data/chealth`），force-push 会把它们**刚写进去的东西**抹掉。
 *   代价是会撞车 —— 所以下面有重试，**重试而不是 force**。
 *
 * ── 边界（照抄 `deploy-pages.sh` 的规矩，别自己发明）────────────
 *
 *   发布：data/coof/**  data/cnsr/**  data/sync-meta.json
 *   不碰：data/paperr/**（两个写入方，服务端那份才是权威）
 *         data/chealth/**（同上，而且是加密载荷）
 *         以及 gh-pages 上其余一切（index.html / js / css / static）
 *
 * ⚠️ `data/paperr/raw-koreader.json` **只在 main 上**，是设备的原始导出，
 *    永远不许出现在公开站点上 —— 上面这条边界正是拦住它的东西。
 *
 * ⚠️⚠️ 调用方注意：`sync.yml` 是用 `GITHUB_TOKEN` 推 main 的，而
 *    **GITHUB_TOKEN 触发的事件不会启动别的 workflow**。
 *    所以 `.github/workflows/publish.yml` **不能**用 `on: push` ——
 *    它用 `workflow_run` + `schedule` 兜底。见那个文件的抬头。
 */

const REPO = process.env.GITHUB_REPOSITORY || 'cevtuocjw/CEVTUO-Z';
const API = `https://api.github.com/repos/${REPO}`;
const SRC = 'main';
const DST = 'gh-pages';

/** 同步范围：`data/` 下的这些路径（目录以 / 结尾）。 */
const SYNC_DIRS = ['coof/', 'cnsr/'];
const SYNC_FILES = ['sync-meta.json'];

/** 撞车重试次数。写入方每 15 分钟一次，而 sync 每 5 小时一次。 */
const MAX_ATTEMPTS = 3;

const DRY = process.argv.includes('--dry-run');

let TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
if (!TOKEN) {
  try {
    TOKEN = new TextDecoder().decode(
      Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe' }).stdout,
    ).trim();
  } catch {}
}
if (!TOKEN) {
  console.error('✗ 没有 GitHub token（GITHUB_TOKEN / gh auth token 都没有）');
  process.exit(1);
}

async function api(path, init = {}) {
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const err = new Error(`${init.method || 'GET'} ${path} → ${r.status} ${body.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

/** `data/` 下的文件清单：路径（去掉 data/ 前缀）→ blob sha。 */
async function dataTree(ref) {
  const j = await api(`/git/trees/${ref}:data?recursive=1`);
  const out = new Map();
  for (const e of j.tree) if (e.type === 'blob') out.set(e.path.replace(/^data\//, ''), e.sha);
  return { files: out, truncated: !!j.truncated };
}

const inScope = (p) => SYNC_DIRS.some((d) => p.startsWith(d)) || SYNC_FILES.includes(p);

/** 一趟：算差异 → 建树 → 提交 → 更新 ref。 */
async function once() {
  const main = await dataTree(SRC);
  const pages = await dataTree(DST);
  if (main.truncated || pages.truncated) {
    console.error('✗ tree 被截断（文件太多）—— 拒绝在看不见全貌的情况下发布。');
    process.exit(1);
  }

  // ⚠️ 只有**范围内**的路径参与比较。范围外的一切（paperr / chealth / .DS_Store）
  //    连看都不看 —— 「没比较」和「比较后认为相同」在结果上必须不重合。
  const upserts = [];
  const deletes = [];
  for (const [p, sha] of main.files) {
    if (!inScope(p)) continue;
    if (pages.files.get(p) !== sha) upserts.push({ path: 'data/' + p, sha });
  }
  for (const p of pages.files.keys()) {
    if (!inScope(p)) continue;
    if (!main.files.has(p)) deletes.push('data/' + p);
  }

  console.log(`▸ 范围：${SYNC_DIRS.concat(SYNC_FILES).join(' ')}`);
  console.log(`▸ 新增/更新 ${upserts.length} 个，删除 ${deletes.length} 个`);
  for (const u of upserts.slice(0, 25)) console.log('    + ' + u.path);
  if (upserts.length > 25) console.log(`    … 还有 ${upserts.length - 25} 个`);
  for (const d of deletes.slice(0, 25)) console.log('    - ' + d);

  if (!upserts.length && !deletes.length) return 'noop';
  if (DRY) return 'dry';

  const ref = await api(`/git/ref/heads/${DST}`);
  const head = ref.object.sha;
  const baseTree = (await api(`/git/commits/${head}`)).tree.sha;

  // ⚠️ `sha: null` 是 Git Data API 里「删掉这个路径」的写法，不是省略。
  //    写错成空字符串会被当成一个内容为空的 blob —— 文件还在，只是空了。
  const entries = [
    ...upserts.map((u) => ({ path: u.path, mode: '100644', type: 'blob', sha: u.sha })),
    ...deletes.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
  ];

  const tree = await api('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const commit = await api('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `publish: 数据同步 (${stamp})`,
      tree: tree.sha,
      parents: [head],
    }),
  });

  await api(`/git/refs/heads/${DST}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  console.log(`✓ 已发布 ${upserts.length + deletes.length} 处改动 → ${DST}  ${commit.sha.slice(0, 7)}`);
  return 'done';
}

for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
  try {
    const r = await once();
    if (r === 'noop') console.log('✓ 已经是最新的，无需发布。');
    if (r === 'dry') console.log('▸ dry-run：到此为止。');
    process.exit(0);
  } catch (e) {
    // 409/422 = 我们算树的时候另一个写入方刚好推过 ⇒ 重新算一遍再试。
    // ⚠️ **不是**去 force —— force 会把接入服务刚写的 paperr/chealth 抹掉。
    const racy = e.status === 409 || e.status === 422;
    if (!racy || i === MAX_ATTEMPTS) {
      console.error(`✗ 发布失败：${e.message}`);
      if (racy) console.error('  连着撞了 ' + MAX_ATTEMPTS + ' 次车 —— 稍后重跑即可，不要去 force。');
      process.exit(1);
    }
    console.log(`  ⚠️ 第 ${i} 次撞车（另一个写入方刚推过），重新计算…`);
    await new Promise((s) => setTimeout(s, 3000));
  }
}
