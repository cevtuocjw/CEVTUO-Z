/**
 * CNSR extraction — the four Notion sources, segmented by `@date`.
 *
 *   bun scripts/cnsr-extract.mjs --only shopping          # dry run, one source
 *   bun scripts/cnsr-extract.mjs --write --only shopping  # write data/cnsr/
 *   bun scripts/cnsr-extract.mjs --write                  # all four
 *
 * ⚠️ READ ONLY with respect to Notion. Nothing here edits the user's workspace.
 * `--write` writes into this repo's `data/cnsr/` and nowhere else.
 *
 * ── The model ────────────────────────────────────────────────
 *
 * 1. An `@date` is a SEPARATOR, not a container title. A date marks a point in
 *    the document; everything after it belongs to it until the next date.
 *    Segment boundaries are independent of toggle nesting — a segment can start
 *    inside one toggle and end inside another.
 *
 * 2. Read BACKWARDS. Entries are appended, so the newest is last, and reading
 *    backwards reaches the material the dashboard shows first and can STOP once
 *    the window is full instead of parsing years of notes to discard them.
 *
 *    A reverse depth-first walk gives this for free: descending into children
 *    BEFORE visiting their parent is exactly reverse document order, so a date
 *    buried at the bottom of a deeply nested toggle is found and cuts the same
 *    segment it would have cut reading forwards.
 *
 * 3. Skip `before` toggles entirely — see SKIP_TITLE below.
 */

const TOKEN = process.env.NOTION_TOKEN;
const VERSION = '2022-06-28';
const WRITE = process.argv.includes('--write');
const argvAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ONLY = argvAfter('--only');

/** The user's spec, 2026-09-23: the newest 5 dated days per source. */
const MAX_DATES = 5;
/** A day with more than this many rows shows only the first N, plus a count. */
const MAX_LINES_PER_DAY = 10;
/** Images are dropped everywhere except Shopping, which may keep this many. */
const MAX_IMAGES = 5;
const MAX_DEPTH = 12;
const MAX_REQUESTS = 1200;

const SOURCES = [
  { key: 'shopping', label: 'Shopping', id: '3dff24c4e01f496d86b5a7fb5b3b133b', images: true },
  { key: 'learn', label: 'Learn', id: 'd6d5f4924b904e8c94ff4ab1a27c1af3', images: false },
  { key: 'techlearn', label: 'tech-learn', id: '045f87789ebd4741a0059c898a9089d4', images: false },
  { key: 'techai', label: 'TECH-AI', id: 'fc17863a1b8543c6ad0288dc80e3bb22', images: false },
];

/**
 * Subtrees to skip WHOLE — not visited, not descended into.
 *
 * ⚠️ `before` is the user's own archive marker: a toggle holding old material
 * that predates the `@date` habit and therefore can never appear on the
 * timeline. Reading it costs hundreds of requests to produce content that is
 * discarded on arrival. Skipping the SUBTREE (not just the toggle) is the point
 * — the cost is in its children.
 */
const SKIP_TITLE = /^\s*(before|旧|old)\b/i;

/** Separate Notion OBJECTS, not content of this document — never spliced in. */
const SEPARATE_OBJECT = new Set(['child_page', 'child_database']);

/** Structural blocks that carry no content of their own. */
const IGNORED = new Set(['table_of_contents', 'breadcrumb', 'divider', 'unsupported', 'column_list', 'column', 'synced_block']);

// ── Notion client — paced, honouring the server's Retry-After ──
const MIN_GAP_MS = 350; // 180 req/min ≈ 3/s on any plan below Business
let tail = Promise.resolve();
let lastAt = 0;

function paced(fn) {
  const run = tail.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  tail = run.then(() => undefined, () => undefined);
  return run;
}

async function api(path, init = {}) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await paced(() =>
      fetch(`https://api.notion.com/v1${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Notion-Version': VERSION,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      }),
    );
    if (res.status === 429 || res.status === 529) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt) + 500;
      process.stderr.write(`    · ${res.status} 被限速，等 ${(waitMs / 1000).toFixed(1)}s（第 ${attempt}/5 次）\n`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.status >= 500 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  return { status: 429, body: { code: 'rate_limited' } };
}

// ── Reading blocks ───────────────────────────────────────────
const richOf = (b) => {
  const raw = b[b.type]?.rich_text ?? b[b.type]?.title ?? [];
  return Array.isArray(raw) ? raw : [];
};
const textOf = (b) => richOf(b).map((r) => r.plain_text).join('').trim();

/**
 * Link runs inside a block, with the text that should carry the link.
 *
 * ⚠️ Two different Notion shapes mean the same thing here:
 *   · a rich-text run with `href` — an inline link, whose `plain_text` is
 *     whatever the user typed (usually the name of the thing), and
 *   · a `bookmark` / `link_preview` block — a bare URL with an optional caption.
 *
 * The user's requirement is that neither becomes a raw `https://…` on screen:
 * the link has to be carried by a NAME. When a bookmark has no caption there is
 * no name to use, so one is derived from the URL (see `nameFromUrl`) rather
 * than printing the address.
 */
function linksOf(b) {
  const out = [];
  for (const r of richOf(b)) {
    if (r.href && r.plain_text) out.push({ t: r.plain_text, href: r.href });
  }
  const url = b[b.type]?.url;
  if (url) {
    const caption = textOf(b);
    out.push({ t: caption || nameFromUrl(url), href: url });
  }
  return out;
}

/**
 * A readable label for a URL that has none of its own.
 *
 * `https://www.example.com/blog/how-to-do-x?utm=…` → `how-to-do-x`.
 * Falls back to the host when the path holds nothing usable.
 */
function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const clean = decodeURIComponent(seg)
      .replace(/\.(html?|php|aspx?|md)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    return clean.length >= 3 ? clean.slice(0, 60) : u.hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

function markerOf(b) {
  for (const r of richOf(b)) {
    if (r.type === 'mention' && r.mention?.type === 'date' && r.mention.date?.start) {
      return { date: r.mention.date.start.slice(0, 10), rendered: r.plain_text ?? '' };
    }
  }
  return null;
}

/**
 * Reverse depth-first walk.
 *
 * ⚠️ Children are descended into BEFORE the parent is visited, and the child
 * list is iterated last-to-first. Together those give exact reverse document
 * order — the page read from the bottom up.
 */
async function walkBackwards(blockId, st, depth = 0) {
  if (st.stop || depth > MAX_DEPTH || st.calls > MAX_REQUESTS) return;

  const out = [];
  let cursor = null;
  do {
    st.calls += 1;
    const { body } = await api(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    if (!body.results) {
      st.errors.push(`${body.code ?? 'error'}: ${String(body.message ?? '').slice(0, 90)}`);
      return;
    }
    out.push(...body.results);
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);

  for (let i = out.length - 1; i >= 0; i -= 1) {
    const b = out[i];
    if (SKIP_TITLE.test(textOf(b))) {
      st.skipped += 1;
      continue; // whole subtree, not just this block
    }
    if (b.has_children && !SEPARATE_OBJECT.has(b.type)) {
      await walkBackwards(b.id, st, depth + 1);
      if (st.stop) return;
    }
    visit(b, st);
    if (st.stop) return;
  }
}

/** Blocks whose entire content IS a link. */
const LINK_BLOCK = new Set(['bookmark', 'link_preview', 'embed']);

/**
 * A line that STARTS with a URL.
 *
 * ⚠️ Deliberately looser than "is exactly a URL". Notion writes the pasted
 * address and whatever the user typed after it into the same text run —
 * `https://supernote.com/JK rowling` — and the strict `^\S+$` form missed it,
 * so the raw address reached the screen, which is the one thing this is here to
 * prevent. The first whitespace-delimited token is taken as the address and the
 * remainder is treated as the name the user gave it.
 */
const BARE_URL = /^https?:\/\//i;

/**
 * One block, in reverse document order.
 *
 * ── Why `st.cur` exists from the very first block ────────────
 *
 * ⚠️ This is the bug that produced five days of 7 / 1 / 8 / 0 / 0 lines.
 *
 * The user's pages hold each day as a TOGGLE WHOSE TITLE IS THE DATE, with the
 * day's content inside it. Reading backwards, a toggle's children are visited
 * BEFORE the toggle itself — so the newest day's content arrives before ANY
 * marker has been seen. An earlier version buffered into `null` until the first
 * marker and dropped everything that arrived earlier as "preamble", which threw
 * away the newest day entirely and slid every other day's content onto the day
 * before it.
 *
 * With a buffer that always exists, the rule is uniform and holds for both
 * shapes in these pages:
 *
 *   · marker as a container title — children precede the marker in reverse
 *     order, so they are in `cur` when the marker closes it, and
 *   · marker as a leaf (a plain paragraph holding a date mention) — its content
 *     follows it in document order, so it also precedes the NEXT marker and is
 *     closed by it.
 *
 * Whatever is still in `cur` when the walk ends is the genuine preamble: the
 * page header and navigation above the OLDEST marker.
 */
function visit(b, st) {
  const marker = markerOf(b);
  const text = textOf(b);

  if (marker) {
    const title = text.replace(marker.rendered, '').replace(/^[\s\-–—:：|]+/, '').trim();
    st.segs.push({ id: b.id, date: marker.date, title, lines: st.cur.lines, images: st.cur.images });
    st.cur = { lines: [], images: [] };
    st.days.add(marker.date);
    if (st.days.size >= st.maxDates) st.stop = true;
    return;
  }

  if (b.type === 'image') {
    // ⚠️ Images are DROPPED unless the source keeps them, and even then the URL
    // is not carried through — Notion-hosted files come from S3 with
    // `X-Amz-Expires=3600`, so a stored URL is a broken image an hour later.
    // What travels is the block id; the caller downloads the bytes now.
    const url = b.image?.file?.url ?? b.image?.external?.url;
    if (url && st.images && st.imageCount < MAX_IMAGES) {
      st.imageCount += 1;
      st.pending.push({ blockId: b.id, url, external: b.image?.type === 'external', caption: text });
      st.cur.images.push({ i: st.pending.length - 1, caption: text, src: '' });
    } else if (url) {
      st.cur.imagesSkipped = (st.cur.imagesSkipped ?? 0) + 1;
    }
    return;
  }

  if (!text || IGNORED.has(b.type)) return;

  // ⚠️ A link must never reach the screen as a bare `https://…`.
  //
  // Three shapes produce one, and all three are turned into a NAME carried by
  // the link: a bookmark/embed block whose URL lives outside its rich text, and
  // a paragraph the user pasted a URL into.
  if (LINK_BLOCK.has(b.type)) {
    const url = b[b.type]?.url;
    if (url) {
      const name = text || nameFromUrl(url);
      st.cur.lines.push({ k: b.type, t: name, links: [{ t: name, href: url }] });
    }
    return;
  }

  if (BARE_URL.test(text)) {
    const [url, ...rest] = text.split(/\s+/);
    // The user's own trailing words win as the label; the URL-derived name is
    // prepended when it adds something ("JK" + "rowling" → "JK rowling").
    const derived = nameFromUrl(url);
    const typed = rest.join(' ').trim();
    const name = typed && !derived.includes(typed) ? `${derived} ${typed}`.trim() : derived;
    st.cur.lines.push({ k: b.type, t: name, links: [{ t: name, href: url }] });
    return;
  }

  // ⚠️ A URL anywhere in the line, not just at the start.
  //
  // Notion only turns a pasted address into a link when it stands alone; an
  // address written INSIDE a sentence stays plain text, and it was reaching the
  // screen verbatim — the timeline view rendered raw `https://…`, which the
  // "no bare links" rule exists to prevent. Every match is replaced by a name
  // derived from it, and the address moves into the link run.
  //
  // ⚠️ The character class stops at CJK punctuation as well as whitespace.
  // Chinese notes write `见 https://example.com，另外…`, and without the CJK
  // stop the trailing comma is swallowed into the href and the link 404s.
  const found = [...text.matchAll(/https?:\/\/[^\s，。、；：）)】」"']+/g)];
  if (found.length) {
    let shown = text;
    const links = [];
    for (const m of found) {
      const href = m[0];
      const name = nameFromUrl(href);
      shown = shown.replace(href, name);
      links.push({ t: name, href });
    }
    st.cur.lines.push({ k: b.type, t: shown, links });
    return;
  }

  // A URL already marked up by Notion keeps its own run as the link target.
  st.cur.lines.push({ k: b.type, t: text, links: linksOf(b) });
}

// ── Main ─────────────────────────────────────────────────────
const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } = await import('node:fs');
const { join } = await import('node:path');

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const outDir = join(root, 'data', 'cnsr');
const imgDir = join(outDir, 'img');
const indexFile = join(outDir, 'index.json');

const wanted = ONLY
  ? SOURCES.filter((s) => s.key === ONLY || s.label.toLowerCase() === ONLY.toLowerCase())
  : SOURCES;
if (!wanted.length) {
  console.error(`未知来源: ${ONLY}（可选 ${SOURCES.map((s) => s.key).join(' / ')}）`);
  process.exit(1);
}

const nowLocal = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16) + '+08:00';
const summary = {};

for (const src of wanted) {
  const t0 = Date.now();
  const st = {
    // ⚠️ Always an object, never null — see the note on `visit`. Content
    // arriving before the first marker belongs to the NEWEST day, not to the
    // preamble; only what is left here after the whole walk is preamble.
    cur: { lines: [], images: [] },
    segs: [],
    days: new Set(),
    stop: false,
    calls: 0,
    errors: [],
    skipped: 0,
    images: src.images,
    imageCount: 0,
    pending: [],
    maxDates: MAX_DATES,
  };

  process.stdout.write(`\n${'═'.repeat(74)}\n${src.label}   ${src.id}\n${'═'.repeat(74)}\n`);
  await walkBackwards(src.id, st);

  // ── Cap each day, and report what the cap hid ──────────────
  let hidden = 0;
  for (const s of st.segs) {
    if (s.lines.length > MAX_LINES_PER_DAY) {
      hidden += s.lines.length - MAX_LINES_PER_DAY;
      s.more = s.lines.length - MAX_LINES_PER_DAY;
      s.lines = s.lines.slice(0, MAX_LINES_PER_DAY);
    }
  }
  const lines = st.segs.reduce((n, s) => n + s.lines.length, 0);

  console.log(`  反向遍历：${st.calls} 次请求，${((Date.now() - t0) / 1000).toFixed(0)}s${st.stop ? '（读够 5 天即停）' : '（读完整页）'}`);
  const preamble = st.cur.lines.length;
  console.log(`  跳过 ${st.skipped} 个 before/old 子树；最老标记之上（页面头部）忽略 ${preamble} 行`);
  console.log(`  得到 ${st.segs.length} 天 / ${lines} 行${hidden ? `（超 10 行被截掉 ${hidden} 行）` : ''}`);
  if (st.segs.length) console.log(`  日期：${st.segs[st.segs.length - 1].date} → ${st.segs[0].date}`);
  for (const e of st.errors.slice(0, 3)) console.log(`  ✗ ${e}`);

  // ── Images: download now, while the signed URLs are alive ──
  const images = [];
  // ⚠️ Downloads happen only on `--write`. A dry run must not leave files
  // behind — "dry run" meaning "wrote images but no JSON" would be a nasty
  // surprise, and the image bytes are the only thing here that is not tiny.
  if (st.pending.length && !WRITE) {
    console.log(`  图片：检测到 ${st.pending.length} 张（dry run 不下载）`);
  }
  if (st.pending.length && WRITE) {
    mkdirSync(imgDir, { recursive: true });
    for (const p of st.pending) {
      const rel = `data/cnsr/img/${p.blockId.replace(/-/g, '')}.jpg`;
      if (p.external) {
        images.push({ blockId: p.blockId, src: p.url, caption: p.caption, external: true });
        continue;
      }
      try {
        const res = await paced(() => fetch(p.url));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        writeFileSync(join(root, rel), bytes);
        images.push({ blockId: p.blockId, src: rel, caption: p.caption, external: false });
      } catch (e) {
        console.log(`  ✗ 图片下载失败 ${p.blockId}: ${e.message}`);
      }
    }
    console.log(`  图片：${images.length} 张已落盘（上限 ${MAX_IMAGES}）`);
  }

  // Point each entry at its downloaded image.
  for (const s of st.segs) {
    s.images = (s.images ?? []).map((ref) => {
      const found = images.find((im) => im.blockId === st.pending[ref.i]?.blockId);
      return found ? { src: found.src, caption: found.caption } : null;
    }).filter(Boolean);
  }

  console.log(`  最近 5 天：`);
  for (const s of st.segs) {
    const first = s.lines[0]?.t?.slice(0, 44) ?? '(无内容)';
    console.log(`    ${s.date}  ${String(s.lines.length).padStart(2)} 行${s.more ? `(+${s.more})` : ''}  ${s.images.length ? `${s.images.length}图 ` : ''}${first}`);
  }
  const linkCount = st.segs.reduce((n, s) => n + s.lines.reduce((m, l) => m + (l.links?.length ?? 0), 0), 0);
  console.log(`  链接 ${linkCount} 个`);

  const payload = {
    source: src.key,
    label: src.label,
    notionId: src.id,
    window: `最近 ${MAX_DATES} 个 @日期`,
    updatedAt: nowLocal(),
    counts: { days: st.segs.length, lines, hidden, links: linkCount, images: images.length, skippedSubtrees: st.skipped },
    /** Newest first — the order the page reads from the bottom up. */
    entries: st.segs.map((s) => ({
      id: s.id,
      date: s.date,
      title: s.title,
      lines: s.lines,
      more: s.more ?? 0,
      images: s.images ?? [],
      imagesSeen: s.imagesSeen ?? 0,
    })),
  };

  if (WRITE) {
    mkdirSync(outDir, { recursive: true });
    // ⚠️ The JSON is rewritten WHOLESALE, and that is the retention rule, not an
    // accident: the file holds the newest 5 days and nothing else, so last
    // week's notes cannot accumulate in it. Overwriting is what keeps the
    // repository from growing a little every run forever.
    writeFileSync(join(outDir, `${src.key}.json`), JSON.stringify(payload, null, 1));
    console.log(`  ✓ 已写 data/cnsr/${src.key}.json`);
  }
  summary[src.key] = payload;

  // ── …and the images need the same treatment ────────────────
  //
  // ⚠️ Rewriting the JSON does NOT prune the image directory. Images whose day
  // has scrolled out of the 5-day window would sit there forever — the one
  // place in this pipeline that grows without bound.
  //
  // ⚠️⚠️ The keep-set is read from EVERY source file ON DISK, not from this
  // process's `summary`.
  //
  // The first version used `summary`, and with `--only <source>` — which is how
  // the staggered schedule runs, one source per process — that set holds only
  // the source this process fetched. Running `--only learn` therefore saw three
  // images referenced by nobody, deleted them, and destroyed Shopping's images.
  // Nothing errored; the only sign was one line in the log. Reading the other
  // sources' JSON off disk is what makes the sweep correct per-process.
  if (WRITE && existsSync(imgDir)) {
    const keep = new Set();
    for (const f of readdirSync(outDir)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const p = JSON.parse(readFileSync(join(outDir, f), 'utf8'));
        for (const e of p.entries ?? []) {
          for (const im of e.images ?? []) keep.add(im.src.split('/').pop());
        }
      } catch {
        // An unreadable source file must not license deleting its images —
        // skipping it keeps nothing from it, which is the safe direction only
        // if we then keep EVERYTHING. Bail out of the sweep instead.
        console.log(`  ⚠️ ${f} 读不出来，本次跳过图片清理`);
        keep.add('*');
        break;
      }
    }
    if (!keep.has('*')) {
      let gone = 0;
      for (const f of readdirSync(imgDir)) {
        if (keep.has(f)) continue;
        try {
          unlinkSync(join(imgDir, f));
          gone += 1;
        } catch {
          /* already gone — ENOENT must never fail the run */
        }
      }
      if (gone) console.log(`  ⌫ 清理过期图片 ${gone} 张（超出最近 5 天的）`);
    }
  }
}

// ── Index, preserving the OTHER sources' timestamps ──────────
//
// ⚠️ Merged, never rewritten wholesale. The whole point of the stagger is that
// one source refreshes per run; a run that rebuilt the index from only what it
// fetched would erase the other three `updatedAt` values and the dashboard
// would claim they had never synced.
if (WRITE) {
  let prior = { sources: [] };
  if (existsSync(indexFile)) {
    try {
      prior = JSON.parse(readFileSync(indexFile, 'utf8'));
    } catch {
      /* unreadable — rebuild from this run */
    }
  }
  const byKey = new Map((prior.sources ?? []).map((s) => [s.key, s]));
  for (const [k, p] of Object.entries(summary)) {
    byKey.set(k, { key: k, label: p.label, path: `data/cnsr/${k}.json`, window: p.window, updatedAt: p.updatedAt, counts: p.counts });
  }
  const sources = SOURCES.map((s) => byKey.get(s.key)).filter(Boolean);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(indexFile, JSON.stringify({ generatedAt: nowLocal(), sources }, null, 1));
  console.log(`\n✓ 已写 data/cnsr/index.json`);
  for (const s of sources) console.log(`    ${s.key.padEnd(11)} ${s.updatedAt}`);
}

console.log(`\n${'═'.repeat(74)}\n汇总\n${'═'.repeat(74)}`);
for (const [k, p] of Object.entries(summary)) {
  console.log(`  ${k.padEnd(11)} ${String(p.counts.days).padStart(2)} 天 / ${String(p.counts.lines).padStart(3)} 行 / 链 ${p.counts.links} / 图 ${p.counts.images}`);
}
if (!WRITE) console.log(`\n（dry run —— 没写任何文件。加 --write 才写 data/cnsr/）`);
