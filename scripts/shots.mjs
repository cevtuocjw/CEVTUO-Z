/**
 * Screenshot tool for visual review.
 *
 *   bun scripts/shots.mjs <base-url> <out-dir>
 *
 * ⚠️ Why Playwright and not CDP against the running Chrome.
 *
 * Chrome 153 on this machine applies an automatic dark-mode inversion to pages
 * it renders, and `Page.captureScreenshot` returns the INVERTED pixels — the
 * screenshot showed a pale grey page while `getComputedStyle` on the very same
 * element reported white-on-dark. That mismatch sent a whole design pass in the
 * wrong direction, because the image looked authoritative and was not.
 *
 * Playwright drives its own bundled Chromium with an explicit
 * `colorScheme: 'dark'`, so the media query resolves deterministically and no
 * inversion is applied. Same engine family as the WeChat WebView, so what it
 * shows is what a phone shows.
 *
 * ⚠️ `colorScheme` must be set at context creation. Setting it afterwards via
 * `emulateMedia` does not reliably reach the inline pre-paint script in
 * index.html, which is what stamps the theme class before first render.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8096/z';
const OUT = process.argv[3] ?? '/tmp/shots';

// Cover screen, unfolded inner screen, and desktop. The widths match the
// breakpoints in tokens.scss so each shot lands in the tier it is meant to.
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'unfolded', width: 700, height: 900 },
  { name: 'desktop', width: 1400, height: 900 },
];

const PAGES = [
  { name: 'home', route: 'home', panels: 4 },
  { name: 'coof', route: 'coof', panels: 2 },
  { name: 'cnsr', route: 'cnsr', panels: 2 },
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

for (const theme of ['dark', 'light']) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      colorScheme: theme,
      // The app is served over plain HTTP on localhost; without this the
      // context treats it as insecure and some APIs behave differently.
      isMobile: vp.width < 600,
      hasTouch: vp.width < 600,
    });

    for (const p of PAGES) {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/#/pages/${p.route}/index`, { waitUntil: 'networkidle' });
      // The poster grid lazy-loads; give the visible ones a chance to decode.
      await page.waitForTimeout(1500);

      for (let i = 0; i < p.panels; i++) {
        // Drive the stack the way the rail does, so a shot of panel 2 exercises
        // the same path a tap would.
        await page.evaluate((idx) => {
          const el = document.querySelector('.stack');
          if (el) el.scrollTop = idx * el.clientHeight;
        }, i);
        await page.waitForTimeout(900);

        const file = `${OUT}/${theme}-${vp.name}-${p.name}-p${i + 1}.png`;
        await page.screenshot({ path: file });

        // Report what the DOM thinks, so a wrong-looking image can be checked
        // against the values rather than trusted on its own.
        const facts = await page.evaluate(() => {
          const g = document.querySelector('.grid');
          return {
            theme: document.documentElement.className,
            bg: (document.querySelector('.cevtuo-wallpaper')?.style.backgroundImage ?? '').includes(
              'static/',
            ),
            cols: g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0,
            tiles: document.querySelectorAll('.tile').length,
            bar: !!document.querySelector('.topbar'),
          };
        });
        console.log(
          `${file}  theme=${facts.theme} bg=${facts.bg} cols=${facts.cols} tiles=${facts.tiles} bar=${facts.bar}`,
        );
      }
      await page.close();
    }
    await ctx.close();
  }
}

await browser.close();
