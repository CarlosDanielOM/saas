import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  input,
  output,
  signal,
} from '@angular/core';

import { IconComponent } from '../icon/icon.component';

export interface TestEventPayload {
  subscription: Record<string, unknown>;
  event: Record<string, unknown>;
}

@Component({
  selector: 'app-test-event-modal',
  templateUrl: './test-event-modal.component.html',
  styleUrl: './test-event-modal.component.css',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TestEventModalComponent implements OnInit, AfterViewInit {
  @ViewChild('dialog') private dialog?: ElementRef<HTMLDialogElement>;

  /** The event type being tested (e.g. 'channel.follow') */
  readonly eventType = input.required<string>();
  /** Plain name for the event (e.g. 'Follows') */
  readonly eventName = input<string>('');
  readonly channelID = input.required<string>();
  readonly channelName = input<string | null>(null);
  /** The pre-generated test payload (JSON string) */
  readonly initialPayload = input.required<string>();
  /** Owned by the parent so a failed send re-enables the button. */
  readonly sending = input(false);

  readonly sendTest = output<TestEventPayload>();
  readonly closeModal = output<void>();

  protected readonly payloadText = signal('');
  protected readonly jsonError = signal<string | null>(null);

  ngOnInit(): void {
    this.payloadText.set(this.initialPayload());
  }

  ngAfterViewInit(): void {
    this.dialog?.nativeElement.showModal();
  }

  onPayloadChange(event: Event): void {
    this.payloadText.set((event.target as HTMLTextAreaElement).value);
    this.jsonError.set(null);
  }

  onSend(): void {
    try {
      const parsed = JSON.parse(this.payloadText()) as TestEventPayload;
      if (!parsed.subscription || !parsed.event) {
        this.jsonError.set('The payload needs both "subscription" and "event".');
        return;
      }
      if (!parsed.subscription['type']) {
        this.jsonError.set('subscription.type is required.');
        return;
      }
      this.jsonError.set(null);
      this.sendTest.emit(parsed);
    } catch (e) {
      this.jsonError.set(e instanceof SyntaxError ? 'Invalid JSON: ' + e.message : "Couldn't read the payload.");
    }
  }

  onReset(): void {
    this.payloadText.set(this.initialPayload());
    this.jsonError.set(null);
  }

  onCancel(): void {
    if (!this.sending()) this.closeModal.emit();
  }
}
