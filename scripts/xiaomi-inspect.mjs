/**
 * 小米运动健康的导出包 —— **先看清楚里面有什么**，再谈怎么接进来。
 *
 *   bun scripts/xiaomi-inspect.mjs ~/Downloads/MiFitness_xxx.zip
 *   bun scripts/xiaomi-inspect.mjs ~/Downloads/已解压的目录
 *
 * ⚠️⚠️ 为什么第一步是「看」而不是「解析」。
 *
 *    小米官方导出的 CSV 结构**随 App 版本变**，而我们手上没有样本。
 *    照着别人的博客猜一套列名去解析，最可能的结局是**静默解析出 0 条**
 *    —— 而 0 条和「那天真的没运动」长得一模一样（这个项目栽过很多次）。
 *
 *    ⇒ 这个脚本**只做三件事**：列出有什么文件、每个 CSV 的表头、每个 CSV 里
 *      `Key` 列出现了哪些值。拿到这些**真实**的东西之后，再写解析器，
 *      而且解析器要拿**真实的几行**当夹具。
 *
 * ── 怎么拿到导出包（读者要做的）────────────────────────────────
 *
 *   1. 打开 https://account.xiaomi.com/ 登录
 *   2. **隐私中心** → **管理您的数据**
 *   3. 找到 **小米运动健康**，点右边的**下载**
 *   4. 按提示**绑定邮箱**（数据量大时生成要等一会儿）
 *   5. 邮件里有压缩包，**解压密码也在邮件里**
 *
 *   ⚠️ 已知限制（第三方导出工具的实测结论）：官方导出**没有 GPS**，
 *      步频也只有零星几个时间点。所以跳绳 / 健腹轮这类多半只有
 *      次数 / 时长 / 卡路里，**没有逐分钟曲线** —— 这一点先知道，
 *      免得接进来之后以为是解析写错了。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const SRC = process.argv[2];
if (!SRC || !existsSync(SRC)) {
  console.error('用法：bun scripts/xiaomi-inspect.mjs <导出的 zip 或已解压的目录>');
  process.exit(1);
}

/** zip 就先解开（`unzip` 是 macOS 自带的），目录就直接走。 */
let root = SRC;
if (statSync(SRC).isFile()) {
  root = mkdtempSync(join(tmpdir(), 'mifit-'));
  const r = Bun.spawnSync(['unzip', '-o', '-q', SRC, '-d', root]);
  if (r.exitCode !== 0) {
    console.error('✗ unzip 失败：', r.stderr.toString().slice(0, 200));
    process.exit(1);
  }
  console.log(`已解压到 ${root}\n`);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root);
console.log(`共 ${files.length} 个文件\n`);

// ── ① 有什么 ────────────────────────────────────────────────
const byExt = {};
for (const f of files) {
  const e = extname(f).toLowerCase() || '(无扩展名)';
  byExt[e] = (byExt[e] ?? 0) + 1;
}
console.log('── 按扩展名 ──');
for (const [e, n] of Object.entries(byExt).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${e}`);
}

const csvs = files.filter((f) => f.toLowerCase().endsWith('.csv'));
console.log(`\n── CSV（${csvs.length} 个）──`);
csvs.forEach((f) => console.log(`  ${f.replace(root, '.')}  ${(statSync(f).size / 1024).toFixed(0)}KB`));

// ── ② 每个 CSV 的表头 + Key 列有哪些值 ───────────────────────
//
// ⚠️ **不解析 CSV**（引号里带逗号、JSON 里带引号）—— 只按行切、取前几个字段，
//    目的是「看见真实的样子」，不是「把数据读对」。读对是下一步的事。
const i0 = (c) => c.length > 0;

for (const f of csvs) {
  console.log(`\n══ ${f.replace(root, '.')} ══`);
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  console.log(`  行数 ${lines.length}`);
  const head = lines[0] ?? '';
  console.log(`  表头：${head.slice(0, 220)}`);
  for (const l of lines.slice(1, 3)) console.log(`  样本：${l.slice(0, 220)}`);

  // `Key` 这一列是小米 fitness_data 的组织方式 —— 找出它有哪些取值
  const cols = head.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
  const ki = cols.findIndex((c) => c.toLowerCase() === 'key');
  if (ki >= 0) {
    const counts = {};
    for (const l of lines.slice(1)) {
      // 只取前 6 个字段就够 —— Key 一般在很前面，且值里不会先出现逗号
      const k = (l.split(',')[ki] ?? '').replace(/^"|"$/g, '').trim();
      if (k) counts[k] = (counts[k] ?? 0) + 1;
    }
    console.log(`  Key 列（${Object.keys(counts).length} 种）：`);
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`    ${String(n).padStart(6)}  ${k}`);
    }
  }

  /**
   * 运动类型那几列 —— 「跳绳 / 健腹轮」就是靠它们区分的。
   *
   * ⚠️ 第一版只挑了**第一个**匹配 `/sport|type/` 的列，于是选中了 `sport_id`
   *    （出来的是 1 / 7 / 23）而**跳过了 `sport_name`**（户外跑步 / 跳绳 / 健腹轮）。
   *    id 当然也有用（将来要按它映射 `exerciseType`），但**两个都要看**才认得出
   *    哪一列是名字、哪一列是编号。
   *    ⇒ 名字优先（`*_name` / 名称 / 类型），然后才是 id。
   */
  const nameIdx = cols
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => i0(c) && /name|名称|类型/i.test(c))
    .map(({ i }) => i);
  const idIdx = cols
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i0(c) && /sport|exercise|type|运动/i.test(c) && !nameIdx.includes(i))
    .map(({ i }) => i);
  for (const ti of [...nameIdx, ...idIdx].slice(0, 3)) {
    if (ti === ki) continue;
    const counts = {};
    for (const l of lines.slice(1)) {
      const v = (l.split(',')[ti] ?? '').replace(/^"|"$/g, '').trim();
      if (v) counts[v] = (counts[v] ?? 0) + 1;
    }
    console.log(`  「${cols[ti]}」列（${Object.keys(counts).length} 种）：`);
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`    ${String(n).padStart(6)}  ${k}`);
    }
  }
}

console.log(`
────────────────────────────────────────────────────────────
下一步：把上面这几段（尤其是表头、Key 列、运动类型列）贴回来，
        再写解析器 —— 而且解析器要拿**真实的几行**当夹具。
⚠️ 先别急着写解析：猜出来的列名解析出 0 条时，和「那天没运动」长得一样。
`);
