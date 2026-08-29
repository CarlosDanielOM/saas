import { Injectable, computed, signal } from '@angular/core';

import {
  type DropTarget,
  type MockNode,
  type MockRoot,
  type PaletteItem,
  SAMPLES,
  emptyRoot,
  insertNode,
  lit,
  moveNode,
  paletteById,
  patchNode,
  removeNode
} from './command-ast-mock.model';
import { DEFAULT_MOCK_CONTEXT, type MockChatContext, mockEvaluate } from './command-ast-mock.eval';
import { parseSource } from './command-ast-mock.parse';
import { astPreview, toSource } from './command-ast-mock.source';

export type DragPayload = { mode: 'new'; itemId: string } | { mode: 'move'; nodeId: string };

@Injectable()
export class CommandAstMockStore {
  readonly root = signal<MockRoot>(SAMPLES[0].build());
  readonly selectedId = signal<string | null>(null);
  readonly dropTarget = signal<DropTarget | null>(null);
  readonly dragging = signal<DragPayload | null>(null);
  readonly hoverTarget = signal<DropTarget | null>(null);
  readonly runOutput = signal<string>('');
  readonly runError = signal<string | null>(null);
  readonly parseError = signal<string | null>(null);
  readonly context = signal<MockChatContext>({ ...DEFAULT_MOCK_CONTEXT });

  private readonly history = signal<MockRoot[]>([this.root()]);
  private readonly historyIndex = signal(0);

  readonly draggingNow = computed(() => this.dragging() !== null);
  readonly source = computed(() => toSource(this.root()));
  readonly astJson = computed(() => astPreview(this.root()));
  readonly canUndo = computed(() => this.historyIndex() > 0);
  readonly canRedo = computed(() => this.historyIndex() < this.history().length - 1);
  readonly selectedNode = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return findById(this.root(), id);
  });

  select(id: string | null): void {
    this.selectedId.set(id);
  }

  setDropTarget(target: DropTarget | null): void {
    this.dropTarget.set(target);
    if (target && target.kind !== 'root') {
      this.selectedId.set(target.parentId);
    }
  }

  loadSample(id: string): void {
    const sample = SAMPLES.find((item) => item.id === id);
    if (!sample) return;
    this.commit(sample.build());
    this.selectedId.set(null);
    this.dropTarget.set(null);
    this.runOutput.set('');
    this.runError.set(null);
    this.parseError.set(null);
  }

  clear(): void {
    this.commit(emptyRoot());
    this.selectedId.set(null);
    this.dropTarget.set(null);
    this.runOutput.set('');
    this.runError.set(null);
    this.parseError.set(null);
  }

  loadFromSource(text: string): void {
    const { root, error } = parseSource(text);
    if (error) {
      this.parseError.set(error);
      return;
    }
    this.parseError.set(null);
    this.commit(root);
    this.selectedId.set(null);
    this.dropTarget.set(null);
  }

  addListItem(parentId: string, index?: number): void {
    const node = lit('');
    const parent = findById(this.root(), parentId);
    let at = index ?? 0;
    if (index === undefined) {
      if (parent?.type === 'arrayLiteral') at = parent.items.length;
      else if (parent?.type === 'setVar' && parent.value?.type === 'arrayLiteral') {
        at = parent.value.items.length;
      }
    }
    this.commit(insertNode(this.root(), { kind: 'list', parentId, slot: 'items', index: at }, node));
    this.selectedId.set(node.id);
  }

  placePalette(item: PaletteItem): void {
    const node = item.factory();
    const target = this.dropTarget() ?? { kind: 'root', index: this.root().children.length };
    this.commit(insertNode(this.root(), target, node));
    this.selectedId.set(node.id);
  }

  startDragNew(itemId: string): void {
    this.dragging.set({ mode: 'new', itemId });
  }

  startDragMove(nodeId: string): void {
    this.dragging.set({ mode: 'move', nodeId });
  }

  endDrag(): void {
    this.dragging.set(null);
    this.hoverTarget.set(null);
  }

  dropOn(target: DropTarget): void {
    const drag = this.dragging();
    if (!drag) return;
    if (drag.mode === 'new') {
      const item = paletteById(drag.itemId);
      if (!item) return;
      const node = item.factory();
      this.commit(insertNode(this.root(), target, node));
      this.selectedId.set(node.id);
    } else {
      this.commit(moveNode(this.root(), drag.nodeId, target));
      this.selectedId.set(drag.nodeId);
    }
    this.dropTarget.set(target);
    this.endDrag();
  }

  removeSelected(): void {
    const id = this.selectedId();
    if (!id) return;
    this.commit(removeNode(this.root(), id));
    this.selectedId.set(null);
  }

  remove(id: string): void {
    this.commit(removeNode(this.root(), id));
    if (this.selectedId() === id) this.selectedId.set(null);
  }

  patch(id: string, patch: Partial<MockNode>): void {
    this.commit(patchNode(this.root(), id, patch));
  }

  undo(): void {
    const index = this.historyIndex();
    if (index <= 0) return;
    const next = index - 1;
    this.historyIndex.set(next);
    this.root.set(this.history()[next]);
  }

  redo(): void {
    const index = this.historyIndex();
    const hist = this.history();
    if (index >= hist.length - 1) return;
    const next = index + 1;
    this.historyIndex.set(next);
    this.root.set(hist[next]);
  }

  run(): void {
    try {
      this.runError.set(null);
      this.runOutput.set(mockEvaluate(this.root(), this.context()));
    } catch (err) {
      this.runOutput.set('');
      this.runError.set(err instanceof Error ? err.message : 'Mock run failed');
    }
  }

  patchContext(patch: Partial<MockChatContext>): void {
    this.context.update((current) => ({ ...current, ...patch }));
  }

  sameTarget(a: DropTarget | null, b: DropTarget): boolean {
    if (!a) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'root' && b.kind === 'root') return a.index === b.index;
    if (a.kind === 'list' && b.kind === 'list') {
      return a.parentId === b.parentId && a.slot === b.slot && a.index === b.index;
    }
    if (a.kind === 'single' && b.kind === 'single') {
      return a.parentId === b.parentId && a.slot === b.slot;
    }
    return false;
  }

  private commit(next: MockRoot): void {
    const hist = this.history().slice(0, this.historyIndex() + 1);
    hist.push(next);
    if (hist.length > 40) hist.shift();
    this.history.set(hist);
    this.historyIndex.set(hist.length - 1);
    this.root.set(next);
  }
}

function findById(node: MockNode, id: string): MockNode | null {
  if (node.id === id) return node;
  const kids: MockNode[] = [];
  switch (node.type) {
    case 'root':
    case 'group':
      kids.push(...node.children);
      break;
    case 'function':
    case 'commandRef':
      kids.push(...node.args);
      break;
    case 'setVar':
      if (node.value) kids.push(node.value);
      break;
    case 'arrayLiteral':
      kids.push(...node.items);
      break;
    case 'getVar':
      if ((node.accessor?.type === 'index' || node.accessor?.type === 'setIndex') && node.accessor.index) {
        kids.push(node.accessor.index);
      }
      break;
    case 'binary':
      if (node.left) kids.push(node.left);
      if (node.right) kids.push(node.right);
      break;
    case 'ternary':
      if (node.test) kids.push(node.test);
      if (node.consequent) kids.push(node.consequent);
      if (node.alternate) kids.push(node.alternate);
      break;
    case 'forLoop':
      if (node.init) kids.push(node.init);
      if (node.condition) kids.push(node.condition);
      if (node.update) kids.push(node.update);
      if (node.iterable) kids.push(node.iterable);
      kids.push(...node.body);
      break;
    default:
      break;
  }
  for (const child of kids) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}
