import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input } from '@angular/core';
import { LucideAngularModule, Repeat, Split, Terminal, Variable, Zap } from 'lucide-angular';

import { catalogEntry, catalogParams, isActionFunction, levelLabel } from './command-ast-catalog';
import {
  type DropTarget,
  type ListSlot,
  type MockForLoop,
  type MockFunction,
  type MockNode,
  type MockTernary,
  type SingleSlot,
  STORAGE_OPTIONS,
  isListSet,
  listItems
} from './command-ast-mock.model';
import { CommandAstMockStore } from './command-ast-mock.store';

export type NodeTone = 'text' | 'value' | 'var' | 'logic' | 'action' | 'flow';

/** Comparison and math operators in plain words. */
export const OP_LABEL: Record<string, string> = {
  '==': 'is',
  '!=': 'is not',
  '>': 'is more than',
  '<': 'is less than',
  '>=': 'is at least',
  '<=': 'is at most',
  '~=': 'matches (any case)',
  '+': '+',
  '-': '−',
  '*': '×',
  '/': '÷',
  '%': 'remainder of ÷'
};

export function nodeTone(node: MockNode): NodeTone {
  switch (node.type) {
    case 'literal':
    case 'template':
      return 'text';
    case 'function':
      if (['timer', 'delay', 'break', 'continue'].includes(catalogEntry(node.name)?.name ?? node.name)) return 'flow';
      return isActionFunction(node.name) ? 'action' : 'value';
    case 'getVar':
    case 'setVar':
    case 'exists':
    case 'deleteVar':
    case 'arrayLiteral':
      return 'var';
    case 'binary':
    case 'ternary':
      return 'logic';
    default:
      return 'flow';
  }
}

/** Plain name of a block type, for labels and the inspector title. */
export function nodeTitle(node: MockNode): string {
  switch (node.type) {
    case 'literal':
      return 'Text';
    case 'template':
      return 'Quoted text';
    case 'function':
      return node.name;
    case 'getVar':
      return node.accessor?.type === 'index'
        ? 'Item from a list'
        : node.accessor?.type === 'random'
          ? 'Random item from a list'
          : node.accessor?.type === 'length'
            ? 'List size'
            : 'Use variable';
    case 'setVar':
      return isListSet(node) ? 'Make a list' : 'Set variable';
    case 'exists':
      return 'Variable is set?';
    case 'deleteVar':
      return 'Forget variable';
    case 'arrayLiteral':
      return 'List';
    case 'binary':
      return ['+', '-', '*', '/', '%'].includes(node.operator) ? 'Math' : 'Compare';
    case 'ternary':
      return 'If / else';
    case 'commandRef':
      return 'Run another command';
    case 'loopVar':
      return 'Loop counter';
    case 'forLoop':
      return 'Repeat';
    case 'group':
      return 'Group';
    case 'root':
      return 'Command';
  }
}

interface ArgHole {
  label: string;
  optional: boolean;
  nodes: MockNode[];
  /** Where a new block goes when this hole is the cursor. */
  target: DropTarget;
}

@Component({
  selector: 'app-command-ast-block',
  imports: [CommandAstBlockComponent, LucideAngularModule, NgTemplateOutlet],
  templateUrl: './command-ast-block.component.html',
  styleUrl: './command-ast-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-wide]': 'wide()'
  }
})
export class CommandAstBlockComponent {
  readonly store = inject(CommandAstMockStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly node = input.required<MockNode>();

  readonly actionIcon = Zap;
  readonly ifIcon = Split;
  readonly loopIcon = Repeat;
  readonly cmdIcon = Terminal;
  readonly varIcon = Variable;
  readonly opLabel = OP_LABEL;

  readonly tone = computed(() => nodeTone(this.node()));
  readonly title = computed(() => nodeTitle(this.node()));
  /** Ifs, loops and lists take a full row. */
  readonly wide = computed(() => {
    const n = this.node();
    return n.type === 'ternary' || n.type === 'forLoop' || n.type === 'arrayLiteral' || (n.type === 'setVar' && isListSet(n));
  });
  readonly selected = computed(() => this.store.selectedId() === this.node().id);

  readonly level = computed(() => {
    const n = this.node();
    if (n.type !== 'function') return null;
    const entry = catalogEntry(n.name);
    return entry ? levelLabel(entry.level) : null;
  });
  readonly destructive = computed(() => {
    const n = this.node();
    return n.type === 'function' && Boolean(catalogEntry(n.name)?.destructive);
  });
  readonly unknownFunction = computed(() => {
    const n = this.node();
    return n.type === 'function' && !catalogEntry(n.name);
  });

  readonly holes = computed<ArgHole[]>(() => {
    const n = this.node();
    if (n.type !== 'function') return [];
    return argHoles(n);
  });

  readonly varColor = computed(() => {
    const n = this.node();
    if (n.type !== 'getVar' && n.type !== 'setVar' && n.type !== 'exists' && n.type !== 'deleteVar' && n.type !== 'loopVar') return null;
    const name = n.name.trim().toLowerCase();
    if (!name) return null;
    return hashVarColor(`${n.type === 'loopVar' ? 'loop' : n.storage}:${name}`);
  });

  /** The position block of "item N of list". */
  readonly indexNode = computed(() => {
    const n = this.node();
    return n.type === 'getVar' && n.accessor?.type === 'index' ? n.accessor.index : null;
  });

  storageLabel(storage: string): string {
    return STORAGE_OPTIONS.find((opt) => opt.id === storage)?.short ?? '';
  }

  isListSet = isListSet;
  listItems = listItems;

  ariaLabel(): string {
    const n = this.node();
    const extra = n.type === 'literal' ? `: ${n.value || 'empty'}` : n.type === 'getVar' || n.type === 'setVar' ? ` ${n.name}` : '';
    return `${this.title()} block${extra}${this.selected() ? ', selected' : ''}. Enter selects, Delete removes, Alt+arrows move.`;
  }

  /** Width of the inline text input, in characters. */
  textWidth(value: string): number {
    return Math.min(Math.max(value.length, 2), 40);
  }

  ifChain(node: MockTernary): MockTernary[] {
    const chain: MockTernary[] = [node];
    let alt = node.alternate;
    while (alt?.type === 'ternary') {
      chain.push(alt);
      alt = alt.alternate;
    }
    return chain;
  }

  ifElseOwner(node: MockTernary): MockTernary {
    const chain = this.ifChain(node);
    return chain[chain.length - 1];
  }

  /** Branch contents as a list: a Group shows its children. */
  branchNodes(node: MockNode | null): MockNode[] {
    if (!node) return [];
    if (node.type === 'literal' && node.value === '') return [];
    return node.type === 'group' ? node.children : [node];
  }

  repeatCount(node: MockForLoop): string {
    if (node.condition?.type === 'binary' && node.condition.right?.type === 'literal') return node.condition.right.value;
    return '3';
  }

  single(parentId: string, slot: SingleSlot): DropTarget {
    return { kind: 'single', parentId, slot };
  }

  list(parentId: string, slot: ListSlot, index: number): DropTarget {
    return { kind: 'list', parentId, slot, index };
  }

  isCursor(target: DropTarget): boolean {
    return this.store.sameTarget(this.store.insertAt(), target);
  }

  isHot(target: DropTarget): boolean {
    return this.store.sameTarget(this.store.hoverTarget(), target);
  }

  // ---------- events ----------

  onSelect(event: Event): void {
    event.stopPropagation();
    this.store.select(this.node().id);
    this.keepVisibleAboveSheet();
  }

  /** On phones the details sheet covers the lower half: keep the block in the top part. */
  private keepVisibleAboveSheet(): void {
    if (typeof window === 'undefined' || window.innerWidth >= 960) return;
    // Wait for the sheet (and the page padding that makes room for it) to render.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const rect = this.host.nativeElement.getBoundingClientRect();
        const sheetTop = window.innerHeight * 0.4;
        if (rect.top < 16 || rect.bottom > sheetTop) {
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          window.scrollBy({ top: rect.top - window.innerHeight * 0.12, behavior: reduce ? 'auto' : 'smooth' });
        }
      })
    );
  }

  onKey(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    const id = this.node().id;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.store.select(id);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.store.remove(id);
    } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) {
      event.preventDefault();
      this.store.moveBy(id, -1);
    } else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.store.moveBy(id, 1);
    }
  }

  setCursor(event: Event, target: DropTarget): void {
    event.stopPropagation();
    this.store.select(null);
    this.store.setInsertAt(target);
  }

  onDragStart(event: DragEvent): void {
    event.stopPropagation();
    event.dataTransfer?.setData('text/plain', this.node().id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.store.startDragMove(this.node().id);
  }

  onDragEnd(): void {
    this.store.endDrag();
  }

  onDragOver(event: DragEvent, target: DropTarget): void {
    if (!this.store.draggingNow()) return;
    event.preventDefault();
    event.stopPropagation();
    this.store.hoverTarget.set(target);
  }

  onDrop(event: DragEvent, target: DropTarget): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.dropOn(target);
  }

  patchText(event: Event): void {
    this.store.patch(this.node().id, { value: (event.target as HTMLInputElement).value } as Partial<MockNode>);
  }

  addListItem(event: Event): void {
    event.stopPropagation();
    this.store.addListItem(this.node().id);
  }

  stop(event: Event): void {
    event.stopPropagation();
  }
}

/** Labelled argument holes from the function's catalog syntax. */
export function argHoles(n: MockFunction): ArgHole[] {
  const params = catalogParams(n.name);
  const holes: ArgHole[] = [];
  let used = 0;
  params.forEach((param, i) => {
    const nodes = param.rest ? n.args.slice(i) : n.args[i] ? [n.args[i]] : [];
    holes.push({
      label: param.optional ? `${param.label} (optional)` : param.label,
      optional: param.optional,
      nodes,
      target: { kind: 'list', parentId: n.id, slot: 'args', index: param.rest ? n.args.length : Math.min(i, n.args.length) }
    });
    used = param.rest ? n.args.length : Math.max(used, i + 1);
  });
  // Arguments the catalog doesn't describe (unknown functions or extras).
  const extra = n.args.slice(used);
  if (extra.length || (params.length === 0 && !catalogEntry(n.name))) {
    holes.push({
      label: params.length ? 'more' : 'arguments',
      optional: true,
      nodes: extra,
      target: { kind: 'list', parentId: n.id, slot: 'args', index: n.args.length }
    });
  }
  return holes;
}

const VAR_COLORS = ['#a78bfa', '#60a5fa', '#f87171', '#f472b6', '#2dd4bf', '#fb923c', '#818cf8', '#a3e635', '#e879f9', '#38bdf8', '#fbbf24', '#fb7185'];

function hashVarColor(name: string): string {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return VAR_COLORS[Math.abs(hash) % VAR_COLORS.length];
}
