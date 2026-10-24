/**
 * Real AST function catalog for the command block editor (and the dev mock).
 *
 * `blocks-catalog.json` is a trimmed copy of the bot's generated catalog
 * (dimabot/src/utils/ai/ast_catalog/ast-catalog.json, built by `npm run gen:ast-docs`).
 * Refresh it after backend function changes: `node scripts/sync-ast-catalog.mjs` (dimasite).
 */
import catalogJson from './blocks-catalog.json';

export interface CatalogEntry {
  name: string;
  description: string;
  syntax: string;
  category: string;
  examples?: string[];
  aliases?: string[];
  level: number;
  destructive?: boolean;
  plan?: 'free' | 'premium' | 'pro';
  keywords?: string[];
}

export interface CatalogParam {
  label: string;
  optional: boolean;
  /** Takes every remaining argument (free text such as a chat message). */
  rest: boolean;
}

export type LibrarySectionId =
  | 'basics'
  | 'people'
  | 'stream'
  | 'events'
  | 'text'
  | 'numbers'
  | 'variables'
  | 'logic'
  | 'chat'
  | 'moderation'
  | 'channel'
  | 'overlay';

export type BlockTone = 'text' | 'value' | 'var' | 'logic' | 'action' | 'flow';

export interface LibrarySection {
  id: LibrarySectionId;
  label: string;
  hint: string;
  tone: BlockTone;
}

export const LIBRARY_SECTIONS: LibrarySection[] = [
  { id: 'basics', label: 'Basics', hint: 'Text the bot says and other commands', tone: 'text' },
  { id: 'people', label: 'People', hint: 'Who is chatting, who they mention', tone: 'value' },
  { id: 'stream', label: 'Stream info', hint: 'Live status, title, game, viewers', tone: 'value' },
  { id: 'events', label: 'Event info', hint: 'Raids, cheers, subs, rewards (event commands only)', tone: 'value' },
  { id: 'text', label: 'Text tools', hint: 'Change or cut text', tone: 'value' },
  { id: 'numbers', label: 'Numbers', hint: 'Random numbers and counters', tone: 'value' },
  { id: 'variables', label: 'Variables', hint: 'Remember things between messages', tone: 'var' },
  { id: 'logic', label: 'Logic & loops', hint: 'If/else, compare, repeat, wait', tone: 'logic' },
  { id: 'chat', label: 'Chat & voice', hint: 'Send messages, TTS, AI replies', tone: 'action' },
  { id: 'moderation', label: 'Moderation', hint: 'Ban, VIP, mod, chat modes', tone: 'action' },
  { id: 'channel', label: 'Channel', hint: 'Title, polls, predictions, pins, clips', tone: 'action' },
  { id: 'overlay', label: 'Overlay & games', hint: 'Alerts queue, triggers, roulette', tone: 'action' }
];

const CATEGORY_SECTION: Record<string, LibrarySectionId> = {
  user: 'people',
  'twitch-data': 'stream',
  'event-data': 'events',
  string: 'text',
  random: 'numbers',
  counters: 'numbers',
  flow: 'logic',
  chat: 'chat',
  tts: 'chat',
  ai: 'chat',
  moderation: 'moderation',
  defense: 'moderation',
  channel: 'channel',
  availability: 'channel',
  pin: 'channel',
  clip: 'channel',
  overlay: 'overlay',
  trigger: 'overlay',
  roulette: 'overlay'
};

/** Functions that do something (shown as actions in the preview) rather than return text. */
const ACTION_CATEGORIES = new Set([
  'chat',
  'tts',
  'moderation',
  'defense',
  'channel',
  'availability',
  'pin',
  'clip',
  'overlay',
  'trigger',
  'roulette'
]);

const RETURNS_VALUE = new Set(['get.poll', 'get.prediction', 'ad.time', 'ai', 'bot.mode']);

export const CATALOG: CatalogEntry[] = (catalogJson as { entries: CatalogEntry[] }).entries;

const BY_NAME = new Map<string, CatalogEntry>();
for (const entry of CATALOG) {
  BY_NAME.set(entry.name, entry);
  for (const alias of entry.aliases ?? []) BY_NAME.set(alias, entry);
}

export function catalogEntry(name: string): CatalogEntry | undefined {
  return BY_NAME.get(name);
}

export function sectionFor(entry: CatalogEntry): LibrarySectionId {
  if (['followage', 'twitch.modiversary', 'twitch.streak'].includes(entry.name)) return 'people';
  return CATEGORY_SECTION[entry.category] ?? 'basics';
}

export function isActionFunction(name: string): boolean {
  const entry = catalogEntry(name);
  if (!entry) return false;
  if (RETURNS_VALUE.has(entry.name)) return false;
  return ACTION_CATEGORIES.has(entry.category) || ['timer', 'delay', 'break', 'continue'].includes(entry.name);
}

/** First sentence of the description, for one-line hints. */
export function shortDescription(entry: CatalogEntry): string {
  const first = entry.description.split(/(?<=\.)\s/)[0] ?? entry.description;
  return first.length > 96 ? `${first.slice(0, 93)}…` : first;
}

/** Who may run it: 'mods' (level 7+) or 'streamer' (8+); translate in the UI. */
export function levelKey(level: number): 'mods' | 'streamer' | null {
  if (level >= 8) return 'streamer';
  if (level >= 7) return 'mods';
  return null;
}

/** Who may run it, in the streamer's words (English; used by the dev mock). */
export function levelLabel(level: number): string | null {
  if (level >= 8) return 'Streamer only';
  if (level >= 7) return 'Mods+';
  return null;
}

const REST_PARAM = /^(message|text|prompt|message_and_actions|actions|reason|title)$/i;
const PARAM_OVERRIDES: Record<string, CatalogParam[]> = {
  'set.title': [{ label: 'new title', optional: false, rest: true }],
  'set.game': [{ label: 'game name', optional: false, rest: true }]
};
const paramCache = new Map<string, CatalogParam[]>();

/** Argument slots from the catalog syntax, e.g. "ban username [seconds]". */
export function catalogParams(name: string): CatalogParam[] {
  const cached = paramCache.get(name);
  if (cached) return cached;
  const entry = catalogEntry(name);
  const params: CatalogParam[] = [...(entry ? PARAM_OVERRIDES[entry.name] ?? [] : [])];
  if (entry && params.length === 0) {
    const tokens = tokenizeSyntax(entry.syntax).slice(1);
    tokens.forEach((token, index) => {
      const optional = token.startsWith('[') && token.endsWith(']');
      const raw = token.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '');
      const label = raw.includes(';')
        ? `${raw.split(';')[0]}; options; seconds`
        : raw.replace(/_/g, ' ').replace(/\|/g, ' or ');
      params.push({ label, optional, rest: index === tokens.length - 1 && REST_PARAM.test(raw) });
    });
  }
  paramCache.set(name, params);
  return params;
}

function tokenizeSyntax(syntax: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote = false;
  let depth = 0;
  for (const ch of syntax) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '[') depth++;
    if (!quote && ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ' ' && !quote && depth === 0) {
      if (buf) out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export function searchCatalog(query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return CATALOG;
  return CATALOG.filter((entry) =>
    [entry.name, entry.description, ...(entry.aliases ?? []), ...(entry.keywords ?? [])].some((field) =>
      field.toLowerCase().includes(q)
    )
  );
}

/** Sample values the live preview uses for read-only functions. */
export const SAMPLE_VALUES: Record<string, string> = {
  followage: '2 years, 4 months',
  'twitch.modiversary': '1 year',
  'twitch.streak': '12',
  'twitch.live': 'true',
  'twitch.subs': '128',
  'twitch.follows': '5400',
  'raid.channel': 'BigStreamer',
  'raid.login': 'bigstreamer',
  'raid.viewers': '42',
  'cheer.amount': '100',
  'cheer.message': 'Take my bits!',
  'sub.tier': '1',
  'sub.months': '6',
  'gifted.user': 'LuckyViewer',
  'hypetrain.progress': '64',
  'hypetrain.level': '3',
  'hypetrain.end': 'in 4 minutes',
  'shoutout.channel': 'FriendlyStreamer',
  'reward.input': 'play some lofi',
  bits: '2500',
  'ad.time': '12 minutes',
  'bot.mode': 'online',
  'get.poll': 'Best map? · Nuke leads',
  'get.prediction': 'Will we win? · 64% yes'
};
