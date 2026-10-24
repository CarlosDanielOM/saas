import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { ArrowLeft, ArrowRight, Copy, LucideAngularModule, ShieldAlert, TextCursorInput, Trash2, TriangleAlert, X } from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { OP_KEY, argHoles, nodeTitle, nodeTone } from './block.component';
import { catalogEntry, catalogParams, levelKey } from './blocks.catalog';
import {
  type AnyNode,
  type ArrayAccessor,
  type BinaryOp,
  type BlockNode,
  type DropTarget,
  type ForLoopNode,
  type LoopAssignOp,
  type TernaryNode,
  type VarStorage,
  COMPARE_OPS,
  MATH_OPS,
  STORAGE_IDS,
  binary,
  isPerViewer,
  lit,
  loopAssign,
  loopVar,
  ternary
} from './blocks.model';
import { BlocksStore } from './blocks.store';

const LOOP_OPS: LoopAssignOp[] = ['=', '+=', '-=', '*=', '/=', '%=', '++', '--'];

@Component({
  selector: 'app-block-inspector',
  imports: [LucideAngularModule],
  templateUrl: './block-inspector.component.html',
  styleUrl: './block-inspector.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlockInspectorComponent {
  readonly store = inject(BlocksStore);
  private readonly language = inject(LanguageService);
  /** Server message for the block it pointed at after a failed save. */
  readonly errorMessage = input<string | null>(null);
  readonly closed = output<void>();

  readonly icons = { left: ArrowLeft, right: ArrowRight, copy: Copy, trash: Trash2, cursor: TextCursorInput, warn: TriangleAlert, shield: ShieldAlert, close: X };
  readonly storages = STORAGE_IDS;
  readonly loopOps = LOOP_OPS;
  readonly t = (key: string, params?: Record<string, string | number>) => this.language.translate(key, params);
  readonly ro = this.store.readOnly;

  readonly node = this.store.selectedNode;
  readonly parent = this.store.selectedParent;

  readonly title = computed(() => {
    const n = this.node();
    return n ? nodeTitle(n, this.t) : '';
  });
  readonly tone = computed(() => {
    const n = this.node();
    return n ? nodeTone(n) : 'text';
  });
  readonly entry = computed(() => {
    const n = this.node();
    return n?.type === 'function' ? catalogEntry(n.name) ?? null : null;
  });
  readonly help = computed(() => {
    const n = this.node();
    if (!n) return '';
    if (n.type === 'function') return this.entry()?.description ?? this.t('commandBlocks.help.unknownFunction');
    if (n.type === 'literal' && /^&p\d+$|^&t$/.test(n.value)) return this.t('commandBlocks.help.argument');
    return this.t(`commandBlocks.help.${n.type}`);
  });
  readonly level = computed(() => {
    const entry = this.entry();
    const key = entry ? levelKey(entry.level) : null;
    return key ? this.t(`commandBlocks.level.${key}`) : null;
  });
  readonly holes = computed(() => {
    const n = this.node();
    return n?.type === 'function' ? argHoles(n, this.t) : [];
  });
  readonly showError = computed(() => {
    const n = this.node();
    return !!n && this.store.errorBlockId() === n.id ? this.errorMessage() : null;
  });
  readonly canMoveEarlier = computed(() => (this.parent()?.index ?? -1) > 0);
  readonly canMoveLater = computed(() => {
    const p = this.parent();
    return !!p && p.index >= 0 && p.index < p.length - 1;
  });
  readonly inList = computed(() => (this.parent()?.index ?? -1) >= 0);

  operators(op: BinaryOp): BinaryOp[] {
    return MATH_OPS.includes(op) ? MATH_OPS : COMPARE_OPS;
  }

  opLabel(op: string): string {
    return this.t(`commandBlocks.ops.${OP_KEY[op] ?? 'eq'}`);
  }

  isPerViewer(storage: VarStorage): boolean {
    return isPerViewer(storage);
  }

  argSummary(nodes: BlockNode[]): string {
    return nodes.every((node) => node.type === 'literal') ? nodes.map((node) => (node as { value: string }).value).join(' ') : '';
  }

  argIsBlocks(nodes: BlockNode[]): boolean {
    return nodes.some((node) => node.type !== 'literal');
  }

  /** Typed text becomes plain words; "rest" arguments (a message) keep their spaces as one piece. */
  setArgText(holeIndex: number, event: Event): void {
    const n = this.node();
    if (n?.type !== 'function') return;
    const value = (event.target as HTMLInputElement).value;
    const hole = this.holes()[holeIndex];
    const param = catalogParams(n.name)[holeIndex];
    const words = value.trim() ? (param?.rest ? [lit(value.trim())] : value.trim().split(/\s+/).map(lit)) : [];
    const args = [...n.args];
    const begin = hole.nodes.length ? args.indexOf(hole.nodes[0]) : args.length;
    args.splice(begin < 0 ? args.length : begin, hole.nodes.length, ...words);
    this.store.patch(n.id, { args } as Partial<BlockNode>);
  }

  setArgCursor(target: DropTarget): void {
    this.store.setInsertAt(target);
    this.store.announcement.set(this.t('commandBlocks.announce.pickForSlot'));
  }

  patchField(field: string, event: Event): void {
    const n = this.node();
    if (!n) return;
    let value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    if (field === 'name') value = value.replace(/[^\p{L}\p{N}_]/gu, '');
    if (field === 'loopVar') value = value.replace(/[^A-Za-z0-9_]/g, '').replace(/^[0-9]+/, '');
    if (field === 'commandName') value = value.replace(/^!/, '').replace(/\s/g, '');
    this.store.patch(n.id, { [field]: value } as Partial<BlockNode>);
  }

  setStorage(storage: VarStorage): void {
    const n = this.node();
    if (!n) return;
    this.store.patch(n.id, { storage, ...(isPerViewer(storage) ? {} : { userSelector: null }) } as Partial<BlockNode>);
  }

  setAccessor(kind: 'value' | 'array' | 'index' | 'random' | 'length'): void {
    const n = this.node();
    if (n?.type !== 'getVar') return;
    const accessor: ArrayAccessor | undefined = kind === 'value' ? undefined : kind === 'index' ? { type: 'index', index: lit('0') } : { type: kind };
    this.store.patch(n.id, { accessor } as Partial<BlockNode>);
  }

  setDeleteMode(kind: 'whole' | 'clear' | 'remove'): void {
    const n = this.node();
    if (n?.type !== 'deleteVar') return;
    const accessor: ArrayAccessor | undefined = kind === 'whole' ? undefined : kind === 'clear' ? { type: 'clear' } : { type: 'remove', index: lit('0') };
    this.store.patch(n.id, { accessor } as Partial<BlockNode>);
  }

  indexValue(): string {
    const n = this.node();
    const acc = n && 'accessor' in n ? n.accessor : undefined;
    const index = acc && 'index' in acc ? acc.index : null;
    return index?.type === 'literal' ? index.value : '';
  }

  patchIndex(event: Event): void {
    const n = this.node();
    const acc = n && 'accessor' in n ? n.accessor : undefined;
    if (!n || !acc || !('index' in acc)) return;
    const value = (event.target as HTMLInputElement).value.replace(/[^\d-]/g, '') || '0';
    this.store.patch(n.id, { accessor: { ...acc, index: lit(value) } } as Partial<BlockNode>);
  }

  /** "Repeat N times" when the loop is the simple kind (start 0, +1 each round, stop below N). */
  simpleTimes(n: ForLoopNode): string | null {
    const c = n.condition;
    const simple = n.init?.type === 'loopAssign' && n.init.operator === '=' && n.init.value?.type === 'literal' && n.init.value.value === '0'
      && n.update?.type === 'loopAssign' && n.update.operator === '++'
      && c?.type === 'binary' && c.operator === '<' && c.left?.type === 'loopVar' && c.right?.type === 'literal';
    return simple && c?.type === 'binary' && c.right?.type === 'literal' ? c.right.value : null;
  }

  patchRepeat(event: Event): void {
    const n = this.node();
    if (n?.type !== 'forLoop') return;
    const count = String(Math.min(25, Math.max(0, Number((event.target as HTMLInputElement).value.replace(/\D/g, '')) || 0)));
    this.store.patch(n.id, {
      init: loopAssign(n.loopVar, '=', lit('0')),
      condition: binary(loopVar(n.loopVar), '<', lit(count)),
      update: loopAssign(n.loopVar, '++')
    } as Partial<BlockNode>);
  }

  /** Renaming the counter renames it everywhere inside the loop too. */
  renameLoopVar(event: Event): void {
    const n = this.node();
    if (n?.type !== 'forLoop') return;
    const next = (event.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_]/g, '').replace(/^[0-9]+/, '');
    if (!next) return;
    const rename = (node: BlockNode | null | undefined): BlockNode | null | undefined => {
      if (!node) return node;
      const copy = JSON.parse(JSON.stringify(node)) as AnyNode;
      const walk = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const rec = value as Record<string, unknown>;
        if ((rec['type'] === 'loopVar' || rec['type'] === 'loopAssign') && rec['name'] === n.loopVar) rec['name'] = next;
        Object.values(rec).forEach((child) => (Array.isArray(child) ? child.forEach(walk) : walk(child)));
      };
      walk(copy);
      return copy as BlockNode;
    };
    this.store.patch(n.id, {
      loopVar: next,
      init: rename(n.init),
      condition: rename(n.condition),
      update: rename(n.update),
      body: n.body.map((child) => rename(child) as BlockNode)
    } as Partial<BlockNode>);
  }

  setLoopOp(event: Event): void {
    const n = this.node();
    if (n?.type !== 'loopAssign') return;
    const operator = (event.target as HTMLSelectElement).value as LoopAssignOp;
    const value = operator === '++' || operator === '--' ? undefined : n.value ?? lit('1');
    this.store.patch(n.id, { operator, value } as Partial<BlockNode>);
  }

  argumentIndex(): string {
    const n = this.node();
    return n?.type === 'literal' && n.value.startsWith('&p') ? n.value.slice(2) : '';
  }

  setArgument(kind: 'word' | 'rest', event?: Event): void {
    const n = this.node();
    if (n?.type !== 'literal') return;
    if (kind === 'rest') {
      this.store.patch(n.id, { value: '&t' } as Partial<BlockNode>);
      return;
    }
    const raw = event ? (event.target as HTMLInputElement).value.replace(/\D/g, '') : '1';
    this.store.patch(n.id, { value: `&p${Math.min(20, Math.max(1, Number(raw) || 1))}` } as Partial<BlockNode>);
  }

  isArgument(value: string): boolean {
    return /^&p\d+$/.test(value) || value === '&t';
  }

  /** Add an "else if" before the final otherwise. */
  addElseIf(): void {
    const n = this.node();
    if (n?.type !== 'ternary') return;
    let last: TernaryNode = n;
    while (last.alternate?.type === 'ternary') last = last.alternate;
    this.store.patch(last.id, { alternate: ternary(binary(null, '==', null), lit(''), last.alternate) } as Partial<BlockNode>);
  }

  branchCount(): number {
    let count = 0;
    let cur: AnyNode | null = this.node();
    while (cur?.type === 'ternary') {
      count += 1;
      cur = cur.alternate;
    }
    return count;
  }

  addAfter(): void {
    const p = this.parent();
    if (!p || p.index < 0) return;
    this.store.setInsertAt(
      p.parentId === this.store.root().id
        ? { kind: 'root', index: p.index + 1 }
        : { kind: 'list', parentId: p.parentId, slot: p.slot as 'children', index: p.index + 1 }
    );
    this.store.select(null);
    this.store.announcement.set(this.t('commandBlocks.announce.cursorAfter'));
  }

  remove(): void {
    const n = this.node();
    if (n) this.store.remove(n.id);
  }

  close(): void {
    this.store.select(null);
    this.closed.emit();
  }
}
