/**
 * Turns a pasted list or an uploaded .txt/.csv file into roulette prizes, and the
 * current prizes back into a CSV for spreadsheet editing.
 *
 * - List: names split by commas and/or new lines. Each name is one slot with weight 1;
 *   repeating a name adds another slot ("a, a, b" → a ×2, b ×1).
 * - Table (CSV): one prize per line as `name, weight, count[, action]`. Weight and count
 *   are optional whole numbers (default 1). A header row maps columns by name (English
 *   or Spanish) and may list them in any order. Each line stays its own prize.
 */
export type ImportFormat = 'list' | 'table';
export type ImportSeparator = ',' | ';' | '\t';
export interface ImportRow {
  label: string;
  weight: number;
  count: number;
  /** Present when the file has an action column; '' means "no command" for this prize. */
  action?: string;
  /** 1-based line where the row (or, in a list, the name's first use) starts. */
  line: number;
}
export type IssueReason = 'name' | 'long' | 'weight' | 'count' | 'action';
export interface ImportIssue {
  line: number;
  reason: IssueReason;
  text: string;
}
export interface ImportResult {
  format: ImportFormat;
  separator: ImportSeparator;
  rows: ImportRow[];
  issues: ImportIssue[];
  /** Total slots the rows add. */
  copies: number;
  /** The file has an action column. */
  hasActionColumn: boolean;
  /** Line of a quote mark that was never closed; quotes were then read as plain text. */
  unclosedQuote: number | null;
  /** Lines with values past the last known column (ignored), and the first such line. */
  extraCells: { count: number; line: number } | null;
}

export const MAX_LABEL = 120;
export const MAX_COUNT = 10000;
export const MAX_ACTION = 8000;
export const MAX_ROWS = 10000;
const SEPARATORS: ImportSeparator[] = [',', ';', '\t'];

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
const COLUMNS = {
  label: /^(name|names|nombre|nombres|prize|prizes|premio|premios|label|item|items|option|options|opcion|opciones|reward|rewards|recompensa|recompensas)$/,
  weight: /^(weight|weights|peso|pesos|odds|chance|probabilidad)$/,
  count: /^(count|counts|cantidad|cantidades|copies|copias|slots|espacios|times|veces|qty|quantity|multiplier|multiplicador)$/,
  action: /^(action|actions|accion|acciones|command|commands|comando|comandos|cmd)$/,
};
type Column = keyof typeof COLUMNS;

interface Record {
  cells: string[];
  line: number;
}

/**
 * RFC 4180 records: quoted fields may hold separators, new lines and "" escapes.
 * Lenient: a quote that does not start a field is plain text. Blank lines are dropped.
 */
function records(text: string, sep: string, quotes = true): { records: Record[]; unclosed: number | null } {
  const out: Record[] = [];
  let cells: string[] = [];
  let cur = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let start = 1;
  let quoteLine = 0;
  const endCell = () => {
    cells.push(wasQuoted ? cur : cur.trim());
    cur = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim())) out.push({ cells, line: start });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        cur += c;
      }
    } else if (quotes && c === '"' && !cur.trim() && !wasQuoted) {
      cur = '';
      quoted = true;
      wasQuoted = true;
      quoteLine = line;
    } else if (c === sep) endCell();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else cur += c;
  }
  if (quoted) return { records: records(text, sep, false).records, unclosed: quoteLine };
  endRecord();
  return { records: out, unclosed: null };
}

const whole = (v: string) => /^\d+$/.test(v);
const wholeOrBlank = (v: string) => v === '' || whole(v);

function headerMap(cells: string[]): Partial<{ [K in Column]: number }> | null {
  if (cells.length < 2 || cells.slice(1).some((c) => whole(c.trim()))) return null;
  const map: Partial<{ [K in Column]: number }> = {};
  cells.forEach((cell, i) => {
    const name = fold(cell);
    for (const col of Object.keys(COLUMNS) as Column[])
      if (map[col] === undefined && COLUMNS[col].test(name)) {
        map[col] = i;
        break;
      }
  });
  // A name column alone could be data ("Premio, grande"); a header names a number or command column too.
  if (map.weight === undefined && map.count === undefined && map.action === undefined) return null;
  if (map.label === undefined) {
    const used = new Set(Object.values(map));
    const free = cells.findIndex((_, i) => !used.has(i));
    if (free < 0) return null;
    map.label = free;
  }
  return map;
}

function looksLikeTable(rows: Record[]): boolean {
  if (!rows.length) return false;
  if (headerMap(rows[0].cells)) return true;
  // A single line like "1, 2, 3" is far more likely a list of numbers than one CSV row.
  if (rows.length < 2) return false;
  return (
    rows.every((r) => r.cells.length <= 4 && !!r.cells[0] && r.cells.slice(1, 3).every((c) => wholeOrBlank(c.trim()))) &&
    rows.some((r) => r.cells.slice(1, 3).some((c) => c.trim() !== ''))
  );
}

/** Separator for forced table mode: the one used most outside quotes on the first line. */
function mostUsed(text: string): ImportSeparator {
  const first = text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? '';
  const outside = first.replace(/"(?:[^"]|"")*"/g, '');
  let best: ImportSeparator = ',';
  for (const sep of SEPARATORS) if (outside.split(sep).length > outside.split(best).length) best = sep;
  return best;
}

function strip(text: string): string {
  return text.replace(/^﻿/, '');
}

/** Table when some separator gives `name, number[, number]` rows (or a known header). */
export function detectFormat(text: string): ImportFormat {
  const clean = strip(text);
  return SEPARATORS.some((sep) => looksLikeTable(records(clean, sep).records)) ? 'table' : 'list';
}

/** Undo the export's spreadsheet-formula guard ('=…, '+…, '-…, '@…) and nothing else. */
const unguard = (cell: string) => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell);

export function parseImport(text: string, format: ImportFormat = detectFormat(text)): ImportResult {
  const clean = strip(text);
  const issues: ImportIssue[] = [];
  const rows: ImportRow[] = [];
  const issue = (line: number, reason: IssueReason, value: string) =>
    issues.push({ line, reason, text: value.length > 60 ? `${value.slice(0, 57)}…` : value });

  if (format === 'list') {
    const parsed = records(clean, ',');
    const byLabel = new Map<string, ImportRow>();
    for (const rec of parsed.records)
      for (const raw of rec.cells) {
        const label = raw.trim();
        if (!label) continue;
        if (label.length > MAX_LABEL) {
          issue(rec.line, 'long', label);
          continue;
        }
        const row = byLabel.get(label);
        if (row) row.count++;
        else {
          const created = { label, weight: 1, count: 1, line: rec.line };
          byLabel.set(label, created);
          rows.push(created);
        }
      }
    for (const row of rows) if (row.count > MAX_COUNT) issue(row.line, 'count', `${row.label} ×${row.count}`);
    const usable = rows.filter((r) => r.count <= MAX_COUNT);
    return {
      format,
      separator: ',',
      rows: usable,
      issues,
      copies: usable.reduce((n, r) => n + r.count, 0),
      hasActionColumn: false,
      unclosedQuote: parsed.unclosed,
      extraCells: null,
    };
  }

  const separator =
    SEPARATORS.find((sep) => looksLikeTable(records(clean, sep).records)) ?? mostUsed(clean);
  const parsed = records(clean, separator);
  const header = parsed.records.length ? headerMap(parsed.records[0].cells) : null;
  const cols = header ?? { label: 0, weight: 1, count: 2, action: 3 };
  const hasActionColumn =
    cols.action !== undefined && (header !== null || parsed.records.some((r) => r.cells.length > 3));
  // Values past the header (or past the 4th column) would be silently dropped; say so.
  const width = header ? parsed.records[0].cells.length : 4;
  let extraCount = 0;
  let extraLine = 0;
  for (const rec of header ? parsed.records.slice(1) : parsed.records) {
    if (rec.cells.slice(width).some((c) => c.trim()) && !extraCount++) extraLine = rec.line;
    const cell = (col: Column) => {
      const i = cols[col];
      return i === undefined ? '' : unguard((rec.cells[i] ?? '').trim());
    };
    const label = cell('label');
    const w = cell('weight');
    const c = cell('count');
    const action = hasActionColumn ? cell('action') : '';
    const weight = w === '' ? 1 : whole(w) ? Number(w) : NaN;
    const count = c === '' ? 1 : whole(c) ? Number(c) : NaN;
    if (!label) issue(rec.line, 'name', rec.cells.join(separator === '\t' ? ' ' : separator));
    else if (label.length > MAX_LABEL) issue(rec.line, 'long', label);
    else if (!Number.isSafeInteger(weight) || weight < 1) issue(rec.line, 'weight', `${label}: ${w}`);
    else if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) issue(rec.line, 'count', `${label}: ${c}`);
    else if (action.length > MAX_ACTION) issue(rec.line, 'action', label);
    else rows.push({ label, weight, count, line: rec.line, ...(hasActionColumn ? { action } : {}) });
  }
  return {
    format,
    separator,
    rows,
    issues,
    copies: rows.reduce((n, r) => n + r.count, 0),
    hasActionColumn,
    unclosedQuote: parsed.unclosed,
    extraCells: extraCount ? { count: extraCount, line: extraLine } : null,
  };
}

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
export type FileProblem = 'spreadsheet' | 'binary' | 'encoding';
export class ImportFileError extends Error {
  readonly reason: FileProblem;
  constructor(reason: FileProblem) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Reads file bytes as text. BOMs pick UTF-8/UTF-16; otherwise strict UTF-8, falling back
 * to Windows-1252, which is what Excel in Spanish uses for "CSV" without UTF-8.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    throw new ImportFileError('spreadsheet');
  const decode = (encoding: TextEncodingName, fatal = true) => {
    try {
      return new TextDecoder(encoding, { fatal }).decode(bytes);
    } catch {
      return null;
    }
  };
  let encoding: TextEncodingName;
  let text: string | null;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    text = decode(encoding);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    text = decode(encoding);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    text = decode(encoding);
  } else {
    encoding = 'utf-8';
    text = decode(encoding);
    if (text === null) {
      encoding = 'windows-1252';
      text = decode(encoding, false);
    }
  }
  if (text === null) throw new ImportFileError('encoding');
  if (text.includes('\u0000')) throw new ImportFileError('binary');
  return { text, encoding };
}

/** Spreadsheet apps run cells that start with these as formulas. */
const guard = (cell: string) => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell);
const quote = (cell: string) => (/[",;\t\r\n]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** CSV that parseImport reads back unchanged (pass through decodeText or prefix a BOM for Excel). */
export function toCsv(items: { label: string; weight: number; multiplier: number; action?: string }[]): string {
  const withAction = items.some((i) => i.action?.trim());
  const head = ['name', 'weight', 'count', ...(withAction ? ['action'] : [])];
  const lines = items.map((i) =>
    [quote(guard(i.label)), String(i.weight), String(i.multiplier), ...(withAction ? [quote(guard(i.action?.trim() ?? ''))] : [])].join(','),
  );
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

export type RowStatus = 'new' | 'joins' | 'sameName' | 'weightClash' | 'actionClash';
export interface PlannedRow {
  row: ImportRow;
  status: RowStatus;
  /** For 'joins': the file line it joins, or null when it joins a prize already on the roulette. */
  joinsLine: number | null;
  /** For clashes: what the existing prize has. */
  existingWeight: number | null;
  /** Chance (0–1) of the prize this row ends up in, after the import. */
  chance: number;
}
export interface ImportPlan {
  rows: PlannedRow[];
  /** Slots on the roulette after the import. */
  slots: number;
  clashes: number;
  /** Prizes the replace removes, and how many of them run a command. */
  removed: number;
  removedCommands: number;
}
interface PlanItem {
  label: string;
  weight: number;
  multiplier: number;
  action?: string;
}

/**
 * Mirrors the server's import rules (dimabot roulette/model.ts importItems) to preview
 * the result: 'increase' joins same names and refuses a different weight or command;
 * 'separate' always adds a new prize.
 */
export function planImport(
  rows: ImportRow[],
  items: PlanItem[],
  duplicate: 'separate' | 'increase',
  replace: boolean,
): ImportPlan {
  interface Entry {
    label: string;
    weight: number;
    multiplier: number;
    action: string;
    line: number | null;
  }
  const entries: Entry[] = replace
    ? []
    : items.map((i) => ({ label: i.label, weight: i.weight, multiplier: i.multiplier, action: i.action ?? '', line: null }));
  const existing = new Set(entries.map((e) => e.label));
  // Like the server: an existing duplicate label joins its first prize.
  const byLabel = duplicate === 'increase' ? new Map<string, Entry>() : null;
  if (byLabel) for (const e of entries) if (!byLabel.has(e.label)) byLabel.set(e.label, e);
  const planned: { row: ImportRow; status: RowStatus; joinsLine: number | null; existingWeight: number | null; entry: Entry | null }[] = [];
  for (const row of rows) {
    const found = byLabel?.get(row.label);
    if (found && found.weight !== row.weight) {
      planned.push({ row, status: 'weightClash', joinsLine: found.line, existingWeight: found.weight, entry: null });
      continue;
    }
    if (found && row.action !== undefined && found.action !== row.action) {
      planned.push({ row, status: 'actionClash', joinsLine: found.line, existingWeight: null, entry: null });
      continue;
    }
    if (found) {
      found.multiplier += row.count;
      planned.push({ row, status: 'joins', joinsLine: found.line, existingWeight: null, entry: found });
      continue;
    }
    const entry: Entry = { label: row.label, weight: row.weight, multiplier: row.count, action: row.action ?? '', line: row.line };
    entries.push(entry);
    byLabel?.set(row.label, entry);
    planned.push({ row, status: existing.has(row.label) ? 'sameName' : 'new', joinsLine: null, existingWeight: null, entry });
  }
  const total = entries.reduce((n, e) => n + e.weight * e.multiplier, 0);
  return {
    rows: planned.map(({ entry, ...p }) => ({ ...p, chance: entry && total ? (entry.weight * entry.multiplier) / total : 0 })),
    slots: entries.reduce((n, e) => n + e.multiplier, 0),
    clashes: planned.filter((p) => p.status === 'weightClash' || p.status === 'actionClash').length,
    removed: replace ? items.length : 0,
    removedCommands: replace ? items.filter((i) => i.action?.trim()).length : 0,
  };
}
