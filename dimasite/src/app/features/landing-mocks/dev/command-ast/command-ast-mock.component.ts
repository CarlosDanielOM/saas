import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';

import { ThemeService } from '../../../../services/theme.service';
import { CommandAstBlockComponent } from './command-ast-block.component';
import {
  PALETTE,
  PALETTE_CATEGORIES,
  SAMPLES,
  type DropTarget,
  type MockPanel,
  type PaletteCategory,
  type PaletteItem
} from './command-ast-mock.model';
import { CommandAstMockStore } from './command-ast-mock.store';

@Component({
  selector: 'app-command-ast-mock',
  imports: [RouterLink, LucideAngularModule, CommandAstBlockComponent],
  providers: [CommandAstMockStore],
  templateUrl: './command-ast-mock.component.html',
  styleUrl: './command-ast-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommandAstMockComponent {
  readonly store = inject(CommandAstMockStore);
  private readonly themeService = inject(ThemeService);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;
  readonly palette = PALETTE;
  readonly categories = PALETTE_CATEGORIES;
  readonly samples = SAMPLES;
  readonly panel = signal<MockPanel>('canvas');
  readonly sourceDraft = signal<string | null>(null);

  itemsFor(category: PaletteCategory): PaletteItem[] {
    return this.palette.filter((item) => item.category === category);
  }

  sourceValue(): string {
    return this.sourceDraft() ?? this.store.source();
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  setPanel(panel: MockPanel): void {
    this.panel.set(panel);
  }

  rootTarget(index: number): DropTarget {
    return { kind: 'root', index };
  }

  onPaletteDrag(event: DragEvent, item: PaletteItem): void {
    event.dataTransfer?.setData('text/plain', item.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.store.startDragNew(item.id);
  }

  onCanvasDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.target === event.currentTarget) {
      this.store.hoverTarget.set(this.rootTarget(this.store.root().children.length));
    }
  }

  onCanvasDrop(event: DragEvent): void {
    event.preventDefault();
    const target = this.store.hoverTarget() ?? this.rootTarget(this.store.root().children.length);
    this.store.dropOn(target);
  }

  onRowDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.hoverTarget.set(this.rootTarget(this.indexFromY(event, index)));
  }

  onRowDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.dropOn(this.rootTarget(this.indexFromY(event, index)));
  }

  ghostAt(index: number): boolean {
    const hover = this.store.hoverTarget();
    return !!this.store.draggingNow() && hover?.kind === 'root' && hover.index === index;
  }

  private indexFromY(event: DragEvent, index: number): number {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return index;
    const rect = el.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
  }

  onSourceInput(event: Event): void {
    this.sourceDraft.set((event.target as HTMLTextAreaElement).value);
  }

  onSourcePaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.trim()) return;
    event.preventDefault();
    this.sourceDraft.set(null);
    this.store.loadFromSource(text);
  }

  loadSample(id: string): void {
    this.sourceDraft.set(null);
    this.store.loadSample(id);
  }

  applySource(): void {
    const draft = this.sourceDraft();
    if (draft === null) return;
    if (draft === this.store.source()) {
      this.sourceDraft.set(null);
      return;
    }
    this.store.loadFromSource(draft);
    if (!this.store.parseError()) this.sourceDraft.set(null);
  }

  patchUser(event: Event): void {
    this.store.patchContext({ user: (event.target as HTMLInputElement).value });
  }

  patchArg(event: Event): void {
    this.store.patchContext({ argument: (event.target as HTMLInputElement).value });
  }
}
