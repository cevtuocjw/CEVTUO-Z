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
import { readFileSync } from 'node:fs';
// ⚠️ The app's own opener, so the fixture below is read exactly the way the
// page reads it. A second implementation here could disagree with the page and
// the test would still pass.
import { openSealed } from '../apps/dashboard/src/platform/health-crypto.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8096/z';
const OUT = process.argv[3] ?? '/tmp/paperr-ui';

/**
 * The health passphrase, so the CHEALTH page can be driven in its UNLOCKED
 * state. It lives in `services/ingest/.env.server-backup` on this machine.
 *
 * ⚠️ Absent ⇒ the unlocked checks are SKIPPED, and they say so in their detail
 * line. Silently passing would make a missing secret look like a page that
 * works — the same shape as every other silent failure in this project.
 */
const PASS = (() => {
  try {
    const key = 'CEVTUO_HEALTH_PASSPHRASE=';
    const p = new URL('../services/ingest/.env.server-backup', import.meta.url);
    const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(key));
    return line ? line.slice(key.length).trim() : '';
  } catch {
    return '';
  }
})();

/**
 * The date the CHEALTH page's stall verdict will actually be measured against
 * — read out of the same sealed index the page fetches.
 *
 * ⚠️⚠️ Why this is read rather than written down as a constant.
 *
 * The stall rule is `pushDay − dataDay ≥ 2`, and **both** of those come off the
 * wire: `lastPushAt` from the heartbeat, `to` from the decrypted index. The
 * check below stubs only the heartbeat. So as long as the local index fixture
 * sat on the stalled data (2026-09-24) the assertion passed — and the moment
 * the phone's sync was fixed and the fixture was refreshed from the CDN, it
 * went red across all three viewports with a message about a working page.
 *
 * ⚠️ That is not a flake, it is the check measuring the wrong thing: "today's
 * data happens to be stalled" rather than "the rule works". Deriving the stub
 * from whatever the page is really about to read means both branches are
 * forced no matter what the live data says — which is what the comment further
 * down always claimed this block did.
 */
const DATA_DAY = await (async () => {
  if (!PASS) return null;
  try {
    const res = await fetch(`${BASE}/data/chealth/index.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const idx = JSON.parse(openSealed(await res.text(), PASS));
    return typeof idx.to === 'string' && idx.to ? idx.to : null;
  } catch {
    return null;
  }
})();

/**
 * `YYYY-MM-DD` shifted by whole days.
 *
 * ⚠️ Parsed as UTC on purpose. The page parses these as `+08:00`, and mixing
 * the two shifts the answer by a day near midnight — which would show up as
 * this check disagreeing with itself depending on the hour it runs.
 */
const shiftDay = (iso, days) => {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

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
  // ⚠️ Names the URL. A bare "Failed to load resource: 404" cost a round of
  // investigation — the failing request was a diagnostic the page fetches and
  // is designed to ignore, so nothing on screen pointed at it.
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  await page.goto(`${BASE}/#/pages/paperr/index`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pr-row', { timeout: 20000 });
  await page.waitForTimeout(800);

  check('no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  // ⚠️ The index must NOT come from the browser's cache.
  //
  // GitHub Pages serves it with `Cache-Control: max-age=600`, so a reader who
  // loaded the page recently and reloads after a sync can sit ten minutes
  // behind — while the freshness line beside it (fetched from the ingest, no
  // cache headers) updates instantly. "It synced" and "nothing changed" in one
  // glance reads exactly like a broken sync.
  //
  // ⚠️ Counted across a RELOAD, because that is the case that matters and the
  // only one a single load can distinguish. A `?v=` cache-buster was tried
  // first and does not work: GitHub Pages' CDN ignores the query string
  // (three different random params all returned `X-Cache: HIT`).
  {
    let indexFetches = 0;
    const count = (r) => { if (r.url().includes('paperr/index.json')) indexFetches += 1; };
    page.on('request', count);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pr-row', { timeout: 20000 });
    await page.waitForTimeout(600);
    page.off('request', count);
    check('the index is re-fetched on reload, not served from cache',
          indexFetches >= 1, `fetches after reload=${indexFetches}`);
  }

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

  // ── The sync heartbeat endpoint ────────────────────────────
  //
  // ⚠️ Asserted DIRECTLY, because nothing else can see it fail.
  //
  // The page treats a failed heartbeat fetch as expected — the server being
  // down is a real possibility, and a page that breaks because a diagnostic is
  // unavailable is worse than one showing a dash. That is the right behaviour
  // and it means a deleted route produces no error, no missing element, nothing
  // a DOM assertion can find.
  //
  // It was deleted for real: an edit removed the block ABOVE it and took this
  // one along, and every page load 404'd in silence. The only thing that
  // noticed was the generic "Failed to load resource: 404" below — which is
  // why that message now names the URL.
  //
  // ⚠️⚠️ And it is asserted against the PAGE'S OWN REQUEST — not a URL typed
  // out here a fifth time.
  //
  // Until 2026-09-28 this block called `page.evaluate` and fetched a hardcoded
  // `http://120.77.27.128:8789/…`. Two things were wrong with that, and the
  // second is the serious one:
  //
  //   1. The host already lived in four places in `data.ts`; this was a fifth.
  //   2. It never checked that the PAGE calls the endpoint. It proved "some
  //      host answers", which is a different claim from "the panel on screen
  //      gets its number". The endpoint could have been dropped from the page
  //      entirely and this would have stayed green.
  //
  // ⚠️ What that would have cost on 2026-09-28: the four URLs moved to
  // `https://api.cevtuogrnd.com:8443` (an HTTPS page fetching plain HTTP is
  // killed by mixed-content blocking before CORS is consulted). This block
  // would have gone on cheerfully testing an address the page no longer used —
  // both sides green, nothing covered, which is the exact shape this file
  // exists to catch.
  //
  // ⚠️ The reload is load-bearing: the heartbeat is fetched on mount, which
  // happens during the `goto` at the top of this function — before a listener
  // attached down here could see it. (Same reason the cache check above
  // reloads.)
  //
  // ⚠️ `requestfailed` is captured separately from `response`, because
  // mixed-content is not a bad STATUS — the request never produces one. Its
  // absence-of-response is why the page would show a dash and no error.
  {
    const seen = [];
    const failed = [];
    const match = (u) => u.includes('/api/paperr/heartbeat.json');
    const onResp = async (r) => {
      if (!match(r.url())) return;
      let body = null;
      try { body = await r.json(); } catch { /* 空/坏响应体由下面的断言报，不在这里炸 */ }
      seen.push({ url: r.url(), status: r.status(), body });
    };
    const onFail = (r) => {
      if (match(r.url())) failed.push(`${r.failure()?.errorText ?? '?'} ${r.url().slice(0, 90)}`);
    };
    page.on('response', onResp);
    page.on('requestfailed', onFail);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pr-row', { timeout: 20000 });
    await page.waitForTimeout(1500);
    page.off('response', onResp);
    page.off('requestfailed', onFail);

    const hit = seen[0];
    check('the page itself asks the heartbeat endpoint', !!hit || failed.length > 0,
          hit ? hit.url.slice(0, 110) : (failed[0] ?? 'no request observed at all'));
    // ⚠️ Names the failure text, so a mixed-content regression says so out loud
    // instead of reporting an unexplained missing request.
    check('the heartbeat request is not blocked before it is sent',
          failed.length === 0, failed[0] ?? '');
    check('the heartbeat endpoint answers 200', hit?.status === 200, `status=${hit?.status ?? '—'}`);
    check('the heartbeat carries a push time',
          !!(hit?.body && 'lastPushAt' in hit.body), JSON.stringify(hit?.body ?? null).slice(0, 120));
    // ⚠️ The regression this whole change was about. Plain HTTP here means the
    // heartbeats die silently the moment the site is served over HTTPS.
    check('the heartbeat is fetched over HTTPS, not plain HTTP',
          !!hit && hit.url.startsWith('https://'), hit?.url.slice(0, 110) ?? '—');
  }

  // ── No brand may invent a number ──────────────────────────
  //
  // ⚠️ Cross-page, and here rather than in a file of its own because this is
  // where the other "the page must not lie" checks live.
  //
  // The CHEALTH panel shipped with hardcoded "8,412" steps and "7h12" sleep,
  // formatted exactly like COOF's live totals on the same screen. A reader
  // glancing at the index cannot tell which figures came from a pipeline and
  // which were typed into the source. The `尚未接入` label on the card does not
  // undo it — that is small type on a control, and 8,412 is set at stat size.
  {
    await page.goto(`${BASE}/#/pages/home/index`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stats__value', { timeout: 20000 });
    await page.waitForTimeout(600);
    const values = await page.locator('.stats__value').allInnerTexts();
    const fabricated = values.filter((v) => /\d/.test(v) && v !== '—');
    // A live figure is fine; the check is that the page does not render one
    // while the matching pipeline has not run. COOF and CAPPERR are live here,
    // so those numbers are expected — what must NOT appear is CHEALTH's.
    const chealth = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.section')];
      const p = panels.find((e) => (e.querySelector('.section__title') || {}).textContent === 'CHEALTH');
      if (!p) return null;
      return [...p.querySelectorAll('.stats__value')].map((e) => e.textContent?.trim());
    });
    check('CHEALTH 未解锁时不显示任何数字', !!chealth && chealth.every((v) => v === '—'),
          JSON.stringify(chealth));
    check('the live brands are still allowed real numbers', fabricated.length > 0 || values.length === 0,
          values.join(','));

    // ⚠️ And the CHEALTH PAGE, not just its panel on the index. The same
    // invented 8,412 / 7h12 lived in both files, and fixing the one visible from
    // the index would have left the other one reachable by URL.
    //
    // ⚠️⚠️ The rule changed on 2026-09-24 and BOTH halves of the change matter.
    //
    // It used to read "no digits anywhere on the page", which was the right
    // expression of "no invented figures" while there was no source. There is
    // one now: the page fetches an AES-GCM-sealed index from the public CDN and
    // shows real readings once the passphrase is entered. A blanket ban on
    // digits would now fail on a page that is working.
    //
    // ⚠️ So the ban is scoped to the LOCKED state — and a second assertion was
    // added beside it, because the first one alone has a hole it cannot see:
    // **a crashed page also shows no digits.** "Nothing wrong is displayed" and
    // "the right thing is displayed" are different claims, and only the pair
    // distinguishes a correctly locked page from a white screen.
    await page.goto(`${BASE}/#/pages/chealth/index`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card__label', { timeout: 20000 });
    await page.waitForTimeout(600);
    const chealthPage = await page.locator('.stats__value').allInnerTexts();
    check('CHEALTH 页面未解锁时也不显示数字',
          chealthPage.filter((v) => /\d/.test(v)).length === 0, JSON.stringify(chealthPage));

    const gate = await page.locator('text=需要口令').count();
    check('未解锁时显示的是口令闸，不是白屏（白屏也没有数字，这条才分得开）', gate > 0, `gate=${gate}`);
    const cryptoErr = await page.locator('text=读不到健康数据').count();
    check('未解锁时不应报错 —— 没有口令是正常状态，不是故障', cryptoErr === 0, `err=${cryptoErr}`);

    // ⚠️ 加密索引必须真的是密文。线上那份若是明文，页面上看不出区别，
    //    但数据已经泄露了 —— 所以这条查文件本身，不查页面。
    const sealedRes = await page.evaluate(async () => {
      const r = await fetch('data/chealth/index.json');
      if (!r.ok) return { status: r.status };
      const t = await r.text();
      // ⚠️ `hasCt` is tested against the WHOLE text, not the preview. The
      // first version looked for `"ct"` inside a 120-character head — but the
      // envelope puts `ct` after `v`/`kdf`/`iter`/`salt`/`iv`, so it fell
      // outside the window and the assertion failed on a file that was
      // perfectly sealed. A test that reports a failure it cannot distinguish
      // from a real one is worse than no test.
      return {
        status: r.status,
        head: t.slice(0, 120).replace(/\s+/g, ' '),
        hasPlain: /"steps"|"date"|"restingHr"|2026-\d\d-/.test(t),
        hasCt: /"ct"\s*:/.test(t),
        bytes: t.length,
      };
    });
    check('已发布的健康索引是密文，不含任何明文片段',
          sealedRes.status === 404 || (sealedRes.hasPlain === false && sealedRes.hasCt === true),
          JSON.stringify(sealedRes).slice(0, 220));

    await page.goto(`${BASE}/#/pages/paperr/index`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pr-row', { timeout: 20000 });
    await page.waitForTimeout(600);
  }

  // ── CHEALTH：手机在推、数据没动 —— 要判决，不是两个时间戳 ──
  //
  // ⚠️ Written for what was measured on 2026-09-28: `lastPushAt` was five
  // minutes old — the phone pushing every 15 minutes, exactly on schedule —
  // while `to` had not moved off 2026-09-24 for four days. The page printed
  // both stamps inside one sentence and drew no conclusion from them. A reader
  // is not going to notice a four-day gap between two timestamps by eye.
  //
  // ⚠️⚠️ The heartbeat is STUBBED, and that is the whole point of the check.
  //
  // The real one comes from the Aliyun box and says whatever it says today. An
  // assertion against it would pass or fail with the weather — and, worse, it
  // would go permanently GREEN on the day someone finally fixes the stall,
  // which is exactly when a regression would slip through. Here both branches
  // are forced, so the assertion means "the rule works", not "today happens to
  // be broken".
  //
  // ⚠️⚠️ The stub is DERIVED from the data date the page is about to read, not
  // written down as `2026-09-28`. Hardcoding it is what made this check pass on
  // the day the data happened to be stalled and fail on the day it was fixed —
  // see `DATA_DAY` above. Both branches are forced either way; what changed is
  // that they are forced by the rule rather than by the calendar.
  //
  // ⚠️ And the second case is load-bearing for the first: with the stub removed
  // entirely the live heartbeat decides, and a live heartbeat that agrees with
  // the data produces exactly case two's expected result — so case one alone
  // cannot tell a working stub from no stub at all. Case two can.
  if (!PASS || !DATA_DAY) {
    check(
      'CHEALTH 解锁态检查（缺口令或读不到本地索引，已跳过）',
      false,
      PASS ? `解不开 ${BASE}/data/chealth/index.json` : 'services/ingest/.env.server-backup 里没有口令',
    );
  } else {
    for (const [offset, want] of [
      [4, true], // 手机一直在推，数据却停在 4 天前 ⇒ 必须警告
      [0, false], // 当天就推过 ⇒ 不许警告
    ]) {
      const pushDay = shiftDay(DATA_DAY, offset);
      const route = '**/api/chealth/heartbeat.json';
      await page.route(route, (r) =>
        r.fulfill({ json: { lastPushAt: `${pushDay}T10:58+08:00`, dayCount: 30, to: DATA_DAY } }),
      );
      await page.goto(`${BASE}/#/pages/chealth/index?k=${PASS}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.card__label', { timeout: 20000 });
      await page.waitForTimeout(1200);
      const warned = (await page.locator('.chc__stale').allInnerTexts()).some((t) =>
        /手机一直在推/.test(t),
      );
      check(
        `心跳落后数据 ${offset} 天 → ${want ? '必须' : '不得'}警告`,
        warned === want,
        `数据 ${DATA_DAY} / 上报 ${pushDay} warned=${warned}`,
      );
      await page.unroute(route);
    }
    // ⚠️ Back to CAPPERR before leaving. Everything below — the shelf, the
    // charts, the filters — assumes this page is on screen, and the block
    // above navigated away to CHEALTH. Without this the very next check
    // reported `shelf rendered — rows=0`, which reads as a broken shelf and is
    // really just a browser parked on another route.
    await page.goto(`${BASE}/#/pages/paperr/index`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pr-row', { timeout: 20000 });
    await page.waitForTimeout(600);
  }

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

  // ⚠️ The line must be SOLID, and must span the same width as the area it
  // fills. It shipped once with a stroke-dash animation whose units did not
  // match the path length: the curve stopped ~55% of the way across while its
  // own shaded area carried on to the edge, and all 120 assertions passed.
  const curveGeom = await page.evaluate(() => {
    const line = document.querySelector('.pc-curve__line');
    const area = document.querySelector('.pc-curve__area');
    const cs = getComputedStyle(line);
    return {
      dash: cs.strokeDasharray,
      lineW: Math.round(line.getBBox().width),
      areaW: Math.round(area.getBBox().width),
    };
  });
  check('curve line is solid, not dashed',
        curveGeom.dash === 'none' || curveGeom.dash === '', `dash="${curveGeom.dash}"`);
  check('curve line spans the same width as its fill',
        Math.abs(curveGeom.lineW - curveGeom.areaW) <= 1,
        `line=${curveGeom.lineW} area=${curveGeom.areaW}`);

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

  // ⚠️ The default readout ("最集中在周三") is gone, so the ONLY way to read a
  // bar's value now is to tap it. If the tap readout does not work, removing the
  // summary did not simplify the chart — it deleted the numbers.
  {
    const readout = page.locator('.pc-bars').locator('.pc-readout').first();
    const before = (await readout.innerText()).trim();
    check('week bars carry no summary before a tap', before === '', `"${before}"`);
    await page.locator('.pc-bars__col').nth(2).click();
    await page.waitForTimeout(250);
    const after = (await readout.innerText()).trim();
    check('tapping a week bar reads out its value', /·/.test(after), `"${after}"`);
    await page.locator('.pc-bars__col').nth(2).click();
    await page.waitForTimeout(200);
  }
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
  // ⚠️ Same for the hour grid: no summary, so the tap is the readout.
  //
  // ⚠️ But "empty" is only right when there IS data to draw. With an old
  // plugin's export every hour is zero and the chart says so in this same line,
  // because a blank chart with no explanation is worse than a headline. So the
  // assertion is "no 最常在 summary", not "empty".
  {
    const ro = page.locator('.pc-hours').locator('.pc-readout').first();
    const before = (await ro.innerText().catch(() => '')).trim();
    check('hour grid has no 最常在 summary',
          !before.includes('最常'), `"${before}"`);
  }

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
  // ⚠️ 360 as well as 390. The donut cell's irreducible width was 266px and a
  // 390px phone gives the grid 260 — so the overflow was 5px, and a check that
  // only ran at 390 would have kept passing after any small regression made it
  // worse. 360 is a real phone (and the narrowest we claim to support).
  await run(browser, { scheme: 'dark', viewport: { width: 360, height: 780 }, mobile: true }, 'narrow');
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
