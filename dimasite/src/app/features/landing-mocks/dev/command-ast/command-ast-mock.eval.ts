import { SAMPLE_VALUES, catalogEntry, isActionFunction, levelLabel } from './command-ast-catalog';
import type { MockNode, MockRoot } from './command-ast-mock.model';

export type MockRole = 'viewer' | 'mod' | 'streamer';

export interface MockChatContext {
  user: string;
  argument: string;
  role: MockRole;
  count: number;
  title: string;
  game: string;
  viewers: number;
  channel: string;
  chatters: string[];
}

export const DEFAULT_MOCK_CONTEXT: MockChatContext = {
  user: 'PixelFan',
  argument: 'SomeMod',
  role: 'viewer',
  count: 17,
  title: 'Night coding',
  game: 'Just Chatting',
  viewers: 42,
  channel: 'cdom201',
  chatters: ['PixelFan', 'ModSnack', 'cdom201', 'ClipGoblin']
};

const ROLE_LEVEL: Record<MockRole, number> = { viewer: 1, mod: 7, streamer: 8 };

/** Something the command does besides talking (ban, TTS, poll, timer…). */
export interface MockAction {
  name: string;
  args: string;
  category: string;
  destructive: boolean;
  /** Why it would not run for this chatter (e.g. "Mods+"). */
  blocked: string | null;
}

export interface MockRunResult {
  /** The bot's chat reply ('' when the command only acts). */
  chat: string;
  /** Extra chat lines sent separately (chat.send, announce, referenced commands). */
  extraLines: string[];
  actions: MockAction[];
  /** Variables written during the run, for the "Remembered" list. */
  variables: { name: string; value: string }[];
}

interface RunState {
  ctx: MockChatContext;
  vars: Map<string, string>;
  loopVars: Map<string, string>;
  actions: MockAction[];
  extraLines: string[];
  steps: number;
}

const MAX_STEPS = 5000;
const MAX_LOOP = 25;

function asText(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(asText(value).trim());
  return Number.isFinite(n) ? n : fallback;
}

function truthy(value: unknown): boolean {
  const text = asText(value).trim().toLowerCase();
  return !(!text || text === '0' || text === 'false' || text === 'null');
}

function compare(op: string, left: string, right: string): boolean {
  const ln = Number(left);
  const rn = Number(right);
  const numeric = left.trim() !== '' && right.trim() !== '' && Number.isFinite(ln) && Number.isFinite(rn);
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return numeric ? ln > rn : left > right;
    case '<':
      return numeric ? ln < rn : left < right;
    case '>=':
      return numeric ? ln >= rn : left >= right;
    case '<=':
      return numeric ? ln <= rn : left <= right;
    case '~=':
      return left.toLowerCase() === right.toLowerCase();
    default:
      return false;
  }
}

function math(op: string, left: string, right: string): string {
  const ln = num(left);
  const rn = num(right);
  switch (op) {
    case '+':
      return String(ln + rn);
    case '-':
      return String(ln - rn);
    case '*':
      return String(ln * rn);
    case '/':
      return rn === 0 ? '0' : String(ln / rn);
    case '%':
      return rn === 0 ? '0' : String(ln % rn);
    default:
      return left;
  }
}

function varKey(node: { name: string; storage: string }): string {
  return `${node.storage}:${node.name}`;
}

function storageMark(storage: string): string {
  return { memory: '', cache: '#', cacheUser: '##', db: '*', dbUser: '**' }[storage] ?? '';
}

export function mockEvaluate(root: MockRoot, ctx: MockChatContext): MockRunResult {
  const state: RunState = {
    ctx,
    vars: new Map(),
    loopVars: new Map(),
    actions: [],
    extraLines: [],
    steps: 0
  };
  const chat = evalNode(root, state).replace(/\s{2,}/g, ' ').trim();
  const variables = [...state.vars.entries()].map(([key, value]) => {
    const [storage, name] = key.split(':');
    return { name: `${storageMark(storage)}${name}`, value };
  });
  return { chat, extraLines: state.extraLines, actions: state.actions, variables };
}

function evalNode(node: MockNode | null, s: RunState): string {
  if (!node) return '';
  s.steps += 1;
  if (s.steps > MAX_STEPS) throw new Error('This command runs too long. Check your loops.');
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'loopVar':
      return s.loopVars.get(node.name) ?? `#${node.name}`;
    case 'getVar': {
      const raw = s.vars.get(varKey(node)) ?? '';
      const acc = node.accessor;
      if (acc?.type === 'index' || acc?.type === 'random' || acc?.type === 'length') {
        const list = parseList(raw);
        if (acc.type === 'length') return String(list.length);
        if (acc.type === 'random') return list[Math.floor(Math.random() * list.length)] ?? '';
        const idx = num(evalNode(acc.index, s));
        return list[idx < 0 ? list.length + idx : idx] ?? '';
      }
      if (raw.startsWith('[')) return parseList(raw).join(', ');
      return raw;
    }
    case 'arrayLiteral':
      return JSON.stringify(node.items.map((item) => evalNode(item, s)));
    case 'exists':
      return s.vars.has(varKey(node)) ? 'true' : '';
    case 'deleteVar':
      s.vars.delete(varKey(node));
      return '';
    case 'setVar': {
      const value = evalNode(node.value, s);
      const key = varKey(node);
      if (node.accessor?.type === 'append' && node.value?.type !== 'arrayLiteral') {
        s.vars.set(key, JSON.stringify([...parseList(s.vars.get(key) ?? ''), value]));
      } else {
        s.vars.set(key, value);
      }
      return '';
    }
    case 'function':
      return evalFunction(node.name, node.args, s);
    case 'binary': {
      const left = evalNode(node.left, s);
      const right = evalNode(node.right, s);
      if (['+', '-', '*', '/', '%'].includes(node.operator)) return math(node.operator, left, right);
      return compare(node.operator, left, right) ? 'true' : '';
    }
    case 'ternary':
      return truthy(evalNode(node.test, s)) ? evalNode(node.consequent, s) : evalNode(node.alternate, s);
    case 'commandRef': {
      const args = node.args.map((arg) => evalNode(arg, s)).filter(Boolean);
      s.extraLines.push(`!${node.commandName}${args.length ? ' ' + args.join(' ') : ''}`);
      return '';
    }
    case 'forLoop':
      return evalLoop(node, s);
    case 'template':
      return node.parts.map((part) => evalNode(part, s)).join('');
    case 'group':
    case 'root':
      return evalList(node.children, s);
  }
}

function evalLoop(node: Extract<MockNode, { type: 'forLoop' }>, s: RunState): string {
  const out: string[] = [];
  if (node.mode === 'foreach') {
    const items = parseList(evalNode(node.iterable, s));
    for (const item of items.slice(0, MAX_LOOP)) {
      s.loopVars.set(node.loopVar, item);
      out.push(evalList(node.body, s));
    }
  } else {
    let i = node.init?.type === 'binary' ? num(evalNode(node.init.right, s)) : 0;
    let guard = 0;
    while (guard < MAX_LOOP) {
      s.loopVars.set(node.loopVar, String(i));
      if (node.condition && !truthy(evalNode(node.condition, s))) break;
      out.push(evalList(node.body, s));
      i += node.update?.type === 'binary' ? num(evalNode(node.update.right, s), 1) : 1;
      guard += 1;
    }
  }
  s.loopVars.delete(node.loopVar);
  return out.filter(Boolean).join(' ');
}

function evalList(nodes: MockNode[], s: RunState): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const part = evalNode(nodes[i], s);
    if (i === 0) {
      out = part;
      continue;
    }
    const prev = nodes[i - 1];
    if (prev.type === 'literal' || nodes[i].type === 'literal') out += part;
    else if (part) out += out.endsWith(' ') || part.startsWith(' ') ? part : ` ${part}`;
  }
  return out;
}

function parseList(raw: string): string[] {
  if (!raw.startsWith('[')) return raw ? [raw] : [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map((item) => asText(item)) : [raw];
  } catch {
    return [raw];
  }
}

function evalFunction(name: string, args: MockNode[], s: RunState): string {
  const { ctx } = s;
  const entry = catalogEntry(name);
  const canonical = entry?.name ?? name;

  // Timers keep their message unevaluated until they fire.
  if (canonical === 'timer') {
    const [seconds, ...rest] = args;
    record(s, canonical, `in ${evalNode(seconds ?? null, s) || '?'}s: ${rest.map((arg) => previewSource(arg)).join(' ')}`);
    return '';
  }

  const values = args.map((arg) => evalNode(arg, s));
  const joined = values.join(' ').trim();

  if (isActionFunction(canonical)) {
    const blocked = entry && entry.level > ROLE_LEVEL[ctx.role] ? levelLabel(entry.level) : null;
    if (!blocked && (canonical === 'chat.send' || canonical === 'announce')) s.extraLines.push(joined);
    record(s, canonical, joined, blocked);
    return '';
  }

  switch (canonical) {
    case 'user':
      return ctx.user;
    case 'touser':
      return values[0] || ctx.argument || ctx.user;
    case 'randomuser':
      return ctx.chatters[Math.floor(Math.random() * ctx.chatters.length)] ?? ctx.user;
    case 'count':
      return String(ctx.count + (values[0] ? num(values[0], 0) : 1));
    case 'scount':
      return String(ctx.count);
    case 'twitch.title':
      return ctx.title;
    case 'twitch.game':
      return ctx.game;
    case 'twitch.viewers':
      return String(ctx.viewers);
    case 'twitch.channel':
    case 'twitch.login':
      return ctx.channel;
    case 'random':
      return String(Math.floor(Math.random() * Math.max(1, num(values[0], 100))));
    case 'upper':
      return joined.toUpperCase();
    case 'lower':
      return joined.toLowerCase();
    case 'title':
      return joined.replace(/\b\w/g, (ch) => ch.toUpperCase());
    case 'capitalize':
      return joined.charAt(0).toUpperCase() + joined.slice(1);
    case 'trim':
      return joined.trim();
    case 'length':
      return String(joined.length);
    case 'slice': {
      const start = num(values[0]);
      const hasEnd = values.length > 2 && /^-?\d+$/.test(values[1] ?? '');
      const text = values.slice(hasEnd ? 2 : 1).join(' ');
      return hasEnd ? text.slice(start, num(values[1])) : text.slice(start);
    }
    case 'replace':
      return values.slice(2).join(' ').split(values[0] ?? '').join(values[1] ?? '');
    case 'ai':
      return `(AI reply to “${joined || 'hi'}”)`;
    default:
      if (SAMPLE_VALUES[canonical] !== undefined) return SAMPLE_VALUES[canonical];
      return `‹${canonical}›`;
  }
}

function record(s: RunState, name: string, args: string, blocked: string | null = null): void {
  const entry = catalogEntry(name);
  s.actions.push({
    name,
    args,
    category: entry?.category ?? 'flow',
    destructive: Boolean(entry?.destructive),
    blocked
  });
}

/** Short source-like rendering for timer payloads (they are not evaluated). */
function previewSource(node: MockNode): string {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'function':
      return `$(${node.name}${node.args.length ? ' ' + node.args.map(previewSource).join(' ') : ''})`;
    default:
      return '…';
  }
}
