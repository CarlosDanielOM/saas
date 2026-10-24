import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, output, untracked, viewChild } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { BlocksEditorComponent } from './blocks-editor.component';
import { type RootNode, emptyRoot } from './blocks.model';
import { BlocksStore } from './blocks.store';

/** Read-only look at a block command (public page, commands list). */
@Component({
  selector: 'app-blocks-viewer-dialog',
  imports: [BlocksEditorComponent],
  providers: [BlocksStore],
  templateUrl: './blocks-viewer-dialog.component.html',
  styleUrl: './blocks-viewer-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'close()'
  }
})
export class BlocksViewerDialogComponent {
  private readonly store = inject(BlocksStore);
  private readonly language = inject(LanguageService);
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  /** `!cmd` shown in the title. */
  readonly commandName = input.required<string>();
  readonly root = input<RootNode | null>(null);
  /** The command's "who can use it" level; null for tag rules. */
  readonly commandLevel = input<number | null>(null);
  readonly closed = output<void>();

  readonly t = (key: string, params?: Record<string, string | number>) => this.language.translate(key, params);

  constructor() {
    this.store.readOnly.set(true);
    effect(() => {
      const root = this.root();
      untracked(() => {
        this.store.load(root ?? emptyRoot());
        this.store.patchContext({ argument: '' });
      });
    });
    effect(() => this.store.commandLevel.set(this.commandLevel()));
    effect(() => {
      const button = this.closeButton();
      if (button) setTimeout(() => button.nativeElement.focus());
    });
  }

  close(): void {
    this.closed.emit();
  }

  onOverlay(event: Event): void {
    if (event.target === event.currentTarget) this.close();
  }
}
