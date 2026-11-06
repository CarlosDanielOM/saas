import { CATALOG, type BlockTone, type CatalogEntry, type LibrarySectionId, levelKey, sectionFor, shortDescription, catalogDescription, catalogEntry } from './blocks.catalog';
import {
  type BlockNode,
  type RootNode,
  arrayLit,
  binary,
  commandRef,
  deleteVar,
  existsVar,
  fn,
  forEach,
  forRange,
  getVar,
  group,
  lit,
  loopVar,
  rootOf,
  setVar,
  template,
  ternary
} from './blocks.model';

export interface LibraryItem {
  id: string;
  /** Function name for catalog items; for built-in blocks, an i18n key under commandBlocks.items.<id>. */
  name: string;
  builtIn: boolean;
  /** Short code-ish hint, e.g. "%(name)". */
  code: string;
  /** English catalog description (functions); built-ins use i18n. */
  description: string;
  section: LibrarySectionId;
  tone: BlockTone;
  level: 'mods' | 'streamer' | null;
  destructive: boolean;
  keywords: string[];
  factory: (t?: (key: string) => string) => BlockNode;
}

interface BuiltIn {
  id: string;
  code: string;
  section: LibrarySectionId;
  tone: BlockTone;
  keywords: string[];
  factory: (t?: (key: string) => string) => BlockNode;
}

/** Built-in blocks; titles and hints live in i18n (commandBlocks.items.<id>.title / .hint). */
const BUILT_INS: BuiltIn[] = [
  { id: 'text', code: 'text', section: 'basics', tone: 'text', keywords: ['say', 'message', 'texto', 'mensaje'], factory: (t = (key) => key) => lit(t('commandBlocks.exampleText.hello')) },
  { id: 'quote', code: '"…"', section: 'basics', tone: 'text', keywords: ['template', 'string', 'comillas'], factory: (t = (key) => key) => template([lit(t('commandBlocks.exampleText.hi')), fn('user'), lit('!')]) },
  { id: 'word', code: '&p1', section: 'basics', tone: 'value', keywords: ['argument', 'word', 'palabra', 'argumento'], factory: () => lit('&p1') },
  { id: 'rest', code: '&t', section: 'basics', tone: 'value', keywords: ['argument', 'text', 'resto', 'argumento'], factory: () => lit('&t') },
  { id: 'cmd', code: '#(name)', section: 'basics', tone: 'flow', keywords: ['command', 'shoutout', 'so', 'comando'], factory: () => commandRef('so', [fn('touser')]) },
  { id: 'setVar', code: '%(name value)', section: 'variables', tone: 'var', keywords: ['save', 'store', 'guardar'], factory: () => setVar('target', fn('touser')) },
  { id: 'getVar', code: '%(name)', section: 'variables', tone: 'var', keywords: ['read', 'load', 'usar'], factory: () => getVar('target') },
  { id: 'counter', code: '%(*n *(%(*n) + 1))', section: 'variables', tone: 'var', keywords: ['counter', 'deaths', 'increment', 'contador'],
    factory: () => setVar('deaths', binary(getVar('deaths', 'db'), '+', lit('1')), 'db') },
  { id: 'setList', code: '%(name[] %[…])', section: 'variables', tone: 'var', keywords: ['array', 'lista'],
    factory: (t = (key) => key) => setVar('list', arrayLit([lit(t('commandBlocks.exampleText.one')), lit(t('commandBlocks.exampleText.two')), lit(t('commandBlocks.exampleText.three'))]), 'memory', { type: 'append' }) },
  { id: 'getItem', code: '%(name[0])', section: 'variables', tone: 'var', keywords: ['index', 'array', 'elemento'],
    factory: () => getVar('list', 'memory', { type: 'index', index: lit('0') }) },
  { id: 'randomItem', code: '%(name[random])', section: 'variables', tone: 'var', keywords: ['random', 'pick', 'azar'],
    factory: () => getVar('list', 'memory', { type: 'random' }) },
  { id: 'listSize', code: '%(name[].length)', section: 'variables', tone: 'var', keywords: ['length', 'count', 'size', 'tamaño'],
    factory: () => getVar('list', 'memory', { type: 'length' }) },
  { id: 'exists', code: '^(name)', section: 'variables', tone: 'var', keywords: ['exists', 'has', 'existe'], factory: () => existsVar('target') },
  { id: 'deleteVar', code: '%del(name)', section: 'variables', tone: 'var', keywords: ['delete', 'remove', 'borrar'], factory: () => deleteVar('target') },
  { id: 'if', code: '*(a ? b : c)', section: 'logic', tone: 'logic', keywords: ['condition', 'ternary', 'si'],
    factory: (t = (key) => key) => ternary(binary(fn('user'), '~=', fn('twitch.channel')), lit(t('commandBlocks.exampleText.bossWelcome')), group([lit(t('commandBlocks.exampleText.hi')), fn('user')])) },
  { id: 'compare', code: '*(a == b)', section: 'logic', tone: 'logic', keywords: ['equal', 'check', 'comparar'], factory: () => binary(fn('user'), '==', lit('name')) },
  { id: 'math', code: '*(a + b)', section: 'numbers', tone: 'logic', keywords: ['add', 'sum', 'calc', 'sumar'], factory: () => binary(fn('random', [lit('10')]), '+', lit('1')) },
  { id: 'repeat', code: '*(for #i …)', section: 'logic', tone: 'flow', keywords: ['loop', 'for', 'repetir', 'bucle'],
    factory: (t = (key) => key) => forRange('i', '3', [fn('chat.send', [lit(t('commandBlocks.exampleText.round')), loopVar('i')])]) },
  { id: 'forEach', code: '*(for #x in …)', section: 'logic', tone: 'flow', keywords: ['loop', 'each', 'list', 'cada'],
    factory: () => forEach('item', getVar('list', 'memory', { type: 'array' }), [fn('chat.send', [loopVar('item')])]) }
];

function functionItem(entry: CatalogEntry): LibraryItem {
  const section = sectionFor(entry);
  return {
    id: `fn:${entry.name}`,
    name: entry.name,
    builtIn: false,
    code: entry.syntax,
    description: shortDescription(entry),
    section,
    tone: ['chat', 'moderation', 'channel', 'overlay'].includes(section) ? 'action' : section === 'logic' ? 'flow' : 'value',
    level: levelKey(entry.level),
    destructive: Boolean(entry.destructive),
    keywords: [...(entry.aliases ?? []), ...(entry.keywords ?? [])],
    factory: () => fn(entry.name, exampleArgs(entry.examples?.[0] ?? ''))
  };
}

/**
 * Arguments from a catalog example ("ban $(touser) 60"), so a new block already
 * works: plain words, "quoted text" and nested $(…) calls.
 */
export function exampleArgs(example: string): BlockNode[] {
  const body = example.trim().replace(/^\S+\s*/, '');
  return readArgs(body);
}

function readArgs(input: string): BlockNode[] {
  const out: BlockNode[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      const stop = end < 0 ? input.length : end;
      out.push(lit(input.slice(i + 1, stop)));
      i = stop + 1;
      continue;
    }
    if (input.startsWith('$(', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < input.length && depth > 0) {
        if (input[j] === '(') depth++;
        else if (input[j] === ')') depth--;
        j++;
      }
      const inner = input.slice(i + 2, j - 1).trim();
      const name = inner.split(/\s+/)[0] ?? '';
      out.push(fn(name, readArgs(inner.slice(name.length))));
      i = j;
      continue;
    }
    let j = i;
    while (j < input.length && !/\s/.test(input[j])) j++;
    out.push(lit(input.slice(i, j)));
    i = j;
  }
  return out;
}

export const LIBRARY: LibraryItem[] = [
  ...BUILT_INS.map((item): LibraryItem => ({ ...item, name: item.id, builtIn: true, description: '', level: null, destructive: false })),
  ...CATALOG.map(functionItem)
];

export function libraryItem(id: string): LibraryItem | undefined {
  return LIBRARY.find((item) => item.id === id);
}

/** Search across names, code, descriptions and keywords (titles/hints are passed in already translated). */
export function searchLibrary(query: string, section: LibrarySectionId | 'all', titleOf: (item: LibraryItem) => string): LibraryItem[] {
  const q = query.trim().toLowerCase();
  return LIBRARY.filter((item) => {
    if (!q) return section === 'all' || item.section === section;
    const entry = item.builtIn ? undefined : catalogEntry(item.name);
    return [titleOf(item), item.name, item.code, item.description, ...(entry ? [entry.description, catalogDescription(entry, 'es')] : []), ...item.keywords].some((field) => field.toLowerCase().includes(q));
  });
}

export interface StarterCommand {
  /** i18n: commandBlocks.starters.<id>.label / .blurb */
  id: string;
  build: (t: (key: string) => string) => RootNode;
}

export const STARTERS: StarterCommand[] = [
  { id: 'hello', build: (t) => rootOf(lit(t('commandBlocks.exampleText.hello')), fn('user'), lit(t('commandBlocks.exampleText.welcomeStream'))) },
  { id: 'hug', build: (t) => rootOf(fn('user'), lit(t('commandBlocks.exampleText.hugs')), fn('touser'), lit(' <3')) },
  { id: 'deaths', build: (t) => rootOf(setVar('deaths', binary(getVar('deaths', 'db'), '+', lit('1')), 'db'), lit(t('commandBlocks.exampleText.deaths')), getVar('deaths', 'db')) },
  { id: 'boss', build: (t) => rootOf(ternary(binary(fn('user'), '~=', fn('twitch.channel')), lit(t('commandBlocks.exampleText.bossWelcome')), group([lit(t('commandBlocks.exampleText.hi')), fn('user')]))) },
  { id: 'roulette', build: (t) => rootOf(ternary(binary(fn('random', [lit('6')]), '==', lit('0')),
      group([lit(t('commandBlocks.exampleText.bang')), fn('user'), lit(t('commandBlocks.exampleText.outMinute')), fn('ban.self', [lit('60')])]),
      group([lit(t('commandBlocks.exampleText.click')), fn('user'), lit(t('commandBlocks.exampleText.survives'))]))) },
  { id: 'raid', build: (t) => rootOf(lit(t('commandBlocks.exampleText.thanksRaid')), fn('raid.channel'), lit(t('commandBlocks.exampleText.with')), fn('raid.viewers'), lit(t('commandBlocks.exampleText.viewers')),
      commandRef('so', [fn('raid.channel')])) }
];
