import { Injectable, computed, inject, signal } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { type LibraryItem, STARTERS, libraryItem } from './blocks.library';
import {
  type BlockNode,
  type DropTarget,
  type RootNode,
  cloneNode,
  containsId,
  countBlocks,
  emptyRoot,
  findNode,
  findParent,
  group,
  insertNode,
  lit,
  moveNode,
  patchNode,
  removeNode
} from './blocks.model';
import { DEFAULT_PREVIEW_CONTEXT, type PreviewContext, type PreviewResult, PreviewTooLong, runPreview } from './blocks.preview';

export type DragPayload = { mode: 'new'; itemId: string } | { mode: 'move'; nodeId: string };

const EMPTY_RUN: PreviewResult = { chat: '', extraLines: [], actions: [], variables: [], skippedAdvanced: 0 };

/** One editor's state. Provided per editor/viewer component. */
@Injectable()
export class BlocksStore {
  private readonly language = inject(LanguageService);

  readonly root = signal<RootNode>(emptyRoot());
  /** Viewers and locked (downgraded) commands: no edits. */
  readonly readOnly = signal(false);
  readonly selectedId = signal<string | null>(null);
  /** Where the next block from the library goes. null = end of the command. */
  readonly insertAt = signal<DropTarget | null>(null);
  readonly dragging = signal<DragPayload | null>(null);
  readonly hoverTarget = signal<DropTarget | null>(null);
  readonly context = signal<PreviewContext>({ ...DEFAULT_PREVIEW_CONTEXT });
  /** A block the server pointed at after a failed save. */
  readonly errorBlockId = signal<string | null>(null);
  /** Last change, announced to screen readers. */
  readonly announcement = signal('');
  /** Bumps on every user edit (not on loads). */
  readonly editCount = signal(0);
  /** True while the blocks are exactly what the last import produced. */
  readonly fromImport = signal(false);

  private readonly runSeed = signal(0);
  private readonly history = signal<RootNode[]>([this.root()]);
  private readonly historyIndex = signal(0);

  readonly draggingNow = computed(() => this.dragging() !== null);
  readonly canUndo = computed(() => !this.readOnly() && this.historyIndex() > 0);
  readonly canRedo = computed(() => !this.readOnly() && this.historyIndex() < this.history().length - 1);
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
  readonly run = computed<{ result: PreviewResult; tooLong: boolean }>(() => {
    this.runSeed();
    try {
      return { result: runPreview(this.root(), this.context()), tooLong: false };
    } catch (err) {
      if (err instanceof PreviewTooLong) return { result: EMPTY_RUN, tooLong: true };
      throw err;
    }
  });

  private t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(`commandBlocks.announce.${key}`, params);
  }

  /** Replace everything (opening a command, restoring a draft). Clears history. */
  load(root: RootNode, options: { fromImport?: boolean } = {}): void {
    this.root.set(root);
    this.history.set([root]);
    this.historyIndex.set(0);
    this.fromImport.set(Boolean(options.fromImport));
    this.resetCursor();
  }

  /** Blocks from the import box: undoable, and the box stays until the next edit. */
  applyImport(root: RootNode): void {
    this.commit(root, this.t('imported'), false);
    this.fromImport.set(true);
    this.resetCursor();
  }

  select(id: string | null): void {
    this.selectedId.set(id);
  }

  setInsertAt(target: DropTarget | null): void {
    this.insertAt.set(target);
  }

  loadStarter(id: string): void {
    const starter = STARTERS.find((item) => item.id === id);
    if (!starter || this.readOnly()) return;
    this.commit(starter.build(), this.t('loadedExample'));
    this.resetCursor();
  }

  clear(): void {
    this.commit(emptyRoot(), this.t('cleared'));
    this.resetCursor();
  }

  addItem(item: LibraryItem, title: string): BlockNode | null {
    if (this.readOnly()) return null;
    const node = item.factory();
    const target = this.insertAt() ?? { kind: 'root', index: this.root().children.length };
    this.commit(this.insertSmart(target, node), this.t('added', { name: title }));
    this.selectedId.set(node.id);
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
    this.commit(insertNode(this.root(), { kind: 'list', parentId, slot: 'items', index: at }, node), this.t('addedItem'));
    this.selectedId.set(node.id);
  }

  startDragNew(itemId: string): void {
    if (!this.readOnly()) this.dragging.set({ mode: 'new', itemId });
  }

  startDragMove(nodeId: string): void {
    if (!this.readOnly()) this.dragging.set({ mode: 'move', nodeId });
  }

  endDrag(): void {
    this.dragging.set(null);
    this.hoverTarget.set(null);
  }

  dropOn(target: DropTarget, titleOf: (item: LibraryItem) => string): void {
    const drag = this.dragging();
    if (!drag || this.readOnly()) return;
    if (drag.mode === 'new') {
      const item = libraryItem(drag.itemId);
      if (item) {
        const node = item.factory();
        this.commit(this.insertSmart(target, node), this.t('added', { name: titleOf(item) }));
        this.selectedId.set(node.id);
      }
    } else {
      const moving = findNode(this.root(), drag.nodeId);
      const valid = moving && moving.type !== 'root' && !(target.kind !== 'root' && containsId(moving, target.parentId));
      this.commit(
        valid ? this.insertSmart(target, moving as BlockNode, removeNode(this.root(), drag.nodeId)) : moveNode(this.root(), drag.nodeId, target),
        this.t('moved')
      );
      this.selectedId.set(drag.nodeId);
    }
    this.endDrag();
  }

  remove(id: string): void {
    const parent = findParent(this.root(), id);
    this.commit(removeNode(this.root(), id), this.t('removed'));
    if (this.selectedId() === id) this.selectedId.set(null);
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
    const copy = cloneNode(node);
    const target: DropTarget =
      parent.parentId === this.root().id
        ? { kind: 'root', index: parent.index + 1 }
        : { kind: 'list', parentId: parent.parentId, slot: parent.slot as 'children', index: parent.index + 1 };
    this.commit(insertNode(this.root(), target, copy), this.t('duplicated'));
    this.selectedId.set(copy.id);
  }

  /** Move a block earlier/later among its siblings (keyboard and touch alternative to dragging). */
  moveBy(id: string, delta: -1 | 1): void {
    const parent = findParent(this.root(), id);
    if (!parent || parent.index < 0) return;
    const next = parent.index + delta;
    if (next < 0 || next >= parent.length) return;
    const target: DropTarget =
      parent.parentId === this.root().id
        ? { kind: 'root', index: next }
        : { kind: 'list', parentId: parent.parentId, slot: parent.slot as 'children', index: next };
    this.commit(moveNode(this.root(), id, target), this.t(delta < 0 ? 'movedEarlier' : 'movedLater'));
  }

  patch(id: string, patch: Partial<BlockNode>): void {
    this.commit(patchNode(this.root(), id, patch));
  }

  /** Put a node into a single slot (if test, compare side, variable value). */
  fillSlot(target: DropTarget, node: BlockNode): void {
    this.commit(insertNode(this.root(), target, node));
    this.selectedId.set(node.id);
  }

  undo(): void {
    const index = this.historyIndex();
    if (index <= 0 || this.readOnly()) return;
    this.historyIndex.set(index - 1);
    this.root.set(this.history()[index - 1]);
    this.editCount.update((n) => n + 1);
    this.fromImport.set(false);
    this.announcement.set(this.t('undone'));
    this.dropStaleSelection();
  }

  redo(): void {
    const index = this.historyIndex();
    const hist = this.history();
    if (index >= hist.length - 1 || this.readOnly()) return;
    this.historyIndex.set(index + 1);
    this.root.set(hist[index + 1]);
    this.editCount.update((n) => n + 1);
    this.fromImport.set(false);
    this.announcement.set(this.t('redone'));
    this.dropStaleSelection();
  }

  rerun(): void {
    this.runSeed.update((n) => n + 1);
  }

  patchContext(patch: Partial<PreviewContext>): void {
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
  private insertSmart(target: DropTarget, node: BlockNode, base = this.root()): RootNode {
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
    this.errorBlockId.set(null);
  }

  private dropStaleSelection(): void {
    const id = this.selectedId();
    if (id && !findNode(this.root(), id)) this.selectedId.set(null);
    const at = this.insertAt();
    if (at && at.kind !== 'root' && !findNode(this.root(), at.parentId)) this.insertAt.set(null);
  }

  private commit(next: RootNode, message = '', userEdit = true): void {
    if (this.readOnly()) return;
    const hist = this.history().slice(0, this.historyIndex() + 1);
    hist.push(next);
    if (hist.length > 60) hist.shift();
    this.history.set(hist);
    this.historyIndex.set(hist.length - 1);
    this.root.set(next);
    this.errorBlockId.set(null);
    if (userEdit) {
      this.editCount.update((n) => n + 1);
      this.fromImport.set(false);
    } else {
      this.editCount.update((n) => n + 1);
    }
    if (message) this.announcement.set(message);
  }
}
