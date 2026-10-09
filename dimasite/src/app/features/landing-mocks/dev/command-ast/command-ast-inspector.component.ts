import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  LucideAngularModule,
  ShieldAlert,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-angular';

import { argHoles, nodeTitle, nodeTone, OP_LABEL } from './command-ast-block.component';
import { catalogEntry, levelLabel } from './command-ast-catalog';
import {
  BINARY_OPS,
  type DropTarget,
  type MockBinaryOp,
  type MockNode,
  type MockTernary,
  type MockVarStorage,
  STORAGE_OPTIONS,
  binary,
  lit,
  loopVar,
  ternary
} from './command-ast-mock.model';
import { parseSource } from './command-ast-mock.parse';
import { CommandAstMockStore } from './command-ast-mock.store';
import { toSource } from './command-ast-mock.source';

const COMPARE_OPS: MockBinaryOp[] = ['==', '!=', '>', '<', '>=', '<=', '~='];
const MATH_OPS: MockBinaryOp[] = ['+', '-', '*', '/', '%'];

const TYPE_HELP: Partial<Record<MockNode['type'], string>> = {
  literal: 'Chat sees this exactly as typed, spaces included.',
  template: 'Text with values inside it, kept together as one piece (for example inside an if).',
  getVar: 'Puts a remembered value into the message.',
  setVar: 'Remembers a value under a name. It says nothing in chat.',
  exists: 'Yes when the variable has a value, no when it was never set or was forgotten.',
  deleteVar: 'Forgets the value, so the next use starts fresh.',
  binary: 'Works out a value: a yes/no check or a number.',
  ternary: 'Checks something, then says or does one branch.',
  commandRef: 'Runs another command of yours, as if someone typed it.',
  forLoop: 'Repeats the blocks inside. Use #i to show the round number (0, 1, 2…).',
  group: 'Keeps blocks together so they count as one, for example in a branch.',
  loopVar: 'The current round of the loop around it.'
};

@Component({
  selector: 'app-command-ast-inspector',
  imports: [LucideAngularModule],
  templateUrl: './command-ast-inspector.component.html',
  styleUrl: './command-ast-inspector.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommandAstInspectorComponent {
  readonly store = inject(CommandAstMockStore);
  readonly closed = output<void>();

  readonly leftIcon = ArrowLeft;
  readonly rightIcon = ArrowRight;
  readonly copyIcon = Copy;
  readonly trashIcon = Trash2;
  readonly cursorIcon = TextCursorInput;
  readonly warnIcon = TriangleAlert;
  readonly shieldIcon = ShieldAlert;
  readonly closeIcon = X;
  readonly storageOptions = STORAGE_OPTIONS;
  readonly opLabel = OP_LABEL;

  readonly node = this.store.selectedNode;
  readonly parent = this.store.selectedParent;

  readonly title = computed(() => {
    const n = this.node();
    return n ? nodeTitle(n) : '';
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
    if (n.type === 'function') return this.entry()?.description ?? 'This function is not in the DomDimaBot catalog. Check the name.';
    return TYPE_HELP[n.type] ?? '';
  });
  readonly level = computed(() => {
    const entry = this.entry();
    return entry ? levelLabel(entry.level) : null;
  });
  readonly holes = computed(() => {
    const n = this.node();
    return n?.type === 'function' ? argHoles(n) : [];
  });
  readonly code = computed(() => {
    const n = this.node();
    return n ? toSource(n) : '';
  });
  readonly canMoveEarlier = computed(() => (this.parent()?.index ?? -1) > 0);
  readonly canMoveLater = computed(() => {
    const p = this.parent();
    return !!p && p.index >= 0 && p.index < p.length - 1;
  });
  readonly inList = computed(() => (this.parent()?.index ?? -1) >= 0);

  operators(op: MockBinaryOp): MockBinaryOp[] {
    return MATH_OPS.includes(op) ? MATH_OPS : COMPARE_OPS;
  }

  allOps = BINARY_OPS;

  argSummary(nodes: MockNode[]): string {
    return nodes.map((node) => (node.type === 'literal' ? node.value : toSource(node))).join(' ');
  }

  /** Type a value straight into an argument. Text with $(…) or %(…) becomes blocks. */
  setArgText(holeIndex: number, event: Event): void {
    const n = this.node();
    if (n?.type !== 'function') return;
    const text = (event.target as HTMLInputElement).value;
    const hole = this.holes()[holeIndex];
    const parsed = text.trim() ? parseSource(text).root.children : [];
    const args = [...n.args];
    const begin = hole.nodes.length ? args.indexOf(hole.nodes[0]) : args.length;
    args.splice(begin, hole.nodes.length, ...parsed);
    this.store.patch(n.id, { args } as Partial<MockNode>);
  }

  useExample(example: string): void {
    const n = this.node();
    if (n?.type !== 'function') return;
    const parsed = parseSource(`$(${example})`).root.children[0];
    if (parsed?.type === 'function') this.store.patch(n.id, { args: parsed.args } as Partial<MockNode>);
  }

  setArgCursor(target: DropTarget): void {
    this.store.setInsertAt(target);
    this.store.announcement.set('Pick a block from the library to put it there');
  }

  patchField(field: string, event: Event): void {
    const n = this.node();
    if (!n) return;
    let value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    if (field === 'name' || field === 'loopVar') value = value.replace(/[^\w]/g, '');
    if (field === 'commandName') value = value.replace(/^!/, '').trim();
    this.store.patch(n.id, { [field]: value } as Partial<MockNode>);
  }

  setStorage(storage: MockVarStorage): void {
    const n = this.node();
    if (!n) return;
    const perUser = storage === 'cacheUser' || storage === 'dbUser';
    this.store.patch(n.id, { storage, ...(perUser ? {} : { userSelector: null }) } as Partial<MockNode>);
  }

  setAccessor(kind: 'value' | 'index' | 'random' | 'length'): void {
    const n = this.node();
    if (n?.type !== 'getVar') return;
    const accessor = kind === 'value' ? undefined : kind === 'index' ? { type: 'index' as const, index: lit('0') } : { type: kind };
    this.store.patch(n.id, { accessor } as Partial<MockNode>);
  }

  indexValue(): string {
    const n = this.node();
    const index = n?.type === 'getVar' && n.accessor?.type === 'index' ? n.accessor.index : null;
    return index?.type === 'literal' ? index.value : '0';
  }

  patchIndex(event: Event): void {
    const n = this.node();
    if (n?.type !== 'getVar' || n.accessor?.type !== 'index') return;
    const value = (event.target as HTMLInputElement).value.replace(/[^\d-]/g, '') || '0';
    this.store.patch(n.id, { accessor: { type: 'index', index: lit(value) } } as Partial<MockNode>);
  }

  patchRepeat(event: Event): void {
    const n = this.node();
    if (n?.type !== 'forLoop') return;
    const count = String(Math.min(25, Math.max(0, Number((event.target as HTMLInputElement).value.replace(/\D/g, '')) || 0)));
    this.store.patch(n.id, { condition: binary(loopVar(n.loopVar), '<', lit(count)) } as Partial<MockNode>);
  }

  repeatCount(): string {
    const n = this.node();
    if (n?.type === 'forLoop' && n.condition?.type === 'binary' && n.condition.right?.type === 'literal') {
      return n.condition.right.value;
    }
    return '3';
  }

  /** Add an "else if" before the final otherwise. */
  addElseIf(): void {
    const n = this.node();
    if (n?.type !== 'ternary') return;
    let last: MockTernary = n;
    while (last.alternate?.type === 'ternary') last = last.alternate;
    const branch = ternary(binary(null, '==', null), lit(''), last.alternate);
    this.store.patch(last.id, { alternate: branch } as Partial<MockNode>);
  }

  branchCount(): number {
    let count = 0;
    let cur: MockNode | null = this.node();
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
    this.store.announcement.set('Cursor moved after the block. Pick one from the library.');
  }

  remove(): void {
    const n = this.node();
    if (n) this.store.remove(n.id);
  }

  storageHint(storage: string): string {
    return STORAGE_OPTIONS.find((opt) => opt.id === storage)?.hint ?? '';
  }
}
