#!/usr/bin/env bun
/**
 * Unify every COOF calendar onto COOF2026's schema.
 *
 *   bun run pipeline/src/cli/migrate-calendars.ts                        # 试跑，全量
 *   bun run pipeline/src/cli/migrate-calendars.ts --calendar COOF2024    # 只做一年
 *   bun run pipeline/src/cli/migrate-calendars.ts --write                # 真的改
 *   ... --drop-old                                                       # 最后删掉旧列
 *
 * ⚠️ Why this is driven by a snapshot taken BEFORE any schema change.
 *
 * Several columns have to move between properties (`name` → the title slot,
 * `ca` → KIND, `cou.` → KIND + COUNTRY). Doing that naively — rename, then read
 * the live row — breaks as soon as two properties normalise to the same key:
 * creating `YEAR` beside COOF2022's existing `year` gives two columns that both
 * match `normKey('year')`, and the reader can no longer tell which one it had.
 * So every row is copied once up front and all values are computed from that
 * copy. Schema changes then cannot perturb the reads.
 *
 * ⚠️ Value extraction delegates to the SAME helpers the pipeline uses
 * (`firstText` / `firstInt` / `firstDate` / `firstList` from normalize.ts).
 * Re-implementing them here is how the two would drift apart, and a drift would
 * mean the app and the migration disagree about what a column means.
 *
 * ⚠️ Ordering of the three phases matters and is not interchangeable:
 *   1. schema — create and rename, so every target column exists under its
 *      final name and type
 *   2. rows   — write the values, now that the names they target are final
 *   3. drop   — remove the superseded columns; this is the only irreversible
 *      step, which is why it sits behind its own flag
 */

import { CALENDAR_COLLECTIONS } from '@cevtuo/schema';
import { scrubError, withRetry } from '@cevtuo/pipeline-core';

import { queryDatabaseAll, type NotionPage, type NotionProperty } from '../notion';
import { firstDate, firstInt, firstList, firstText } from '../sources/coof/normalize';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const WRITE = has('write');
const DROP_OLD = has('drop-old');
const ONLY = arg('calendar');

const token = process.env.NOTION_TOKEN?.trim();
if (!token) {
  console.error('✗ 需要 NOTION_TOKEN');
  process.exit(1);
}
const headers = {
  Authorization: `Bearer ${token}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

type Scalar = 'number' | 'text' | 'multi' | 'date';

/** Property name → type, for deciding which schema ops are already applied. */
async function databaseProperties(databaseId: string): Promise<Record<string, { type: string }>> {
  const res = await fetch(`${API}/databases/${databaseId}`, { headers });
  if (!res.ok) throw new Error(`读取数据库结构失败 HTTP ${res.status}`);
  const j = (await res.json()) as { properties: Record<string, { type: string }> };
  return j.properties;
}

interface TargetCol {
  name: string;
  kind: Scalar;
  /**
   * The ORIGINAL column names this value is sourced from.
   *
   * ⚠️ Load-bearing on a re-run. Every other lookup here goes through `normKey`,
   * which is case- and punctuation-insensitive — correct for reading live
   * calendars, but on a second pass it silently re-resolves the spec's source
   * names against columns that have since MOVED. Measured: COOF2023's spec says
   * FILM comes from `other`; once `other` was renamed to FILM and `from` renamed
   * to OTHER, the string "other" resolved to the NEW OTHER column and wrote
   * Netflix over the real FILM — while TIME/LONG/`from` resolved to nothing,
   * returned null, and CLEARED Date, time and OTHER. 145 rows, silently.
   * This list is matched by EXACT name so that cannot happen again.
   */
  sources: string[];
  /** Value taken from the pre-migration snapshot. */
  read: (p: Record<string, NotionProperty>) => string | number | string[] | null;
}

interface SchemaOp {
  op: 'rename' | 'create';
  from?: string;
  name: string;
  type?: 'number' | 'rich_text' | 'date' | 'multi_select';
}

interface Spec {
  /** Applied in order, before any row write. */
  schema: SchemaOp[];
  /** The 2026 column set, and where each value comes from. POSTER is excluded —
   *  `notion-posters.ts` owns that column and this tool must not touch it. */
  cols: TargetCol[];
  /** Superseded columns, removed in phase 3. */
  drop: string[];
}

const TEXT = (p: Record<string, NotionProperty>, ...n: string[]) => firstText(p, ...n) || null;
const INT = (p: Record<string, NotionProperty>, ...n: string[]) => firstInt(p, ...n);
const DATE = (p: Record<string, NotionProperty>, ...n: string[]) => firstDate(p, ...n);
const LIST = (p: Record<string, NotionProperty>, ...n: string[]) => firstList(p, ...n);

/**
 * Controlled vocabularies read from COOF2026 at startup.
 *
 * ⚠️ COOF2026's own COUNTRY options are contaminated — 传记 / 运动 / 动作 /
 * 历史 / 奇幻 / 冒险 sit in the country list, plus one glued pair
 * ("西班牙比利时"). They are removed by intersecting with KIND, or the splitter
 * below would file a genre as a country and re-create the same mess in the new
 * columns.
 */
let GENRE_VOCAB = new Set<string>();
let COUNTRY_VOCAB = new Set<string>();

/**
 * Countries and genres that the vocabulary does not carry but the data uses.
 *
 * Measured on COOF2020's 729 `cou.` tokens: 435 matched a genre, 277 a country,
 * 2 were glued, and 15 were these. Left unaliased they would land in KIND as
 * junk options (`中大陆`, `:剧情`, `美国—`) that nobody would ever clean up.
 */
const COUNTRY_ALIASES = ['阿联酋', '中国', '中大陆', '哥伦比亚'];
const GENRE_ALIASES = ['真人秀', '灾难', '武侠', '演讲', '一代'];

/**
 * Split COOF2020's `cou.` into genres and countries.
 *
 * ⚠️ That one cell holds BOTH fields, delimited by `/` and by parentheses, and
 * — on two rows — with no delimiter at all ("运动美国" is 运动 + 美国). Reading
 * it as a single genre list is what put "运动美国" in front of the user as an
 * option in the first place, so the trailing country is peeled off by matching
 * against the country vocabulary.
 */
export function splitCou(raw: string): { genres: string[]; countries: string[] } {
  const genres: string[] = [];
  const countries: string[] = [];
  // Parentheses are field separators here, not decoration: "犯罪（瑞典 / 丹麦）".
  for (const part of raw.replace(/[（）()]/g, '/').split(/[\/、,，]/)) {
    // ⚠️ Strip leading/trailing noise before matching: the real data contains
    // "美国—", ":剧情" and "惊悚9美国". Without this they match nothing and
    // become brand-new junk options.
    const t = part.trim().replace(/^[:：\-—\s]+|[\-—\s]+$/g, '').replace(/\d+$/, '').trim();
    if (!t) continue;
    if (GENRE_VOCAB.has(t)) { genres.push(t); continue; }
    if (COUNTRY_VOCAB.has(t) || COUNTRY_ALIASES.includes(t)) { countries.push(t); continue; }
    // Glued: a known country as a suffix with a genre in front of it.
    const hit = [...COUNTRY_VOCAB]
      .filter((c) => t.length > c.length && t.endsWith(c))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) {
      // ⚠️ Digits survive in the head ("惊悚9美国"): the strip above ran on the
      // whole token, where the country — not a digit — was the last character.
      const head = t.slice(0, -hit.length).replace(/\d+$/, '').trim();
      if (head) genres.push(head);
      countries.push(hit);
      continue;
    }
    // Unclassified: `cou.` is the category column, so a bare unknown is far more
    // likely a genre the vocabulary happens not to carry (真人秀, 武侠) than a
    // country. Only a handful of rows are affected.
    genres.push(t);
  }
  return { genres: [...new Set(genres)], countries: [...new Set(countries)] };
}

/** The 2026 columns, parameterised by which source column each one reads. */
function cols2026(src: {
  NAME: string[];
  NUM: string[];
  Date: string[];
  YEAR: string[];
  FILM: string[];
  time: string[];
  COUNTRY: string[] | ((p: Record<string, NotionProperty>) => string[]);
  KIND: string[] | ((p: Record<string, NotionProperty>) => string[]);
  OTHER: string[];
}, labelSrc: { COUNTRY: string[]; KIND: string[] }): TargetCol[] {
  // COUNTRY/KIND may be functions, in which case `src` carries no names to gate
  // on — the caller states them explicitly here.
  const labels = (k: 'COUNTRY' | 'KIND') => labelSrc[k];

  return [
    { name: 'NAME', kind: 'text', sources: src.NAME, read: (p) => TEXT(p, ...src.NAME) },
    { name: 'NUM', kind: 'number', sources: src.NUM, read: (p) => INT(p, ...src.NUM) },
    { name: 'Date', kind: 'date', sources: src.Date, read: (p) => DATE(p, ...src.Date) },
    { name: 'YEAR', kind: 'text', sources: src.YEAR, read: (p) => TEXT(p, ...src.YEAR) },
    { name: 'FILM', kind: 'text', sources: src.FILM, read: (p) => TEXT(p, ...src.FILM) },
    { name: 'time', kind: 'text', sources: src.time, read: (p) => TEXT(p, ...src.time) },
    { name: 'COUNTRY', kind: 'multi', sources: labels('COUNTRY'), read: (p) => (typeof src.COUNTRY === 'function' ? src.COUNTRY(p) : LIST(p, ...src.COUNTRY)) },
    { name: 'KIND', kind: 'multi', sources: labels('KIND'), read: (p) => (typeof src.KIND === 'function' ? src.KIND(p) : LIST(p, ...src.KIND)) },
    { name: 'OTHER', kind: 'text', sources: src.OTHER, read: (p) => TEXT(p, ...src.OTHER) },
  ];
}

const SPECS: Record<string, Spec> = {
  // ⚠️ 2025 needs nothing — measured identical to 2026, same 10 names and types.
  // Deliberately absent rather than present-and-empty, so a future edit has to
  // add it consciously instead of inheriting a no-op.

  // Only the order column differs: same type, so a rename carries every value.
  COOF2024: {
    schema: [{ op: 'rename', from: 'NUMBER', name: 'NUM' }],
    cols: [],
    drop: [],
  },

  COOF2023: {
    schema: [
      { op: 'create', name: 'NUM', type: 'number' },
      { op: 'rename', from: 'TIME', name: 'Date' },
      { op: 'rename', from: 'year', name: 'YEAR' },
      { op: 'rename', from: 'other', name: 'FILM' }, // holds 影/剧
      { op: 'rename', from: 'LONG', name: 'time' }, // runtime
      { op: 'rename', from: 'from', name: 'OTHER' }, // Netflix / Marvel
      // `KIND` exists but as rich_text; the name must be freed before a
      // multi_select column can take it.
      { op: 'rename', from: 'KIND', name: 'KIND__old' },
      { op: 'create', name: 'KIND', type: 'multi_select' },
      { op: 'create', name: 'COUNTRY', type: 'multi_select' },
      // ⚠️ Last: this is the title property itself, currently `num ` holding a
      // SEQUENCE NUMBER ("145"). Its values must be copied into NUM first —
      // which phase 2 does — or renaming it to NAME would publish row numbers
      // as film titles.
      { op: 'rename', from: 'num ', name: 'NAME' },
    ],
    cols: cols2026({
      NAME: ['name'],
      NUM: ['num '],
      Date: ['TIME'],
      YEAR: ['year'],
      FILM: ['other'],
      time: ['LONG'],
      COUNTRY: ['country'],
      // ⚠️ `KIND__old` is the fallback for a re-run: the first pass renamed the
      // original rich_text KIND out of the way, so on a second pass the genres
      // are only in the renamed column.
      KIND: ['KIND', 'KIND__old'],
      OTHER: ['from'],
    }, { COUNTRY: ['country'], KIND: ['KIND', 'KIND__old'] }),
    drop: ['name', 'KIND__old', 'country'],
  },

  COOF2022: {
    schema: [
      { op: 'rename', from: 'date', name: 'Date' },
      { op: 'rename', from: 'num', name: 'NUM' },
      { op: 'rename', from: 'attributes', name: 'OTHER' },
      { op: 'rename', from: 'length', name: 'time' },
      // `year` is a number here and YEAR is rich_text — a type change cannot be
      // a rename, so the new column is created beside it and the old is dropped.
      { op: 'create', name: 'YEAR', type: 'rich_text' },
      { op: 'create', name: 'COUNTRY', type: 'multi_select' },
      { op: 'create', name: 'KIND', type: 'multi_select' },
      { op: 'create', name: 'FILM', type: 'rich_text' },
      { op: 'rename', from: 'ca', name: 'NAME' },
    ],
    cols: cols2026({
      NAME: ['name'],
      NUM: ['num'],
      Date: ['date'],
      YEAR: ['year'],
      // ⚠️ `kind` is a SELECT holding "影" — that is FILM's meaning, not KIND's.
      FILM: ['kind'],
      time: ['length'],
      COUNTRY: ['country'],
      // ⚠️ The genres are in `ca` — the TITLE-typed column — not in `kind`.
      KIND: ['ca'],
      OTHER: ['attributes'],
    }, { COUNTRY: ['country'], KIND: ['ca'] }),
    drop: ['name', 'kind', 'country', 'year'],
  },

  COOF2021: {
    schema: [
      { op: 'rename', from: 'time', name: 'Date' },
      { op: 'rename', from: 'year', name: 'YEAR' },
      // Free only because the line above moved `time` out of the way.
      { op: 'rename', from: 'length', name: 'time' },
      { op: 'rename', from: 'cou', name: 'NUM' },
      { op: 'create', name: 'COUNTRY', type: 'multi_select' },
      { op: 'create', name: 'KIND', type: 'multi_select' },
      { op: 'create', name: 'FILM', type: 'rich_text' },
      { op: 'rename', from: 'ca', name: 'NAME' },
    ],
    cols: cols2026({
      NAME: ['name'],
      NUM: ['cou'],
      Date: ['time'],
      YEAR: ['year'],
      FILM: ['tim'], // "影"
      time: ['length'],
      COUNTRY: ['country'],
      KIND: ['ca'],
      OTHER: [], // 2021 has no source column for this
    }, { COUNTRY: ['country'], KIND: ['ca'] }),
    drop: ['name', 'tim', 'country'],
  },

  COOF2020: {
    schema: [
      { op: 'rename', from: 'year', name: 'YEAR' },
      { op: 'rename', from: 'n+A2:H161um.', name: 'NUM' },
      // `w` is rich_text holding "2020.5.4"; Date is a real date property, so
      // this is a type change, not a rename.
      { op: 'create', name: 'Date', type: 'date' },
      { op: 'create', name: 'KIND', type: 'multi_select' },
      { op: 'create', name: 'COUNTRY', type: 'multi_select' },
      { op: 'create', name: 'OTHER', type: 'rich_text' },
      // ⚠️ Title-typed, but it holds "剧情/英国" — genre and country jammed into
      // one cell — while the film name sits in `film`. Phase 2 overwrites this
      // with the real titles; the genre/country halves are read from the
      // snapshot above before that happens.
      { op: 'rename', from: 'cou.', name: 'NAME' },
    ],
    cols: cols2026({
      NAME: ['film'],
      NUM: ['n+A2:H161um.'],
      Date: ['w'],
      YEAR: ['year'],
      FILM: [],
      time: ['time'], // already correct — name and type both
      // ⚠️ Both halves come out of `cou.`, which holds "剧情/英国" — and on two
      // rows "运动美国" with no separator at all. The splitter peels the country
      // off the end using the vocabulary; a plain `/` split would file
      // "运动美国" as a genre option, which is precisely the complaint.
      COUNTRY: (p) => splitCou(TEXT(p, 'cou') ?? '').countries,
      KIND: (p) => splitCou(TEXT(p, 'cou') ?? '').genres,
      OTHER: ['link'], // "Douban"
    }, { COUNTRY: ['cou'], KIND: ['cou'] }),
    drop: ['film', 'w', 'link'],
  },
};

// ─────────────────────────────────────────────────────────────
// Value formatting
// ─────────────────────────────────────────────────────────────

/** The Notion write payload for one target column. */
function payloadFor(col: TargetCol, value: string | number | string[] | null): unknown {
  switch (col.kind) {
    case 'number':
      return { number: typeof value === 'number' ? value : null };
    case 'multi':
      return { multi_select: (Array.isArray(value) ? value : []).map((name) => ({ name })) };
    case 'date':
      // `{date: null}` clears the cell; a missing start is not a valid date.
      return { date: value ? { start: String(value) } : null };
    case 'text':
      return { rich_text: value ? [{ text: { content: String(value) } }] : [] };
  }
}

/** The title column needs `title`, not `rich_text`, in its payload. */
function titlePayload(value: string | null): unknown {
  return { title: value ? [{ text: { content: value } }] : [] };
}

/** Current value of a property, formatted the same way the readers return it. */
function currentValue(p: NotionProperty | undefined, kind: Scalar): string | number | string[] | null {
  if (!p) return null;
  if (kind === 'number') return firstInt({ x: p }, 'x');
  if (kind === 'multi') return firstList({ x: p }, 'x');
  if (kind === 'date') return firstDate({ x: p }, 'x');
  return firstText({ x: p }, 'x') || null;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return (a ?? null) === (b ?? null);
}

// ─────────────────────────────────────────────────────────────

const targets = ONLY
  ? CALENDAR_COLLECTIONS.filter((c) => c.key.toUpperCase() === ONLY.toUpperCase())
  : CALENDAR_COLLECTIONS;

console.log(`\n═══ COOF 列结构统一 ═══`);
console.log(`  模式: ${WRITE ? '⚠️  写入 Notion' : '试跑'}`);
console.log(`  删旧列: ${DROP_OLD ? '⚠️  开' : '关'}\n`);

// Load the controlled vocabularies from COOF2026 — the schema everything else is
// being unified onto, so it is the only defensible source for "what is a genre".
{
  const ref = CALENDAR_COLLECTIONS.find((c) => c.key === 'COOF2026');
  if (!ref) throw new Error('找不到 COOF2026，无法建立词表');
  const res = await fetch(`${API}/databases/${ref.databaseId}`, { headers });
  if (!res.ok) throw new Error(`读取 COOF2026 词表失败 HTTP ${res.status}`);
  const j = (await res.json()) as {
    properties: Record<string, { multi_select?: { options: Array<{ name: string }> } }>;
  };
  const kind = (j.properties.KIND?.multi_select?.options ?? []).map((o) => o.name);
  const country = (j.properties.COUNTRY?.multi_select?.options ?? []).map((o) => o.name);
  GENRE_VOCAB = new Set([...kind, ...GENRE_ALIASES]);
  // ⚠️ Intersect away anything that is really a genre. COOF2026's COUNTRY list
  // carries 传记 / 运动 / 动作 / 历史 / 奇幻 / 冒险 — borrowing it wholesale would
  // make the splitter file genres as countries, i.e. rebuild the exact
  // contamination it exists to remove.
  COUNTRY_VOCAB = new Set(country.filter((c) => !GENRE_VOCAB.has(c) && c.length >= 2));
  console.log(`  词表: 类型 ${GENRE_VOCAB.size}, 国家 ${COUNTRY_VOCAB.size} (剔除 ${
    country.filter((c) => GENRE_VOCAB.has(c)).join(',') || '无'
  })\n`);
}

for (const col of targets) {
  const spec = SPECS[col.key];
  if (!spec) {
    console.log(`  · ${col.key}: 已与 2026 一致，跳过\n`);
    continue;
  }

  console.log(`  ▸ ${col.key}`);

  // ⚠️ Snapshot first. Every value below is read from this copy, so the schema
  // edits cannot change what a source column is understood to mean.
  const snapshot: NotionPage[] = await queryDatabaseAll(col.databaseId);

  // ⚠️ Skip ops that are already applied. This is what makes it safe to run the
  // migration in two passes — once without `--drop-old` to verify the copied
  // values, then again to remove the superseded columns — instead of forcing the
  // irreversible drop into the same run as the copy. Re-applying a rename whose
  // source no longer exists would 400 and, worse, a naive `create` would put a
  // second `NUM`-like column beside the first.
  const liveNames = new Set(Object.keys(await databaseProperties(col.databaseId)));
  // ⚠️ Simulated SEQUENTIALLY, not filtered against a frozen snapshot. COOF2023
  // renames `KIND` → `KIND__old` and then creates a new `KIND` in the same batch;
  // judging that create against the starting state sees `KIND` already present
  // and skips it, leaving the genres stranded in `KIND__old` with no error
  // anywhere — the row write then compares the new column (which does not exist)
  // against the old one and finds them equal, so it skips too. Tracking the name
  // set as the batch runs is what makes "this rename frees that name" visible.
  const applied: SchemaOp[] = [];
  for (const op of spec.schema) {
    if (op.op === 'create') {
      if (liveNames.has(op.name)) continue;
      liveNames.add(op.name);
      applied.push(op);
      continue;
    }
    const from = op.from as string;
    if (!liveNames.has(from)) continue; // source gone: already applied
    if (liveNames.has(op.name)) continue; // target taken: would collide
    liveNames.delete(from);
    liveNames.add(op.name);
    applied.push(op);
  }

  console.log(`    阶段 1 — schema (${spec.schema.length} 项${applied.length < spec.schema.length ? `，${spec.schema.length - applied.length} 项已应用` : ''})`);
  for (const op of spec.schema) {
    const label = op.op === 'rename' ? `${op.from} → ${op.name}` : `新建 ${op.name} [${op.type}]`;
    if (!WRITE) {
      console.log(`      · ${label}${applied.includes(op) ? '' : '  (已应用)'}`);
      continue;
    }
    if (!applied.includes(op)) continue;
    const body =
      op.op === 'rename'
        ? { properties: { [op.from as string]: { name: op.name } } }
        : { properties: { [op.name]: { [op.type as string]: {} } } };
    await withRetry(
      async () => {
        const res = await fetch(`${API}/databases/${col.databaseId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
      },
      { attempts: 3, baseDelayMs: 1200, jitterMs: 600, label: `schema ${label}` },
    ).catch((e) => console.log(`      ✗ ${label} — ${scrubError(e).message}`));
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!spec.cols.length) {
    console.log(`    阶段 2 — 逐行：无需改写（值随改名保留）\n`);
    continue;
  }

  console.log(`    阶段 2 — 逐行写值 (${snapshot.length} 行)`);
  if (!WRITE) {
    const sample = spec.cols.map((c) => c.name);
    const row =
      snapshot.find((r) => spec.cols.some((c) => {
        const v = c.read(r.properties ?? {});
        return Array.isArray(v) ? v.length > 0 : v !== null && v !== '';
      })) ?? snapshot[0];
    if (row) {
      const p = row.properties ?? {};
      console.log(`      样例改动：`);
      for (const c of spec.cols) {
        const want = c.read(p);
        const have = currentValue(p[c.name], c.kind);
        const tag = same(want, have) ? '=' : '✎';
        console.log(`        ${tag} ${c.name.padEnd(9)} ${JSON.stringify(have ?? null)} → ${JSON.stringify(want ?? null)}`);
      }
    }
    void sample;
    console.log(`      (试跑：未写任何行)\n`);
    continue;
  }

  let changed = 0;
  let rowFailures = 0;
  for (const [i, row] of snapshot.entries()) {
    const p = row.properties ?? {};
    const props: Record<string, unknown> = {};
    for (const c of spec.cols) {
      // ⚠️ Exact-name gate: if none of the original source columns survive, this
      // column has already been migrated. Re-deriving it would read whatever now
      // occupies a similarly-named column — see the note on TargetCol.sources.
      if (!c.sources.some((n) => n in p)) continue;
      const want = c.read(p);
      const have = currentValue(p[c.name], c.kind);
      if (same(want, have)) continue;
      props[c.name] = c.name === 'NAME' ? titlePayload(want as string | null) : payloadFor(c, want);
    }
    if (!Object.keys(props).length) continue;

    try {
      await withRetry(
        async () => {
          const res = await fetch(`${API}/pages/${row.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ properties: props }),
          });
          if (res.status === 429) throw new Error('rate limited');
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
        },
        { attempts: 3, baseDelayMs: 1000, jitterMs: 500, label: `row ${row.id.slice(0, 8)}` },
      );
      changed++;
    } catch (e) {
      rowFailures++;
      if (rowFailures <= 3) console.log(`      ✗ 行 ${i + 1} — ${scrubError(e).message}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`      改写 ${changed} 行, 失败 ${rowFailures}`);

  // ── Phase 3 ────────────────────────────────────────────────
  if (spec.drop.length) {
    console.log(`    阶段 3 — 删旧列 (${spec.drop.join(', ')})`);
    if (!DROP_OLD) {
      console.log(`      · 未加 --drop-old，保留\n`);
      continue;
    }
    if (!WRITE) {
      console.log(`      (试跑：不删)\n`);
      continue;
    }
    // ⚠️ Never drop a superseded column while rows are still holding only the
    // old value. The drop is the one irreversible step here, and a row that
    // failed to copy would lose its data with no way back.
    if (rowFailures > 0) {
      console.log(`      ✗ 有 ${rowFailures} 行写入失败 — 拒绝删列\n`);
      continue;
    }
    for (const name of spec.drop) {
      await withRetry(
        async () => {
          const res = await fetch(`${API}/databases/${col.databaseId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ properties: { [name]: null } }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
        },
        { attempts: 3, baseDelayMs: 1200, jitterMs: 600, label: `drop ${name}` },
      ).catch((e) => console.log(`      ✗ 删 ${name} — ${scrubError(e).message}`));
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log('');
  }
}

console.log(`\n  完成。\n`);
