import {
  type MockBinaryOp,
  type MockNode,
  type MockRoot,
  type MockVarStorage,
  binary,
  commandRef,
  deleteVar,
  existsVar,
  fn,
  getVar,
  group,
  lit,
  loopVar,
  nid,
  setVar,
  ternary
} from './command-ast-mock.model';

const STARTS = ['%del(', '$(', '%(', '*(', '^(', '#('] as const;
const OPS: MockBinaryOp[] = ['==', '!=', '>=', '<=', '~=', '>', '<', '+', '-', '*', '/', '%'];

export interface ParseSourceResult {
  root: MockRoot;
  error?: string;
}

export function parseSource(input: string): ParseSourceResult {
  try {
    const children = parseSequence(input);
    return { root: { id: nid('root'), type: 'root', children } };
  } catch (err) {
    return {
      root: { id: nid('root'), type: 'root', children: [lit(input)] },
      error: err instanceof Error ? err.message : 'Could not read that command'
    };
  }
}

function parseSequence(input: string): MockNode[] {
  const nodes: MockNode[] = [];
  let i = 0;
  while (i < input.length) {
    const start = matchStart(input, i);
    if (start) {
      const parsed = parseStart(input, i, start);
      nodes.push(parsed.node);
      i = parsed.next;
      continue;
    }
    if (input[i] === '"' || input[i] === "'") {
      const end = skipQuote(input, i);
      nodes.push(lit(unquote(input.slice(i, end + 1))));
      i = end + 1;
      continue;
    }
    const nextStart = findStart(input, i);
    const text = input.slice(i, nextStart);
    const cut = nextQuote(text);
    if (cut >= 0) {
      const before = text.slice(0, cut);
      if (before) nodes.push(lit(before));
      i += cut;
      continue;
    }
    if (text) nodes.push(lit(text));
    i = nextStart;
  }
  return nodes.filter((node) => node.type !== 'literal' || node.value !== '');
}

function nextQuote(text: string): number {
  const d = text.indexOf('"');
  const s = text.indexOf("'");
  if (d < 0) return s;
  if (s < 0) return d;
  return Math.min(d, s);
}

function matchStart(input: string, index: number): (typeof STARTS)[number] | null {
  const slice = input.slice(index);
  for (const start of STARTS) {
    if (slice.startsWith(start)) return start;
  }
  return null;
}

function findStart(input: string, from: number): number {
  let best = input.length;
  for (const start of STARTS) {
    const at = input.indexOf(start, from);
    if (at >= 0 && at < best) best = at;
  }
  return best;
}

function parseStart(
  input: string,
  index: number,
  start: (typeof STARTS)[number]
): { node: MockNode; next: number } {
  const innerStart = index + start.length;
  const close = matchingParen(input, innerStart);
  const inner = input.slice(innerStart, close);
  const next = Math.min(close + 1, input.length);

  switch (start) {
    case '$(':
      return { node: parseFunctionInner(inner), next };
    case '%(':
      return { node: parseVarInner(inner), next };
    case '%del(':
      return { node: parseDeleteInner(inner), next };
    case '^(':
      return { node: parseExistsInner(inner), next };
    case '#(':
      return { node: parseCommandInner(inner), next };
    case '*(':
      return { node: parseComputeInner(inner), next };
  }
}

function matchingParen(input: string, from: number): number {
  let depth = 1;
  for (let i = from; i < input.length; i++) {
    if (input[i] === '"' || input[i] === "'") {
      i = skipQuote(input, i);
      continue;
    }
    const hit = matchStart(input, i);
    if (hit) {
      i += hit.length - 1;
      depth++;
      continue;
    }
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return input.length;
}

function parseFunctionInner(inner: string): MockNode {
  const trimmed = inner.trim();
  if (!trimmed) return fn('user');
  const [name, rest] = splitName(trimmed);
  return fn(name, rest ? parseArgs(rest) : []);
}

function parseCommandInner(inner: string): MockNode {
  const trimmed = inner.trim();
  const [name, rest] = splitName(trimmed || 'so');
  return commandRef(name, rest ? parseArgs(rest) : []);
}

function parseVarInner(inner: string): MockNode {
  const trimmed = inner.trim();
  const [raw, rest] = splitName(trimmed);
  const { name, storage } = parseStorage(raw);
  if (!rest) return getVar(name || 'var', storage);
  return setVar(name || 'var', parseOneOrGroup(rest), storage);
}

function parseDeleteInner(inner: string): MockNode {
  const { name, storage } = parseStorage(inner.trim());
  return deleteVar(name || 'var', storage);
}

function parseExistsInner(inner: string): MockNode {
  const { name, storage } = parseStorage(inner.trim());
  return existsVar(name || 'var', storage);
}

function parseComputeInner(inner: string): MockNode {
  const trimmed = inner.trim();
  const forNode = parseFor(trimmed);
  if (forNode) return forNode;
  return parseStar(trimmed);
}

function parseStar(input: string): MockNode {
  const trimmed = input.trim();
  if (!trimmed) return lit('');
  const q = splitTop(trimmed, '?');
  if (q) {
    const colon = splitTop(q.right, ':');
    return ternary(
      parseExpr(q.left),
      parseStar(colon?.left ?? q.right),
      colon ? parseStar(colon.right) : lit('')
    );
  }
  return parseExpr(trimmed);
}

function parseFor(inner: string): MockNode | null {
  const foreach = inner.match(/^for\s+#([A-Za-z_][\w]*)\s+in\s+([\s\S]+)\s*\{([\s\S]*)\}\s*$/i);
  if (foreach) {
    return {
      id: nid('for'),
      type: 'forLoop',
      loopVar: foreach[1],
      mode: 'foreach',
      init: null,
      condition: null,
      update: null,
      iterable: parseOneOrGroup(foreach[2].trim()),
      body: parseSequence(foreach[3].trim())
    };
  }
  const range = inner.match(/^for\s+([\s\S]+?);\s*([\s\S]+?);\s*([\s\S]+?)\s*\{([\s\S]*)\}\s*$/i);
  if (!range) return null;
  const initText = range[1].trim();
  const loopVarName = /^#([A-Za-z_][\w]*)/.exec(initText)?.[1] ?? 'i';
  return {
    id: nid('for'),
    type: 'forLoop',
    loopVar: loopVarName,
    mode: 'range',
    init: parseOneOrGroup(initText),
    condition: parseOneOrGroup(range[2].trim()),
    update: parseOneOrGroup(range[3].trim()),
    iterable: null,
    body: parseSequence(range[4].trim())
  };
}

function parseExpr(input: string): MockNode {
  const trimmed = input.trim();
  for (const op of OPS) {
    const parts = splitTop(trimmed, op);
    if (!parts) continue;
    if (!parts.left.trim() || !parts.right.trim()) continue;
    return binary(parseExpr(parts.left), op, parseExpr(parts.right));
  }
  return parsePrimary(trimmed);
}

function parsePrimary(input: string): MockNode {
  const trimmed = input.trim();
  if (!trimmed) return lit('');
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return lit(unquote(trimmed));
  }
  const start = matchStart(trimmed, 0);
  if (start) {
    const parsed = parseStart(trimmed, 0, start);
    if (parsed.next >= trimmed.length) return parsed.node;
    return parseOneOrGroup(trimmed);
  }
  if (/^#[A-Za-z_][\w]*$/.test(trimmed)) return loopVar(trimmed.slice(1));
  return lit(trimmed);
}

function parseArgs(input: string): MockNode[] {
  const out: MockNode[] = [];
  let i = 0;
  while (i < input.length) {
    while (input[i] === ' ') i++;
    if (i >= input.length) break;
    if (input[i] === '"' || input[i] === "'") {
      const end = skipQuote(input, i);
      out.push(lit(unquote(input.slice(i, end + 1))));
      i = end + 1;
      continue;
    }
    const start = matchStart(input, i);
    if (start) {
      const parsed = parseStart(input, i, start);
      out.push(parsed.node);
      i = parsed.next;
      continue;
    }
    if (input[i] === '#' && /[A-Za-z_]/.test(input[i + 1] ?? '')) {
      let j = i + 1;
      while (/[\w]/.test(input[j] ?? '')) j++;
      out.push(loopVar(input.slice(i + 1, j)));
      i = j;
      continue;
    }
    let j = i;
    while (j < input.length && input[j] !== ' ' && !matchStart(input, j) && input[j] !== '"' && input[j] !== "'") {
      j++;
    }
    const atom = input.slice(i, j);
    if (atom) out.push(lit(atom));
    i = j;
  }
  return out;
}

function parseOneOrGroup(input: string): MockNode {
  const nodes = parseSequence(input);
  if (nodes.length === 0) return lit('');
  if (nodes.length === 1) return nodes[0];
  return group(nodes);
}

function splitName(input: string): [string, string] {
  const m = /^([^\s]+)\s*([\s\S]*)$/.exec(input.trim());
  return [m?.[1] ?? '', (m?.[2] ?? '').trim()];
}

function parseStorage(raw: string): { name: string; storage: MockVarStorage } {
  if (raw.startsWith('**')) return { name: raw.slice(2), storage: 'dbUser' };
  if (raw.startsWith('*')) return { name: raw.slice(1), storage: 'db' };
  if (raw.startsWith('##')) return { name: raw.slice(2), storage: 'cacheUser' };
  if (raw.startsWith('#')) return { name: raw.slice(1), storage: 'cache' };
  return { name: raw, storage: 'memory' };
}

function splitTop(input: string, sep: string): { left: string; right: string } | null {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '"' || input[i] === "'") {
      i = skipQuote(input, i);
      continue;
    }
    const start = matchStart(input, i);
    if (start) {
      const close = matchingParen(input, i + start.length);
      i = close;
      continue;
    }
    const ch = input[i];
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && input.startsWith(sep, i)) {
      if (sep === '<' && input[i + 1] === '=') continue;
      if (sep === '>' && input[i + 1] === '=') continue;
      return { left: input.slice(0, i), right: input.slice(i + sep.length) };
    }
  }
  return null;
}

function skipQuote(input: string, i: number): number {
  const q = input[i];
  i++;
  while (i < input.length) {
    if (input[i] === '\\') {
      i += 2;
      continue;
    }
    if (input[i] === q) return i;
    i++;
  }
  return Math.max(i - 1, 0);
}

function unquote(raw: string): string {
  const q = raw[0];
  if ((q === '"' || q === "'") && raw.length >= 2 && raw.endsWith(q)) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return raw;
}
