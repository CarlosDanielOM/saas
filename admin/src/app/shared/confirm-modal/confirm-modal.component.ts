import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Reusable confirmation modal for admin actions (e.g. sending real reminder emails).
 * Accepts plain values (not signals) for easy binding from parent components.
 */
@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <dialog
      #dialog
      class="confirm-modal"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-message"
      (cancel)="$event.preventDefault(); onCancel()"
      (click)="onBackdropClick($event)"
    >
      <div class="confirm-modal__header">
        <h3 id="confirmation-title" class="confirm-modal__title">{{ title }}</h3>
      </div>

      <div class="confirm-modal__body">
        <p id="confirmation-message" class="confirm-modal__message">{{ message }}</p>

        @if (warning) {
          <div class="confirm-modal__warning">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span>{{ warning }}</span>
          </div>
        }
      </div>

      <div class="confirm-modal__actions">
        <button type="button" class="btn btn--secondary" (click)="onCancel()" [disabled]="loading">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn"
          [class.btn--primary]="!isDanger"
          [class.btn--danger]="isDanger"
          (click)="onConfirm()"
          [disabled]="loading"
        >
          @if (loading) {
            <span class="btn__spinner"></span>
            Sending...
          } @else {
            {{ confirmLabel }}
          }
        </button>
      </div>
    </dialog>
  `,
  styleUrl: './confirm-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmModalComponent implements AfterViewInit, OnChanges {
  @ViewChild('dialog') private dialog?: ElementRef<HTMLDialogElement>;
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

  @Input({ required: true }) open: boolean = false;
  @Input({ required: true }) title: string = 'Confirm';
  @Input({ required: true }) message: string = '';
  @Input() warning: string | null = null;
  @Input() confirmLabel: string = 'Confirm';
  @Input() cancelLabel: string = 'Cancel';
  @Input() isDanger: boolean = false;
  @Input() loading: boolean = false;

  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  onConfirm(): void {
    if (!this.loading) {
      this.confirmed.emit();
    }
  }

  onCancel(): void {
    if (!this.loading) {
      this.cancelled.emit();
    }
  }
}
