import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  Blocks,
  Check,
  Copy,
  Dices,
  FlaskConical,
  Code,
  LucideAngularModule,
  Moon,
  Plus,
  Redo2,
  Search,
  ShieldAlert,
  Sun,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  Zap
} from 'lucide-angular';

import { ThemeService } from '../../../../services/theme.service';
import { CommandAstBlockComponent, argHoles, nodeTitle } from './command-ast-block.component';
import { CATALOG, LIBRARY_SECTIONS, type LibrarySectionId } from './command-ast-catalog';
import { CommandAstInspectorComponent } from './command-ast-inspector.component';
import { LIBRARY, type LibraryItem, STARTERS, searchLibrary } from './command-ast-library';
import type { MockRole } from './command-ast-mock.eval';
import { type DropTarget, findNode } from './command-ast-mock.model';
import { CommandAstMockStore } from './command-ast-mock.store';
import { toSource } from './command-ast-mock.source';

type MobileTab = 'build' | 'test' | 'code';

const SLOT_LABEL: Record<string, string> = {
  value: 'the value',
  left: 'the left side',
  right: 'the right side',
  test: 'the check',
  consequent: 'the “then” branch',
  alternate: 'the “otherwise” branch',
  body: 'the loop',
  children: 'the group',
  items: 'the list'
};

@Component({
  selector: 'app-command-ast-mock',
  imports: [RouterLink, NgTemplateOutlet, LucideAngularModule, CommandAstBlockComponent, CommandAstInspectorComponent],
  providers: [CommandAstMockStore],
  templateUrl: './command-ast-mock.component.html',
  styleUrl: './command-ast-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeydown($event)'
  }
})
export class CommandAstMockComponent {
  readonly store = inject(CommandAstMockStore);
  private readonly themeService = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly icons = {
    sun: Sun,
    moon: Moon,
    undo: Undo2,
    redo: Redo2,
    trash: Trash2,
    plus: Plus,
    search: Search,
    close: X,
    copy: Copy,
    check: Check,
    dice: Dices,
    zap: Zap,
    shield: ShieldAlert,
    warn: TriangleAlert,
    build: Blocks,
    test: FlaskConical,
    code: Code
  };

  readonly starters = STARTERS;
  readonly sections = LIBRARY_SECTIONS;
  readonly functionCount = CATALOG.length;
  readonly roles: { id: MockRole; label: string }[] = [
    { id: 'viewer', label: 'Viewer' },
    { id: 'mod', label: 'Mod' },
    { id: 'streamer', label: 'Streamer' }
  ];

  readonly mobileTab = signal<MobileTab>('build');
  readonly libraryOpen = signal(false);
  readonly query = signal('');
  readonly section = signal<LibrarySectionId | 'all'>('all');
  readonly copied = signal(false);

  /** Text typed in the code box that hasn't been turned back into blocks yet. */
  readonly sourceDraft = signal<string | null>(null);
  private applyTimer: number | null = null;
  private applyingFromCode = false;

  private readonly starterSources = STARTERS.map((starter) => ({ id: starter.id, source: toSource(starter.build()) }));
  readonly activeStarter = computed(
    () => this.starterSources.find((starter) => starter.source === this.store.source())?.id ?? null
  );

  readonly results = computed(() => searchLibrary(this.query(), this.section()));
  readonly grouped = computed(() => {
    if (this.query().trim() || this.section() !== 'all') return null;
    return this.sections.map((section) => ({ section, items: LIBRARY.filter((item) => item.section === section.id) }));
  });

  /** Plain words for where the next block goes. */
  readonly cursorLabel = computed(() => {
    const target = this.store.insertAt();
    const root = this.store.root();
    if (!target || (target.kind === 'root' && target.index >= root.children.length)) return 'at the end';
    if (target.kind === 'root') return target.index === 0 ? 'at the start' : `after block ${target.index}`;
    const parent = findNode(root, target.parentId);
    if (!parent) return 'at the end';
    if (parent.type === 'function') {
      const hole = argHoles(parent).find((h) => this.store.sameTarget(h.target, target));
      return `into “${hole?.label ?? 'arguments'}” of ${parent.name}`;
    }
    const slot = target.slot;
    return `into ${SLOT_LABEL[slot] ?? slot} of ${nodeTitle(parent)}`;
  });

  readonly run = this.store.run;

  constructor() {
    // Block edits (not typing in the code box) refresh the code box.
    effect(() => {
      this.store.root();
      untracked(() => {
        if (!this.applyingFromCode) this.sourceDraft.set(null);
      });
    });
    // Opening the library on a phone shows the Build tab underneath.
    effect(() => {
      if (this.libraryOpen()) untracked(() => this.mobileTab.set('build'));
    });
    this.destroyRef.onDestroy(() => this.clearApplyTimer());
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  setTab(tab: MobileTab): void {
    this.mobileTab.set(tab);
    this.libraryOpen.set(false);
  }

  loadStarter(id: string): void {
    this.store.loadStarter(id);
  }

  clearAll(): void {
    if (this.store.isEmpty()) return;
    this.store.clear();
  }

  // ---------- library ----------

  openLibrary(): void {
    this.libraryOpen.set(true);
  }

  closeLibrary(): void {
    this.libraryOpen.set(false);
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  clearQuery(): void {
    this.query.set('');
  }

  addItem(item: LibraryItem): void {
    this.store.addItem(item);
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
    return this.store.sameTarget(this.store.effectiveInsertAt(), this.rootTarget(index));
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
    if (event.target === event.currentTarget) {
      this.store.hoverTarget.set(this.rootTarget(this.store.root().children.length));
    }
  }

  onCanvasDrop(event: DragEvent, index?: number): void {
    event.preventDefault();
    event.stopPropagation();
    const target =
      index !== undefined
        ? this.rootTarget(index)
        : this.store.hoverTarget() ?? this.rootTarget(this.store.root().children.length);
    this.store.dropOn(target);
  }

  // ---------- code ----------

  sourceValue(): string {
    return this.sourceDraft() ?? this.store.source();
  }

  onSourceInput(event: Event): void {
    this.sourceDraft.set((event.target as HTMLTextAreaElement).value);
    this.store.parseError.set(null);
    this.clearApplyTimer();
    this.applyTimer = window.setTimeout(() => this.applySource(), 600);
  }

  /** Leaving the code box shows the tidy version of what was typed. */
  onSourceBlur(): void {
    this.applySource();
    if (!this.store.parseError()) this.sourceDraft.set(null);
  }

  applySource(): void {
    this.clearApplyTimer();
    const draft = this.sourceDraft();
    if (draft === null || draft === this.store.source()) return;
    this.applyingFromCode = true;
    this.store.loadFromSource(draft);
    this.applyingFromCode = false;
  }

  async copySource(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.store.source());
      this.copied.set(true);
      window.setTimeout(() => this.copied.set(false), 1600);
    } catch {
      this.store.announcement.set('Copy failed. Select the text and copy it manually.');
    }
  }

  // ---------- test ----------

  patchContext(field: 'user' | 'argument', event: Event): void {
    this.store.patchContext({ [field]: (event.target as HTMLInputElement).value });
  }

  setRole(role: MockRole): void {
    this.store.patchContext({ role });
  }

  // ---------- keyboard ----------

  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      if (this.libraryOpen()) this.libraryOpen.set(false);
      else if (this.store.selectedId()) this.store.select(null);
      return;
    }
    if (typing || !mod) return;
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

  private clearApplyTimer(): void {
    if (this.applyTimer !== null) {
      window.clearTimeout(this.applyTimer);
      this.applyTimer = null;
    }
  }
}
