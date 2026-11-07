/**
 * Turns a pasted list or an uploaded .txt/.csv file into roulette prizes.
 *
 * - List: names split by commas and/or new lines. Each name is one slot with weight 1;
 *   repeating a name adds another slot ("a, a, b" → a ×2, b ×1).
 * - Table (CSV): one prize per line as `name, weight, count`. Weight and count are
 *   optional whole numbers (default 1). An optional header row is skipped.
 */
export type ImportFormat = 'list' | 'table';
export interface ImportRow {
  label: string;
  weight: number;
  count: number;
}
export interface ImportResult {
  format: ImportFormat;
  rows: ImportRow[];
  /** Lines or names that could not be used (too long, bad numbers). */
  skipped: number;
  /** Total slots the rows add. */
  copies: number;
}

const MAX_LABEL = 120;
const MAX_COUNT = 10000;
const HEADER = /^(name|names|nombre|nombres|prize|prizes|premio|premios|label|item|items|option|opcion|opción|weight|peso|count|cantidad|copies|copias|slots|espacios|times|veces|qty)$/i;

/** Splits one CSV line on `sep`; supports "quoted, values" and "" escapes. */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && !cur.trim()) {
      cur = '';
      quoted = true;
    } else if (c === sep) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function lines(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim());
}

/** Commas first (what streamers type); Excel files in some regions use ";" or tabs. */
function separator(text: string): string {
  if (text.includes(',')) return ',';
  if (text.includes('\t')) return '\t';
  if (text.includes(';')) return ';';
  return ',';
}

const wholeOrBlank = (v: string) => v === '' || /^\d+$/.test(v);
const isHeader = (row: string[]) =>
  row.length >= 2 && row.some((c) => HEADER.test(c)) && !row.slice(1).some((c) => /^\d+$/.test(c));

/** Table only when every line looks like `name, number[, number]` (a header row is allowed). */
export function detectFormat(text: string): ImportFormat {
  const sep = separator(text);
  const rows = lines(text).map((l) => cells(l, sep));
  if (!rows.length) return 'list';
  const header = isHeader(rows[0]);
  const data = header ? rows.slice(1) : rows;
  if (header) return 'table';
  // A single line like "1, 2, 3" is far more likely a list of numbers than one CSV row.
  if (data.length < 2) return 'list';
  const tableLike =
    data.every((r) => r.length <= 3 && !!r[0] && r.slice(1).every(wholeOrBlank)) &&
    data.some((r) => r.slice(1).some((c) => c !== ''));
  return tableLike ? 'table' : 'list';
}

export function parseImport(text: string, format: ImportFormat = detectFormat(text)): ImportResult {
  const sep = separator(text);
  const merged = new Map<string, ImportRow>();
  let skipped = 0;
  const push = (label: string, weight: number, count: number) => {
    const key = `${weight}\u0000${label}`;
    const row = merged.get(key);
    if (row) row.count += count;
    else merged.set(key, { label, weight, count });
  };
  const rows = lines(text).map((l) => cells(l, sep));
  if (format === 'list') {
    for (const name of rows.flat()) {
      if (!name) continue;
      if (name.length > MAX_LABEL) skipped++;
      else push(name, 1, 1);
    }
  } else {
    for (const [i, row] of rows.entries()) {
      if (i === 0 && isHeader(row)) continue;
      const [label = '', w = '', c = ''] = row;
      const weight = w === '' ? 1 : /^\d+$/.test(w) ? Number(w) : NaN;
      const count = c === '' ? 1 : /^\d+$/.test(c) ? Number(c) : NaN;
      if (
        !label ||
        label.length > MAX_LABEL ||
        !Number.isSafeInteger(weight) ||
        weight < 1 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > MAX_COUNT
      )
        skipped++;
      else push(label, weight, count);
    }
  }
  const out = [...merged.values()];
  // The server allows at most 10000 copies per prize; repeated rows could exceed it.
  for (const row of out) if (row.count > MAX_COUNT) row.count = MAX_COUNT;
  return { format, rows: out, skipped, copies: out.reduce((n, r) => n + r.count, 0) };
}
