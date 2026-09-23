/**
 * Read-only reconnaissance of the four CNSR sources.
 *
 *   bun scripts/cnsr-recon.mjs
 *
 * ⚠️ READ ONLY. Nothing here writes to Notion.
 *
 * The pages are about to be restructured into year → month → day toggle trees,
 * and this project has already destroyed 145 rows once by editing a live
 * workspace before understanding its shape (see HANDOFF). So: resolve each id,
 * print what it actually is, and only then decide what the migration writes.
 *
 * The four ids come from the URLs the user supplied. A Notion URL's last
 * hyphen-segment is the object id whether the object is a page or a database,
 * and the SAME id resolves differently depending on which — so ask for both
 * rather than assuming.
 */

const TOKEN = process.env.NOTION_TOKEN;
const VERSION = '2022-06-28';

const SOURCES = [
  ['Shopping', '3dff24c4e01f496d86b5a7fb5b3b133b'],
  ['Learn', 'd6d5f4924b904e8c94ff4ab1a27c1af3'],
  ['tech-learn', '045f87789ebd4741a0059c898a9089d4'],
  ['TECH-AI', 'fc17863a1b8543c6ad0288dc80e3bb22'],
];

async function api(path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const titleOf = (obj) => {
  const t = obj.object === 'database' ? obj.title : obj.properties?.title?.title ?? obj.properties?.Name?.title;
  return (t ?? []).map((x) => x.plain_text).join('') || '(untitled)';
};

/** Every block type in a subtree, with a text preview and its children. */
async function walk(blockId, depth = 0, acc = { types: {}, samples: [], toggles: 0, maxDepth: 0, blocks: 0 }) {
  let cursor = null;
  do {
    const { body } = await api(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    if (!body.results) return acc;
    for (const b of body.results) {
      acc.blocks += 1;
      acc.types[b.type] = (acc.types[b.type] ?? 0) + 1;
      acc.maxDepth = Math.max(acc.maxDepth, depth);
      // ⚠️ Not every block keeps its text in a rich-text array. `child_page` and
      // `child_database` carry a plain string in `.title`, so `rich.map` throws
      // on exactly the blocks that matter most here — a page whose whole content
      // is nested databases is invisible if the walk dies on the first one.
      const raw = b[b.type]?.rich_text ?? b[b.type]?.title ?? [];
      const rich = Array.isArray(raw) ? raw : [{ plain_text: String(raw) }];
      const text = rich.map((r) => r.plain_text).join('');
      const mentions = rich.filter((r) => r.type === 'mention').map((r) => `${r.mention?.type}:${r.mention?.date?.start ?? r.mention?.page?.id ?? ''}`);
      if (acc.samples.length < 26 && text.trim()) acc.samples.push({ d: depth, type: b.type, text: text.slice(0, 78), mentions, hasChildren: b.has_children });
      if (b.type === 'toggle' || (b.has_children && (b.type === 'paragraph' || b.type === 'heading_1' || b.type === 'heading_2'))) acc.toggles += 1;
      if (b.has_children && depth < 5) await walk(b.id, depth + 1, acc);
    }
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);
  return acc;
}

for (const [label, id] of SOURCES) {
  console.log(`\n${'═'.repeat(78)}\n${label}   ${id}\n${'═'.repeat(78)}`);

  const asPage = await api(`/pages/${id}`);
  const asDb = asPage.status === 200 ? null : await api(`/databases/${id}`);
  const meta = asPage.status === 200 ? asPage.body : asDb?.body;

  if (!meta) {
    console.log(`  ✗ 两种解析都失败`);
    console.log(`    page → ${asPage.status} ${JSON.stringify(asPage.body).slice(0, 160)}`);
    console.log(`    db   → ${asDb?.status} ${JSON.stringify(asDb?.body).slice(0, 160)}`);
    continue;
  }

  if (asPage.status === 200) {
    console.log(`  类型：PAGE  标题：${titleOf(meta)}  最后编辑：${meta.last_edited_time?.slice(0, 10)}`);
    console.log(`  parent：${meta.parent?.type} ${meta.parent?.database_id ?? meta.parent?.page_id ?? ''}`);
    if (meta.url) console.log(`  url：${meta.url}`);
    if (meta.properties) {
      const keys = Object.entries(meta.properties).filter(([, v]) => v.type !== 'title');
      if (keys.length) console.log(`  属性：${keys.map(([k, v]) => `${k}[${v.type}]`).join('  ')}`);
      const dateProp = keys.find(([, v]) => v.type === 'date');
      if (dateProp) console.log(`  日期属性 ${dateProp[0]} = ${JSON.stringify(meta.properties[dateProp[0]].date)}`);
    }
    const tree = await walk(id);
    console.log(`  子块 ${tree.blocks} 个，最大深度 ${tree.maxDepth + 1}，含子块的块 ${tree.toggles} 个`);
    console.log(`  块类型：${JSON.stringify(tree.types)}`);
    console.log(`  样本：`);
    for (const s of tree.samples) {
      console.log(`    ${'  '.repeat(s.d)}[${s.type}${s.hasChildren ? '+' : ''}] ${s.text}${s.mentions.length ? `   ⟨${s.mentions.join(',')}⟩` : ''}`);
    }
  } else {
    const props = meta.properties ?? {};
    console.log(`  类型：DATABASE  标题：${titleOf(meta)}`);
    console.log(`  属性：`);
    for (const [k, v] of Object.entries(props)) {
      const opts = v[v.type]?.options?.map((o) => o.name).slice(0, 8);
      console.log(`    ${k.padEnd(18)} ${String(v.type).padEnd(14)} ${opts ? `options: ${opts.join(' / ')}` : ''}`);
    }
    const q = await api(`/databases/${id}/query`, { method: 'POST', body: JSON.stringify({ page_size: 4 }) });
    console.log(`  行数（首页）: ${q.body.results?.length ?? 0}  has_more=${q.body.has_more}`);
    for (const r of q.body.results ?? []) {
      const flat = Object.entries(r.properties)
        .map(([k, v]) => {
          const val =
            v[v.type]?.plain_text ?? v[v.type]?.name ?? v[v.type]?.start ?? v[v.type]?.number ?? (Array.isArray(v[v.type]) ? v[v.type].map((o) => o.name).join('|') : JSON.stringify(v[v.type]));
          return `${k}=${String(val).slice(0, 34)}`;
        })
        .join('  ');
      console.log(`    · ${flat.slice(0, 260)}`);
      console.log(`      子块：${r.has_children ? '有' : '无'}`);
    }
  }
}
