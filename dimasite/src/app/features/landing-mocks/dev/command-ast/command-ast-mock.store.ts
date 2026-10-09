import { Injectable, computed, signal } from '@angular/core';

import { type LibraryItem, STARTERS, libraryItem } from './command-ast-library';
import {
  type DropTarget,
  type MockChildNode,
  type MockNode,
  type MockRoot,
  childNodes,
  cloneNode,
  emptyRoot,
  findNode,
  findParent,
  group,
  containsId,
  insertNode,
  lit,
  moveNode,
  patchNode,
  removeNode
} from './command-ast-mock.model';
import { DEFAULT_MOCK_CONTEXT, type MockChatContext, type MockRunResult, mockEvaluate } from './command-ast-mock.eval';
import { parseSource } from './command-ast-mock.parse';
import { toSource } from './command-ast-mock.source';

export type DragPayload = { mode: 'new'; itemId: string } | { mode: 'move'; nodeId: string };

const EMPTY_RUN: MockRunResult = { chat: '', extraLines: [], actions: [], variables: [] };

@Injectable()
export class CommandAstMockStore {
  readonly root = signal<MockRoot>(STARTERS[0].build());
  readonly selectedId = signal<string | null>(null);
  /** Where the next block from the library goes. null = end of the command. */
  readonly insertAt = signal<DropTarget | null>(null);
  readonly dragging = signal<DragPayload | null>(null);
  readonly hoverTarget = signal<DropTarget | null>(null);
  readonly parseError = signal<string | null>(null);
  readonly context = signal<MockChatContext>({ ...DEFAULT_MOCK_CONTEXT });
  /** Bumped by "Run again" so random values re-roll. */
  private readonly runSeed = signal(0);
  /** Last change, announced to screen readers. */
  readonly announcement = signal('');

  private readonly history = signal<MockRoot[]>([this.root()]);
  private readonly historyIndex = signal(0);

  readonly draggingNow = computed(() => this.dragging() !== null);
  readonly source = computed(() => toSource(this.root()));
  readonly canUndo = computed(() => this.historyIndex() > 0);
  readonly canRedo = computed(() => this.historyIndex() < this.history().length - 1);
  readonly isEmpty = computed(() => this.root().children.length === 0);
  readonly selectedNode = computed(() => {
    const id = this.selectedId();
    return id ? findNode(this.root(), id) : null;
  });
  readonly selectedParent = computed(() => {
    const id = this.selectedId();
    return id ? findParent(this.root(), id) : null;
  });
  readonly blockCount = computed(() => countBlocks(this.root()) - 1);

  /** Live preview: re-runs on every edit, context change or "Run again". */
  readonly run = computed<{ result: MockRunResult; error: string | null }>(() => {
    this.runSeed();
    try {
      return { result: mockEvaluate(this.root(), this.context()), error: null };
    } catch (err) {
      return { result: EMPTY_RUN, error: err instanceof Error ? err.message : 'The preview could not run.' };
    }
  });

  select(id: string | null): void {
    this.selectedId.set(id);
  }

  setInsertAt(target: DropTarget | null): void {
    this.insertAt.set(target);
  }

  loadStarter(id: string): void {
    const starter = STARTERS.find((item) => item.id === id);
    if (!starter) return;
    this.commit(starter.build(), `Loaded “${starter.label}”`);
    this.resetCursor();
  }

  clear(): void {
    this.commit(emptyRoot(), 'Cleared the command');
    this.resetCursor();
  }

  /** Replace the blocks from command text. Returns false (and keeps blocks) on a parse error. */
  loadFromSource(text: string): boolean {
    const { root, error } = parseSource(text);
    if (error) {
      this.parseError.set(error);
      return false;
    }
    this.parseError.set(null);
    this.commit(root, 'Updated blocks from the text');
    this.resetCursor();
    return true;
  }

  addItem(item: LibraryItem): MockChildNode {
    const node = item.factory();
    const target = this.insertAt() ?? { kind: 'root', index: this.root().children.length };
    this.commit(this.insertSmart(target, node), `Added ${item.title}`);
    this.selectedId.set(node.id);
    // Keep typing forward: the cursor moves past the new block in lists.
    if (target.kind === 'root' || target.kind === 'list') {
      this.insertAt.set({ ...target, index: target.index + 1 } as DropTarget);
    } else {
      this.insertAt.set(null);
    }
    return node;
  }

  addListItem(parentId: string): void {
    const node = lit('');
    const parent = findNode(this.root(), parentId);
    let at = 0;
    if (parent?.type === 'arrayLiteral') at = parent.items.length;
    else if (parent?.type === 'setVar' && parent.value?.type === 'arrayLiteral') at = parent.value.items.length;
    this.commit(insertNode(this.root(), { kind: 'list', parentId, slot: 'items', index: at }, node), 'Added a list item');
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
      const item = libraryItem(drag.itemId);
      if (item) {
        const node = item.factory();
        this.commit(this.insertSmart(target, node), `Added ${item.title}`);
        this.selectedId.set(node.id);
      }
    } else {
      const moving = findNode(this.root(), drag.nodeId);
      const stripped = moving && moving.type !== 'root' ? removeNode(this.root(), drag.nodeId) : this.root();
      this.commit(
        moving && moving.type !== 'root' && !(target.kind !== 'root' && containsId(moving, target.parentId))
          ? this.insertSmart(target, moving, stripped)
          : moveNode(this.root(), drag.nodeId, target),
        'Moved the block'
      );
      this.selectedId.set(drag.nodeId);
    }
    this.endDrag();
  }

  remove(id: string): void {
    const parent = findParent(this.root(), id);
    this.commit(removeNode(this.root(), id), 'Removed the block');
    if (this.selectedId() === id) this.selectedId.set(null);
    // Leave the cursor where the block was.
    if (parent && parent.index >= 0) {
      this.insertAt.set(
        parent.parentId === this.root().id
          ? { kind: 'root', index: parent.index }
          : { kind: 'list', parentId: parent.parentId, slot: parent.slot as 'children', index: parent.index }
      );
    }
  }

  duplicate(id: string): void {
    const node = findNode(this.root(), id);
    const parent = findParent(this.root(), id);
    if (!node || node.type === 'root' || !parent || parent.index < 0) return;
    const copy = cloneNode(node) as MockChildNode;
    const target: DropTarget =
      parent.parentId === this.root().id
        ? { kind: 'root', index: parent.index + 1 }
        : { kind: 'list', parentId: parent.parentId, slot: parent.slot as 'children', index: parent.index + 1 };
    this.commit(insertNode(this.root(), target, copy), 'Duplicated the block');
    this.selectedId.set(copy.id);
  }

  /** Move a block earlier/later among its siblings (keyboard and touch alternative to dragging). */
  moveBy(id: string, delta: -1 | 1): void {
    const parent = findParent(this.root(), id);
    if (!parent || parent.index < 0) return;
    const next = parent.index + delta;
    if (next < 0 || next >= parent.length) return;
    // moveNode removes first, so the target index is already in post-removal terms.
    const target: DropTarget =
      parent.parentId === this.root().id
        ? { kind: 'root', index: next }
        : { kind: 'list', parentId: parent.parentId, slot: parent.slot as 'children', index: next };
    this.commit(moveNode(this.root(), id, target), delta < 0 ? 'Moved earlier' : 'Moved later');
  }

  patch(id: string, patch: Partial<MockNode>): void {
    this.commit(patchNode(this.root(), id, patch));
  }

  /** Put a node into a single slot (if test, compare side, variable value). */
  fillSlot(target: DropTarget, node: MockChildNode): void {
    this.commit(insertNode(this.root(), target, node));
    this.selectedId.set(node.id);
  }

  undo(): void {
    const index = this.historyIndex();
    if (index <= 0) return;
    this.historyIndex.set(index - 1);
    this.root.set(this.history()[index - 1]);
    this.announcement.set('Undone');
    this.dropStaleSelection();
  }

  redo(): void {
    const index = this.historyIndex();
    const hist = this.history();
    if (index >= hist.length - 1) return;
    this.historyIndex.set(index + 1);
    this.root.set(hist[index + 1]);
    this.announcement.set('Redone');
    this.dropStaleSelection();
  }

  rerun(): void {
    this.runSeed.update((n) => n + 1);
  }

  patchContext(patch: Partial<MockChatContext>): void {
    this.context.update((current) => ({ ...current, ...patch }));
  }

  sameTarget(a: DropTarget | null, b: DropTarget): boolean {
    if (!a || a.kind !== b.kind) return false;
    if (a.kind === 'root' && b.kind === 'root') return a.index === b.index;
    if (a.kind === 'list' && b.kind === 'list') return a.parentId === b.parentId && a.slot === b.slot && a.index === b.index;
    if (a.kind === 'single' && b.kind === 'single') return a.parentId === b.parentId && a.slot === b.slot;
    return false;
  }

  /** Cursor target, defaulting to the end of the command. */
  effectiveInsertAt(): DropTarget {
    return this.insertAt() ?? { kind: 'root', index: this.root().children.length };
  }

  /**
   * Insert that never silently loses work: adding to a filled if/else branch keeps
   * what was there (both go in a group); other filled slots are replaced (undo restores).
   */
  private insertSmart(target: DropTarget, node: MockChildNode, base = this.root()): MockRoot {
    if (target.kind === 'single' && (target.slot === 'consequent' || target.slot === 'alternate')) {
      const parent = findNode(base, target.parentId);
      const existing = parent?.type === 'ternary' ? parent[target.slot] : null;
      if (existing?.type === 'group') {
        return insertNode(base, { kind: 'list', parentId: existing.id, slot: 'children', index: existing.children.length }, node);
      }
      if (existing && !(existing.type === 'literal' && existing.value === '')) {
        return insertNode(base, target, group([existing, node]));
      }
    }
    return insertNode(base, target, node);
  }

  private resetCursor(): void {
    this.selectedId.set(null);
    this.insertAt.set(null);
    this.parseError.set(null);
  }

  private dropStaleSelection(): void {
    const id = this.selectedId();
    if (id && !findNode(this.root(), id)) this.selectedId.set(null);
    const at = this.insertAt();
    if (at && at.kind !== 'root' && !findNode(this.root(), at.parentId)) this.insertAt.set(null);
  }

  private commit(next: MockRoot, message = ''): void {
    const hist = this.history().slice(0, this.historyIndex() + 1);
    hist.push(next);
    if (hist.length > 60) hist.shift();
    this.history.set(hist);
    this.historyIndex.set(hist.length - 1);
    this.root.set(next);
    if (message) this.announcement.set(message);
  }
}

function countBlocks(node: MockNode): number {
  return 1 + childNodes(node).reduce((sum, child) => sum + countBlocks(child), 0);
}
