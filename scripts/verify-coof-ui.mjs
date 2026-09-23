/**
 * Behaviour check for the COOF overview panel — wave chart, donut sheet, jump.
 *
 *   bun scripts/verify-coof-ui.mjs [base-url] [out-dir]
 *
 * ⚠️ Why this exists at all.
 *
 * This project has shipped "done" three times in a row with a control that was
 * wired to nothing — `Section.onPress` never passed, a label swallowed by
 * `pointer-events: none`, a stylesheet never imported. None of those were
 * visible in a screenshot or in the source. The only thing that catches them is
 * driving the real page and reading the DOM before and after a real event.
 *
 * ⚠️ Playwright, not CDP against the running Chrome — see the note in
 * shots.mjs. Chrome 153 on this machine inverts dark pages in
 * `Page.captureScreenshot`, and this script's whole value is that what it
 * reports matches what a person sees.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8096/z';
const OUT = process.argv[3] ?? '/tmp/coof-ui';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Drag a finger across the wave, through CDP — Playwright's touchscreen only taps. */
async function touchDrag(page, from, to, steps = 6) {
  const cdp = await page.context().newCDPSession(page);
  const at = (f) => ({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
  const p0 = at(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p0] });
  for (let i = 1; i <= steps; i += 1) {
    const p = at(i / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    await page.waitForTimeout(30);
  }
  return async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
}

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

  await page.goto(`${BASE}/#/pages/coof/index`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wave__line', { timeout: 20000 });
  await page.waitForFunction(() => /全年|暂无/.test(document.querySelector('.wave__read')?.textContent ?? ''), {
    timeout: 20000,
  });
  await page.waitForTimeout(900); // let the draw-on animation finish

  // ── 1. The chart is actually drawn ────────────────────────
  const chart = await page.evaluate(() => {
    const line = document.querySelector('.wave__line');
    const svg = document.querySelector('.wave__svg');
    const cs = line ? getComputedStyle(line) : null;
    return {
      hasSvg: !!svg,
      svgNs: svg ? svg.namespaceURI : null,
      d: line ? line.getAttribute('d') ?? '' : '',
      stroke: cs?.stroke ?? '',
      width: cs?.strokeWidth ?? '',
      boxW: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
      boxH: svg ? Math.round(svg.getBoundingClientRect().height) : 0,
      read: document.querySelector('.wave__read')?.textContent ?? '',
      readLines: (() => {
        const r = document.querySelector('.wave__read');
        const lh = r ? parseFloat(getComputedStyle(r).lineHeight) : 0;
        return r && lh ? Math.round(r.getBoundingClientRect().height / lh) : 0;
      })(),
      readW: (() => {
        const r = document.querySelector('.wave__read');
        return r ? Math.round(r.getBoundingClientRect().width) : 0;
      })(),
      title: document.querySelector('.wave__title')?.textContent ?? '',
    };
  });
  check('svg element exists', chart.hasSvg, chart.svgNs ?? '');
  check('svg in SVG namespace', chart.svgNs === 'http://www.w3.org/2000/svg', chart.svgNs ?? '');
  check('path has geometry', chart.d.startsWith('M ') && chart.d.length > 60, `${chart.d.length} chars`);
  check('stroke is not none', chart.stroke !== 'none' && chart.stroke !== '', chart.stroke);
  check('chart has real size', chart.boxW > 80 && chart.boxH > 40, `${chart.boxW}×${chart.boxH}`);
  check('title names the year', /观影量/.test(chart.title), chart.title);
  check('readout reports the year', /全年|暂无/.test(chart.read), chart.read);
  // ⚠️ A readout that wraps is the visible half of the panel being too tight —
  // measured on a 390px screen it broke its caveat onto a second line, which
  // reads as a layout that gave up.
  check(
    'readout stays on one line',
    chart.readLines === 1,
    `${chart.readLines} line(s) in ${chart.readW}px: "${chart.read}"`,
  );

  // ── 2. Numbers and chart share a row ──────────────────────
  const layout = await page.evaluate(() => {
    const s = document.querySelector('.section__split');
    const stats = s?.querySelector('.stats');
    const wave = s?.querySelector('.wave');
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const body = document.querySelector('.section__body');
    const cue = document.querySelector('.section__cue');
    const sv = stats?.querySelector('.stats__value');
    return {
      hasSplit: !!s,
      stats: r(stats),
      wave: r(wave),
      valueSize: sv ? parseFloat(getComputedStyle(sv).fontSize) : 0,
      overflow: body ? body.scrollHeight - body.clientHeight : 0,
      cueTop: r(cue)?.top ?? null,
      lastBottom: (() => {
        const kids = [...(body?.children ?? [])];
        const last = kids[kids.length - 1];
        return last ? r(last).bottom : null;
      })(),
    };
  });
  check('stats and chart are wrapped together', layout.hasSplit);
  // ⚠️ Either arrangement is correct, but only one per width: side by side from
  // 600px up, stacked below it. Measured on 390px, a row left the chart 156px
  // for twelve months. Asserting "side by side" everywhere would have passed
  // while the phone was unreadable.
  const sideBySide = layout.stats && layout.wave && layout.wave.left >= layout.stats.right - 1;
  const stacked = layout.stats && layout.wave && layout.wave.top >= layout.stats.bottom - 1;
  check(
    `numbers and chart are laid out for ${viewport.width}px`,
    viewport.width >= 600 ? sideBySide : stacked,
    layout.stats && layout.wave
      ? `stats ${Math.round(layout.stats.left)},${Math.round(layout.stats.top)}–${Math.round(layout.stats.right)},${Math.round(layout.stats.bottom)} · wave ${Math.round(layout.wave.left)},${Math.round(layout.wave.top)}–${Math.round(layout.wave.right)},${Math.round(layout.wave.bottom)}`
      : 'missing box',
  );

  // ── The month scale lines up with the curve ───────────────
  const ticks = await page.evaluate(() => {
    const plot = document.querySelector('.wave__plot');
    const pb = plot.getBoundingClientRect();
    const line = document.querySelector('.wave__line');
    const d = line.getAttribute('d') ?? '';
    // The 12 point x-positions, read back out of the path itself rather than
    // recomputed — this checks the labels against what was actually DRAWN.
    //
    // ⚠️ Every coordinate in order, then every THIRD PAIR. The path is
    // `M p0 C c1 c2 p1 C c1 c2 p2 …`, so a naive "first number of each command"
    // sweep collects the first CONTROL points — which sit near their own
    // endpoints and look almost right, making this test pass on a chart whose
    // labels are visibly offset. It was written that way first and reported a
    // 704px error, which is exactly the plot width: the number that says "the
    // assertion, not the chart, is broken".
    const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
    const pairs = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pairs.push(nums[i]);
    const pts = pairs.filter((_, i) => i % 3 === 0);
    return {
      labels: [...document.querySelectorAll('.wave__tick')].map((t) => {
        const r = t.getBoundingClientRect();
        return { text: t.textContent, cx: r.left + r.width / 2 - pb.left, left: r.left - pb.left, right: r.right - pb.left };
      }),
      plotW: pb.width,
      drawn: pts,
    };
  });
  const worst = ticks.labels.reduce((w, l, i) => {
    const want = (ticks.drawn[i] ?? 0) / 320 * ticks.plotW;
    return Math.max(w, Math.abs(l.cx - want));
  }, 0);
  check(
    'month labels sit under their points',
    ticks.labels.length === 12 && worst < 3,
    `${ticks.labels.length} labels, worst offset ${worst.toFixed(1)}px`,
  );
  check(
    'first and last labels stay in frame',
    ticks.labels.length === 12 &&
      ticks.labels[0].left > -14 &&
      ticks.labels[11].right < ticks.plotW + 14,
    ticks.labels.length === 12
      ? `left edge ${ticks.labels[0].left.toFixed(0)}px, right edge ${(ticks.labels[11].right - ticks.plotW).toFixed(0)}px past the end`
      : '',
  );
  check('COOF numbers are small', layout.valueSize > 0 && layout.valueSize <= 44, `${layout.valueSize}px`);
  check(
    'panel content fits the viewport',
    layout.overflow <= 2 && (layout.cueTop === null || layout.lastBottom === null || layout.lastBottom < layout.cueTop),
    `overflow ${layout.overflow}px, content bottom ${layout.lastBottom && Math.round(layout.lastBottom)} vs cue ${layout.cueTop && Math.round(layout.cueTop)}`,
  );

  await page.screenshot({ path: `${OUT}/${tag}-overview.png` });

  // ── 3. Hover reports a month ──────────────────────────────
  const box = await page.locator('.wave__hit').boundingBox();
  if (box) {
    const before = await page.textContent('.wave__read');
    const seen = new Set();
    for (const f of [0.05, 0.28, 0.5, 0.95]) {
      await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
      await page.waitForTimeout(120);
      seen.add(await page.textContent('.wave__read'));
    }
    check('hover follows the pointer', seen.size >= 3, `${seen.size} distinct readouts, first "${before}"`);
    check('hover names a month', [...seen].every((s) => /月/.test(s)), [...seen].join(' | ').slice(0, 120));
    check('guide + dot appear on hover', await page.locator('.wave__dot').count() === 1);
    await page.screenshot({ path: `${OUT}/${tag}-wave-hover.png` });
    await page.mouse.move(box.x - 60, box.y - 60);
    await page.waitForTimeout(200);
    check('readout resets on leave', /全年|暂无/.test(await page.textContent('.wave__read')));
  } else {
    check('wave hit area measurable', false);
  }

  // ── 4. Touch drag (phone only) ────────────────────────────
  if (mobile && box) {
    const end = await touchDrag(page, { x: box.x + 20, y: box.y + box.height / 2 }, { x: box.x + box.width - 20, y: box.y + box.height / 2 });
    const live = await page.evaluate(() => ({
      live: document.querySelector('.wave__hit')?.className ?? '',
      read: document.querySelector('.wave__read')?.textContent ?? '',
      toast: document.body.innerText.includes('拖动'),
    }));
    check('chart enlarges while dragging', /wave__hit--live/.test(live.live), live.live);
    check('drag reports a month', /月/.test(live.read), live.read);
    check('drag is announced to the user', live.toast, live.toast ? 'toast seen' : 'no toast text in DOM');
    await page.screenshot({ path: `${OUT}/${tag}-wave-drag.png` });
    await end();
    await page.waitForTimeout(300);
    check('chart settles after drag', !/wave__hit--live/.test(await page.getAttribute('.wave__hit', 'class')));
  }

  // ── 5. Chip opens the breakdown sheet ─────────────────────
  await page.locator('.chip').first().click();
  await page.waitForSelector('.ysheet', { timeout: 8000 });
  await page.waitForTimeout(600);

  const sheet = await page.evaluate(() => {
    const rings = [...document.querySelectorAll('.dnb__ring')];
    const panel = document.querySelector('.ysheet__panel');
    const bg = panel ? getComputedStyle(panel).backgroundColor : '';
    const alpha = /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(bg);
    const blocks = [...document.querySelectorAll('.dnb')];
    const rects = blocks.map((d) => d.getBoundingClientRect());
    const leg = document.querySelector('.dnb__legend');
    return {
      bgAlpha: alpha ? parseFloat(alpha[1]) : 1,
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      legendW: leg ? Math.round(leg.getBoundingClientRect().width) : 0,
      sideBySide: rects.length === 2 && rects[1].left >= rects[0].right - 1,
      blocks: document.querySelectorAll('.dnb').length,
      rings: rings.length,
      bg: rings.map((r) => (getComputedStyle(r).backgroundImage || '').slice(0, 40)),
      legend: [...document.querySelectorAll('.dnb__legend')].map((l) => l.children.length),
      go: document.querySelector('.ysheet__go-t')?.textContent ?? '',
      center: [...document.querySelectorAll('.dnb__count')].map((c) => c.textContent),
    };
  });
  check('sheet opens with two rings', sheet.blocks === 2 && sheet.rings === 2, `${sheet.blocks} blocks, ${sheet.rings} rings`);
  // ⚠️ A RANGE, and it was inverted deliberately.
  //
  // This asserted `alpha >= 0.94` — "the sheet hides the page behind it". That
  // is how the sheet became an opaque slab, and the user's next report was
  // exactly that: black, not glass. Glass needs blur AND some transparency;
  // a test that demands opacity will keep re-creating the thing being
  // complained about.
  check(
    'sheet is glass, not an opaque slab',
    sheet.bgAlpha >= 0.2 && sheet.bgAlpha <= 0.8,
    `background alpha ${sheet.bgAlpha}（需 0.2–0.8）`,
  );
  check('sheet is not a full-width stripe', sheet.panelW <= 1040, `panel ${sheet.panelW}px of ${viewport.width}px`);
  // ⚠️ Only on a window wide enough to hold two lists. Asserting it everywhere
  // would fail the phone, which is correct as one column.
  if (viewport.width >= 900) {
    check('wide window splits the two rings into columns', sheet.sideBySide, `legend ${sheet.legendW}px each`);
  } else {
    check('narrow window stacks the two rings', !sheet.sideBySide, `legend ${sheet.legendW}px`);
  }
  check('rings are conic gradients', sheet.bg.every((b) => b.includes('conic-gradient')), sheet.bg.join(' / ').slice(0, 90));
  check('legends are populated', sheet.legend.every((n) => n >= 3), sheet.legend.join(', '));
  check('jump button names the year', /查看 COOF/.test(sheet.go), sheet.go);
  await page.screenshot({ path: `${OUT}/${tag}-donut.png` });

  // ── 6. Tapping the ring steps the selection ───────────────
  const before = (await page.textContent('.dnb__count')) ?? '';
  await page.locator('.dnb__tap').first().click();
  await page.waitForTimeout(500);
  const after = (await page.textContent('.dnb__count')) ?? '';
  check('tapping the ring advances the slice', before !== after, `${before} → ${after}`);
  const rotated = await page.evaluate(() => getComputedStyle(document.querySelector('.dnb__hl')).transform);
  check('highlight wedge is transformed', rotated !== 'none', rotated);
  await page.screenshot({ path: `${OUT}/${tag}-donut-stepped.png` });

  // ── 7. Jump lands on the poster list, at that year ────────
  const yearWanted = (await page.textContent('.ysheet__title')) ?? '';
  await page.locator('.ysheet__go').click();
  await page.waitForTimeout(1400); // smooth scroll
  const jumped = await page.evaluate(() => {
    const stack = document.querySelector('.stack');
    return {
      sheetGone: !document.querySelector('.ysheet'),
      top: stack?.scrollTop ?? -1,
      height: stack?.clientHeight ?? 0,
      subtitle: document.querySelector('.section__subtitle')?.textContent ?? '',
      firstTile: document.querySelector('.tile__title')?.textContent ?? '',
    };
  });
  check('sheet closes on jump', jumped.sheetGone);
  check(
    'stack scrolled to the poster panel',
    jumped.height > 0 && jumped.top >= jumped.height * 0.9,
    `scrollTop ${Math.round(jumped.top)} of panel height ${jumped.height}`,
  );
  check('poster panel shows the chosen year', yearWanted.replace(/^COOF/, '').includes(jumped.subtitle), `want ${yearWanted}, subtitle ${jumped.subtitle}`);
  await page.screenshot({ path: `${OUT}/${tag}-jumped.png` });

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' || '));

  await ctx.close();
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

await run(browser, { scheme: 'dark', viewport: { width: 1440, height: 900 }, mobile: false }, 'desktop-dark');
await run(browser, { scheme: 'light', viewport: { width: 1440, height: 900 }, mobile: false }, 'desktop-light');
await run(browser, { scheme: 'dark', viewport: { width: 390, height: 844 }, mobile: true }, 'phone-dark');

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n══ ${results.length - failed.length}/${results.length} passed ══`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  process.exit(1);
}
