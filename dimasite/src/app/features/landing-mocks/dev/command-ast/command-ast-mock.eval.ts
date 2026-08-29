import type { MockNode, MockRoot } from './command-ast-mock.model';

export interface MockChatContext {
  user: string;
  argument: string;
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
  count: 17,
  title: 'Night coding',
  game: 'Just Chatting',
  viewers: 42,
  channel: 'cdom201',
  chatters: ['PixelFan', 'ModSnack', 'cdom201', 'ClipGoblin']
};

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
  if (!text || text === '0' || text === 'false' || text === 'null') return false;
  return true;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  const l = asText(left);
  const r = asText(right);
  const ln = Number(l);
  const rn = Number(r);
  const numeric = Number.isFinite(ln) && Number.isFinite(rn);
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '>':
      return numeric ? ln > rn : l > r;
    case '<':
      return numeric ? ln < rn : l < r;
    case '>=':
      return numeric ? ln >= rn : l >= r;
    case '<=':
      return numeric ? ln <= rn : l <= r;
    case '~=':
      return l.toLowerCase() === r.toLowerCase();
    default:
      return false;
  }
}

function math(op: string, left: unknown, right: unknown): string {
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
      return asText(left);
  }
}

export function mockEvaluate(root: MockRoot, ctx: MockChatContext): string {
  const vars = new Map<string, string>();
  const loopVars = new Map<string, string>();
  return evalNode(root, ctx, vars, loopVars);
}

function evalNode(
  node: MockNode | null,
  ctx: MockChatContext,
  vars: Map<string, string>,
  loopVars: Map<string, string>
): string {
  if (!node) return '';
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'loopVar':
      return loopVars.get(node.name) ?? `#${node.name}`;
    case 'getVar': {
      const raw = vars.get(node.name) ?? '';
      if (node.accessor?.type === 'index') {
        try {
          const arr = JSON.parse(raw) as unknown;
          if (Array.isArray(arr)) {
            const idx = Number(evalNode(node.accessor.index, ctx, vars, loopVars));
            return asText(arr[idx] ?? '');
          }
        } catch {
          return raw;
        }
      }
      return raw;
    }
    case 'arrayLiteral':
      return JSON.stringify(node.items.map((item) => evalNode(item, ctx, vars, loopVars)));
    case 'exists':
      return vars.has(node.name) ? 'true' : '';
    case 'deleteVar':
      vars.delete(node.name);
      return '';
    case 'setVar': {
      const value = evalNode(node.value, ctx, vars, loopVars);
      vars.set(node.name, value);
      return '';
    }
    case 'function':
      return evalFunction(node.name, node.args, ctx, vars, loopVars);
    case 'binary': {
      const left = evalNode(node.left, ctx, vars, loopVars);
      const right = evalNode(node.right, ctx, vars, loopVars);
      if ('+-*/%'.includes(node.operator) && node.operator !== '==') {
        return math(node.operator, left, right);
      }
      return compare(node.operator, left, right) ? 'true' : '';
    }
    case 'ternary':
      return truthy(evalNode(node.test, ctx, vars, loopVars))
        ? evalNode(node.consequent, ctx, vars, loopVars)
        : evalNode(node.alternate, ctx, vars, loopVars);
    case 'commandRef': {
      const args = node.args.map((arg) => evalNode(arg, ctx, vars, loopVars)).filter(Boolean);
      return `[mock #${node.commandName}${args.length ? ' ' + args.join(' ') : ''}]`;
    }
    case 'forLoop': {
      if (node.mode === 'foreach') {
        return '[mock foreach]';
      }
      const out: string[] = [];
      let i = 0;
      const max = 8;
      while (i < max) {
        loopVars.set(node.loopVar, String(i));
        if (node.condition && !truthy(evalNode(node.condition, ctx, vars, loopVars))) break;
        out.push(evalList(node.body, ctx, vars, loopVars));
        i += 1;
        loopVars.set(node.loopVar, String(i));
      }
      loopVars.delete(node.loopVar);
      return out.join(' ');
    }
    case 'template':
      return node.parts.map((part) => evalNode(part, ctx, vars, loopVars)).join('');
    case 'group':
    case 'root':
      return evalList(node.children, ctx, vars, loopVars);
  }
}

function evalList(
  nodes: MockNode[],
  ctx: MockChatContext,
  vars: Map<string, string>,
  loopVars: Map<string, string>
): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const part = evalNode(nodes[i], ctx, vars, loopVars);
    if (i === 0) {
      out = part;
      continue;
    }
    const prev = nodes[i - 1];
    if (prev.type === 'literal' || nodes[i].type === 'literal') {
      out += part;
    } else if (part) {
      out += out.endsWith(' ') || part.startsWith(' ') ? part : ` ${part}`;
    }
  }
  return out;
}

function evalFunction(
  name: string,
  args: MockNode[],
  ctx: MockChatContext,
  vars: Map<string, string>,
  loopVars: Map<string, string>
): string {
  const values = args.map((arg) => evalNode(arg, ctx, vars, loopVars));
  const joined = values.join(' ').trim();
  switch (name) {
    case 'user':
      return ctx.user;
    case 'touser':
      return values[0] || ctx.argument || ctx.user;
    case 'randomuser':
      return ctx.chatters[Math.floor(Math.random() * ctx.chatters.length)] ?? ctx.user;
    case 'count':
    case 'scount':
      return String(ctx.count);
    case 'followage':
      return '2 years, 4 months';
    case 'twitch.title':
      return ctx.title;
    case 'twitch.game':
      return ctx.game;
    case 'twitch.viewers':
      return String(ctx.viewers);
    case 'twitch.channel':
    case 'twitch.login':
      return ctx.channel;
    case 'upper':
      return joined.toUpperCase();
    case 'lower':
      return joined.toLowerCase();
    case 'title':
      return joined.replace(/\b\w/g, (ch) => ch.toUpperCase());
    case 'trim':
      return joined.trim();
    case 'length':
      return String(joined.length);
    case 'random': {
      const min = num(values[0], 1);
      const max = num(values[1], 10);
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
    case 'ban':
      return `[mock ban ${values[0] || ctx.argument} ${values[1] || 'perm'}]`;
    case 'vip':
    case 'add.vip':
      return `[mock vip ${values[0] || ctx.argument}]`;
    case 'unvip':
      return `[mock unvip ${values[0] || ctx.argument}]`;
    case 'chat.send':
      return `[mock chat] ${joined}`;
    case 'tts':
    case 'tts.speak':
      return `[mock tts] ${joined}`;
    case 'delay':
      return '';
    case 'break':
    case 'continue':
      return '';
    default:
      return `[mock $(${name}${joined ? ' ' + joined : ''})]`;
  }
}
