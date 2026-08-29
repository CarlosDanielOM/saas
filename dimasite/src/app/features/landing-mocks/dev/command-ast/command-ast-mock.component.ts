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
  readonly preview = signal<'source' | 'ast'>('source');

  itemsFor(category: PaletteCategory): PaletteItem[] {
    return this.palette.filter((item) => item.category === category);
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

  onCanvasDragOver(event: DragEvent, target: DropTarget): void {
    event.preventDefault();
    this.store.hoverTarget.set(target);
  }

  onCanvasDrop(event: DragEvent, target: DropTarget): void {
    event.preventDefault();
    this.store.dropOn(target);
  }

  patchUser(event: Event): void {
    this.store.patchContext({ user: (event.target as HTMLInputElement).value });
  }

  patchArg(event: Event): void {
    this.store.patchContext({ argument: (event.target as HTMLInputElement).value });
  }

  copySource(): void {
    void navigator.clipboard?.writeText(this.store.source());
  }
}
