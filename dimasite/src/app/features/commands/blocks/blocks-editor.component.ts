import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  Blocks,
  Dices,
  FileInput,
  FlaskConical,
  LucideAngularModule,
  Plus,
  Redo2,
  Search,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  Zap
} from 'lucide-angular';

import { CommandsApiService } from '../../../services/commands-api.service';
import { LanguageService } from '../../../services/language.service';
import { BlockComponent, argHoles, nodeTitle } from './block.component';
import { BlockInspectorComponent } from './block-inspector.component';
import { CATALOG, LIBRARY_SECTIONS, type LibrarySectionId } from './blocks.catalog';
import { LIBRARY, type LibraryItem, STARTERS, searchLibrary } from './blocks.library';
import { type DropTarget, findNode } from './blocks.model';
import type { PreviewRole } from './blocks.preview';
import { BlocksStore } from './blocks.store';

type EditorTab = 'build' | 'test';

const SLOT_KEYS: Record<string, string> = {
  value: 'value',
  left: 'left',
  right: 'right',
  test: 'test',
  consequent: 'then',
  alternate: 'otherwise',
  body: 'loop',
  children: 'group',
  items: 'list',
  init: 'start',
  condition: 'test',
  update: 'step',
  iterable: 'list',
  argument: 'value',
  args: 'arguments',
  parts: 'quote',
  userSelector: 'viewer'
};

/**
 * The block workspace. The parent provides BlocksStore (the command modal for
 * editing, the viewer dialog read-only) and reads the blocks from it.
 */
@Component({
  selector: 'app-blocks-editor',
  imports: [NgTemplateOutlet, LucideAngularModule, BlockComponent, BlockInspectorComponent],
  templateUrl: './blocks-editor.component.html',
  styleUrl: './blocks-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(keydown)': 'onKeydown($event)',
    '[attr.data-tab]': 'tab()',
    '[class.has-selection]': '!!store.selectedNode()',
    '[class.lib-open]': 'libraryOpen()',
    '[class.is-ro]': 'store.readOnly()'
  }
})
export class BlocksEditorComponent {
  readonly store = inject(BlocksStore);
  private readonly language = inject(LanguageService);
  private readonly commandsApi = inject(CommandsApiService);

  /** Needed for the import box. */
  readonly channelID = input<string | null>(null);
  /** Message from the server for `store.errorBlockId()` after a failed save. */
  readonly errorMessage = input<string | null>(null);
  readonly allowImport = input(true);

  readonly icons = {
    undo: Undo2, redo: Redo2, trash: Trash2, plus: Plus, search: Search, close: X, dice: Dices, zap: Zap,
    shield: ShieldAlert, warn: TriangleAlert, build: Blocks, test: FlaskConical, import: FileInput
  };
  readonly starters = STARTERS;
  readonly sections = LIBRARY_SECTIONS;
  readonly functionCount = CATALOG.length;
  readonly roles: PreviewRole[] = ['viewer', 'mod', 'streamer'];

  readonly tab = signal<EditorTab>('build');
  readonly libraryOpen = signal(false);
  readonly query = signal('');
  readonly section = signal<LibrarySectionId | 'all'>('all');

  readonly importText = signal('');
  readonly importing = signal(false);
  readonly importError = signal<string | null>(null);
  readonly importAdvanced = signal(0);

  readonly t = (key: string, params?: Record<string, string | number>) => this.language.translate(key, params);
  readonly titleOf = (item: LibraryItem) => (item.builtIn ? this.t(`commandBlocks.items.${item.id}.title`) : item.name);
  readonly hintOf = (item: LibraryItem) => (item.builtIn ? this.t(`commandBlocks.items.${item.id}.hint`) : item.description);

  /** Import box: only while there's nothing to overwrite, or right after an import before any edit. */
  readonly showImport = computed(() => this.allowImport() && !this.store.readOnly() && !!this.channelID() && (this.store.isEmpty() || this.store.fromImport()));

  readonly results = computed(() => searchLibrary(this.query(), this.section(), this.titleOf));
  readonly grouped = computed(() => {
    if (this.query().trim() || this.section() !== 'all') return null;
    return this.sections.map((section) => ({ section, items: LIBRARY.filter((item) => item.section === section.id) }));
  });

  /** Plain words for where the next block goes. */
  readonly cursorLabel = computed(() => {
    const target = this.store.insertAt();
    const root = this.store.root();
    if (!target || (target.kind === 'root' && target.index >= root.children.length)) return this.t('commandBlocks.cursor.end');
    if (target.kind === 'root') return target.index === 0 ? this.t('commandBlocks.cursor.start') : this.t('commandBlocks.cursor.after', { n: target.index });
    const parent = findNode(root, target.parentId);
    if (!parent) return this.t('commandBlocks.cursor.end');
    if (parent.type === 'function') {
      const hole = argHoles(parent, this.t).find((h) => this.store.sameTarget(h.target, target));
      return this.t('commandBlocks.cursor.intoArg', { slot: hole?.label ?? this.t('commandBlocks.block.arguments'), name: parent.name });
    }
    const slot = this.t(`commandBlocks.slots.${SLOT_KEYS[target.slot] ?? 'value'}`);
    return this.t('commandBlocks.cursor.into', { slot, name: nodeTitle(parent, this.t) });
  });

  readonly run = this.store.run;

  constructor() {
    // Editing after an import hides the box and forgets the pasted text.
    effect(() => {
      const fromImport = this.store.fromImport();
      untracked(() => {
        if (!fromImport && !this.store.isEmpty()) {
          this.importText.set('');
          this.importAdvanced.set(0);
        }
      });
    });
    // A server error points at a block: show it on the Build tab.
    effect(() => {
      const id = this.store.errorBlockId();
      if (id) untracked(() => {
        this.tab.set('build');
        this.store.select(id);
      });
    });
  }

  setTab(tab: EditorTab): void {
    this.tab.set(tab);
    this.libraryOpen.set(false);
  }

  loadStarter(id: string): void {
    this.store.loadStarter(id);
  }

  clearAll(): void {
    if (!this.store.isEmpty()) this.store.clear();
  }

  // ---------- import ----------

  onImportInput(event: Event): void {
    this.importText.set((event.target as HTMLTextAreaElement).value);
    this.importError.set(null);
  }

  async runImport(): Promise<void> {
    const channelID = this.channelID();
    const text = this.importText().trim();
    if (!channelID || !text || this.importing()) return;
    this.importing.set(true);
    this.importError.set(null);
    const { result, error } = await firstValueFrom(this.commandsApi.importBlocks(channelID, text));
    this.importing.set(false);
    if (!result) {
      this.importError.set(error?.code === 'too_long' ? this.t('commandBlocks.import.tooLong') : this.t('commandBlocks.import.failed'));
      return;
    }
    this.store.applyImport(result.root);
    this.importAdvanced.set(result.advancedCount);
  }

  // ---------- library ----------

  openLibrary(): void {
    this.libraryOpen.set(true);
    this.tab.set('build');
  }

  closeLibrary(): void {
    this.libraryOpen.set(false);
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  addItem(item: LibraryItem): void {
    this.store.addItem(item, this.titleOf(item));
    this.libraryOpen.set(false);
  }

  onLibraryDrag(event: DragEvent, item: LibraryItem): void {
    event.dataTransfer?.setData('text/plain', item.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.store.startDragNew(item.id);
  }

  // ---------- canvas ----------

  rootTarget(index: number): DropTarget {
    return { kind: 'root', index };
  }

  isCursor(index: number): boolean {
    return !this.store.readOnly() && this.store.sameTarget(this.store.effectiveInsertAt(), this.rootTarget(index));
  }

  isHot(index: number): boolean {
    return this.store.sameTarget(this.store.hoverTarget(), this.rootTarget(index));
  }

  setRootCursor(event: Event, index: number): void {
    event.stopPropagation();
    this.store.select(null);
    this.store.setInsertAt(index >= this.store.root().children.length ? null : this.rootTarget(index));
  }

  onCanvasClick(): void {
    this.store.select(null);
  }

  onSlotDragOver(event: DragEvent, index: number): void {
    if (!this.store.draggingNow()) return;
    event.preventDefault();
    event.stopPropagation();
    this.store.hoverTarget.set(this.rootTarget(index));
  }

  onCanvasDragOver(event: DragEvent): void {
    if (!this.store.draggingNow()) return;
    event.preventDefault();
    if (event.target === event.currentTarget) this.store.hoverTarget.set(this.rootTarget(this.store.root().children.length));
  }

  onCanvasDrop(event: DragEvent, index?: number): void {
    event.preventDefault();
    event.stopPropagation();
    const target = index !== undefined ? this.rootTarget(index) : this.store.hoverTarget() ?? this.rootTarget(this.store.root().children.length);
    this.store.dropOn(target, this.titleOf);
  }

  // ---------- try it ----------

  patchContext(field: 'user' | 'argument', event: Event): void {
    this.store.patchContext({ [field]: (event.target as HTMLInputElement).value });
  }

  setRole(role: PreviewRole): void {
    this.store.patchContext({ role });
  }

  // ---------- keyboard (only while focus is inside the editor) ----------

  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (event.key === 'Escape' && (this.libraryOpen() || this.store.selectedId())) {
      event.stopPropagation();
      if (this.libraryOpen()) this.libraryOpen.set(false);
      else this.store.select(null);
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (typing || !mod || this.store.readOnly()) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.store.undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      this.store.redo();
    } else if (key === 'd' && this.store.selectedId()) {
      event.preventDefault();
      this.store.duplicate(this.store.selectedId()!);
    }
  }
}
