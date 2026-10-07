/*
 * UO 面板**冷启动**探针 —— 「打开 UO 一直读取中」那个竞态。
 *
 * 读者 2026-10-07 原话：
 *   「在主页直接点击 UO 非常快速就可以看到内容，但是如果在其他页面例如点击进入
 *     CHEALTH 等页面，打开 UO 就一直在读取中完全加载不出来内容，返回主页也是的」。
 *
 * ⚠️⚠️ 这个 bug 是**竞态**：只有当"挂载时的预热还在飞"的时候点开才触发。
 *   所以探针**故意把数据请求拖慢**（`DELAY`），把它变成确定性的 ——
 *   不然线上跑一次可能是绿的，而问题还在。
 *   （同一个道理：FACT 纪律 9/15 —— 测运气的断言要换成测契约的断言。）
 *
 * 契约（判据）：**只要数据到了，面板上就必须有内容。**
 *   修好的版本：预热那次**不因为"打开"而被放弃** ⇒ 数据 2.5s 到 ⇒ 2.5s 出内容。
 *   坏掉的版本：打开动作杀掉预热，而"120 秒内取过"又把重取挡掉 ⇒ **永远没有**。
 *
 * 用法：
 *   bun scripts/probe-uo-coldstart.mjs <baseUrl> [DELAY_MS]
 * 例：
 *   bun scripts/probe-uo-coldstart.mjs http://127.0.0.1:8127 2500
 */
import { chromium } from 'playwright';

const base = (process.argv[2] || 'http://127.0.0.1:8127').replace(/\/$/, '');
const DELAY = Number(process.argv[3] ?? 2500);

const ARMS = [
  ['home', '/'],
  ['chealth', '/chealth'],
];

const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-bypass-list=*'] });
const out = {};

for (const [name, path] of ARMS) {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();

  /*
   * ⚠️ 把**两份**数据都拖慢。只拖一份的话另一份先到、`setFeed` 照样会被调用，
   *    竞态就重现不出来了（`setFeed` 是在两份都取完之后才调的）。
   */
  const slow = async (route) => {
    await new Promise((r) => setTimeout(r, DELAY));
    await route.continue();
  };
  await page.route('**/data/chealth/index.json*', slow);
  await page.route('**/data/paperr/index.json*', slow);
  await page.route('**/data/coof/index.json*', slow);

  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cnb__btn--uo', { timeout: 20000 });

  const t0 = Date.now();
  await page.click('.cnb__btn--uo');

  /*
   * ⚠️⚠️ **判据必须把"加载中"那行排除掉 —— 我第一版没排除，断言是空跑的。**
   *
   * 实测证据：数据被拖慢 2500ms，而第一版报 `appearedAtMs: 117`，
   * 同时 `stageText` 还是「读取中…」、`lines: 1`。
   * ⇒ 那唯一的 `.nowb__line` **就是"读取中…"自己**，它的文本非空，
   *   于是"有内容"这条判据在**加载态**就成立了 ——
   *   **它对坏掉的版本一样会绿，等于没测东西**（FACT 纪律 15(2)）。
   *
   * ⚠️ 也不能数"元素个数"（占位行也带这个类），不能用 `innerText`
   *   （元素没显出来时读空串，我因此误判过两次）。
   */
  const LOADING = ['读取中', 'Loading'];
  const countContent = () =>
    page.evaluate((loading) => {
      const lines = Array.from(document.querySelectorAll('.nowb__line'));
      return lines.filter((e) => {
        const t = (e.textContent || '').trim();
        return t.length > 1 && !loading.some((s) => t.includes(s));
      }).length;
    }, LOADING);

  let appearedAt = null;
  for (let i = 0; i < 90; i++) {
    if ((await countContent()) > 0) {
      appearedAt = Date.now() - t0;
      break;
    }
    await page.waitForTimeout(150);
  }

  // ⚠️ 失败时再等一会儿 —— 要能分清"慢"和"永远不来"（FACT 纪律 8）
  if (appearedAt === null) await page.waitForTimeout(4000);

  const diag = await page.evaluate(() => {
    const w = document.querySelector('.nowb');
    const stage = document.querySelector('.nowb__stage');
    return {
      dataOpen: w ? w.getAttribute('data-open') : null,
      lines: document.querySelectorAll('.nowb__line').length,
      // ⚠️ 量不到时把看到的东西原样带出去，不要只回 null 让人对着空白猜
      stageText: (stage ? stage.textContent : '').slice(0, 120),
      lineTexts: Array.from(document.querySelectorAll('.nowb__line'))
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 12),
    };
  });

  out[name] = { appearedAtMs: appearedAt, ...diag };
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify({ base, DELAY, arms: out }, null, 2));

const bad = Object.entries(out).filter(([, v]) => v.appearedAtMs === null);
if (bad.length) {
  console.log('\n✗ 卡在读取中：' + bad.map(([k]) => k).join(', '));
  process.exit(1);
}
console.log('\n✓ 两页都在数据到达后出内容');
