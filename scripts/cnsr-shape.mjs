/**
 * What shape are the four CNSR pages in? — containers only.
 *
 *   bun scripts/cnsr-shape.mjs
 *
 * ⚠️ READ ONLY.
 *
 * ⚠️ Why this replaces `cnsr-recon.mjs`.
 *
 * That version walked every block recursively. `Learn` has 7121 blocks and 226
 * of them have children, so the walk spent minutes issuing hundreds of
 * rate-limited requests to enumerate 3318 paragraphs — and the paragraphs are
 * exactly the part that does NOT matter. What matters for a year → month → day
 * restructure is the set of CONTAINERS (toggles, headings, child pages) and what
 * their titles look like, because that is where a date convention can live.
 *
 * So: descend only into blocks that can hold other blocks, stop at a bounded
 * depth, and print the container skeleton. `has_children` is the gate.
 */

const TOKEN = process.env.NOTION_TOKEN;
const VERSION = '2022-06-28';
const MAX_DEPTH = Number(process.env.DEPTH ?? 4);

const SOURCES = [
  ['Shopping', '3dff24c4e01f496d86b5a7fb5b3b133b'],
  ['Learn', 'd6d5f4924b904e8c94ff4ab1a27c1af3'],
  ['tech-learn', '045f87789ebd4741a0059c898a9089d4'],
  ['TECH-AI', 'fc17863a1b8543c6ad0288dc80e3bb22'],
];

/** Container types worth descending into. Everything else is leaf content. */
const CONTAINERS = new Set(['toggle', 'child_page', 'column_list', 'column', 'synced_block', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'callout', 'quote', 'template']);

// Date-ish conventions seen in this workspace: `-23.10.11`, `23.10.11`,
// `2023-10-11`, `10.11`, `2023年10月11日`.
const DATE_RE = /(20\d\d|\b\d\d)[.\-年/](\d{1,2})[.\-月/](\d{1,2})|^\s*[-–—]?\s*\d{2}\.\d{1,2}\.\d{1,2}/;

async function api(path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 2) * 1000));
      continue;
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  return { status: 429, body: {} };
}

const textOf = (b) => {
  const raw = b[b.type]?.rich_text ?? b[b.type]?.title ?? [];
  const rich = Array.isArray(raw) ? raw : [{ plain_text: String(raw) }];
  return rich.map((r) => r.plain_text).join('').trim();
};

/** Rich-text runs of a block, with mention details — this is where @date lives. */
const runsOf = (b) => {
  const raw = b[b.type]?.rich_text ?? [];
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    t: r.plain_text,
    type: r.type,
    date: r.type === 'mention' && r.mention?.type === 'date' ? r.mention.date : undefined,
  }));
};

async function children(blockId) {
  const out = [];
  let cursor = null;
  do {
    const { body } = await api(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    if (!body.results) return out;
    out.push(...body.results);
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);
  return out;
}

let apiCalls = 0;
async function walk(blockId, depth, sink, label) {
  if (depth > MAX_DEPTH) return;
  const kids = await children(blockId);
  apiCalls += 1;
  for (const b of kids) {
    const title = textOf(b);
    const runs = runsOf(b);
    const dated = runs.filter((r) => r.date);
    if (CONTAINERS.has(b.type) || dated.length || DATE_RE.test(title)) {
      sink.push({ depth, type: b.type, title: title.slice(0, 70), kids: b.has_children, dated, id: b.id });
    }
    if (b.has_children && CONTAINERS.has(b.type)) await walk(b.id, depth + 1, sink, label);
    // ⚠️ `child_database` is a leaf for block purposes — it holds rows, not
    // blocks. Descending would list nothing; the rows are read via the query
    // endpoint instead.
  }
}

for (const [label, id] of SOURCES) {
  console.log(`\n${'═'.repeat(80)}\n${label}   ${id}\n${'═'.repeat(80)}`);
  const page = await api(`/pages/${id}`);
  if (page.status !== 200) {
    console.log(`  ✗ 取页面失败 ${page.status}: ${JSON.stringify(page.body).slice(0, 200)}`);
    const db = await api(`/databases/${id}`);
    if (db.status === 200) {
      console.log(`  但它是个 DATABASE，属性：`);
      for (const [k, v] of Object.entries(db.body.properties ?? {})) console.log(`    ${k.padEnd(20)} ${v.type}`);
    }
    continue;
  }
  console.log(`  PAGE 标题：「${(page.body.properties?.title?.title ?? []).map((x) => x.plain_text).join('')}」  最后编辑 ${page.body.last_edited_time?.slice(0, 10)}`);

  const sink = [];
  await walk(id, 1, sink, label);

  const byType = {};
  for (const s of sink) byType[s.type] = (byType[s.type] ?? 0) + 1;
  console.log(`  容器 ${sink.length} 个  ${JSON.stringify(byType)}   (${apiCalls} 次请求)`);

  const datedBlocks = sink.filter((s) => s.dated.length);
  console.log(`  含真 @date mention 的块：${datedBlocks.length}`);
  for (const d of datedBlocks.slice(0, 6)) console.log(`    [${d.type}] ${d.title.slice(0, 40)}  ⟨@${d.dated.map((x) => x.date.start).join(', ')}⟩`);

  const dateNamedToggles = sink.filter((s) => !s.dated.length && DATE_RE.test(s.title));
  console.log(`  标题像日期的容器：${dateNamedToggles.length}`);
  for (const t of dateNamedToggles.slice(0, 40)) console.log(`    ${'  '.repeat(t.depth - 1)}[${t.type}] ${t.title}`);

  console.log(`  容器骨架（前 40 个）：`);
  for (const s of sink.slice(0, 40)) {
    console.log(`    ${'  '.repeat(s.depth - 1)}[${s.type}${s.kids ? '+' : ''}] ${s.title || '(无文字)'}`);
  }
}
