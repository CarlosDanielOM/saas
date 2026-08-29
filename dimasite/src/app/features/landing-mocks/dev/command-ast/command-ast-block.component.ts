import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import {
  BINARY_OPS,
  type DropTarget,
  type ListSlot,
  type MockNode,
  type SingleSlot,
  blockTone
} from './command-ast-mock.model';
import { CommandAstMockStore } from './command-ast-mock.store';

@Component({
  selector: 'app-command-ast-block',
  imports: [CommandAstBlockComponent],
  templateUrl: './command-ast-block.component.html',
  styleUrl: './command-ast-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommandAstBlockComponent {
  readonly store = inject(CommandAstMockStore);
  readonly node = input.required<MockNode>();

  readonly ops = BINARY_OPS;

  tone(type: MockNode['type']): string {
    return blockTone(type);
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

  patchStorage(id: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.store.patch(id, { storage: value } as Partial<MockNode>);
  }

  remove(event: Event, id: string): void {
    event.stopPropagation();
    this.store.remove(id);
  }

  stop(event: Event): void {
    event.stopPropagation();
  }
}
