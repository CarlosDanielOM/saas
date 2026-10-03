import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  ViewChild,
} from '@angular/core';

import { IconComponent } from '../icon/icon.component';

let nextId = 0;

/**
 * Confirmation for admin actions with real side effects (emails, credit grants).
 * Native <dialog>: focus is trapped, Escape cancels, bottom sheet on phones.
 * Projected content is shown between the message and the warning.
 */
@Component({
  selector: 'app-confirm-modal',
  imports: [IconComponent],
  template: `
    <dialog
      #dialog
      class="lf-dialog confirm"
      [attr.aria-labelledby]="id + '-title'"
      [attr.aria-describedby]="id + '-message'"
      (cancel)="$event.preventDefault(); onCancel()"
      (click)="onBackdropClick($event)"
    >
      <div class="lf-dialog__head">
        <h2 [id]="id + '-title'">{{ title }}</h2>
        <button
          type="button"
          class="lf-btn lf-btn--ghost lf-btn--icon lf-btn--sm"
          aria-label="Close"
          (click)="onCancel()"
          [disabled]="loading"
        >
          <app-icon name="x" />
        </button>
      </div>
      <div class="lf-dialog__body">
        <p [id]="id + '-message'" class="confirm__message">{{ message }}</p>
        <ng-content />
        @if (warning) {
          <p class="lf-warning"><app-icon name="alert" /><span>{{ warning }}</span></p>
        }
      </div>
      <div class="lf-dialog__foot">
        <button type="button" class="lf-btn" (click)="onCancel()" [disabled]="loading">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="lf-btn"
          [class.lf-btn--primary]="!isDanger"
          [class.lf-btn--danger]="isDanger"
          (click)="onConfirm()"
          [disabled]="loading"
        >
          @if (loading) {
            <span class="lf-spin"></span>{{ busyLabel }}
          } @else {
            {{ confirmLabel }}
          }
        </button>
      </div>
    </dialog>
  `,
  styles: [
    `
      .confirm__message {
        color: var(--fg);
        font-size: 0.95rem;
        overflow-wrap: anywhere;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmModalComponent implements AfterViewInit, OnChanges {
  @ViewChild('dialog') private dialog?: ElementRef<HTMLDialogElement>;
  readonly id = `confirm-${++nextId}`;

  @Input({ required: true }) open = false;
  @Input({ required: true }) title = 'Confirm';
  @Input({ required: true }) message = '';
  @Input() warning: string | null = null;
  @Input() confirmLabel = 'Confirm';
  @Input() cancelLabel = 'Cancel';
  @Input() busyLabel = 'Working…';
  @Input() isDanger = false;
  @Input() loading = false;

  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  ngAfterViewInit(): void {
    this.syncDialog();
  }
  ngOnChanges(): void {
    this.syncDialog();
  }
  private syncDialog(): void {
    const dialog = this.dialog?.nativeElement;
    if (!dialog) return;
    if (this.open && !dialog.open) dialog.showModal();
    if (!this.open && dialog.open) dialog.close();
  }
  onBackdropClick(event: MouseEvent): void {
    if (event.target !== this.dialog?.nativeElement) return;
    const rect = this.dialog.nativeElement.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      this.onCancel();
  }
  onConfirm(): void {
    if (!this.loading) this.confirmed.emit();
  }
  onCancel(): void {
    if (!this.loading) this.cancelled.emit();
  }
}
