#!/usr/bin/env bun
/**
 * 生成站点图标（浏览器标签页那一格）。
 *
 *   bun scripts/make-favicon.mjs
 *
 * 产出 `apps/dashboard/static/brand/`：
 *   favicon-16.png / favicon-32.png     标签页
 *   favicon-180.png                     apple-touch-icon
 *
 * ── ⚠️⚠️ 为什么是**字 Z**，不是那枚线稿标记 ──────────────────────
 *
 * 读者 2026-10-07：「我的网站的logo没有帮我换好，现在没有logo，
 *    就是在浏览器条上看到的那个」。
 *
 * 我先做了一张四宫格，在 **32px 真实像素**下比较（最近邻放大看，不插值）：
 *   · 线稿标记 + 深底 → **糊成一团**，认不出是 Z（墨线 8 单位、缝 4 单位，
 *     32px 时线宽不到 1px，抗锯齿把缝填满）
 *   · 线稿标记 + **透明底** → 白标签栏下**完全消失**（白线压白底）
 *   · **Ela Sans 斜体 Z + 深底 → 清晰锐利，一眼可读** ✓
 *
 * ⚠️ 这个判断**只能看图得到**。字标用的就是这个字体，所以它也是最贴品牌的做法。
 * ⚠️ 底必须是**实色**：标签栏有浅色也有深色（`prefers-color-scheme`），
 *    白字压透明底在浅色标签栏上等于没有。
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..');
const DIR = resolve(ROOT, 'apps/dashboard/static/brand');
const FONT = resolve(ROOT, 'apps/dashboard/static/fonts/ela-sans-italic.ttf');
const fontB64 = readFileSync(FONT).toString('base64');

const SIZES = [
  [16, 'favicon-16.png'],
  [32, 'favicon-32.png'],
  [180, 'favicon-180.png'],
];

const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-bypass-list=*'] });
const page = await browser.newPage();
await page.setContent('<html><head></head><body></body></html>');

for (const [size, name] of SIZES) {
  const url = await page.evaluate(
    async ([b64, s]) => {
      const ff = new FontFace('Ela', 'url(data:font/ttf;base64,' + b64 + ')');
      await ff.load();
      document.fonts.add(ff);
      const c = document.createElement('canvas');
      c.width = s;
      c.height = s;
      const g = c.getContext('2d');
      // 实色底 + 圆角：标签栏是浅色时，方块有边界；深色时融进去也不突兀。
      g.fillStyle = '#0a0b0f';
      g.beginPath();
      g.roundRect(0, 0, s, s, s * 0.22);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'italic ' + Math.round(s * 0.78) + 'px Ela';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // ⚠️ `+ s * 0.04`：斜体 Z 的几何中心比行盒中心略高，不补就偏上。
      g.fillText('Z', s / 2, s / 2 + s * 0.04);
      return c.toDataURL('image/png');
    },
    [fontB64, size],
  );
  const buf = Buffer.from(url.split(',')[1], 'base64');
  writeFileSync(resolve(DIR, name), buf);
  console.log(`  ${String(size).padStart(3)}×${size}  ${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}
await browser.close();
