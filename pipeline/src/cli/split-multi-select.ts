#!/usr/bin/env bun
/**
 * Split glued multi-select options into separate ones.
 *
 *   bun run pipeline/src/cli/split-multi-select.ts                # 试跑
 *   bun run pipeline/src/cli/split-multi-select.ts --write        # 真的改
 *   ... --property KIND                                           # 只处理一列
 *   ... --calendar COOF2022
 *
 * The problem: a cell can hold two values with no delimiter between them —
 * COOF2020's `cou.` produced "运动美国" (genre + country) and COOF2023's KIND
 * produced "冒险动作" (two genres). As single options they are unusable: nobody
 * filters by "冒险动作".
 *
 * ⚠️ The rule is FULL DECOMPOSITION, not suffix-peeling, and the difference
 * matters. Peeling a known value off the end would turn "中国大陆" into
 * 中国 + 大陆 and "北马其顿" into 北 + 马其顿 — both are single legitimate
 * countries, and both would be destroyed. A token is only split when it can be
 * decomposed ENTIRELY into two or more known values with nothing left over.
 *
 * ⚠️ Source is the column itself, not an upstream column. By the time this runs
 * the original sources may have been renamed away (`ca` → NAME holds film names
 * now), so re-deriving would read the wrong data — the same trap that corrupted
 * COOF2023 during the schema migration.
 */

import { CALENDAR_COLLECTIONS } from '@cevtuo/schema';
import { scrubError } from '@cevtuo/pipeline-core';

import { queryDatabaseAll, type NotionPage } from '../notion';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const WRITE = has('write');
const ONLY_CAL = arg('calendar');
const ONLY_PROP = arg('property');

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

/** Junk in the option lists — dropped, never a split part, never an atom. */
const JUNK = new Set(['nh', '犯规', '西班牙比利时']);

/**
 * Values that decompose cleanly but are single entities and must NOT be split.
 *
 * ⚠️ 捷克斯洛伐克 is the case that proves the rule needs an escape hatch: it
 * splits perfectly into 捷克 + 斯洛伐克, and doing so would be a factual error —
 * the films in this calendar were made in Czechoslovakia, one country, not in
 * two that did not exist yet. "Decomposes" is a necessary condition for a split,
 * never a sufficient one.
 */
const PROTECTED = new Set(['捷克斯洛伐克', '南斯拉夫', '苏联', '西德', '东德']);

async function multiSelectNames(databaseId: string, prop: string): Promise<string[]> {
  const res = await fetch(`${API}/databases/${databaseId}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as {
    properties: Record<string, { multi_select?: { options: Array<{ name: string }> } }>;
  };
  return (j.properties[prop]?.multi_select?.options ?? []).map((o) => o.name);
}

/**
 * Every way `t` splits into known values, or null if it cannot be fully covered.
 *
 * Memoised because the recursion revisits the same suffixes across hundreds of
 * tokens; without it this is exponential on long compound names.
 */
function decompose(t: string, vocab: Set<string>, memo = new Map<string, string[] | null>()): string[] | null {
  const cached = memo.get(t);
  if (cached !== undefined) return cached;

  let result: string[] | null = null;
  for (let i = 2; i < t.length; i++) {
    const head = t.slice(0, i);
    if (!vocab.has(head)) continue;
    const tail = t.slice(i);
    if (vocab.has(tail)) {
      result = [head, tail];
      break;
    }
    const rest = decompose(tail, vocab, memo);
    if (rest) {
      result = [head, ...rest];
      break;
    }
  }
  memo.set(t, result);
  return result;
}

/** The option list rebuilt as atoms; unchanged when nothing decomposes. */
function splitOptions(options: string[], vocab: Set<string>, pool: Set<string>): { options: string[]; changed: string[] } {
  const memo = new Map<string, string[] | null>();
  const out: string[] = [];
  const changed: string[] = [];
  for (const o of options) {
    if (JUNK.has(o)) continue; // dropped outright; it is not a genre or a country
    if (PROTECTED.has(o)) {
      out.push(o);
      continue;
    }
    // ⚠️ An option can carry a DELIMITER, not just a glued neighbour — "剧情.悬疑"
    // arrived as a single option because the upstream cell used a full stop where
    // every other row used "/". Left alone it becomes a genre nothing else
    // matches. Only atoms the vocabulary knows are kept from the split, so a
    // period that is genuinely part of a name survives.
    if (/[\/.;；、,，|]/.test(o)) {
      const parts = o
        .split(/[\/.;；、,，|]/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length > 1 && parts.every((x) => pool.has(x))) {
        out.push(...parts);
        changed.push(`${o} → ${parts.join(' + ')}`);
        continue;
      }
    }
    if (vocab.has(o) && !decompose(o, vocab, memo)) {
      out.push(o);
      continue;
    }
    const parts = decompose(o, vocab, memo);
    // ⚠️ Only split when it decomposes into 2+ atoms. A token the vocabulary does
    // not know at all is left alone rather than guessed at.
    if (parts && parts.length > 1) {
      out.push(...parts);
      changed.push(`${o} → ${parts.join(' + ')}`);
    } else {
      out.push(o);
    }
  }
  return { options: [...new Set(out)], changed };
}

// ─────────────────────────────────────────────────────────────

const cal = CALENDAR_COLLECTIONS.find((c) => c.key === (ONLY_CAL ?? 'COOF2026'));
if (!cal) {
  console.error(`✗ 找不到 ${ONLY_CAL}`);
  process.exit(1);
}

const props = (ONLY_PROP ? [ONLY_PROP] : ['KIND', 'COUNTRY']).filter((p) => p);
console.log(`\n═══ 拆分粘连选项 ═══`);
console.log(`  词表来源: ${cal.key}   模式: ${WRITE ? '⚠️  写入' : '试跑'}\n`);

// ⚠️ One vocabulary for both columns. A genre sitting in the COUNTRY list (and
// six of them do — 传记 运动 动作 历史 奇幻 冒险) must be recognised as a genre,
// or "运动美国" would split into two "countries".
const kinds = await multiSelectNames(cal.databaseId, 'KIND');
const countries = await multiSelectNames(cal.databaseId, 'COUNTRY');
const GENRES = new Set([...kinds, '真人秀', '灾难', '武侠', '演讲', '一代'].filter((x) => !JUNK.has(x)));
const COUNTRIES = new Set(countries.filter((c) => !GENRES.has(c) && c.length >= 2));
const VOCAB = new Set([...GENRES, ...COUNTRIES]);

for (const prop of props) {
  const vocab = prop === 'KIND' ? GENRES : COUNTRIES;
  const pool = new Set([...vocab, ...(prop === 'KIND' ? COUNTRIES : GENRES)]);
  console.log(`  ▸ ${prop}  (词表 ${pool.size})`);

  for (const target of CALENDAR_COLLECTIONS) {
    if (ONLY_CAL && target.key !== ONLY_CAL) continue;
    const rows: NotionPage[] = await queryDatabaseAll(target.databaseId);
    const before = new Set<string>();
    for (const r of rows) {
      for (const o of (r.properties?.[prop]?.multi_select ?? []) as Array<{ name: string }>) before.add(o.name);
    }
    const { options, changed } = splitOptions([...before], pool, pool);
    console.log(`    · ${target.key}: ${before.size} 个选项 → ${options.length}${changed.length ? `  (${changed.length} 个被拆)` : ''}`);
    for (const c of changed.slice(0, 6)) console.log(`        ${c}`);
    if (changed.length > 6) console.log(`        … 另有 ${changed.length - 6} 个`);

    if (!WRITE || !changed.length) continue;

    // Update the option list, then rewrite only the rows that carried a glued one.
    const res = await fetch(`${API}/databases/${target.databaseId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: { [prop]: { multi_select: { options: options.map((name) => ({ name })) } } },
      }),
    });
    if (!res.ok) {
      console.log(`      ✗ 更新选项失败 HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      continue;
    }

    const splitMap = new Map<string, string[]>();
    for (const c of changed) {
      const [from, to] = c.split(' → ');
      if (from && to) splitMap.set(from, to.split(' + '));
    }
    let rowsFixed = 0;
    for (const r of rows) {
      const cur = ((r.properties?.[prop]?.multi_select ?? []) as Array<{ name: string }>).map((o) => o.name);
      const next = [...new Set(cur.flatMap((n) => splitMap.get(n) ?? [n]))];
      if (next.length === cur.length) continue;
      try {
        const pr = await fetch(`${API}/pages/${r.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ properties: { [prop]: { multi_select: next.map((name) => ({ name })) } } }),
        });
        if (!pr.ok) throw new Error(`HTTP ${pr.status}`);
        rowsFixed++;
      } catch (e) {
        console.log(`      ✗ 行 ${r.id.slice(0, 8)} — ${scrubError(e).message}`);
      }
      await new Promise((res2) => setTimeout(res2, 350));
    }
    console.log(`      ✓ 改写 ${rowsFixed} 行`);
  }
}
console.log();
