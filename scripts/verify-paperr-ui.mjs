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
 * books off the Kindle), not a fixture. That matters: the relabelling rules were
 * written from that file, and a synthetic one would agree with them by
 * construction.
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
    colorScheme: scheme,
    viewport,
    hasTouch: mobile,
    isMobile: mobile,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });

  await page.goto(`${BASE}/#/pages/paperr/index`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pr-row', { timeout: 20000 });

  // ── The page rendered at all ──────────────────────────────
  check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  const rowCount = await page.locator('.pr-row').count();
  check('book list rendered', rowCount === 36, `rows=${rowCount}`);

  // ── Overview numbers came from the data, not from placeholders ──
  const heroText = await page.locator('.section').first().innerText();
  // 56363 s = 15.66 h. Asserting the EXACT rendered string, so a page rendering
  // a placeholder that merely looks like a duration still fails.
  check('overview shows the computed reading total', heroText.includes('15.7h'), heroText.replace(/\n/g, ' ').slice(0, 90));
  check('overview is not the old placeholder', !heroText.includes('36h'), 'placeholder leaked');
  check('overview counts 36 books', heroText.includes('共 36 本'), heroText.replace(/\n/g, ' ').slice(0, 90));
  check('overview shows the page total', heroText.includes('2471 页'), heroText.replace(/\n/g, ' ').slice(0, 90));

  // ── Currently-reading panel ───────────────────────────────
  const curTitle = await page.locator('.pr-current__title').count();
  check('current book panel rendered', curTitle === 1);

  const barW = await page.locator('.pr-bar__fill').evaluate((el) => el.style.width);
  check('progress bar has a width from the data', /^[\d.]+%$/.test(barW) && parseFloat(barW) > 0, barW);

  const curBlock = await page.locator('.pr-current').innerText();
  check('current panel shows a finish estimate or says it cannot', /预计 \d{2}-\d{2} 读完|还看不出读完时间/.test(curBlock), curBlock.replace(/\n/g, ' ').slice(0, 80));

  // ⚠️ The whole point of the triage: KOReader's own documents must not reach
  // the ROWS. This is the assertion that would have caught the rules silently
  // failing open.
  //
  // ⚠️ Scoped to `.pr-row__title`, not `document.body`. The page's own lede
  // legitimately says "只取 KOReader 自己的 statistics.sqlite3" — a whole-body
  // regex flags that and reports a bug that is not there.
  const titles = await page.locator('.pr-row__title').allInnerTexts();
  const leaked = titles.filter((t) => /koreader/i.test(t));
  check('no KOReader document titles among the rows', leaked.length === 0, leaked.slice(0, 3).join(' | '));
  check('no UUID-only titles left among the rows',
        !titles.some((t) => /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(t)), 'raw uuid leaked');
  check('every relabelled row is a newsN/unknownN label',
        titles.every((t) => !/^(EpubPressX|.* · \d{4}-\d{2}-\d{2})$/.test(t.trim())),
        titles.find((t) => /^EpubPressX/.test(t)) ?? '');

  // ── Daily strip ───────────────────────────────────────────
  const bars = await page.locator('.pr-days__bar').count();
  check('daily strip rendered', bars === 14, `bars=${bars}`);

  const heights = await page.locator('.pr-days__bar').evaluateAll((els) =>
    els.map((e) => e.style.height),
  );
  const nums = heights.map((h) => parseFloat(h)).filter((n) => Number.isFinite(n));
  check('every bar has a height', nums.length === bars, `${nums.length}/${bars}`);
  check('tallest bar is 100% (scaled to its own window)', Math.max(...nums) === 100, `max=${Math.max(...nums)}`);
  check('no bar is zero-height', Math.min(...nums) > 0, `min=${Math.min(...nums)}`);

  // ── Relabelling is visible, and the original survives ─────
  const newsRow = page.locator('.pr-row', { has: page.locator('.pr-row__title', { hasText: /^news\d+$/ }) }).first();
  check('news rows exist', (await newsRow.count()) === 1);

  const newsText = await newsRow.innerText();
  check('news row shows the device title underneath', /EpubPressX|·/.test(newsText), newsText.replace(/\n/g, ' ').slice(0, 90));

  const unknownRow = page.locator('.pr-row', { has: page.locator('.pr-row__title', { hasText: /^unknown\d+ \(/ }) }).first();
  check('unknown rows exist', (await unknownRow.count()) === 1);
  const unknownBlock = await unknownRow.innerText();
  const unknownTitle = await unknownRow.locator('.pr-row__title').innerText();
  // ⚠️ The original is already inside the parentheses — a subtitle here would
  // print the same string twice.
  const unkLines = unknownBlock.split('\n').filter(Boolean);
  check('unknown row does NOT duplicate the original title', unkLines.length < 3 || unkLines[1] !== unknownTitle, unkLines.slice(0, 3).join(' / '));

  // ── Filters actually filter (real clicks) ─────────────────
  const chip = (label) => page.locator('.pr-chip', { hasText: label });

  await chip('只看书').click();
  await page.waitForTimeout(150);
  const booksOnly = await page.locator('.pr-row').count();
  check('「只看书」narrows the list', booksOnly > 0 && booksOnly < rowCount, `${rowCount} → ${booksOnly}`);
  check('「只看书」hides every relabelled row', booksOnly === 5, `books=${booksOnly}`);

  await chip('读完').click();
  await page.waitForTimeout(150);
  const doneRows = await page.locator('.pr-row').count();
  const doneTags = await page.locator('.pr-row__pct--done').count();
  check('「读完」filters to finished books', doneRows === 2, `rows=${doneRows}`);
  check('every row in 「读完」is marked finished', doneTags === doneRows, `${doneTags}/${doneRows}`);

  await chip('在读').click();
  await page.waitForTimeout(150);
  const readingRows = await page.locator('.pr-row').count();
  check('「在读」and 「读完」partition the list', readingRows + doneRows === rowCount, `${readingRows}+${doneRows} vs ${rowCount}`);

  await chip('全部').click();
  await page.waitForTimeout(150);
  check('「全部」restores the full list', (await page.locator('.pr-row').count()) === rowCount);

  // ⚠️ The chip's own state must follow the click. A filter that filters but
  // does not LOOK selected is the exact "wired to nothing" failure this file
  // exists to catch — the list would change while the control lied about it.
  const onCount = await page.locator('.pr-chip--on').count();
  check('exactly one chip is marked active', onCount === 1, `active=${onCount}`);

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
