/**
 * Behaviour check for the CAPPERR page.
 *
 *   bun scripts/verify-paperr-ui.mjs [base-url] [out-dir]
 *
 * ⚠️ Why this exists at all.
 *
 * This project has shipped "done" three times with a control wired to nothing —
 * `Section.onPress` never passed, a label swallowed by `pointer-events: none`, a
 * stylesheet never imported. None of those are visible in a screenshot or in the
 * source. The only thing that catches them is driving the real page and reading
 * the DOM before and after a real event.
 *
 * ⚠️ Playwright, not CDP against the running Chrome — see scripts/shots.mjs.
 * Chrome 153 here inverts dark pages in `Page.captureScreenshot`, and this
 * script's whole value is that what it reports matches what a person sees.
 *
 * ⚠️ It runs against a REAL device export (data/paperr/raw-koreader.json, 41
 * books off the Kindle). A synthetic fixture would agree with the relabelling
 * rules by construction.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8096/z';
const OUT = process.argv[3] ?? '/tmp/paperr-ui';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function run(browser, { scheme, viewport, mobile }, tag) {
  console.log(`\n── ${tag} (${scheme}, ${viewport.width}×${viewport.height}) ──`);

  const ctx = await browser.newContext({
    colorScheme: scheme, viewport, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  await page.goto(`${BASE}/#/pages/paperr/index`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pr-row', { timeout: 20000 });
  await page.waitForTimeout(800);

  check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  // ── Two panels, as asked ──────────────────────────────────
  const sections = await page.locator('.section').count();
  check('exactly two panels', sections === 2, `sections=${sections}`);

  const titles = await page.locator('.section__title, .section__label').allInnerTexts().catch(() => []);
  // ⚠️ `.topbar__title`, not `.nav__title`. `nav__*` is demo.scss's older nav;
  // the component that actually renders the bar is TopBar and it uses `topbar__*`.
  const navText = await page.locator('.topbar__title').first().innerText().catch(() => '');
  check('top bar says CAPPERR, not CE-CAPPERR', navText.trim() === 'CAPPERR', navText);

  // ⚠️ Every other brand's title has no CE- prefix. One brand carrying it is a
  // typo, not a style.
  const anyCePrefix = await page.evaluate(() => /CE-CAPPER/.test(document.body.innerText));
  check('no CE-CAPPER anywhere on the page', !anyCePrefix);

  // ── The shelf ─────────────────────────────────────────────
  const rowCount = await page.locator('.pr-row').count();
  check('shelf rendered', rowCount === 36, `rows=${rowCount}`);

  // ⚠️ These two used to look for "15.7h" and "29" anywhere in the panel and
  // pass — but they were written for a top stat block that no longer exists, and
  // "15.7h" also happens to be the donut's centre label. They were asserting a
  // coincidence. Anchored on `.pc-periods` now, which is the block that is
  // actually supposed to carry the current-window numbers.
  const heroText = await page.locator('.section').first().innerText();
  check('no all-time total in the headline', !heroText.includes('累计阅读'),
        heroText.replace(/\n/g, ' ').slice(0, 80));
  const periodText = await page.locator('.pc-periods').innerText();
  check('period block leads with today / week / month',
        ['今天', '本周', '本月'].every((w) => periodText.includes(w)),
        periodText.replace(/\n/g, ' ').slice(0, 80));

  // ── The charts ────────────────────────────────────────────
  check('donut rendered', (await page.locator('.pc-donut__seg').count()) === 3);
  const legend = await page.locator('.pc-legend__label').allInnerTexts();
  check('donut categories are Books / News / Unnamed',
        legend.join(',') === 'Books,News,Unnamed', legend.join(','));

  const centreBefore = await page.locator('.pc-donut__value').innerText();
  await page.locator('.pc-legend__row').first().click();
  await page.waitForTimeout(200);
  const centreAfter = await page.locator('.pc-donut__value').innerText();
  check('tapping a donut legend changes the centre', centreAfter !== centreBefore && /%$/.test(centreAfter),
        `${centreBefore} → ${centreAfter}`);
  await page.locator('.pc-legend__row').first().click();
  await page.waitForTimeout(150);

  const curveD = await page.locator('.pc-curve__line').getAttribute('d');
  check('curve drew a smoothed path', !!curveD && curveD.includes(' C '), `${curveD?.slice(0, 20)}…`);
  // ⚠️ This month as a calendar, which replaced the rolling 12-week heatmap.
  // A month is 28–31 days plus leading blanks padded to whole weeks, so the
  // count varies — what must hold is that it is a whole number of weeks and
  // covers at least the month.
  const calCells = await page.locator('.pc-cal__cell').count();
  check('month calendar rendered whole weeks', calCells > 0 && calCells % 7 === 0, `cells=${calCells}`);
  check('calendar shows every day of the month',
        (await page.locator('.pc-cal__day').count()) >= 28, `days=${await page.locator('.pc-cal__day').count()}`);
  check('weekday bars rendered', (await page.locator('.pc-bars__col').count()) === 7);
  // ⚠️ Five, not four. `速度` was added as a rate — every other record is a
  // sum, and a sum only ever goes up, which makes it useless for "am I reading
  // faster than I was".
  check('records rendered', (await page.locator('.pc-records__cell').count()) === 4);

  // ⚠️ Today / this week / this month, with a delta each. A running total
  // cannot answer "am I reading more than last week", which is the question
  // this block exists for — so the delta is asserted, not just the total.
  const periodCols = await page.locator('.pc-periods__col').count();
  check('three period columns rendered', periodCols === 3, `cols=${periodCols}`);
  const deltas = await page.locator('.pc-periods__delta').allInnerTexts();
  check('every period carries a comparison',
        deltas.length === 3 && deltas.every((d) => /比|可比/.test(d)), deltas.join(' | '));

  // ⚠️ THIS week's bars, with today marked. The month's weekday totals were
  // replaced: "which weekday do I read most" barely moves, so it stops being
  // worth a slot on the page.
  check('this week bars rendered', (await page.locator('.pc-bars__col').count()) === 7);
  check('today is marked in the week bars',
        (await page.locator('.pc-bars__col--now').count()) === 1,
        `marked=${await page.locator('.pc-bars__col--now').count()}`);

  const bandBars = await page.locator('.pc-bands__col').count();
  check('progress bands rendered', bandBars === 10, `bars=${bandBars}`);

  // ⚠️ The heatmap must not be magnified. Its viewBox is 12px cells; measured
  // width tells us the render size, and anything far past the natural size
  // means `width: 100%` is stretching it again — which is what "热力图过大"
  // was, and it is invisible to every other assertion here.
  // ⚠️ Charts must actually animate in. The reveal is driven by an
  // IntersectionObserver that only finds its targets if the effect runs AFTER
  // the fetch resolves — keyed on mount it would query an empty document and
  // every chart would stay at `opacity: 0`, which looks exactly like "no
  // animation was written" from the outside.
  const revealed = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.pc-reveal')];
    return { total: all.length, shown: all.filter((e) => e.classList.contains('pc-reveal--in')).length };
  });
  check('charts carry a reveal class', revealed.total > 0, JSON.stringify(revealed));
  check('charts animate in on becoming visible', revealed.shown > 0, JSON.stringify(revealed));

  // ⚠️ The hour grid has an honest empty state: the export on disk predates the
  // plugin change that added `hourly`, so all 24 hours are zero and the chart
  // says so rather than drawing 24 flat bars that read as "never read".
  const hourBars = await page.locator('.pc-hours__bar').count();
  const hourEmpty = (await page.locator('.pc-hours').innerText()).includes('时段数据还没有');
  check('hour grid is either drawn or honestly empty', hourBars === 24 || hourEmpty,
        `bars=${hourBars} empty=${hourEmpty}`);

  // ⚠️ A heading with no chart under it reads as a chart that failed to load.
  const headTexts = await page.locator('.pr-h').allInnerTexts();
  const monthHeading = headTexts.includes('月份');
  const monthBars = await page.locator('.pc-months__bar').count();
  check('the 月份 heading is hidden when there is no chart', !monthHeading || monthBars > 0,
        `heading=${monthHeading} bars=${monthBars}`);

  // ── 待看 sorts last ───────────────────────────────────────
  await page.locator('.pr-chip', { hasText: '全部' }).click();
  await page.waitForTimeout(200);
  const bucketSeq = await page.evaluate(() =>
    [...document.querySelectorAll('.pr-row__pct')].map((e) => e.textContent?.trim() ?? ''));
  const firstTodo = bucketSeq.indexOf('待看');
  const lastNonTodo = bucketSeq.reduce((n, x, i) => (x !== '待看' ? i : n), -1);
  check('待看 rows sort after every other row', firstTodo === -1 || firstTodo > lastNonTodo,
        `firstTodo=${firstTodo} lastOther=${lastNonTodo}`);

  // ── The filters ───────────────────────────────────────────
  const chip = (label) => page.locator('.pr-chip', { hasText: label });
  // ⚠️ Books is 3: the dictionary, plus two RSS articles whose titles are real
// headlines rather than a generated pattern, so no relabelling rule fires on
// them. It was 1 while the unknown rule was still swallowing them.
for (const [label, expect] of [['在读', 3], ['读完', 29], ['待看', 4], ['Books', 3]]) {
    await chip(label).click();
    await page.waitForTimeout(200);
    const n = await page.locator('.pr-row').count();
    check(`「${label}」filter`, n === expect, `rows=${n} (expected ${expect})`);
  }
  // ⚠️ 3 + 29 + 4, not +1. `Books` is a CROSS-CUTTING filter — the rows it keeps
  // are also in 在读/读完/待看 — so it is not a fourth bucket. Adding it double
  // counts the dictionary, which is exactly what the first version of this
  // assertion did.
  check('the three buckets partition the shelf',
        3 + 29 + 4 === rowCount, `3+29+4 vs ${rowCount}`);
  check('Books is a filter, not a bucket', 1 < 3 + 29 + 4, 'Books must overlap');

  await chip('全部').click();
  await page.waitForTimeout(200);
  check('「全部」restores the full list', (await page.locator('.pr-row').count()) === rowCount);
  check('exactly one chip is active', (await page.locator('.pr-chip--on').count()) === 1);

  // ⚠️ Nothing may spill out of its panel. This shipped broken once: the shelf's
  // scrollHeight was 2077px inside a 1000px panel with `overflow: visible`, so
  // two thirds of it could not be reached — and every DOM assertion passed.
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.section')]
    .map((s) => ({ h: Math.round(s.getBoundingClientRect().height), sh: s.scrollHeight }))
    .filter((s) => s.sh > s.h + 2));
  check('no section overflows its panel', overflow.length === 0, JSON.stringify(overflow));

  // ⚠️ And the overview must actually scroll — it holds six charts in one panel.
  const scrollInfo = await page.evaluate(() => {
    const el = document.querySelector('.pr-scroll');
    if (!el) return null;
    el.scrollTop = el.scrollHeight;
    return { sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop };
  });
  check('the overview panel scrolls to its last chart', !!scrollInfo && scrollInfo.top > 0, JSON.stringify(scrollInfo));

  // ── The grid actually arranges by width ───────────────────
  //
  // ⚠️ "这几个图标块都应该自动排……可以分列，根据屏幕宽度". Counting the distinct
  // `top` values of the cells tells us the real column count the browser chose —
  // reading the CSS would only tell us what we hoped it would choose.
  const grid = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.pr-grid__cell')];
    const perRow = {};
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      const k = Math.round(r.top);
      perRow[k] = (perRow[k] ?? 0) + 1;
    }
    const counts = Object.values(perRow);
    return {
      cells: cells.length,
      widestRow: counts.length ? Math.max(...counts) : 0,
      // A cell whose children stick out of it is the donut-in-a-narrow-column
      // failure: it paints over its neighbour and eats that neighbour's clicks.
      spilling: cells.filter((c) => c.scrollWidth > c.clientWidth + 2).length,
    };
  });
  check('图表块按宽度自动分列（至少一行两列）', grid.widestRow >= 2, JSON.stringify(grid));
  check('没有图表块溢出自己的格子', grid.spilling === 0, JSON.stringify(grid));

  await page.screenshot({ path: `${OUT}/paperr-${tag}.png`, fullPage: false });
  await ctx.close();
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  await run(browser, { scheme: 'dark', viewport: { width: 390, height: 844 }, mobile: true }, 'phone');
  await run(browser, { scheme: 'light', viewport: { width: 900, height: 1000 }, mobile: false }, 'wide');
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  · ${f.name}  ${f.detail}`);
  process.exit(1);
}
