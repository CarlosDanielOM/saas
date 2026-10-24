import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input } from '@angular/core';
import { Code, LucideAngularModule, Repeat, Split, Terminal, Variable, Zap } from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { catalogEntry, catalogParams, isActionFunction, levelKey } from './blocks.catalog';
import {
  type AnyNode,
  type BlockNode,
  type DropTarget,
  type ForLoopNode,
  type FunctionNode,
  type ListSlot,
  type SingleSlot,
  type TernaryNode,
  isListSet,
  listItems
} from './blocks.model';
import { BlocksStore } from './blocks.store';

export type NodeTone = 'text' | 'value' | 'var' | 'logic' | 'action' | 'flow';

export function nodeTone(node: AnyNode): NodeTone {
  switch (node.type) {
    case 'literal':
    case 'template':
      return /&p\d|&t\b/.test(node.type === 'literal' ? node.value : '') ? 'value' : 'text';
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
    case 'unary':
    case 'ternary':
      return 'logic';
    default:
      return 'flow';
  }
}

/** i18n key (under commandBlocks.types) for a block's plain name. Functions use their own name. */
export function nodeTitleKey(node: AnyNode): string | null {
  switch (node.type) {
    case 'function':
      return null;
    case 'getVar':
      return node.accessor?.type === 'index' ? 'getItem'
        : node.accessor?.type === 'random' ? 'randomItem'
          : node.accessor?.type === 'length' ? 'listSize'
            : node.accessor?.type === 'array' ? 'wholeList' : 'getVar';
    case 'setVar':
      return isListSet(node) ? 'setList' : 'setVar';
    case 'binary':
      return ['+', '-', '*', '/', '%'].includes(node.operator) ? 'math' : 'compare';
    case 'literal':
      return /^&p\d+$/.test(node.value) ? 'word' : node.value === '&t' ? 'rest' : 'literal';
    default:
      return node.type;
  }
}

export function nodeTitle(node: AnyNode, t: (key: string) => string): string {
  const key = nodeTitleKey(node);
  return key ? t(`commandBlocks.types.${key}`) : (node as FunctionNode).name;
}

interface ArgHole {
  label: string;
  optional: boolean;
  nodes: BlockNode[];
  target: DropTarget;
}

/** Labelled argument holes from the function's catalog syntax. */
export function argHoles(n: FunctionNode, t: (key: string) => string): ArgHole[] {
  const params = catalogParams(n.name);
  const holes: ArgHole[] = [];
  let used = 0;
  params.forEach((param, i) => {
    const nodes = param.rest ? n.args.slice(i) : n.args[i] ? [n.args[i]] : [];
    holes.push({
      label: param.label,
      optional: param.optional,
      nodes,
      target: { kind: 'list', parentId: n.id, slot: 'args', index: param.rest ? n.args.length : Math.min(i, n.args.length) }
    });
    used = param.rest ? n.args.length : Math.max(used, i + 1);
  });
  const extra = n.args.slice(used);
  if (extra.length || (params.length === 0 && !catalogEntry(n.name))) {
    holes.push({
      label: t(params.length ? 'commandBlocks.block.more' : 'commandBlocks.block.arguments'),
      optional: true,
      nodes: extra,
      target: { kind: 'list', parentId: n.id, slot: 'args', index: n.args.length }
    });
  }
  return holes;
}

/** Comparison and math signs in plain words (i18n keys under commandBlocks.ops). */
export const OP_KEY: Record<string, string> = {
  '==': 'eq', '=': 'eq', '!=': 'ne', '<>': 'ne', '>': 'gt', '<': 'lt', '>=': 'ge', '<=': 'le', '~=': 'like',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod'
};

const VAR_COLORS = ['#a78bfa', '#60a5fa', '#f87171', '#f472b6', '#2dd4bf', '#fb923c', '#818cf8', '#a3e635', '#e879f9', '#38bdf8', '#fbbf24', '#fb7185'];

function hashVarColor(name: string): string {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return VAR_COLORS[Math.abs(hash) % VAR_COLORS.length];
}

@Component({
  selector: 'app-command-block',
  imports: [BlockComponent, LucideAngularModule, NgTemplateOutlet],
  templateUrl: './block.component.html',
  styleUrl: './block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-wide]': 'wide()'
  }
})
export class BlockComponent {
  readonly store = inject(BlocksStore);
  private readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly node = input.required<BlockNode>();

  readonly actionIcon = Zap;
  readonly ifIcon = Split;
  readonly loopIcon = Repeat;
  readonly cmdIcon = Terminal;
  readonly varIcon = Variable;
  readonly rawIcon = Code;

  readonly t = (key: string, params?: Record<string, string | number>) => this.language.translate(key, params);
  readonly ro = this.store.readOnly;

  readonly tone = computed(() => nodeTone(this.node()));
  readonly title = computed(() => nodeTitle(this.node(), this.t));
  readonly wide = computed(() => {
    const n = this.node();
    return n.type === 'ternary' || n.type === 'forLoop' || n.type === 'arrayLiteral' || (n.type === 'setVar' && isListSet(n));
  });
  readonly selected = computed(() => this.store.selectedId() === this.node().id);
  readonly hasError = computed(() => this.store.errorBlockId() === this.node().id);

  readonly level = computed(() => {
    const n = this.node();
    const entry = n.type === 'function' ? catalogEntry(n.name) : null;
    const key = entry ? levelKey(entry.level) : null;
    return key ? this.t(`commandBlocks.level.${key}`) : null;
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
    return n.type === 'function' ? argHoles(n, this.t) : [];
  });
  /** Empty optional inputs only show on the selected block (or where the cursor is), to keep the canvas calm. */
  readonly visibleHoles = computed(() => this.holes().filter((h) =>
    h.nodes.length > 0 || !h.optional || (!this.ro() && (this.selected() || this.isCursor(h.target)))));
  readonly varColor = computed(() => {
    const n = this.node();
    if (n.type !== 'getVar' && n.type !== 'setVar' && n.type !== 'exists' && n.type !== 'deleteVar' && n.type !== 'loopVar') return null;
    const name = n.name.trim().toLowerCase();
    if (!name) return null;
    return hashVarColor(`${n.type === 'loopVar' ? 'loop' : n.storage}:${name}`);
  });
  /** The position block of "item N of list" / "forget item N". */
  readonly indexNode = computed(() => {
    const n = this.node();
    const acc = 'accessor' in n ? n.accessor : undefined;
    return acc && 'index' in acc ? acc.index : null;
  });

  isListSet = isListSet;
  listItems = listItems;

  opLabel(op: string): string {
    return this.t(`commandBlocks.ops.${OP_KEY[op] ?? 'eq'}`);
  }

  storageLabel(storage: string): string {
    return this.t(`commandBlocks.storage.${storage}.short`);
  }

  isArgumentText(value: string): boolean {
    return /^&p\d+$/.test(value) || value === '&t';
  }

  argumentLabel(value: string): string {
    return value === '&t' ? this.t('commandBlocks.block.restText') : this.t('commandBlocks.block.wordN', { n: value.slice(2) });
  }

  ariaLabel(): string {
    const n = this.node();
    const extra = n.type === 'literal' ? `: ${n.value || this.t('commandBlocks.block.empty')}` : n.type === 'getVar' || n.type === 'setVar' ? ` ${n.name}` : '';
    const how = this.ro() ? '' : ` ${this.t('commandBlocks.block.keysHint')}`;
    return `${this.title()}${extra}${this.selected() ? `, ${this.t('commandBlocks.block.selected')}` : ''}.${how}`;
  }

  /** Width of the inline text input, in characters. */
  textWidth(value: string): number {
    return Math.min(Math.max(value.length, 2), 40);
  }

  /** Read-only text keeps its spaces (white-space: pre-wrap). */
  visibleText(value: string): string {
    return value;
  }

  loopTimes(node: ForLoopNode): string | null {
    const c = node.condition;
    const startsAtZero = node.init?.type === 'loopAssign' && node.init.operator === '=' && node.init.value?.type === 'literal' && node.init.value.value === '0';
    const stepsByOne = node.update?.type === 'loopAssign' && node.update.operator === '++';
    if (startsAtZero && stepsByOne && c?.type === 'binary' && c.operator === '<' && c.left?.type === 'loopVar' && c.right?.type === 'literal') {
      return c.right.value;
    }
    return null;
  }

  ifChain(node: TernaryNode): TernaryNode[] {
    const chain: TernaryNode[] = [node];
    let alt = node.alternate;
    while (alt?.type === 'ternary') {
      chain.push(alt);
      alt = alt.alternate;
    }
    return chain;
  }

  ifElseOwner(node: TernaryNode): TernaryNode {
    const chain = this.ifChain(node);
    return chain[chain.length - 1];
  }

  /** Branch contents as a list: a group or quoted text shows its pieces. */
  branchNodes(node: BlockNode | null): BlockNode[] {
    if (!node) return [];
    if (node.type === 'literal' && node.value === '') return [];
    return node.type === 'group' ? node.children : [node];
  }

  single(parentId: string, slot: SingleSlot): DropTarget {
    return { kind: 'single', parentId, slot };
  }

  list(parentId: string, slot: ListSlot, index: number): DropTarget {
    return { kind: 'list', parentId, slot, index };
  }

  isCursor(target: DropTarget): boolean {
    return !this.ro() && this.store.sameTarget(this.store.insertAt(), target);
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

  /** On phones the details panel covers the lower part: keep the block in view. */
  private keepVisibleAboveSheet(): void {
    if (typeof window === 'undefined' || window.innerWidth >= 960 || this.ro()) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = this.host.nativeElement;
        const scroller = el.closest('.bx-work') as HTMLElement | null;
        if (!scroller) return;
        const rect = el.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        const visibleBottom = box.top + box.height * 0.45;
        if (rect.top < box.top + 8 || rect.bottom > visibleBottom) {
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          scroller.scrollBy({ top: rect.top - box.top - 24, behavior: reduce ? 'auto' : 'smooth' });
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
    } else if (this.ro()) {
      return;
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
    if (this.ro()) return;
    this.store.select(null);
    this.store.setInsertAt(target);
  }

  onDragStart(event: DragEvent): void {
    event.stopPropagation();
    if (this.ro()) {
      event.preventDefault();
      return;
    }
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
    this.store.dropOn(target, (item) => (item.builtIn ? this.t(`commandBlocks.items.${item.id}.title`) : item.name));
  }

  patchText(event: Event): void {
    this.store.patch(this.node().id, { value: (event.target as HTMLInputElement).value } as Partial<BlockNode>);
  }

  addListItem(event: Event): void {
    event.stopPropagation();
    this.store.addListItem(this.node().id);
  }

  stop(event: Event): void {
    event.stopPropagation();
  }
}
