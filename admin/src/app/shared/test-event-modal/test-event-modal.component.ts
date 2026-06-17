import {
    ChangeDetectionStrategy,
    Component,
    input,
    output,
    signal
} from '@angular/core';

export interface TestEventPayload {
    subscription: Record<string, unknown>;
    event: Record<string, unknown>;
}

@Component({
    selector: 'app-test-event-modal',
    templateUrl: './test-event-modal.component.html',
    styleUrl: './test-event-modal.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class TestEventModalComponent {
    /** The event type being tested (e.g., 'channel.follow') */
    readonly eventType = input.required<string>();

    /** The channel ID for this eventsub */
    readonly channelID = input.required<string>();

    /** The pre-generated test payload (JSON string) */
    readonly initialPayload = input.required<string>();

    /** Emitted when user clicks Send */
    readonly sendTest = output<TestEventPayload>();

    /** Emitted when user clicks Cancel */
    readonly closeModal = output<void>();

    /** Current editable payload as string */
    protected payloadText = signal('');

    /** Loading state when sending */
    protected isSending = signal(false);

    /** Error message if payload is invalid JSON */
    protected jsonError = signal<string | null>(null);

    ngOnInit(): void {
        this.payloadText.set(this.initialPayload());
    }

    /**
     * Called when the initialPayload input changes (when user selects different event type)
     */
    onPayloadChange(event: Event): void {
        const textarea = event.target as HTMLTextAreaElement;
        this.payloadText.set(textarea.value);
        this.jsonError.set(null);
    }

    /**
     * Validate the current payload and emit sendTest if valid
     */
    onSend(): void {
        try {
            const parsed = JSON.parse(this.payloadText()) as TestEventPayload;

            // Basic structure validation
            if (!parsed.subscription || !parsed.event) {
                this.jsonError.set('Payload must have "subscription" and "event" fields');
                return;
            }

            if (!parsed.subscription['type']) {
                this.jsonError.set('subscription.type is required');
                return;
            }

            this.jsonError.set(null);
            this.isSending.set(true);
            this.sendTest.emit(parsed);
        } catch (e) {
            if (e instanceof SyntaxError) {
                this.jsonError.set('Invalid JSON: ' + e.message);
            } else {
                this.jsonError.set('Error parsing payload');
            }
        }
    }

    /**
     * Reset payload to the initial default values
     */
    onReset(): void {
        this.payloadText.set(this.initialPayload());
        this.jsonError.set(null);
    }

    /**
     * Called when parent signals that sending is complete (success or failure)
     */
    onSendComplete(): void {
        this.isSending.set(false);
    }

    onCancel(): void {
        this.closeModal.emit();
    }
}
