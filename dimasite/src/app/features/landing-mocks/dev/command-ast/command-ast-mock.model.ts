export type MockVarStorage = 'memory' | 'cache' | 'cacheUser' | 'db' | 'dbUser';
export type MockBinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '~=';

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

export const STORAGE_OPTIONS: { id: MockVarStorage; mark: string; label: string; short: string; hint: string }[] = [
  { id: 'memory', mark: 'tmp', label: 'Just this run', short: 'this run', hint: 'Forgotten as soon as the command finishes.' },
  { id: 'cache', mark: '#', label: 'Until the stream ends', short: 'this stream', hint: 'Shared by everyone in chat, cleared after the stream.' },
  { id: 'cacheUser', mark: '##', label: 'Per viewer, this stream', short: 'per viewer', hint: 'Each viewer gets their own value until the stream ends.' },
  { id: 'db', mark: '*', label: 'Saved for the channel', short: 'saved', hint: 'Kept across streams, e.g. a death counter.' },
  { id: 'dbUser', mark: '**', label: 'Saved per viewer', short: 'saved per viewer', hint: 'Kept across streams for each viewer, e.g. points.' }
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


export interface ParentSlot {
  parentId: string;
  slot: ListSlot | SingleSlot;
  /** Position inside a list slot; -1 for single slots. */
  index: number;
  length: number;
}

/** Where a node lives: its parent and the list/slot that holds it. */
export function findParent(root: MockRoot, id: string): ParentSlot | null {
  const visit = (node: MockNode): ParentSlot | null => {
    const lists: [ListSlot, MockNode[]][] = [];
    const singles: [SingleSlot, MockNode | null | undefined][] = [];
    switch (node.type) {
      case 'root':
      case 'group':
        lists.push(['children', node.children]);
        break;
      case 'function':
      case 'commandRef':
        lists.push(['args', node.args]);
        break;
      case 'arrayLiteral':
        lists.push(['items', node.items]);
        break;
      case 'forLoop':
        lists.push(['body', node.body]);
        singles.push(['init', node.init], ['condition', node.condition], ['update', node.update], ['iterable', node.iterable]);
        break;
      case 'setVar':
        if (node.value?.type === 'arrayLiteral') lists.push(['items', node.value.items]);
        else singles.push(['value', node.value]);
        break;
      case 'binary':
        singles.push(['left', node.left], ['right', node.right]);
        break;
      case 'ternary':
        singles.push(['test', node.test], ['consequent', node.consequent], ['alternate', node.alternate]);
        break;
      default:
        break;
    }
    for (const [slot, list] of lists) {
      const index = list.findIndex((child) => child.id === id);
      if (index >= 0) return { parentId: node.id, slot, index, length: list.length };
    }
    for (const [slot, child] of singles) {
      if (child?.id === id) return { parentId: node.id, slot, index: -1, length: 1 };
    }
    for (const child of childNodes(node)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root);
}
