import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { AssistantsApiService, type AssistantTurn, type AssistantTurnDetail } from '../../services/assistants-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { dateTime, formatDuration, formatNumber, formatUSD } from '../../shared/format';
import { approvalLabel, errorLabel, modelName, toolLabel, toolState } from './assistants-format';
import { turnLabel } from './assistant-turn.component';

/**
 * The whole exchange of one Dima assistant message in a bottom sheet: what the person wrote, what they added
 * while it worked, each tool call with its arguments and result, and the answer. Everything is shown as text
 * (answers may contain Markdown; it is never rendered as HTML). Loaded details are kept for the visit.
 */
@Component({
  selector: 'app-assistant-turn-sheet',
  templateUrl: './assistant-turn-sheet.component.html',
  styleUrl: './assistant-turn-sheet.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent],
})
export class AssistantTurnSheetComponent implements OnDestroy {
  private readonly api = inject(AssistantsApiService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private request?: Subscription;

  /** The turn to show (from `?open=`); null keeps the sheet closed. */
  readonly turnId = input<string | null>(null);
  /** The list row, when it is on screen: shown while the detail loads. */
  readonly preview = input<AssistantTurn | null>(null);
  readonly closed = output<void>();
  readonly onlyPerson = output<string>();

  private readonly cache = signal<ReadonlyMap<string, AssistantTurnDetail>>(new Map());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly detail = computed(() => {
    const id = this.turnId();
    return id ? (this.cache().get(id) ?? null) : null;
  });
  /** Facts every view has: from the detail once loaded, from the list row before that. */
  readonly base = computed<Omit<AssistantTurn, 'tools'> | null>(() => this.detail() ?? this.preview());
  readonly status = computed(() => {
    const base = this.base();
    return base ? turnLabel(base) : null;
  });
  readonly models = computed(() => this.base()?.models.map(modelName).join(', ') || 'not recorded');

  constructor() {
    effect(() => {
      const id = this.turnId();
      untracked(() => {
        const dialog = this.dialog().nativeElement;
        if (!id) {
          this.request?.unsubscribe();
          if (dialog.open) dialog.close();
          return;
        }
        if (!dialog.open) dialog.showModal();
        dialog.querySelector('.lf-dialog__body')?.scrollTo(0, 0);
        if (!this.cache().has(id)) this.load(id);
        else this.error.set(null);
      });
    });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }

  retry(): void {
    const id = this.turnId();
    if (id) this.load(id);
  }

  private load(id: string): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api.assistantTurn(id).subscribe({
      next: ({ data }) => {
        const cache = new Map(this.cache());
        cache.set(id, data);
        this.cache.set(cache);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(
          error instanceof HttpErrorResponse && error.status === 404
            ? 'This message is no longer kept (messages are kept 90 days) or the link is wrong.'
            : "The conversation didn't load. Nothing was changed.",
        );
      },
    });
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  /** Esc, the close button and a tap on the backdrop all end here. */
  onClose(): void {
    if (this.turnId()) this.closed.emit();
  }

  backdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  readonly dateTime = dateTime;
  readonly formatDuration = formatDuration;
  readonly formatNumber = formatNumber;
  readonly formatUSD = formatUSD;
  readonly errorLabel = errorLabel;
  readonly toolLabel = toolLabel;
  readonly toolState = toolState;
  readonly approvalLabel = approvalLabel;
}
