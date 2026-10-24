import { SAMPLE_VALUES, catalogEntry, isActionFunction } from './blocks.catalog';
import { type AnyNode, type BlockNode, type ForLoopNode, type LoopAssignNode, STORAGE_MARK, type VarStorage } from './blocks.model';

/**
 * Local "Try it" runner. It follows the bot's rules where they shape the reply
 * (plain text is copied as typed, loops only act, quoted text joins its parts)
 * and uses sample values for anything that needs Twitch or the database.
 * Nothing is sent anywhere.
 */
export type PreviewRole = 'viewer' | 'mod' | 'streamer';

export interface PreviewContext {
  user: string;
  argument: string;
  role: PreviewRole;
  count: number;
  title: string;
  game: string;
  viewers: number;
  channel: string;
  chatters: string[];
}

export const DEFAULT_PREVIEW_CONTEXT: PreviewContext = {
  user: 'PixelFan',
  argument: 'SomeMod',
  role: 'viewer',
  count: 17,
  title: 'Night coding',
  game: 'Just Chatting',
  viewers: 42,
  channel: 'yourchannel',
  chatters: ['PixelFan', 'ModSnack', 'ClipGoblin']
};

/** The bot runs every function of a saved command as the streamer; only the command's own "who can use it" gates it. */
export const ROLE_LEVEL: Record<PreviewRole, number> = { viewer: 1, mod: 7, streamer: 10 };

export interface PreviewAction {
  name: string;
  args: string;
  destructive: boolean;
}

export interface PreviewResult {
  chat: string;
  extraLines: string[];
  actions: PreviewAction[];
  variables: { name: string; value: string }[];
  /** Advanced pieces are kept as text and not previewed. */
  skippedAdvanced: number;
  /** The chosen role is below the command's "who can use it": nothing runs. */
  notAllowed: boolean;
}

const MAX_STEPS = 5000;
const MAX_LOOP = 25;

interface RunState {
  ctx: PreviewContext;
  vars: Map<string, string>;
  loopVars: Map<string, string>;
  actions: PreviewAction[];
  extraLines: string[];
  steps: number;
  skipped: number;
}

export class PreviewTooLong extends Error {}

export function runPreview(root: AnyNode, ctx: PreviewContext, commandLevel: number | null = null): PreviewResult {
  if (commandLevel !== null && ROLE_LEVEL[ctx.role] < commandLevel) {
    return { chat: '', extraLines: [], actions: [], variables: [], skippedAdvanced: 0, notAllowed: true };
  }
  const state: RunState = { ctx, vars: new Map(), loopVars: new Map(), actions: [], extraLines: [], steps: 0, skipped: 0 };
  const children = root.type === 'root' ? root.children : [root];
  const chat = children.map((node) => evalNode(node, state)).join('').trim();
  const variables = [...state.vars.entries()].map(([key, value]) => {
    const [storage, name] = key.split(':');
    return { name: `${STORAGE_MARK[storage as VarStorage] ?? ''}${name}`, value };
  });
  return { chat, extraLines: state.extraLines, actions: state.actions, variables, skippedAdvanced: state.skipped, notAllowed: false };
}

const text = (value: unknown) => (value == null ? '' : String(value));
const num = (value: unknown, fallback = 0) => {
  const n = Number(text(value).trim());
  return Number.isFinite(n) ? n : fallback;
};
const truthy = (value: unknown) => {
  const t = text(value).trim().toLowerCase();
  return !(!t || t === '0' || t === 'false' || t === 'null');
};

function compare(op: string, left: string, right: string): boolean {
  const ln = Number(left);
  const rn = Number(right);
  const numeric = left.trim() !== '' && right.trim() !== '' && Number.isFinite(ln) && Number.isFinite(rn);
  switch (op) {
    case '==':
    case '=':
      return numeric ? ln === rn : left === right;
    case '!=':
    case '<>':
      return numeric ? ln !== rn : left !== right;
    case '>': return numeric ? ln > rn : left > right;
    case '<': return numeric ? ln < rn : left < right;
    case '>=': return numeric ? ln >= rn : left >= right;
    case '<=': return numeric ? ln <= rn : left <= right;
    case '~=': return left.toLowerCase() === right.toLowerCase();
    default: return false;
  }
}

function math(op: string, left: string, right: string): string {
  const ln = num(left);
  const rn = num(right);
  switch (op) {
    case '+': return String(ln + rn);
    case '-': return String(ln - rn);
    case '*': return String(ln * rn);
    case '/': return rn === 0 ? '0' : String(ln / rn);
    case '%': return rn === 0 ? '0' : String(ln % rn);
    default: return left;
  }
}

/** The bot swaps `&p1`, `&p2`… for words typed after the command and `&t` for the rest. */
function withArguments(value: string, argument: string): string {
  if (!value.includes('&')) return value;
  const words = argument.trim() ? argument.trim().split(/\s+/) : [];
  let used = 0;
  return value.replace(/&p(\d+)|&t\b/g, (match, index: string | undefined) => {
    if (match === '&t') return words.slice(used).join(' ');
    const position = Number(index);
    used = Math.max(used, position);
    return words[position - 1] ?? '';
  });
}

const varKey = (node: { name: string; storage: string }) => `${node.storage}:${node.name}`;

function parseList(raw: string): string[] {
  if (!raw.startsWith('[')) return raw ? [raw] : [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map(text) : [raw];
  } catch {
    return [raw];
  }
}

function evalNode(node: BlockNode | null | undefined, s: RunState): string {
  if (!node) return '';
  s.steps += 1;
  if (s.steps > MAX_STEPS) throw new PreviewTooLong();
  switch (node.type) {
    case 'literal':
      return withArguments(node.value, s.ctx.argument);
    case 'raw':
      s.skipped += 1;
      return '';
    case 'loopVar':
      return s.loopVars.get(node.name) ?? `#${node.name}`;
    case 'loopAssign':
      applyLoopAssign(node, s);
      return '';
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
      return raw.startsWith('[') ? parseList(raw).join(', ') : raw;
    }
    case 'arrayLiteral': {
      const items = node.items.map((item) => evalNode(item, s));
      const acc = node.accessor;
      if (acc?.type === 'length') return String(items.length);
      if (acc?.type === 'random') return items[Math.floor(Math.random() * items.length)] ?? '';
      if (acc?.type === 'index') return items[num(evalNode(acc.index, s))] ?? '';
      return JSON.stringify(items);
    }
    case 'exists':
      return s.vars.has(varKey(node)) ? 'true' : '';
    case 'deleteVar':
      s.vars.delete(varKey(node));
      return '';
    case 'setVar': {
      const value = evalNode(node.value, s);
      const key = varKey(node);
      if (node.accessor?.type === 'append') {
        const added = node.value?.type === 'arrayLiteral' ? parseList(value) : [value];
        s.vars.set(key, JSON.stringify([...parseList(s.vars.get(key) ?? ''), ...added]));
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
    case 'unary':
      return String(node.operator === '-' ? -num(evalNode(node.argument, s)) : num(evalNode(node.argument, s)));
    case 'ternary':
      return truthy(evalNode(node.test, s)) ? evalNode(node.consequent, s) : evalNode(node.alternate, s);
    case 'commandRef': {
      const args = node.args.map((arg) => evalNode(arg, s)).filter(Boolean);
      s.extraLines.push(`!${node.commandName}${args.length ? ' ' + args.join(' ') : ''}`);
      return '';
    }
    case 'forLoop':
      runLoop(node, s);
      return '';
    case 'template':
    case 'group':
      return (node.type === 'template' ? node.parts : node.children).map((part) => evalNode(part, s)).join('');
  }
}

function applyLoopAssign(node: LoopAssignNode, s: RunState): void {
  const current = num(s.loopVars.get(node.name));
  const value = num(evalNode(node.value ?? null, s));
  const next: Record<string, number> = {
    '=': value, '+=': current + value, '-=': current - value, '*=': current * value,
    '/=': value === 0 ? 0 : current / value, '%=': value === 0 ? 0 : current % value, '++': current + 1, '--': current - 1
  };
  s.loopVars.set(node.name, String(next[node.operator] ?? current));
}

/** Loops only act (send messages, change variables); their own text is not part of the reply. */
function runLoop(node: ForLoopNode, s: RunState): void {
  const saved = s.loopVars.get(node.loopVar);
  if (node.mode === 'foreach') {
    for (const item of parseList(evalNode(node.iterable, s)).slice(0, MAX_LOOP)) {
      s.loopVars.set(node.loopVar, item);
      node.body.forEach((child) => evalNode(child, s));
    }
  } else {
    s.loopVars.set(node.loopVar, '0');
    evalNode(node.init, s);
    for (let guard = 0; guard < MAX_LOOP; guard++) {
      if (node.condition && !truthy(evalNode(node.condition, s))) break;
      node.body.forEach((child) => evalNode(child, s));
      evalNode(node.update, s);
    }
  }
  if (saved === undefined) s.loopVars.delete(node.loopVar);
  else s.loopVars.set(node.loopVar, saved);
}

function evalFunction(name: string, args: BlockNode[], s: RunState): string {
  const { ctx } = s;
  const entry = catalogEntry(name);
  const canonical = entry?.name ?? name;

  if (canonical === 'timer') {
    const [seconds] = args;
    record(s, canonical, `${evalNode(seconds ?? null, s) || '?'}s`);
    return '';
  }

  const values = args.map((arg) => evalNode(arg, s));
  const joined = values.join(' ').trim();

  if (isActionFunction(canonical)) {
    if (canonical === 'chat.send' || canonical === 'announce') s.extraLines.push(joined);
    record(s, canonical, joined);
    return '';
  }

  switch (canonical) {
    case 'user': return ctx.user;
    case 'touser': return values[0] || ctx.argument || ctx.user;
    case 'randomuser': return ctx.chatters[Math.floor(Math.random() * ctx.chatters.length)] ?? ctx.user;
    case 'count': return String(ctx.count + (values[0] ? num(values[0], 0) : 1));
    case 'scount': return String(ctx.count);
    case 'twitch.title': return ctx.title;
    case 'twitch.game': return ctx.game;
    case 'twitch.viewers': return String(ctx.viewers);
    case 'twitch.channel':
    case 'twitch.login': return ctx.channel;
    case 'random': return String(Math.floor(Math.random() * Math.max(1, num(values[0], 100))));
    case 'upper': return joined.toUpperCase();
    case 'lower': return joined.toLowerCase();
    case 'title': return joined.replace(/\b\w/g, (ch) => ch.toUpperCase());
    case 'capitalize': return joined.charAt(0).toUpperCase() + joined.slice(1);
    case 'trim': return joined.trim();
    case 'length': return String(joined.length);
    case 'replace': return values.slice(2).join(' ').split(values[0] ?? '').join(values[1] ?? '');
    default:
      if (SAMPLE_VALUES[canonical] !== undefined) return SAMPLE_VALUES[canonical];
      return `‹${canonical}›`;
  }
}

function record(s: RunState, name: string, args: string): void {
  s.actions.push({ name, args, destructive: Boolean(catalogEntry(name)?.destructive) });
}
