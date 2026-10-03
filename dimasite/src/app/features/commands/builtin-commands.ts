import type { Command } from '../../models/command.model';

/**
 * Built-in (reserved) commands keyed by `func`, from dimadocs `commands/built-in.mdx`.
 * Saved built-ins have no useful description ("No description provided."), so the
 * pages explain them from here. `usage` placeholders are keys under `commands.builtin.args`.
 */
export type BuiltinGroup = 'info' | 'fun' | 'stream' | 'polls' | 'roles' | 'manage' | 'other';

export const BUILTIN_GROUP_ORDER: readonly BuiltinGroup[] = ['info', 'fun', 'stream', 'polls', 'roles', 'manage', 'other'];

interface BuiltinInfo {
  group: BuiltinGroup;
  /** Arguments after the command, e.g. '<user>' or '[seconds] [title]'. */
  usage?: string;
}

const BUILTINS: Record<string, BuiltinInfo> = {
  commands: { group: 'info' },
  followage: { group: 'info', usage: '[user]' },

  amor: { group: 'fun', usage: '<user>' },
  sumimetro: { group: 'fun', usage: '[user]' },
  memide: { group: 'fun' },
  ponerla: { group: 'fun' },
  mecabe: { group: 'fun' },
  ruletarusa: { group: 'fun' },
  duel: { group: 'fun', usage: '<user>' },
  chiste: { group: 'fun' },
  vanish: { group: 'fun' },

  shoutout: { group: 'stream', usage: '<user>' },
  promo: { group: 'stream', usage: '<user>' },
  anuncio: { group: 'stream', usage: '<message>' },
  title: { group: 'stream', usage: '<title>' },
  game: { group: 'stream', usage: '<game>' },
  createClip: { group: 'stream', usage: '[seconds] [title]' },
  onlyemotes: { group: 'stream', usage: '[seconds]' },
  clearChat: { group: 'stream' },

  poll: { group: 'polls', usage: '<question>;<option>/<option>;<seconds>' },
  endpoll: { group: 'polls' },
  cancelpoll: { group: 'polls' },
  predi: { group: 'polls', usage: '<question>;<option>/<option>;<seconds>' },
  lockpredi: { group: 'polls' },
  endpredi: { group: 'polls', usage: '<winner>' },
  cancelpredi: { group: 'polls' },

  mod: { group: 'roles', usage: '<user> [days]' },
  unmod: { group: 'roles', usage: '<user>' },
  vip: { group: 'roles', usage: '<user> [days]' },
  unvip: { group: 'roles', usage: '<user>' },

  createCommand: { group: 'manage', usage: '<name> <reply>' },
  editCommand: { group: 'manage', usage: '<name> <reply>' },
  deleteCommand: { group: 'manage', usage: '<name>' },
  enableCommand: { group: 'manage', usage: '<name>' },
  disableCommand: { group: 'manage', usage: '<name>' },
  createCommandTimer: { group: 'manage', usage: '<name> <minutes> <message>' },
  editCommandTimer: { group: 'manage', usage: '<name> [minutes] [message]' },
  deleteCommandTimer: { group: 'manage', usage: '<name>' },
};

export function builtinInfo(command: Pick<Command, 'func'>): (BuiltinInfo & { known: boolean }) {
  const info = BUILTINS[command.func];
  return info ? { ...info, known: true } : { group: 'other', known: false };
}

const PLACEHOLDER_DESCRIPTIONS = new Set(['', 'no description provided.', 'sin descripción.', 'sin descripcion']);

/** Saved descriptions are often a placeholder; treat those as missing. */
export function realDescription(command: Pick<Command, 'description'>): string | null {
  const text = (command.description ?? '').trim();
  return PLACEHOLDER_DESCRIPTIONS.has(text.toLowerCase()) ? null : text;
}

/** `<user> [days]` with translated argument names. */
export function formatUsage(usage: string, translate: (key: string, params?: Record<string, string | number>) => string): string {
  return usage.replace(/([<[])([a-z]+)(\d*)([>\]])/gi, (_, open: string, key: string, n: string, close: string) =>
    `${open}${n ? translate(`commands.builtin.args.${key}N`, { n }) : translate(`commands.builtin.args.${key}`)}${close}`);
}

/** Arguments a custom reply reads: `&t` = any text, `&p1`, `&p2` = single words. */
export function customUsage(message: string): string | null {
  const text = message || '';
  const positions = [...text.matchAll(/&p(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 9);
  const max = positions.length ? Math.max(...positions) : 0;
  const parts: string[] = [];
  for (let i = 1; i <= max; i++) parts.push(`<word${i}>`);
  if (/&t\b/.test(text)) parts.push('<text>');
  return parts.length ? parts.join(' ') : null;
}

export interface ReplyPart {
  text: string;
  code: boolean;
}

/** Splits a reply so `$(…)`, `%(…)` and `&t`/`&pN` can be shown as code. One level of nesting. */
export function replyParts(message: string): ReplyPart[] {
  const pattern = /[$%*^#]\((?:[^()]|\([^()]*\))*\)|&p\d+|&t\b/g;
  const parts: ReplyPart[] = [];
  let last = 0;
  for (const match of message.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: message.slice(last, index), code: false });
    parts.push({ text: match[0], code: true });
    last = index + match[0].length;
  }
  if (last < message.length) parts.push({ text: message.slice(last), code: false });
  return parts;
}
