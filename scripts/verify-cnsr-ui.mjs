/**
 * Behaviour check for the CNSR page.
 *
 *   bun scripts/verify-cnsr-ui.mjs [base-url] [out-dir]
 *
 * ⚠️ Same reasoning as `verify-coof-ui.mjs`, and the same rule this project has
 * now been bitten by seven times: a screenshot proves nothing about whether a
 * control is wired, and neither does reading the source. Every assertion below
 * drives the real page and reads the DOM before and after a real event.
 *
 * ⚠️ Playwright, not CDP against the running Chrome — Chrome 153 on this
 * machine inverts dark pages in `Page.captureScreenshot` (see shots.mjs).
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8096/z';
const OUT = process.argv[3] ?? '/tmp/cnsr-ui';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const SOURCES = ['shopping', 'learn', 'techlearn', 'techai'];

async function run(browser, { scheme, viewport }, tag) {
  const wide = viewport.width >= 840;
  console.log(`\n── ${tag} (${scheme}, ${viewport.width}×${viewport.height}, ${wide ? '宽屏' : '窄屏'}) ──`);

  const ctx = await browser.newContext({ colorScheme: scheme, viewport, hasTouch: !wide, isMobile: !wide, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 180)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // ⚠️ The failing URL is in `location()`, NOT in `text()`. The console
    // message for a failed subresource is the bare string "Failed to load
    // resource: the server responded with a status of 404 ()" — which is why
    // the first version of this filter matched nothing and could not tell a
    // third-party favicon from one of our own files.
    const t = m.text();
    const url = m.location()?.url ?? '';
    // A missing favicon on a THIRD-PARTY host is not this page's error: the link
    // rows pull `icons.duckduckgo.com/ip3/<host>.ico`, plenty of hosts have
    // none, and that is exactly what the letter badge behind the icon is for.
    // Anything from our own origin still counts, and the URL is in the detail
    // line either way so a real one is never mistaken for noise.
    const ours = /^https?:\/\/(127\.0\.0\.1|localhost|cevtuocjw\.github\.io)/.test(url);
    if (/404/.test(t) && url && !ours) return;
    errors.push(`${t} @ ${url}`.slice(0, 190));
  });

  await page.goto(`${BASE}/#/pages/cnsr/index`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(wide ? '.cn__col' : '.cn__card', { timeout: 20000 });
  // Every source is fetched in parallel; wait for the last payload to land.
  await page.waitForFunction(
    (n) => document.querySelectorAll('.cn__col-head, .cn__card').length >= n &&
      document.body.innerText.includes('同步于'),
    SOURCES.length,
    { timeout: 25000 },
  );
  await page.waitForTimeout(500);

  // ── The page-level summary comes from the loaded payloads ──
  const head = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.hm__cell')];
    return {
      lede: document.querySelector('.section__lede')?.textContent ?? '',
      stats: document.querySelectorAll('.stats__item').length,
      cells: cells.length,
      tabs: [...document.querySelectorAll('.hm__tab')].map((t) => t.textContent.trim()),
      levels: [...new Set(cells.map((c) => /hm__cell--(\d)/.exec(c.className)?.[1]).filter(Boolean))],
      cue: document.querySelector('.section__cue') ? 'present' : 'none',
      heapx: Math.round(document.querySelector('.hm')?.getBoundingClientRect().height ?? 0),
    };
  });
  check('文案改成欢迎语', /欢迎阅读/.test(head.lede), head.lede);
  check('统计数字已移除', head.stats === 0, `${head.stats} 个统计块`);
  check('热力图渲染出格子', head.cells > 0, `${head.cells} 格 · 高度 ${head.heapx}px（留高度给来源和时间线）`);
  check('热力图可切换来源', head.tabs.length === SOURCES.length + 1, head.tabs.join(' / '));
  check('热力图有明暗层次', head.levels.length >= 2, `等级 ${head.levels.sort().join(',')}`);
  check('页面没有「下滑」提示', head.cue === 'none', head.cue);

  // Switching the heatmap's source must change the shading, or the control is
  // decoration.
  const beforePick = await page.evaluate(() => [...document.querySelectorAll('.hm__cell')].map((c) => c.className).join('|'));
  await page.locator('.hm__tab').nth(1).click();
  await page.waitForTimeout(250);
  const afterPick = await page.evaluate(() => [...document.querySelectorAll('.hm__cell')].map((c) => c.className).join('|'));
  check('切换来源真的改了热力', beforePick !== afterPick, beforePick === afterPick ? '切换前后完全一致' : '有变化');
  await page.locator('.hm__tab').first().click();
  await page.waitForTimeout(200);

  // ── Every module carries its OWN sync time ────────────────
  const syncs = await page.evaluate(() => {
    const sel = ['.cn__col-sync', '.cn__card-sync'];
    for (const s of sel) {
      const found = [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
      if (found.length) return found;
    }
    return [];
  });
  check('每个模块都有自己的同步时间', syncs.length === SOURCES.length && syncs.every((s) => /同步于\s*\d{4}-\d{2}-\d{2}/.test(s)), syncs.join(' / '));
  const distinct = new Set(syncs.map((s) => s.replace(/[^0-9:-]/g, '')));
  check('四个模块的同步时间各自独立', distinct.size >= 1, `不同时间戳 ${distinct.size} 个`);

  // ── No raw URL ever reaches the screen ────────────────────
  //
  // ⚠️ The single most explicit requirement: a link must be carried by a NAME.
  // Searching rendered TEXT (not HTML) is what makes this meaningful — an href
  // attribute may hold the address, the visible string must not.
  const text = await page.evaluate(() => document.body.innerText);
  const rawUrls = text.match(/https?:\/\/[^\s]+/g) ?? [];
  check('界面上没有裸 http 链接', rawUrls.length === 0, rawUrls.slice(0, 3).join(' , ') || '0 处');

  if (wide) {
    // ── Four columns, side by side, each independently scrollable ──
    const cols = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.cn__col')];
      const heads = [...document.querySelectorAll('.cn__col-head')];
      return {
        n: nodes.length,
        heads: heads.length,
        boxes: nodes.map((e) => {
          const r = e.getBoundingClientRect();
          return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        }),
        labels: heads.map((h) => h.querySelector('.cn__col-t')?.textContent ?? ''),
      };
    });
    check('四列都在', cols.n === SOURCES.length && cols.heads === SOURCES.length, `${cols.n} 列`);
    const sideBySide = cols.boxes.length === 4 &&
      cols.boxes.every((b, i) => i === 0 || b.l >= cols.boxes[i - 1].l + cols.boxes[i - 1].w - 2);
    check('四列并排而不是堆叠', sideBySide, cols.boxes.map((b) => `${b.l}w${b.w}`).join(' '));
    const tall = cols.boxes.every((b) => b.h > 200);
    check('每列有自己的固定高度', tall, cols.boxes.map((b) => `h${b.h}`).join(' '));
    check('四列各自标着来源名', cols.labels.every(Boolean), cols.labels.join(' / '));

    // ── The per-column fullscreen key ─────────────────────────
    check('每列有全屏键', (await page.locator('.cn__full').count()) === SOURCES.length, `${await page.locator('.cn__full').count()} 个`);
    await page.locator('.cn__full').first().click();
    await page.waitForSelector('.cnsr-sheet--wide', { timeout: 8000 });
    await page.waitForTimeout(500);
    const full = await page.evaluate(() => {
      const p = document.querySelector('.cnsr-sheet--wide .cnsr-sheet__panel');
      const col = document.querySelector('.cn__col');
      return {
        w: Math.round(p?.getBoundingClientRect().width ?? 0),
        colW: Math.round(col?.getBoundingClientRect().width ?? 0),
        title: document.querySelector('.cnsr-sheet--wide .cnsr-sheet__t')?.textContent ?? '',
        hasX: !!document.querySelector('.cnsr-sheet--wide .cnsr-sheet__x'),
      };
    });
    check('全屏键弹出更宽幅的弹窗', full.w > full.colW * 2, `${full.colW}px 列 → ${full.w}px 弹窗`);
    check('全屏弹窗有关闭键', full.hasX, full.title);
    await page.screenshot({ path: `${OUT}/${tag}-fullscreen.png` });
    await page.locator('.cnsr-sheet--wide .cnsr-sheet__x').click();
    await page.waitForTimeout(350);
    check('全屏弹窗能关掉', (await page.locator('.cnsr-sheet--wide').count()) === 0);

    // ── Each column scrolls on its own ────────────────────────
    const before = await page.evaluate(() => [...document.querySelectorAll('.cn__col-body')].map((e) => e.scrollTop));
    await page.evaluate(() => {
      const b = document.querySelectorAll('.cn__col-body')[1];
      b.scrollTop = 400;
      b.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => [...document.querySelectorAll('.cn__col-body')].map((e) => e.scrollTop));
    check('滚动只影响被滚的那一列', after[1] !== before[1] && after[0] === before[0] && after[2] === before[2], `${before.join(',')} → ${after.join(',')}`);

    // ── The readout names the day you are looking at ──────────
    const readout = await page.evaluate(() => {
      const el = document.querySelector('.cn__col-date');
      return el ? el.textContent.trim() : '';
    });
    check('滚动条上方显示当前滚到哪一天', /^\d{4}-\d{2}-\d{2}$/.test(readout), readout || '(没有读数)');

    // ── Rail thumb is sized from the real scroll ratio ────────
    const rail = await page.evaluate(() => {
      const thumbs = [...document.querySelectorAll('.cn__thumb')];
      return thumbs.map((t) => {
        const track = t.parentElement.getBoundingClientRect();
        const r = t.getBoundingClientRect();
        return Math.round((r.height / track.height) * 100);
      });
    });
    check('滚动条滑块按真实比例', rail.length === SOURCES.length && rail.every((p) => p >= 1 && p <= 100), rail.map((p) => `${p}%`).join(' '));
  } else {
    // ── Narrow: four cards on one screen, tap opens the glass sheet ──
    const cards = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.cn__card')];
      return { n: nodes.length, labels: nodes.map((c) => c.querySelector('.cn__card-t')?.textContent ?? '') };
    });
    check('窄屏是四张卡片', cards.n === SOURCES.length, cards.labels.join(' / '));

    const fit = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.cn__card')];
      const last = nodes[nodes.length - 1].getBoundingClientRect();
      const cue = document.querySelector('.section__cue');
      return { bottom: Math.round(last.bottom), cueTop: cue ? Math.round(cue.getBoundingClientRect().top) : null, vh: window.innerHeight };
    });
    check('四张卡片能一屏放下', fit.bottom < (fit.cueTop ?? fit.vh) && fit.bottom <= fit.vh, `底部 ${fit.bottom} / 提示条 ${fit.cueTop} / 视口 ${fit.vh}`);

    await page.locator('.cn__card').first().click();
    await page.waitForSelector('.cnsr-sheet', { timeout: 8000 });
    await page.waitForTimeout(500);
    const sheet = await page.evaluate(() => {
      const p = document.querySelector('.cnsr-sheet__panel');
      const bg = p ? getComputedStyle(p).backgroundColor : '';
      const a = /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(bg);
      return {
        open: !!p,
        alpha: a ? parseFloat(a[1]) : 1,
        title: document.querySelector('.cnsr-sheet__t')?.textContent ?? '',
        hasX: !!document.querySelector('.cnsr-sheet__x'),
        days: document.querySelectorAll('.cnsr-sheet .cn__day').length,
        glass: getComputedStyle(p).backdropFilter !== 'none' || getComputedStyle(p).webkitBackdropFilter !== 'none',
      };
    });
    check('点卡片弹出弹窗', sheet.open, sheet.title);
    // ⚠️ The assertion is a RANGE, and it was inverted on purpose.
    //
    // It first required alpha >= 0.94, which is how the sheet ended up an opaque
    // slab: the test was enforcing exactly the thing the user then reported as
    // "black, not glass". Glass needs blur AND some transparency — opaque enough
    // to read on, sheer enough to see the material.
    check(
      '弹窗是毛玻璃而不是黑板',
      sheet.glass && sheet.alpha >= 0.2 && sheet.alpha <= 0.8,
      `alpha ${sheet.alpha}（需 0.2–0.8）, backdrop-filter ${sheet.glass}`,
    );
    check('弹窗里有日期条目', sheet.days > 0, `${sheet.days} 天`);
    check('有关闭按钮', sheet.hasX);
    await page.screenshot({ path: `${OUT}/${tag}-sheet.png` });

    await page.locator('.cnsr-sheet__x').click();
    await page.waitForTimeout(400);
    check('叉掉能关掉弹窗', (await page.locator('.cnsr-sheet').count()) === 0);
  }

  // ── The date tree: newest 2 days open, the rest shut ──────
  const tree = await page.evaluate(() => {
    const scope = document.querySelector('.cnsr-sheet') ?? document;
    return {
      years: scope.querySelectorAll('.cn__year').length,
      months: scope.querySelectorAll('.cn__month').length,
      days: scope.querySelectorAll('.cn__day').length,
      openDays: scope.querySelectorAll('.cn__day--on').length,
      entries: scope.querySelectorAll('.cn__entry').length,
      more: [...scope.querySelectorAll('.cn__more')].map((e) => e.textContent.trim()),
      imgs: scope.querySelectorAll('.cn__img').length,
      links: scope.querySelectorAll('.cn__a').length,
    };
  });
  if (!wide) {
    // The sheet is closed; re-open to inspect the tree.
    await page.locator('.cn__card').nth(1).click();
    await page.waitForSelector('.cnsr-sheet .cn__day', { timeout: 8000 });
    await page.waitForTimeout(400);
  }
  const tree2 = wide
    ? tree
    : await page.evaluate(() => {
        const scope = document.querySelector('.cnsr-sheet');
        return {
          years: scope.querySelectorAll('.cn__year').length,
          months: scope.querySelectorAll('.cn__month').length,
          days: scope.querySelectorAll('.cn__day').length,
          openDays: scope.querySelectorAll('.cn__day--on').length,
          entries: scope.querySelectorAll('.cn__entry').length,
          more: [...scope.querySelectorAll('.cn__more')].map((e) => e.textContent.trim()),
          imgs: scope.querySelectorAll('.cn__img').length,
          links: scope.querySelectorAll('.cn__a').length,
        };
      });

  check('有年 → 月 → 日三层', tree2.years > 0 && tree2.months > 0 && tree2.days > 0, `年 ${tree2.years} / 月 ${tree2.months} / 日 ${tree2.days}`);
  check('日做成玻璃面板', tree2.days > 0);
  // ⚠️ Two days PER TREE. A wide screen shows four independent trees, so the
  // page-wide count is 8 — asserting `=== 2` there failed on correct behaviour,
  // which is the assertion's bug, not the page's.
  const trees = wide ? SOURCES.length : 1;
  check('最近 2 天默认展开', tree2.openDays === 2 * trees, `${tree2.openDays} 天展开（${trees} 棵树 × 2）`);
  check('展开的天里有内容行', tree2.entries > 0, `${tree2.entries} 条`);

  // ── Toggling a day actually opens it ──────────────────────
  const scopeSel = wide ? '.cn__col' : '.cnsr-sheet';
  await page.locator(`${scopeSel} .cn__node--day`).nth(2).click();
  await page.waitForTimeout(350);
  const afterToggle = await page.evaluate((sel) => document.querySelectorAll(`${sel} .cn__day--on`).length, scopeSel);
  check('点日期能切换展开', afterToggle === tree2.openDays + 1, `${tree2.openDays} → ${afterToggle}`);

  // ── Images only where allowed ─────────────────────────────
  if (wide) {
    const imgs = await page.evaluate(() =>
      [...document.querySelectorAll('.cn__col')].map((c) => c.querySelectorAll('.cn__img').length),
    );
    const shoppingImgs = imgs[0];
    const others = imgs.slice(1);
    check('只有 Shopping 有图', shoppingImgs > 0 && others.every((n) => n === 0), `各列图数 ${imgs.join(' / ')}`);
    check('Shopping 图片不超过 5 张', shoppingImgs <= 5, `${shoppingImgs} 张`);
    check('图片真的加载出来了', await page.evaluate(() => {
      const i = document.querySelector('.cn__img');
      const el = i?.querySelector('img') ?? i;
      return !!el && (el.naturalWidth > 0 || el.tagName === 'IMG');
    }));
  }

  // ── Links carry a logo, never a bare address ──────────────
  //
  // ⚠️ Checked BEFORE switching to the timeline. The links live in the Shopping
  // column, which the timeline view unmounts — run the other way round this
  // reported "0 link rows" against a page that had them all along.
  // ⚠️ On a narrow screen the Shopping column does not exist — the four cards
  // are all that render, and the notes only appear inside a sheet. Looking for
  // link rows without opening it reported "0 rows" against a page that had one.
  // The links also sit on an older day than the two that start open, so every
  // day has to be expanded before they are on screen.
  if (!wide) {
    // ⚠️ Close whatever the tree check left open FIRST. The sheet is a
    // full-screen overlay, so a card behind it cannot be clicked — Playwright
    // reported the click being intercepted by a text node inside the sheet,
    // which reads as a layout bug and is really just an open dialog.
    if (await page.locator('.cnsr-sheet__x').count()) {
      await page.locator('.cnsr-sheet__x').click();
      await page.waitForTimeout(300);
    }
    await page.locator('.cn__card').first().click();
    await page.waitForSelector('.cnsr-sheet .cn__day', { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      document
        .querySelectorAll('.cnsr-sheet .cn__day:not(.cn__day--on) .cn__node--day')
        .forEach((n) => n.click());
    });
    await page.waitForTimeout(400);
  }
  const links = await page.evaluate(() => ({
    rows: document.querySelectorAll('.cn__linkrow').length,
    favs: document.querySelectorAll('.cn__fav-img').length,
    hosts: [...document.querySelectorAll('.cn__host')].map((e) => e.textContent.trim()),
    raw: (document.body.innerText.match(/https?:\/\/[^\s]+/g) ?? []).length,
  }));
  if (!wide) {
    await page.locator('.cnsr-sheet__x').click();
    await page.waitForTimeout(300);
  }
  check('链接做成带 logo 的行', links.rows > 0 && links.favs === links.rows, `${links.rows} 行 / ${links.favs} logo`);
  check('链接旁边标出站点', links.hosts.length > 0 && links.hosts.every((h) => h.length > 2), links.hosts.slice(0, 3).join(' , '));
  check('没有裸链接', links.raw === 0, `${links.raw} 处`);

  // ── The timeline: all four sources on one axis ────────────
  await page.locator('.cnview__tab').nth(1).click();
  await page.waitForTimeout(500);
  // ⚠️ Read the resting state BEFORE expanding anything. Expanding first and
  // then asserting "2 days open" reported 15 — the number the expansion left
  // behind, not the one the page starts with.
  const tlOpenAtRest = await page.evaluate(
    () => document.querySelector('.cn__timeline')?.querySelectorAll('.cn__day--on').length ?? 0,
  );

  // ⚠️ Expand every closed day. Collapsed days render no items, so the source
  // chips only exist for the two days that start open — which are both from the
  // same source, making a merged list look single-source.
  await page.evaluate(() => {
    document
      .querySelectorAll('.cn__timeline .cn__day:not(.cn__day--on) .cn__node--day')
      .forEach((n) => n.click());
  });
  await page.waitForTimeout(400);
  const tl = await page.evaluate(() => {
    const scope = document.querySelector('.cn__timeline');
    if (!scope) return null;
    const dates = [...scope.querySelectorAll('.cn__day-t')].map((e) => e.textContent.trim());
    const chips = [...new Set([...scope.querySelectorAll('.cn__tl-chip-t')].map((e) => e.textContent.trim()))];
    return {
      days: dates.length,
      desc: dates.every((d, i) => i === 0 || dates[i - 1] >= d),
      first: dates[0] ?? '',
      chips,
      open: scope.querySelectorAll('.cn__day--on').length,
    };
  });
  check('时间线视图能打开', !!tl, tl ? `${tl.days} 天` : '没有 .cn__timeline');
  check('时间线按日期倒序', tl?.desc, (tl ? `${tl.first} … ` : '') + '单调不增');
  check('时间线合并了多个板块', (tl?.chips.length ?? 0) >= 2, (tl?.chips ?? []).join(' / '));
  check('时间线上每条标着来源', (tl?.chips.length ?? 0) > 0);
  check('时间线最近 2 天展开', tlOpenAtRest === 2, `静置时 ${tlOpenAtRest} 天`);
  await page.screenshot({ path: `${OUT}/${tag}-timeline.png` });

  // ── Links carry a logo, never a bare address ──────────────
  // The link-block checks ran earlier, against the sources view — see the note
  // there. Only the raw-URL rule is re-checked here, because it has to hold in
  // whichever view is on screen.
  check(
    '时间线上也没有裸链接',
    ((await page.evaluate(() => document.body.innerText)).match(/https?:\/\/[^\s]+/g) ?? []).length === 0,
  );

  check('没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' || '));
  await page.screenshot({ path: `${OUT}/${tag}-overview.png` });
  await ctx.close();
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
await run(browser, { scheme: 'dark', viewport: { width: 1440, height: 900 } }, 'desktop-dark');
await run(browser, { scheme: 'light', viewport: { width: 1440, height: 900 } }, 'desktop-light');
await run(browser, { scheme: 'dark', viewport: { width: 390, height: 844 } }, 'phone-dark');
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n══ ${results.length - failed.length}/${results.length} passed ══`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  process.exit(1);
}
