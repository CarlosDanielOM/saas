import {
  CATALOG,
  type BlockTone,
  type CatalogEntry,
  type LibrarySectionId,
  levelLabel,
  sectionFor,
  shortDescription
} from './command-ast-catalog';
import {
  type MockChildNode,
  type MockRoot,
  arrayLit,
  binary,
  commandRef,
  deleteVar,
  existsVar,
  fn,
  forRange,
  getVar,
  group,
  lit,
  rootOf,
  say,
  setVar,
  ternary
} from './command-ast-mock.model';
import { parseSource } from './command-ast-mock.parse';

export interface LibraryItem {
  id: string;
  /** Human title, e.g. "Ban or time out". */
  title: string;
  /** Code-ish name shown small, e.g. "ban" or "%(name)". */
  code: string;
  hint: string;
  section: LibrarySectionId;
  tone: BlockTone;
  level: string | null;
  destructive: boolean;
  plan: string | null;
  keywords: string[];
  factory: () => MockChildNode;
}

interface StructuralSpec {
  id: string;
  title: string;
  code: string;
  hint: string;
  section: LibrarySectionId;
  tone: BlockTone;
  keywords?: string[];
  factory: () => MockChildNode;
}

const STRUCTURAL: StructuralSpec[] = [
  { id: 'text', title: 'Text', code: 'text', hint: 'Words the bot says, exactly as typed', section: 'basics', tone: 'text', keywords: ['say', 'message', 'texto'], factory: () => lit('Hello ') },
  { id: 'quote', title: 'Quoted text', code: '"…"', hint: 'Text with values inside it, used as one piece', section: 'basics', tone: 'text', keywords: ['template', 'string'], factory: () => say([lit('Hi '), fn('user'), lit('!')]) },
  { id: 'group', title: 'Group', code: 'group', hint: 'Keep several blocks together, e.g. inside an if', section: 'basics', tone: 'flow', keywords: ['stack', 'join'], factory: () => group([lit('Hi '), fn('user')]) },
  { id: 'cmd', title: 'Run another command', code: '#(name)', hint: 'Runs one of your commands, like !so', section: 'basics', tone: 'flow', keywords: ['command', 'shoutout', 'so'], factory: () => commandRef('so', [fn('touser')]) },
  { id: 'setVar', title: 'Set variable', code: '%(name value)', hint: 'Remember a value under a name', section: 'variables', tone: 'var', keywords: ['save', 'store', 'guardar'], factory: () => setVar('target', fn('touser')) },
  { id: 'getVar', title: 'Use variable', code: '%(name)', hint: 'Insert a remembered value', section: 'variables', tone: 'var', keywords: ['read', 'load'], factory: () => getVar('target') },
  { id: 'counter', title: 'Add 1 to a saved number', code: '%(*n *(%(*n) + 1))', hint: 'A counter that keeps counting across streams', section: 'variables', tone: 'var', keywords: ['counter', 'deaths', 'increment', 'contador'], factory: () => setVar('deaths', binary(getVar('deaths', 'db'), '+', lit('1')), 'db') },
  { id: 'setList', title: 'Make a list', code: '%(name[] %[…])', hint: 'Several items under one name', section: 'variables', tone: 'var', keywords: ['array', 'lista'], factory: () => setVar('list', arrayLit([lit('one'), lit('two'), lit('three')]), 'memory', { type: 'append' }) },
  { id: 'getItem', title: 'Item from a list', code: '%(name[0])', hint: 'Pick one item by position (0 = first)', section: 'variables', tone: 'var', keywords: ['index', 'array'], factory: () => getVar('list', 'memory', { type: 'index', index: lit('0') }) },
  { id: 'randomItem', title: 'Random item from a list', code: '%(name[random])', hint: 'Pick any item at random', section: 'variables', tone: 'var', keywords: ['random', 'pick'], factory: () => getVar('list', 'memory', { type: 'random' }) },
  { id: 'exists', title: 'Variable is set?', code: '^(name)', hint: 'Yes when the variable has a value', section: 'variables', tone: 'var', keywords: ['exists', 'has'], factory: () => existsVar('target') },
  { id: 'deleteVar', title: 'Forget variable', code: '%del(name)', hint: 'Remove a remembered value', section: 'variables', tone: 'var', keywords: ['delete', 'remove', 'borrar'], factory: () => deleteVar('target') },
  { id: 'if', title: 'If / else', code: '*(a ? b : c)', hint: 'Say or do something different depending on a check', section: 'logic', tone: 'logic', keywords: ['condition', 'ternary', 'si'], factory: () => ternary(binary(fn('user'), '==', lit('cdom201')), lit('Welcome back, boss'), group([lit('Hi '), fn('user')])) },
  { id: 'compare', title: 'Compare', code: '*(a == b)', hint: 'Yes/no check: equal, bigger, smaller…', section: 'logic', tone: 'logic', keywords: ['equal', 'check', 'comparar'], factory: () => binary(fn('user'), '==', lit('cdom201')) },
  { id: 'math', title: 'Math', code: '*(a + b)', hint: 'Add, subtract, multiply or divide', section: 'numbers', tone: 'logic', keywords: ['add', 'sum', 'calc'], factory: () => binary(fn('random', [lit('10')]), '+', lit('1')) },
  { id: 'for', title: 'Repeat', code: '*(for #i …)', hint: 'Do the blocks inside several times', section: 'logic', tone: 'flow', keywords: ['loop', 'for', 'repetir'], factory: () => forRange('i') }
];

function functionItem(entry: CatalogEntry): LibraryItem {
  const section = sectionFor(entry);
  return {
    id: `fn:${entry.name}`,
    title: entry.name,
    code: entry.syntax,
    hint: shortDescription(entry),
    section,
    tone: section === 'chat' || section === 'moderation' || section === 'channel' || section === 'overlay' ? 'action' : section === 'logic' ? 'flow' : 'value',
    level: levelLabel(entry.level),
    destructive: Boolean(entry.destructive),
    plan: entry.plan && entry.plan !== 'free' ? entry.plan : null,
    keywords: [...(entry.aliases ?? []), ...(entry.keywords ?? [])],
    factory: () => fromExample(entry)
  };
}

/** New function blocks start from the catalog's first example, so they already work. */
function fromExample(entry: CatalogEntry): MockChildNode {
  const example = entry.examples?.[0];
  if (example) {
    const { root, error } = parseSource(`$(${example})`);
    const first = root.children[0];
    if (!error && root.children.length === 1 && first?.type === 'function') {
      return { ...first, name: entry.name };
    }
  }
  return fn(entry.name);
}

export const LIBRARY: LibraryItem[] = [
  ...STRUCTURAL.map((spec) => ({ ...spec, level: null, destructive: false, plan: null, keywords: spec.keywords ?? [] })),
  ...CATALOG.map(functionItem)
];

export function libraryItem(id: string): LibraryItem | undefined {
  return LIBRARY.find((item) => item.id === id);
}

export function searchLibrary(query: string, section: LibrarySectionId | 'all'): LibraryItem[] {
  const q = query.trim().toLowerCase();
  return LIBRARY.filter((item) => {
    if (section !== 'all' && item.section !== section && !q) return false;
    if (!q) return true;
    return [item.title, item.code, item.hint, ...item.keywords].some((field) => field.toLowerCase().includes(q));
  });
}

/** Ready-made commands to start from. */
export interface StarterCommand {
  id: string;
  label: string;
  blurb: string;
  build: () => MockRoot;
}

function fromSource(source: string): () => MockRoot {
  return () => parseSource(source).root;
}

export const STARTERS: StarterCommand[] = [
  { id: 'hello', label: 'Greeting', blurb: 'Says hi to whoever typed it', build: () => rootOf(lit('Hello '), fn('user'), lit('! Welcome to the stream.')) },
  { id: 'hug', label: 'Hug someone', blurb: 'Uses the name after the command', build: fromSource('$(user) hugs $(touser) <3') },
  { id: 'deaths', label: 'Death counter', blurb: 'Saved number that grows every use', build: fromSource('%(*deaths *(%(*deaths) + 1))Deaths so far: %(*deaths)') },
  { id: 'boss', label: 'If / else', blurb: 'Different reply for the streamer', build: () => rootOf(ternary(binary(fn('user'), '==', lit('cdom201')), lit('Welcome back, boss'), group([lit('Hi '), fn('user')]))) },
  { id: 'roulette', label: 'Timeout roulette', blurb: '1 in 6 gets a 60s timeout', build: fromSource('*($(random 6) == 0 ? "BANG! $(user) is out for a minute. $(ban $(user) 60)" : "click... $(user) survives")') },
  { id: 'raid', label: 'Raid thanks', blurb: 'For raid events: thank and shout out', build: fromSource('Thanks for the raid $(raid.channel) with $(raid.viewers) viewers! #(so $(raid.channel))') },
  { id: 'loop', label: 'Repeat', blurb: 'A loop that counts to 3', build: () => rootOf(forRange('i')) }
];
