export type MockVarStorage = 'memory' | 'cache' | 'cacheUser' | 'db' | 'dbUser';
export type MockBinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '~=';
export type MockPanel = 'palette' | 'canvas' | 'output';
export type PaletteCategory = 'say' | 'value' | 'var' | 'logic' | 'action' | 'flow';

export interface MockLiteral {
  id: string;
  type: 'literal';
  value: string;
}

export interface MockFunction {
  id: string;
  type: 'function';
  name: string;
  args: MockNode[];
}

export type MockArrayAccessor =
  | { type: 'array' }
  | { type: 'append' }
  | { type: 'index'; index: MockNode | null }
  | { type: 'setIndex'; index: MockNode | null }
  | { type: 'random' }
  | { type: 'length' };

export interface MockGetVar {
  id: string;
  type: 'getVar';
  name: string;
  storage: MockVarStorage;
  accessor?: MockArrayAccessor;
  userSelector?: MockNode | null;
}

export interface MockSetVar {
  id: string;
  type: 'setVar';
  name: string;
  storage: MockVarStorage;
  value: MockNode | null;
  accessor?: MockArrayAccessor;
  userSelector?: MockNode | null;
}

export interface MockArrayLiteral {
  id: string;
  type: 'arrayLiteral';
  items: MockNode[];
}

export interface MockExists {
  id: string;
  type: 'exists';
  name: string;
  storage: MockVarStorage;
  userSelector?: MockNode | null;
}

export interface MockDeleteVar {
  id: string;
  type: 'deleteVar';
  name: string;
  storage: MockVarStorage;
  userSelector?: MockNode | null;
}

export interface MockTemplate {
  id: string;
  type: 'template';
  parts: MockNode[];
}

export interface MockBinary {
  id: string;
  type: 'binary';
  operator: MockBinaryOp;
  left: MockNode | null;
  right: MockNode | null;
}

export interface MockTernary {
  id: string;
  type: 'ternary';
  test: MockNode | null;
  consequent: MockNode | null;
  alternate: MockNode | null;
}

export interface MockCommandRef {
  id: string;
  type: 'commandRef';
  commandName: string;
  args: MockNode[];
}

export interface MockLoopVar {
  id: string;
  type: 'loopVar';
  name: string;
}

export interface MockForLoop {
  id: string;
  type: 'forLoop';
  loopVar: string;
  mode: 'range' | 'foreach';
  init: MockNode | null;
  condition: MockNode | null;
  update: MockNode | null;
  iterable: MockNode | null;
  body: MockNode[];
}

export interface MockGroup {
  id: string;
  type: 'group';
  children: MockNode[];
}

export interface MockRoot {
  id: string;
  type: 'root';
  children: MockNode[];
}

export type MockNode =
  | MockLiteral
  | MockFunction
  | MockGetVar
  | MockSetVar
  | MockExists
  | MockDeleteVar
  | MockBinary
  | MockTernary
  | MockCommandRef
  | MockLoopVar
  | MockForLoop
  | MockGroup
  | MockTemplate
  | MockArrayLiteral
  | MockRoot;

export type MockChildNode = Exclude<MockNode, MockRoot>;

export type SingleSlot =
  | 'value'
  | 'left'
  | 'right'
  | 'test'
  | 'consequent'
  | 'alternate'
  | 'init'
  | 'condition'
  | 'update'
  | 'iterable';

export type ListSlot = 'children' | 'args' | 'body' | 'items';

export type DropTarget =
  | { kind: 'root'; index: number }
  | { kind: 'list'; parentId: string; slot: ListSlot; index: number }
  | { kind: 'single'; parentId: string; slot: SingleSlot };

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  category: PaletteCategory;
  factory: () => MockChildNode;
}

export interface SampleRecipe {
  id: string;
  label: string;
  blurb: string;
  build: () => MockRoot;
}

let seq = 0;

export function nid(prefix = 'b'): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

export function lit(value: string): MockLiteral {
  return { id: nid('t'), type: 'literal', value };
}

export function fn(name: string, args: MockNode[] = []): MockFunction {
  return { id: nid('fn'), type: 'function', name, args };
}

export function getVar(
  name: string,
  storage: MockVarStorage = 'memory',
  accessor?: MockArrayAccessor,
  userSelector?: MockNode | null
): MockGetVar {
  return { id: nid('gv'), type: 'getVar', name, storage, accessor, userSelector };
}

export function setVar(
  name: string,
  value: MockNode | null,
  storage: MockVarStorage = 'memory',
  accessor?: MockArrayAccessor,
  userSelector?: MockNode | null
): MockSetVar {
  return { id: nid('sv'), type: 'setVar', name, storage, value, accessor, userSelector };
}

export function say(parts: MockNode[]): MockTemplate {
  return { id: nid('say'), type: 'template', parts };
}

export const STORAGE_OPTIONS: { id: MockVarStorage; mark: string; label: string }[] = [
  { id: 'memory', mark: 'tmp', label: 'Temporary (this command)' },
  { id: 'cache', mark: '#', label: 'Cache (this stream)' },
  { id: 'cacheUser', mark: '##', label: 'Cache per user' },
  { id: 'db', mark: '*', label: 'Saved (channel)' },
  { id: 'dbUser', mark: '**', label: 'Saved per user' }
];

export function arrayLit(items: MockNode[]): MockArrayLiteral {
  return { id: nid('arr'), type: 'arrayLiteral', items };
}

export function isListSet(node: MockSetVar): boolean {
  const acc = node.accessor?.type;
  return acc === 'append' || acc === 'array' || acc === 'setIndex' || node.value?.type === 'arrayLiteral';
}

export function listItems(node: MockSetVar | MockArrayLiteral): MockNode[] {
  if (node.type === 'arrayLiteral') return node.items;
  return node.value?.type === 'arrayLiteral' ? node.value.items : [];
}

export function existsVar(
  name: string,
  storage: MockVarStorage = 'memory',
  userSelector?: MockNode | null
): MockExists {
  return { id: nid('ex'), type: 'exists', name, storage, userSelector };
}

export function deleteVar(
  name: string,
  storage: MockVarStorage = 'memory',
  userSelector?: MockNode | null
): MockDeleteVar {
  return { id: nid('dv'), type: 'deleteVar', name, storage, userSelector };
}

export function binary(
  left: MockNode | null,
  operator: MockBinaryOp,
  right: MockNode | null
): MockBinary {
  return { id: nid('op'), type: 'binary', operator, left, right };
}

export function ternary(
  test: MockNode | null,
  consequent: MockNode | null,
  alternate: MockNode | null
): MockTernary {
  return { id: nid('if'), type: 'ternary', test, consequent, alternate };
}

export function commandRef(commandName: string, args: MockNode[] = []): MockCommandRef {
  return { id: nid('cmd'), type: 'commandRef', commandName, args };
}

export function loopVar(name: string): MockLoopVar {
  return { id: nid('lv'), type: 'loopVar', name };
}

export function forRange(loopVarName = 'i'): MockForLoop {
  return {
    id: nid('for'),
    type: 'forLoop',
    loopVar: loopVarName,
    mode: 'range',
    init: binary(loopVar(loopVarName), '==', lit('0')),
    condition: binary(loopVar(loopVarName), '<', lit('3')),
    update: binary(loopVar(loopVarName), '+', lit('1')),
    iterable: null,
    body: [lit('ping '), loopVar(loopVarName)]
  };
}

export function group(children: MockNode[]): MockGroup {
  return { id: nid('g'), type: 'group', children };
}

export function emptyRoot(): MockRoot {
  return { id: nid('root'), type: 'root', children: [] };
}

export function rootOf(...children: MockNode[]): MockRoot {
  return { id: nid('root'), type: 'root', children };
}

export const STORAGE_LABEL: Record<MockVarStorage, string> = {
  memory: '%(name)',
  cache: '%(#name)',
  cacheUser: '%(##name)',
  db: '%(*name)',
  dbUser: '%(**name)'
};

export const BINARY_OPS: MockBinaryOp[] = [
  '==',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  '~=',
  '+',
  '-',
  '*',
  '/',
  '%'
];

export const PALETTE: PaletteItem[] = [
  {
    id: 'text',
    label: 'Text',
    hint: 'Plain chat text',
    category: 'say',
    factory: () => lit('Hello ')
  },
  {
    id: 'stack',
    label: 'Stack',
    hint: 'Group blocks together',
    category: 'say',
    factory: () => group([lit('Hi '), fn('user')])
  },
  {
    id: 'user',
    label: 'user',
    hint: '$(user)',
    category: 'value',
    factory: () => fn('user')
  },
  {
    id: 'touser',
    label: 'touser',
    hint: '$(touser)',
    category: 'value',
    factory: () => fn('touser')
  },
  {
    id: 'randomuser',
    label: 'randomuser',
    hint: '$(randomuser)',
    category: 'value',
    factory: () => fn('randomuser')
  },
  {
    id: 'count',
    label: 'count',
    hint: '$(count)',
    category: 'value',
    factory: () => fn('count')
  },
  {
    id: 'followage',
    label: 'followage',
    hint: '$(followage)',
    category: 'value',
    factory: () => fn('followage')
  },
  {
    id: 'twitch.title',
    label: 'twitch.title',
    hint: '$(twitch.title)',
    category: 'value',
    factory: () => fn('twitch.title')
  },
  {
    id: 'twitch.game',
    label: 'twitch.game',
    hint: '$(twitch.game)',
    category: 'value',
    factory: () => fn('twitch.game')
  },
  {
    id: 'twitch.viewers',
    label: 'twitch.viewers',
    hint: '$(twitch.viewers)',
    category: 'value',
    factory: () => fn('twitch.viewers')
  },
  {
    id: 'upper',
    label: 'upper',
    hint: '$(upper …)',
    category: 'value',
    factory: () => fn('upper', [fn('user')])
  },
  {
    id: 'random',
    label: 'random',
    hint: '$(random 1 10)',
    category: 'value',
    factory: () => fn('random', [lit('1'), lit('10')])
  },
  {
    id: 'getVar',
    label: 'Get var',
    hint: '%(name)',
    category: 'var',
    factory: () => getVar('target')
  },
  {
    id: 'setVar',
    label: 'Set var',
    hint: '%(name value)',
    category: 'var',
    factory: () => setVar('target', fn('touser'))
  },
  {
    id: 'setList',
    label: 'Set list',
    hint: '%(name[] %[...])',
    category: 'var',
    factory: () =>
      setVar('list', arrayLit([lit('one'), lit('two'), lit('three')]), 'memory', { type: 'append' })
  },
  {
    id: 'getItem',
    label: 'Item of list',
    hint: '%(name[0])',
    category: 'var',
    factory: () => getVar('list', 'memory', { type: 'index', index: lit('0') })
  },
  {
    id: 'exists',
    label: 'Exists',
    hint: '^(name)',
    category: 'var',
    factory: () => existsVar('target')
  },
  {
    id: 'deleteVar',
    label: 'Delete var',
    hint: '%del(name)',
    category: 'var',
    factory: () => deleteVar('target')
  },
  {
    id: 'compare',
    label: 'Compare',
    hint: '*(a == b)',
    category: 'logic',
    factory: () => binary(fn('user'), '==', lit('cdom201'))
  },
  {
    id: 'if',
    label: 'If / else',
    hint: '*(test ? a : b)',
    category: 'logic',
    factory: () =>
      ternary(binary(fn('user'), '==', lit('cdom201')), lit('Welcome back, boss'), group([lit('Hi '), fn('user')]))
  },
  {
    id: 'ban',
    label: 'ban',
    hint: '$(ban user seconds)',
    category: 'action',
    factory: () => fn('ban', [fn('touser'), lit('600')])
  },
  {
    id: 'vip',
    label: 'vip',
    hint: '$(vip user)',
    category: 'action',
    factory: () => fn('vip', [fn('touser')])
  },
  {
    id: 'chat.send',
    label: 'chat.send',
    hint: '$(chat.send …)',
    category: 'action',
    factory: () => fn('chat.send', [lit('Hello chat')])
  },
  {
    id: 'tts',
    label: 'tts',
    hint: '$(tts …)',
    category: 'action',
    factory: () => fn('tts', [lit('Hello'), fn('user')])
  },
  {
    id: 'delay',
    label: 'delay',
    hint: '$(delay ms)',
    category: 'action',
    factory: () => fn('delay', [lit('1000')])
  },
  {
    id: 'for',
    label: 'For loop',
    hint: '*(for #i … { })',
    category: 'flow',
    factory: () => forRange('i')
  },
  {
    id: 'cmd',
    label: 'Command',
    hint: '#(other)',
    category: 'flow',
    factory: () => commandRef('so', [fn('touser')])
  },
  {
    id: 'fn',
    label: 'Function',
    hint: '$(name …)',
    category: 'flow',
    factory: () => fn('user')
  }
];

export const PALETTE_CATEGORIES: { id: PaletteCategory; label: string }[] = [
  { id: 'say', label: 'Say' },
  { id: 'value', label: 'Values' },
  { id: 'var', label: 'Variables' },
  { id: 'logic', label: 'Logic' },
  { id: 'action', label: 'Actions' },
  { id: 'flow', label: 'Flow' }
];

export const SAMPLES: SampleRecipe[] = [
  {
    id: 'hello',
    label: 'Hello user',
    blurb: 'Hello $(user)!',
    build: () => rootOf(lit('Hello '), fn('user'), lit('!'))
  },
  {
    id: 'ban',
    label: 'Ban target',
    blurb: '%(target $(touser)) $(ban %(target) 600)',
    build: () => rootOf(setVar('target', fn('touser')), fn('ban', [getVar('target'), lit('600')]))
  },
  {
    id: 'followage',
    label: 'Followage',
    blurb: '$(user) has followed for $(followage)',
    build: () => rootOf(fn('user'), lit(' has followed for '), fn('followage'))
  },
  {
    id: 'if',
    label: 'If / else',
    blurb: 'Boss vs everyone else',
    build: () =>
      rootOf(
        ternary(
          binary(fn('user'), '==', lit('cdom201')),
          lit('Welcome back, boss'),
          group([lit('Hi '), fn('user')])
        )
      )
  },
  {
    id: 'count',
    label: 'Use count',
    blurb: 'Used $(count) times',
    build: () => rootOf(lit('This command has been used '), fn('count'), lit(' times'))
  },
  {
    id: 'loop',
    label: 'Range loop',
    blurb: '*(for #i …)',
    build: () => rootOf(forRange('i'))
  }
];

export function paletteById(id: string): PaletteItem | undefined {
  return PALETTE.find((item) => item.id === id);
}

export function isRoot(node: MockNode): node is MockRoot {
  return node.type === 'root';
}

export function cloneNode(node: MockNode, newIds = true): MockNode {
  const id = newIds ? nid(node.type.slice(0, 2)) : node.id;
  switch (node.type) {
    case 'literal':
      return { ...node, id };
    case 'function':
      return { ...node, id, args: node.args.map((child) => cloneNode(child, newIds)) };
    case 'getVar':
      return {
        ...node,
        id,
        userSelector: node.userSelector ? cloneNode(node.userSelector, newIds) : node.userSelector,
        accessor:
          node.accessor?.type === 'index' || node.accessor?.type === 'setIndex'
            ? { ...node.accessor, index: node.accessor.index ? cloneNode(node.accessor.index, newIds) : null }
            : node.accessor
      };
    case 'exists':
    case 'deleteVar':
      return {
        ...node,
        id,
        userSelector: node.userSelector ? cloneNode(node.userSelector, newIds) : node.userSelector
      };
    case 'loopVar':
      return { ...node, id };
    case 'setVar':
      return {
        ...node,
        id,
        value: node.value ? cloneNode(node.value, newIds) : null,
        userSelector: node.userSelector ? cloneNode(node.userSelector, newIds) : node.userSelector,
        accessor:
          node.accessor?.type === 'index' || node.accessor?.type === 'setIndex'
            ? { ...node.accessor, index: node.accessor.index ? cloneNode(node.accessor.index, newIds) : null }
            : node.accessor
      };
    case 'arrayLiteral':
      return { ...node, id, items: node.items.map((child) => cloneNode(child, newIds)) };
    case 'binary':
      return {
        ...node,
        id,
        left: node.left ? cloneNode(node.left, newIds) : null,
        right: node.right ? cloneNode(node.right, newIds) : null
      };
    case 'ternary':
      return {
        ...node,
        id,
        test: node.test ? cloneNode(node.test, newIds) : null,
        consequent: node.consequent ? cloneNode(node.consequent, newIds) : null,
        alternate: node.alternate ? cloneNode(node.alternate, newIds) : null
      };
    case 'commandRef':
      return { ...node, id, args: node.args.map((child) => cloneNode(child, newIds)) };
    case 'forLoop':
      return {
        ...node,
        id,
        init: node.init ? cloneNode(node.init, newIds) : null,
        condition: node.condition ? cloneNode(node.condition, newIds) : null,
        update: node.update ? cloneNode(node.update, newIds) : null,
        iterable: node.iterable ? cloneNode(node.iterable, newIds) : null,
        body: node.body.map((child) => cloneNode(child, newIds))
      };
    case 'template':
      return { ...node, id, parts: node.parts.map((child) => cloneNode(child, newIds)) };
    case 'group':
    case 'root':
      return { ...node, id, children: node.children.map((child) => cloneNode(child, newIds)) };
  }
}

export function findNode(node: MockNode, id: string): MockNode | null {
  if (node.id === id) return node;
  for (const child of childNodes(node)) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function containsId(node: MockNode, id: string): boolean {
  return findNode(node, id) !== null;
}

export function childNodes(node: MockNode): MockNode[] {
  switch (node.type) {
    case 'root':
    case 'group':
      return node.children;
    case 'template':
      return node.parts;
    case 'function':
    case 'commandRef':
      return node.args;
    case 'setVar': {
      const kids = node.value ? [node.value] : [];
      if (node.userSelector) kids.push(node.userSelector);
      if ((node.accessor?.type === 'index' || node.accessor?.type === 'setIndex') && node.accessor.index) {
        kids.push(node.accessor.index);
      }
      return kids;
    }
    case 'arrayLiteral':
      return node.items;
    case 'getVar':
    case 'exists':
    case 'deleteVar': {
      const kids: MockNode[] = [];
      if (node.userSelector) kids.push(node.userSelector);
      if (
        node.type === 'getVar' &&
        (node.accessor?.type === 'index' || node.accessor?.type === 'setIndex') &&
        node.accessor.index
      ) {
        kids.push(node.accessor.index);
      }
      return kids;
    }
    case 'binary':
      return [node.left, node.right].filter((child): child is MockNode => child !== null);
    case 'ternary':
      return [node.test, node.consequent, node.alternate].filter(
        (child): child is MockNode => child !== null
      );
    case 'forLoop':
      return [node.init, node.condition, node.update, node.iterable, ...node.body].filter(
        (child): child is MockNode => child !== null
      );
    default:
      return [];
  }
}

function mapList(nodes: MockNode[], fn: (node: MockNode) => MockNode | null): MockNode[] {
  const next: MockNode[] = [];
  for (const node of nodes) {
    const mapped = fn(node);
    if (mapped) next.push(mapped);
  }
  return next;
}

export function transformTree(node: MockNode, fn: (node: MockNode) => MockNode | null): MockNode | null {
  let current: MockNode = node;
  switch (current.type) {
    case 'function':
    case 'commandRef':
      current = { ...current, args: mapList(current.args, (child) => transformTree(child, fn)) };
      break;
    case 'setVar':
      current = {
        ...current,
        value: current.value ? transformTree(current.value, fn) : null,
        userSelector: current.userSelector ? transformTree(current.userSelector, fn) : current.userSelector,
        accessor:
          current.accessor?.type === 'index' || current.accessor?.type === 'setIndex'
            ? {
                ...current.accessor,
                index: current.accessor.index ? transformTree(current.accessor.index, fn) : null
              }
            : current.accessor
      };
      break;
    case 'arrayLiteral':
      current = { ...current, items: mapList(current.items, (child) => transformTree(child, fn)) };
      break;
    case 'getVar':
    case 'exists':
    case 'deleteVar':
      current = {
        ...current,
        userSelector: current.userSelector ? transformTree(current.userSelector, fn) : current.userSelector,
        ...(current.type === 'getVar'
          ? {
              accessor:
                current.accessor?.type === 'index' || current.accessor?.type === 'setIndex'
                  ? {
                      ...current.accessor,
                      index: current.accessor.index ? transformTree(current.accessor.index, fn) : null
                    }
                  : current.accessor
            }
          : {})
      } as MockNode;
      break;
    case 'binary':
      current = {
        ...current,
        left: current.left ? transformTree(current.left, fn) : null,
        right: current.right ? transformTree(current.right, fn) : null
      };
      break;
    case 'ternary':
      current = {
        ...current,
        test: current.test ? transformTree(current.test, fn) : null,
        consequent: current.consequent ? transformTree(current.consequent, fn) : null,
        alternate: current.alternate ? transformTree(current.alternate, fn) : null
      };
      break;
    case 'forLoop':
      current = {
        ...current,
        init: current.init ? transformTree(current.init, fn) : null,
        condition: current.condition ? transformTree(current.condition, fn) : null,
        update: current.update ? transformTree(current.update, fn) : null,
        iterable: current.iterable ? transformTree(current.iterable, fn) : null,
        body: mapList(current.body, (child) => transformTree(child, fn))
      };
      break;
    case 'template':
      current = { ...current, parts: mapList(current.parts, (child) => transformTree(child, fn)) };
      break;
    case 'group':
    case 'root':
      current = { ...current, children: mapList(current.children, (child) => transformTree(child, fn)) };
      break;
    default:
      break;
  }
  return fn(current);
}

export function removeNode(root: MockRoot, id: string): MockRoot {
  if (root.id === id) return root;
  const next = transformTree(root, (node) => (node.id === id ? null : node));
  return next && next.type === 'root' ? next : root;
}

export function patchNode(root: MockRoot, id: string, patch: Partial<MockNode>): MockRoot {
  const next = transformTree(root, (node) => (node.id === id ? ({ ...node, ...patch } as MockNode) : node));
  return next && next.type === 'root' ? next : root;
}

function insertInList(list: MockNode[], index: number, node: MockNode): MockNode[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), node, ...list.slice(at)];
}

export function insertNode(root: MockRoot, target: DropTarget, node: MockChildNode): MockRoot {
  if (target.kind === 'root') {
    return { ...root, children: insertInList(root.children, target.index, node) };
  }

  const next = transformTree(root, (current) => {
    if (current.id !== target.parentId) return current;
    if (target.kind === 'list') {
      if (current.type === 'root' || current.type === 'group') {
        if (target.slot !== 'children') return current;
        return { ...current, children: insertInList(current.children, target.index, node) };
      }
      if (current.type === 'function' || current.type === 'commandRef') {
        if (target.slot !== 'args') return current;
        return { ...current, args: insertInList(current.args, target.index, node) };
      }
      if (current.type === 'forLoop' && target.slot === 'body') {
        return { ...current, body: insertInList(current.body, target.index, node) };
      }
      if (current.type === 'arrayLiteral' && target.slot === 'items') {
        return { ...current, items: insertInList(current.items, target.index, node) };
      }
      if (current.type === 'setVar' && target.slot === 'items') {
        const items = current.value?.type === 'arrayLiteral' ? current.value.items : [];
        const nextItems = insertInList(items, target.index, node);
        const arr: MockArrayLiteral =
          current.value?.type === 'arrayLiteral'
            ? { ...current.value, items: nextItems }
            : arrayLit(nextItems);
        return { ...current, value: arr, accessor: current.accessor ?? { type: 'append' } };
      }
      return current;
    }
    if (
      (current.type === 'setVar' && target.slot === 'value') ||
      (current.type === 'binary' && (target.slot === 'left' || target.slot === 'right')) ||
      (current.type === 'ternary' &&
        (target.slot === 'test' || target.slot === 'consequent' || target.slot === 'alternate')) ||
      (current.type === 'forLoop' &&
        (target.slot === 'init' ||
          target.slot === 'condition' ||
          target.slot === 'update' ||
          target.slot === 'iterable'))
    ) {
      return { ...current, [target.slot]: node } as MockNode;
    }
    return current;
  });

  return next && next.type === 'root' ? next : root;
}

export function moveNode(root: MockRoot, nodeId: string, target: DropTarget): MockRoot {
  const found = findNode(root, nodeId);
  if (!found || found.type === 'root') return root;
  if (target.kind !== 'root') {
    const parent = findNode(root, target.parentId);
    if (parent && containsId(found, target.parentId)) return root;
  }
  const stripped = removeNode(root, nodeId);
  return insertNode(stripped, target, found);
}

export function blockTone(type: MockNode['type']): string {
  switch (type) {
    case 'literal':
    case 'template':
      return 'text';
    case 'function':
      return 'fn';
    case 'getVar':
    case 'setVar':
    case 'exists':
    case 'deleteVar':
    case 'arrayLiteral':
      return 'var';
    case 'binary':
    case 'ternary':
      return 'logic';
    case 'commandRef':
    case 'forLoop':
    case 'loopVar':
    case 'group':
      return 'flow';
    default:
      return 'text';
  }
}

export type BlockShape = 'stack' | 'oval' | 'hex' | 'c';

export function blockShape(node: MockNode, inset: boolean): BlockShape {
  if (node.type === 'forLoop' || node.type === 'ternary' || node.type === 'group') return 'c';
  if (node.type === 'arrayLiteral' || (node.type === 'setVar' && isListSet(node))) return 'c';
  if (node.type === 'template') return inset ? 'oval' : 'stack';
  if (node.type === 'binary') return 'hex';
  if (inset) return 'oval';
  return 'stack';
}
