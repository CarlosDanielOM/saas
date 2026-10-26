/**
 * Block tree for the command block editor. Same JSON shape as the server
 * (dimabot/src/utils/ast_blocks/types.ts); the server compiles it to command
 * text and checks it reads back the same. Slots may be null while editing.
 */
export type VarStorage = 'memory' | 'cache' | 'cacheUser' | 'db' | 'dbUser';
export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '~=' | '=' | '<>';
export type LoopAssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '++' | '--';

export type ArrayAccessor =
  | { type: 'array' }
  | { type: 'append' }
  | { type: 'random' }
  | { type: 'length' }
  | { type: 'clear' }
  | { type: 'index'; index: BlockNode | null }
  | { type: 'setIndex'; index: BlockNode | null }
  | { type: 'remove'; index: BlockNode | null };

interface Base {
  id: string;
}

export interface LiteralNode extends Base { type: 'literal'; value: string }
/** An expression blocks can't show yet, kept as its exact text (top level only). */
export interface RawNode extends Base { type: 'raw'; source: string }
export interface FunctionNode extends Base { type: 'function'; name: string; args: BlockNode[] }
export interface CommandRefNode extends Base { type: 'commandRef'; commandName: string; args: BlockNode[] }
interface VarBase extends Base { name: string; storage: VarStorage; accessor?: ArrayAccessor; userSelector?: BlockNode | null }
export interface GetVarNode extends VarBase { type: 'getVar' }
export interface ExistsNode extends VarBase { type: 'exists' }
export interface DeleteVarNode extends VarBase { type: 'deleteVar' }
export interface SetVarNode extends VarBase { type: 'setVar'; value: BlockNode | null }
export interface BinaryNode extends Base { type: 'binary'; operator: BinaryOp; left: BlockNode | null; right: BlockNode | null }
export interface UnaryNode extends Base { type: 'unary'; operator: '+' | '-'; argument: BlockNode | null }
export interface TernaryNode extends Base { type: 'ternary'; test: BlockNode | null; consequent: BlockNode | null; alternate: BlockNode | null }
export interface TemplateNode extends Base { type: 'template'; parts: BlockNode[] }
export interface ArrayLiteralNode extends Base { type: 'arrayLiteral'; items: BlockNode[]; accessor?: ArrayAccessor }
export interface LoopVarNode extends Base { type: 'loopVar'; name: string }
export interface LoopAssignNode extends Base { type: 'loopAssign'; name: string; operator: LoopAssignOp; value?: BlockNode | null }
export interface ForLoopNode extends Base {
  type: 'forLoop';
  loopVar: string;
  mode: 'range' | 'foreach';
  init?: BlockNode | null;
  condition?: BlockNode | null;
  update?: BlockNode | null;
  iterable?: BlockNode | null;
  body: BlockNode[];
}
export interface GroupNode extends Base { type: 'group'; children: BlockNode[] }
export interface RootNode extends Base { type: 'root'; children: BlockNode[] }

export type BlockNode =
  | LiteralNode
  | RawNode
  | FunctionNode
  | CommandRefNode
  | GetVarNode
  | SetVarNode
  | ExistsNode
  | DeleteVarNode
  | BinaryNode
  | UnaryNode
  | TernaryNode
  | TemplateNode
  | ArrayLiteralNode
  | LoopVarNode
  | LoopAssignNode
  | ForLoopNode
  | GroupNode;

export type AnyNode = BlockNode | RootNode;

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
  | 'iterable'
  | 'argument'
  | 'userSelector';

export type ListSlot = 'children' | 'args' | 'body' | 'items' | 'parts';

export type DropTarget =
  | { kind: 'root'; index: number }
  | { kind: 'list'; parentId: string; slot: ListSlot; index: number }
  | { kind: 'single'; parentId: string; slot: SingleSlot };

const SINGLE_SLOTS: Partial<Record<AnyNode['type'], SingleSlot[]>> = {
  setVar: ['value', 'userSelector'],
  getVar: ['userSelector'],
  exists: ['userSelector'],
  deleteVar: ['userSelector'],
  binary: ['left', 'right'],
  unary: ['argument'],
  ternary: ['test', 'consequent', 'alternate'],
  loopAssign: ['value'],
  forLoop: ['init', 'condition', 'update', 'iterable']
};

const LIST_SLOTS: Partial<Record<AnyNode['type'], ListSlot[]>> = {
  root: ['children'],
  group: ['children'],
  function: ['args'],
  commandRef: ['args'],
  arrayLiteral: ['items'],
  template: ['parts'],
  forLoop: ['body']
};

let seq = 0;

export function nid(prefix = 'b'): string {
  seq += 1;
  return `${prefix}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- constructors ----------

export const lit = (value: string): LiteralNode => ({ id: nid('t'), type: 'literal', value });
export const fn = (name: string, args: BlockNode[] = []): FunctionNode => ({ id: nid('f'), type: 'function', name, args });
export const commandRef = (commandName: string, args: BlockNode[] = []): CommandRefNode => ({ id: nid('c'), type: 'commandRef', commandName, args });
export const getVar = (name: string, storage: VarStorage = 'memory', accessor?: ArrayAccessor): GetVarNode =>
  withAccessor({ id: nid('g'), type: 'getVar', name, storage }, accessor);
export const setVar = (name: string, value: BlockNode | null, storage: VarStorage = 'memory', accessor?: ArrayAccessor): SetVarNode =>
  withAccessor({ id: nid('s'), type: 'setVar', name, storage, value }, accessor);
export const existsVar = (name: string, storage: VarStorage = 'memory'): ExistsNode => ({ id: nid('e'), type: 'exists', name, storage });
export const deleteVar = (name: string, storage: VarStorage = 'memory'): DeleteVarNode => ({ id: nid('d'), type: 'deleteVar', name, storage });
export const binary = (left: BlockNode | null, operator: BinaryOp, right: BlockNode | null): BinaryNode =>
  ({ id: nid('o'), type: 'binary', operator, left, right });
export const ternary = (test: BlockNode | null, consequent: BlockNode | null, alternate: BlockNode | null): TernaryNode =>
  ({ id: nid('i'), type: 'ternary', test, consequent, alternate });
export const template = (parts: BlockNode[]): TemplateNode => ({ id: nid('q'), type: 'template', parts });
export const group = (children: BlockNode[]): GroupNode => ({ id: nid('p'), type: 'group', children });
export const arrayLit = (items: BlockNode[]): ArrayLiteralNode => ({ id: nid('a'), type: 'arrayLiteral', items });
export const loopVar = (name: string): LoopVarNode => ({ id: nid('l'), type: 'loopVar', name });
export const loopAssign = (name: string, operator: LoopAssignOp, value?: BlockNode | null): LoopAssignNode =>
  operator === '++' || operator === '--' ? { id: nid('m'), type: 'loopAssign', name, operator } : { id: nid('m'), type: 'loopAssign', name, operator, value: value ?? lit('0') };

export function forRange(name = 'i', times = '3', body: BlockNode[] = []): ForLoopNode {
  return {
    id: nid('r'),
    type: 'forLoop',
    loopVar: name,
    mode: 'range',
    init: loopAssign(name, '=', lit('0')),
    condition: binary(loopVar(name), '<', lit(times)),
    update: loopAssign(name, '++'),
    body
  };
}

export function forEach(name = 'item', iterable: BlockNode | null = null, body: BlockNode[] = []): ForLoopNode {
  return { id: nid('r'), type: 'forLoop', loopVar: name, mode: 'foreach', iterable, body };
}

export const emptyRoot = (): RootNode => ({ id: nid('root'), type: 'root', children: [] });
export const rootOf = (...children: BlockNode[]): RootNode => ({ id: nid('root'), type: 'root', children });

function withAccessor<T extends VarBase>(node: T, accessor?: ArrayAccessor): T {
  return accessor ? { ...node, accessor } : node;
}

export const STORAGE_IDS: VarStorage[] = ['memory', 'cache', 'cacheUser', 'db', 'dbUser'];
export const STORAGE_MARK: Record<VarStorage, string> = { memory: '', cache: '#', cacheUser: '##', db: '*', dbUser: '**' };
export const COMPARE_OPS: BinaryOp[] = ['==', '!=', '>', '<', '>=', '<=', '~='];
export const MATH_OPS: BinaryOp[] = ['+', '-', '*', '/', '%'];

export function isPerViewer(storage: VarStorage): boolean {
  return storage === 'cacheUser' || storage === 'dbUser';
}

export function isListSet(node: SetVarNode): boolean {
  const acc = node.accessor?.type;
  return acc === 'append' || node.value?.type === 'arrayLiteral';
}

export function listItems(node: SetVarNode | ArrayLiteralNode): BlockNode[] {
  if (node.type === 'arrayLiteral') return node.items;
  return node.value?.type === 'arrayLiteral' ? node.value.items : [];
}

function accessorIndex(node: AnyNode): BlockNode | null {
  const acc = 'accessor' in node ? node.accessor : undefined;
  return acc && 'index' in acc ? acc.index : null;
}

// ---------- traversal ----------

export function childNodes(node: AnyNode): BlockNode[] {
  const out: BlockNode[] = [];
  const rec = node as unknown as Record<string, unknown>;
  for (const slot of LIST_SLOTS[node.type] ?? []) out.push(...((rec[slot] as BlockNode[]) ?? []));
  for (const slot of SINGLE_SLOTS[node.type] ?? []) {
    const child = rec[slot] as BlockNode | null | undefined;
    if (child) out.push(child);
  }
  const index = accessorIndex(node);
  if (index) out.push(index);
  return out;
}

export function findNode(node: AnyNode, id: string): AnyNode | null {
  if (node.id === id) return node;
  for (const child of childNodes(node)) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function containsId(node: AnyNode, id: string): boolean {
  return findNode(node, id) !== null;
}

/** Rebuilds the tree bottom-up; `fn` may return null to drop a node from a list (single slots become null). */
export function transformTree(node: AnyNode, fn: (node: AnyNode) => AnyNode | null): AnyNode | null {
  const rec = { ...(node as unknown as Record<string, unknown>) };
  for (const slot of LIST_SLOTS[node.type] ?? []) {
    const list = (rec[slot] as BlockNode[]) ?? [];
    rec[slot] = list.map((child) => transformTree(child, fn)).filter((child): child is BlockNode => child !== null);
  }
  for (const slot of SINGLE_SLOTS[node.type] ?? []) {
    const child = rec[slot] as BlockNode | null | undefined;
    if (child) rec[slot] = transformTree(child, fn);
  }
  const acc = rec['accessor'] as ArrayAccessor | undefined;
  if (acc && 'index' in acc && acc.index) {
    rec['accessor'] = { ...acc, index: transformTree(acc.index, fn) };
  }
  return fn(rec as unknown as AnyNode);
}

export function cloneNode<T extends AnyNode>(node: T): T {
  return transformTree(node, (current) => ({ ...current, id: nid(current.type.slice(0, 2)) })) as T;
}

export function removeNode(root: RootNode, id: string): RootNode {
  if (root.id === id) return root;
  const next = transformTree(root, (node) => (node.id === id ? null : node));
  return next?.type === 'root' ? next : root;
}

export function patchNode(root: RootNode, id: string, patch: Partial<BlockNode>): RootNode {
  const next = transformTree(root, (node) => (node.id === id ? ({ ...node, ...patch } as AnyNode) : node));
  return next?.type === 'root' ? next : root;
}

function insertInList(list: BlockNode[], index: number, node: BlockNode): BlockNode[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), node, ...list.slice(at)];
}

export function insertNode(root: RootNode, target: DropTarget, node: BlockNode): RootNode {
  if (target.kind === 'root') return { ...root, children: insertInList(root.children, target.index, node) };
  const next = transformTree(root, (current) => {
    if (current.id !== target.parentId) return current;
    const rec = current as unknown as Record<string, unknown>;
    if (target.kind === 'list') {
      // A list variable's items live in its value.
      if (current.type === 'setVar' && target.slot === 'items') {
        const items = current.value?.type === 'arrayLiteral' ? current.value.items : [];
        const arr = current.value?.type === 'arrayLiteral'
          ? { ...current.value, items: insertInList(items, target.index, node) }
          : arrayLit(insertInList(items, target.index, node));
        return { ...current, value: arr, accessor: current.accessor ?? { type: 'append' } };
      }
      if (!(LIST_SLOTS[current.type] ?? []).includes(target.slot)) return current;
      return { ...current, [target.slot]: insertInList((rec[target.slot] as BlockNode[]) ?? [], target.index, node) } as AnyNode;
    }
    if (!(SINGLE_SLOTS[current.type] ?? []).includes(target.slot)) return current;
    return { ...current, [target.slot]: node } as AnyNode;
  });
  return next?.type === 'root' ? next : root;
}

export function moveNode(root: RootNode, nodeId: string, target: DropTarget): RootNode {
  const found = findNode(root, nodeId);
  if (!found || found.type === 'root') return root;
  if (target.kind !== 'root' && containsId(found, target.parentId)) return root;
  return insertNode(removeNode(root, nodeId), target, found);
}

export interface ParentSlot {
  parentId: string;
  slot: ListSlot | SingleSlot;
  /** Position inside a list slot; -1 for single slots. */
  index: number;
  length: number;
}

/** Where a node lives: its parent and the list/slot that holds it. */
export function findParent(root: RootNode, id: string): ParentSlot | null {
  const visit = (node: AnyNode): ParentSlot | null => {
    const rec = node as unknown as Record<string, unknown>;
    const lists: [ListSlot, BlockNode[]][] = (LIST_SLOTS[node.type] ?? []).map((slot) => [slot, (rec[slot] as BlockNode[]) ?? []]);
    if (node.type === 'setVar' && node.value?.type === 'arrayLiteral') lists.push(['items', node.value.items]);
    for (const [slot, list] of lists) {
      const index = list.findIndex((child) => child.id === id);
      if (index >= 0) return { parentId: node.id, slot, index, length: list.length };
    }
    for (const slot of SINGLE_SLOTS[node.type] ?? []) {
      if ((rec[slot] as BlockNode | null | undefined)?.id === id) return { parentId: node.id, slot, index: -1, length: 1 };
    }
    for (const child of childNodes(node)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root);
}

export function countBlocks(node: AnyNode): number {
  return 1 + childNodes(node).reduce((sum, child) => sum + countBlocks(child), 0);
}

/** All plain text in the tree, e.g. to find `&p1` / `&t` argument placeholders or to search. */
export function plainText(node: AnyNode): string {
  const own = node.type === 'literal' ? node.value : node.type === 'raw' ? node.source : '';
  return [own, ...childNodes(node).map(plainText)].filter(Boolean).join(' ');
}

/** Stored shape: `{ v, root }` from the API; tolerant of bad data (returns null). */
export function rootFromStored(value: unknown): RootNode | null {
  if (!value || typeof value !== 'object') return null;
  const root = (value as { root?: unknown }).root;
  if (!root || typeof root !== 'object' || (root as RootNode).type !== 'root' || !Array.isArray((root as RootNode).children)) return null;
  return root as RootNode;
}

// ---------- variables ----------

type VarNode = GetVarNode | SetVarNode | ExistsNode | DeleteVarNode;

export interface KnownVariable {
  name: string;
  storage: VarStorage;
  /** A Set variable block in this command writes it. */
  setHere: boolean;
}

function isVarNode(node: AnyNode): node is VarNode {
  return node.type === 'getVar' || node.type === 'setVar' || node.type === 'exists' || node.type === 'deleteVar';
}

/** Every variable this command touches, once per name + place, in order of first use. */
export function knownVariables(root: RootNode): KnownVariable[] {
  const found = new Map<string, KnownVariable>();
  const visit = (node: AnyNode): void => {
    if (isVarNode(node) && node.name) {
      const key = `${node.storage}:${node.name}`;
      const prev = found.get(key);
      found.set(key, { name: node.name, storage: node.storage, setHere: (prev?.setHere ?? false) || node.type === 'setVar' });
    }
    childNodes(node).forEach(visit);
  };
  visit(root);
  return [...found.values()];
}

/** Moves every block for `name` in `from` to `to` (the name in another place is a different variable). */
export function moveVariable(root: RootNode, name: string, from: VarStorage, to: VarStorage): RootNode {
  const next = transformTree(root, (node) =>
    isVarNode(node) && node.name === name && node.storage === from
      ? ({ ...node, storage: to, ...(isPerViewer(to) ? {} : { userSelector: null }) } as AnyNode)
      : node
  );
  return next?.type === 'root' ? next : root;
}
