import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { DecisionsApiService, type DecisionDetail, type DecisionLabel, type DecisionRow } from '../../services/decisions-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { dateTime, formatCreditValue, formatCredits, formatDuration, formatNumber, formatUSD, relativeTime } from '../format';
import { IconComponent } from '../icon/icon.component';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { ToastService } from '../toast/toast.service';
import {
  LABEL_TEXT,
  SOURCE_LABEL,
  categoryName,
  modelName,
  ordinal,
  outcomeLabel,
  percent,
  ruleName,
  scoredCategories,
  twitchSaid,
  verdictAgrees,
  whatHappened,
  type DetailHistory,
} from './decision-format';

export const NOTE_MAX = 500;
/** The counter shows from here on, so it is not noise on every short note. */
const NOTE_COUNTER_FROM = 400;

/**
 * One decision in a bottom sheet (a centred card on desktop): what happened and why, the message and
 * the chat before it, the scores against the channel's ban bar, what it cost, and the owner's verdict.
 * The parent owns which decision is open (it lives in the URL) and the list it steps through.
 */
@Component({
  selector: 'app-decision-detail',
  templateUrl: './decision-detail.component.html',
  styleUrl: './decision-detail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SkeletonComponent, RouterLink],
})
export class DecisionDetailComponent implements OnDestroy {
  private readonly api = inject(DecisionsApiService);
  private readonly toast = inject(ToastService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('sheet');
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');

  /** The decision to show; null closes the sheet. */
  readonly id = input<string | null>(null);
  /** The list row, when the decision is on the current page: shown at once while the detail loads. */
  readonly row = input<DecisionRow | null>(null);
  /** Inside a channel's tab: the channel is already known, so it is not a link out. */
  readonly fixedChannel = input(false);
  /** Where this decision sits in the list being stepped through; null when it is not on the list. */
  readonly position = input<{ index: number; total: number } | null>(null);
  readonly hasPrev = input(false);
  readonly hasNext = input(false);

  readonly closed = output<void>();
  readonly step = output<-1 | 1>();
  readonly openId = output<string>();
  readonly saved = output<{ id: string; feedback: DecisionRow['feedback'] }>();
  readonly onlyViewer = output<{ id: string; name: string }>();

  readonly detail = signal<DecisionDetail | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saving = signal<DecisionLabel | 'remove' | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly changing = signal(false);
  readonly note = signal('');
  readonly copied = signal<string | null>(null);

  readonly noteMax = NOTE_MAX;
  readonly showCounter = computed(() => this.note().length >= NOTE_COUNTER_FROM);

  /** What is on screen: the full detail once loaded, the list row until then. */
  readonly shown = computed<DecisionRow | null>(() => this.detail() ?? this.row());
  readonly outcome = computed(() => {
    const row = this.shown();
    return row ? outcomeLabel(row) : null;
  });
  readonly sentence = computed(() => {
    const row = this.shown();
    return row ? whatHappened(row) : '';
  });
  readonly scores = computed(() => {
    const row = this.shown();
    if (!row || row.kind !== 'ai' || !row.scores) return [];
    return scoredCategories(row, this.detail()?.categories ?? []).map((item) => ({ name: categoryName(item.key), percent: percent(item.value) }));
  });
  readonly safe = computed(() => {
    const value = this.shown()?.scores?.['safe'];
    return typeof value === 'number' ? percent(value) : null;
  });
  readonly feedback = computed(() => this.shown()?.feedback ?? null);
  readonly agrees = computed(() => {
    const row = this.shown();
    const feedback = row?.feedback;
    return row && feedback ? verdictAgrees(feedback.label, row.verdict) : null;
  });
  /** The verdict buttons show for a new verdict, or after "Change". */
  readonly choosing = computed(() => !this.feedback() || this.changing());

  private request?: Subscription;
  private saveRequest?: Subscription;
  private copiedTimer?: ReturnType<typeof setTimeout>;
  /** Set while the parent closes the sheet, so the dialog's own close event is not reported back. */
  private closingFromInput = false;

  readonly labelText = LABEL_TEXT;
  readonly sourceLabel = SOURCE_LABEL;
  readonly modelName = modelName;
  readonly ruleName = ruleName;
  readonly ordinal = ordinal;
  readonly dateTime = dateTime;
  readonly relativeTime = relativeTime;
  readonly formatUSD = formatUSD;
  readonly formatCredits = formatCredits;
  readonly formatCreditValue = formatCreditValue;
  readonly formatDuration = formatDuration;
  readonly formatNumber = formatNumber;
  readonly twitchSaid = twitchSaid;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.openFor(id));
    });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    this.saveRequest?.unsubscribe();
    clearTimeout(this.copiedTimer);
  }

  private openFor(id: string | null): void {
    const dialog = this.dialog().nativeElement;
    this.request?.unsubscribe();
    this.saveRequest?.unsubscribe();
    this.saving.set(null);
    this.saveError.set(null);
    this.changing.set(false);
    this.copied.set(null);
    if (!id) {
      this.detail.set(null);
      if (dialog.open) {
        this.closingFromInput = true;
        dialog.close();
        this.closingFromInput = false;
      }
      return;
    }
    if (this.detail()?.id !== id) this.detail.set(null);
    this.note.set(this.row()?.feedback?.note ?? '');
    if (!dialog.open) dialog.showModal();
    this.body()?.nativeElement.scrollTo({ top: 0 });
    this.load();
  }

  load(): void {
    const id = this.id();
    if (!id) return;
    this.request?.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    this.request = this.api.get(id).subscribe({
      next: ({ data }) => {
        this.detail.set(data);
        this.loading.set(false);
        if (!this.changing() && !this.saveError()) this.note.set(data.feedback?.note ?? '');
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.loadError.set(
          error instanceof HttpErrorResponse && error.status === 404
            ? 'This decision was not found. Decisions are kept for 180 days.'
            : apiErrorMessage(error, "The decision's details did not load."),
        );
      },
    });
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  onDialogClose(): void {
    if (!this.closingFromInput && this.id()) this.closed.emit();
  }

  /** A tap on the dimmed backdrop closes the sheet, like the other admin dialogs. */
  onDialogClick(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  onNote(field: HTMLTextAreaElement): void {
    // A paste can go past maxlength in some browsers: cut it here and in the field.
    if (field.value.length > NOTE_MAX) field.value = field.value.slice(0, NOTE_MAX);
    this.note.set(field.value);
  }

  startChange(): void {
    this.changing.set(true);
    this.saveError.set(null);
  }

  cancelChange(): void {
    this.changing.set(false);
    this.saveError.set(null);
    this.note.set(this.feedback()?.note ?? '');
  }

  save(label: DecisionLabel | null): void {
    const id = this.id();
    if (!id || this.saving()) return;
    const note = label ? this.note().trim() : '';
    this.saving.set(label ?? 'remove');
    this.saveError.set(null);
    this.saveRequest = this.api.setFeedback(id, label, label ? note || null : null).subscribe({
      next: ({ data }) => {
        this.saving.set(null);
        if (this.id() !== id) return;
        const feedback = data.feedback ?? null;
        this.detail.update((detail) => (detail && detail.id === id ? { ...detail, feedback } : detail));
        this.changing.set(false);
        this.note.set(feedback?.note ?? '');
        this.saved.emit({ id, feedback });
        this.toast.success(label ? `Verdict saved: ${LABEL_TEXT[label].toLowerCase()}.` : 'Verdict removed.');
      },
      error: (error: unknown) => {
        this.saving.set(null);
        const reason = apiErrorMessage(error, 'The server did not save it. Your note is kept: try again.');
        this.saveError.set(label ? `Your verdict was not saved. ${reason}` : `The verdict was not removed. ${reason}`);
        this.toast.error(label ? 'Your verdict was not saved.' : 'The verdict was not removed.');
      },
    });
  }

  historyLabel(item: DetailHistory): { label: string; tone: string } {
    // History rows carry no scores, so "Almost banned" cannot be told apart from "Allowed" here.
    return outcomeLabel({ ...item, kind: 'rule', status: 'completed', scores: null });
  }

  copy(value: string, what: string): void {
    void navigator.clipboard?.writeText(value).then(
      () => {
        this.copied.set(what);
        clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.copied.set(null), 2000);
      },
      () => this.copied.set(null),
    );
  }
}
