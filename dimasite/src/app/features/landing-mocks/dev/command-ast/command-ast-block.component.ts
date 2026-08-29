import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import {
  BINARY_OPS,
  type DropTarget,
  type ListSlot,
  type MockForLoop,
  type MockNode,
  type MockTernary,
  type SingleSlot,
  binary,
  blockShape,
  blockTone,
  lit,
  loopVar
} from './command-ast-mock.model';
import { CommandAstMockStore } from './command-ast-mock.store';

@Component({
  selector: 'app-command-ast-block',
  imports: [CommandAstBlockComponent],
  templateUrl: './command-ast-block.component.html',
  styleUrl: './command-ast-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-inset]': 'inset()'
  }
})
export class CommandAstBlockComponent {
  readonly store = inject(CommandAstMockStore);
  readonly node = input.required<MockNode>();
  readonly inset = input(false);

  readonly ops = BINARY_OPS;

  tone(type: MockNode['type']): string {
    return blockTone(type);
  }

  shape(type: MockNode['type']): string {
    return blockShape(type, this.inset());
  }

  isSelected(id: string): boolean {
    return this.store.selectedId() === id;
  }

  isHot(target: DropTarget): boolean {
    return this.store.sameTarget(this.store.hoverTarget(), target);
  }

  isMarked(target: DropTarget): boolean {
    return this.store.sameTarget(this.store.dropTarget(), target);
  }

  onSelect(event: Event, id: string): void {
    event.stopPropagation();
    this.store.select(id);
  }

  onDragStart(event: DragEvent, id: string): void {
    event.stopPropagation();
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.store.startDragMove(id);
  }

  onDragEnd(): void {
    this.store.endDrag();
  }

  onDragOver(event: DragEvent, target: DropTarget): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.hoverTarget.set(target);
  }

  onDrop(event: DragEvent, target: DropTarget): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.dropOn(target);
  }

  markSlot(event: Event, target: DropTarget): void {
    event.stopPropagation();
    this.store.setDropTarget(target);
  }

  listTarget(parentId: string, slot: ListSlot, index: number): DropTarget {
    return { kind: 'list', parentId, slot, index };
  }

  singleTarget(parentId: string, slot: SingleSlot): DropTarget {
    return { kind: 'single', parentId, slot };
  }

  patchName(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.store.patch(id, { name: value } as Partial<MockNode>);
  }

  patchValue(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.store.patch(id, { value } as Partial<MockNode>);
  }

  patchCommand(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.store.patch(id, { commandName: value } as Partial<MockNode>);
  }

  patchLoopVar(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.replace(/^#/, '');
    this.store.patch(id, { loopVar: value } as Partial<MockNode>);
  }

  patchOp(id: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.store.patch(id, { operator: value } as Partial<MockNode>);
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

  ifElse(node: MockTernary): MockNode | null {
    let alt = node.alternate;
    let last = node;
    while (alt?.type === 'ternary') {
      last = alt;
      alt = alt.alternate;
    }
    if (!alt || (alt.type === 'literal' && alt.value === '')) return null;
    return alt;
  }

  ifElseParent(node: MockTernary): MockTernary {
    let last = node;
    let alt = node.alternate;
    while (alt?.type === 'ternary') {
      last = alt;
      alt = alt.alternate;
    }
    return last;
  }

  repeatCount(node: MockForLoop): string {
    if (node.condition?.type === 'binary' && node.condition.right?.type === 'literal') {
      return node.condition.right.value;
    }
    return '3';
  }

  patchRepeat(node: MockForLoop, event: Event): void {
    const count = (event.target as HTMLInputElement).value.replace(/\D/g, '') || '0';
    this.store.patch(node.id, {
      condition: binary(loopVar(node.loopVar), '<', lit(count))
    } as Partial<MockNode>);
  }

  remove(event: Event, id: string): void {
    event.stopPropagation();
    this.store.remove(id);
  }

  stop(event: Event): void {
    event.stopPropagation();
  }
}
