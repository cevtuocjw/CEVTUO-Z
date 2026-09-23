#!/usr/bin/env bun
/**
 * Audit the real shape of every COOF calendar, with sample cell values.
 *
 *   bun run scripts/coof-schema-audit.ts
 *
 * ⚠️ Why this exists rather than reading the schema alone.
 *
 * Unifying the calendars onto COOF2026's schema means deciding, for every old
 * column, which 2026 column it becomes. The property NAMES and TYPES are not
 * enough to decide that: several columns are named misleadingly and one holds
 * two fields at once. Concretely, from the pipeline's own verified notes:
 *
 *   · COOF2020's title-typed property is `cou.` and holds "剧情/英国" — genre
 *     and country jammed together — while the real film name sits in `film`.
 *   · COOF2023's title-typed property is `num ` and holds a SEQUENCE NUMBER
 *     ("145"), while the real name sits in the lowercase `name` rich_text.
 *
 * A migration driven by property types alone would therefore overwrite real
 * titles with sequence numbers and genre strings. This prints actual values so
 * the mapping is decided from evidence.
 *
 * Read-only. Makes no changes to anything.
 */

import { CALENDAR_COLLECTIONS } from '@cevtuo/schema';
import { queryDatabaseAll, type NotionProperty } from '../pipeline/src/notion';

const SAMPLE_ROWS = 3;

/** One readable line for a property value, whatever its type. */
function describe(p: NotionProperty | undefined): string {
  if (!p) return '—';
  const v = p as unknown as Record<string, any>;
  switch (p.type) {
    case 'title':
      return (v.title ?? []).map((r: any) => r.plain_text).join('') || '(空)';
    case 'rich_text':
      return (v.rich_text ?? []).map((r: any) => r.plain_text).join('') || '(空)';
    case 'number':
      return v.number === null || v.number === undefined ? '(空)' : String(v.number);
    case 'select':
      return v.select?.name ?? '(空)';
    case 'multi_select':
      return (v.multi_select ?? []).map((o: any) => o.name).join(' / ') || '(空)';
    case 'date':
      return v.date?.start ?? '(空)';
    case 'files': {
      const files = v.files ?? [];
      return files.length ? `<${files.length} 个文件>` : '(空)';
    }
    default:
      return `(${p.type})`;
  }
}

const token = process.env.NOTION_TOKEN?.trim();
if (!token) {
  console.error('✗ 需要 NOTION_TOKEN');
  process.exit(1);
}

for (const col of CALENDAR_COLLECTIONS) {
  const rows = await queryDatabaseAll(col.databaseId);
  console.log(`\n═══ ${col.key} — ${rows.length} 行 ═══`);

  // Property order/types come from the first row that has them; Notion returns
  // every property on every page, so one row is enough for the shape.
  const shape = new Map<string, string>();
  for (const row of rows) {
    for (const [name, prop] of Object.entries(row.properties ?? {})) {
      if (!shape.has(name)) shape.set(name, prop.type);
    }
  }

  for (const [name, type] of shape) {
    const samples: string[] = [];
    for (const row of rows) {
      if (samples.length >= SAMPLE_ROWS) break;
      const d = describe(row.properties?.[name] as NotionProperty | undefined);
      if (d !== '(空)' && d !== '—') samples.push(d);
    }
    const named = /[^\x00-\x7F]/.test(name) ? `「${name}」` : name;
    console.log(`  ${named.padEnd(22)} [${type.padEnd(12)}] ${samples.join('  |  ') || '(全空)'}`);
  }
}
console.log();
