import { Schema, model, Types } from 'mongoose';

export type DomainEventDeliveryStatus = 'pending' | 'processing' | 'retry' | 'succeeded' | 'skipped' | 'dead';
export type DomainEventDeliveryErrorCode = '' | 'prerequisite_missing' | 'contract_invalid' | 'handler_failed' | 'interrupted' | 'journal_missing' | 'policy_rejected';

export interface IDomainEventDelivery {
    _id: Types.ObjectId;
    consumer: string;
    topic: string;
    eventID: Types.ObjectId;
    eventKey: string;
    status: DomainEventDeliveryStatus;
    attempts: number;
    nextAttemptAt: Date | null;
    lockedUntil: Date | null;
    leaseToken: string | null;
    lastError: string;
    lastErrorCode?: DomainEventDeliveryErrorCode;
    lastPrerequisiteKind?: '' | 'owner' | 'subject' | 'metric' | 'other';
    lastAttemptDurationMs?: number | null;
    lastDeadLetterError: string;
    firstAttemptAt: Date | null;
    completedAt: Date | null;
    skipReason?: string;
    deadLetteredAt: Date | null;
    replayCount: number;
    lastReplayedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const domainEventDeliverySchema = new Schema<IDomainEventDelivery>({
    consumer: { type: String, required: true, index: true },
    topic: { type: String, required: true, index: true },
    eventID: { type: Schema.Types.ObjectId, required: true, ref: 'domain_event' },
    eventKey: { type: String, required: true },
    status: {
        type: String,
        enum: ['pending', 'processing', 'retry', 'succeeded', 'skipped', 'dead'],
        required: true,
        default: 'pending',
        index: true
    },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    leaseToken: { type: String, default: null },
    lastError: { type: String, default: '' },
    lastErrorCode: { type: String, enum: ['', 'prerequisite_missing', 'contract_invalid', 'handler_failed', 'interrupted', 'journal_missing', 'policy_rejected'], default: '' },
    lastPrerequisiteKind: { type: String, enum: ['', 'owner', 'subject', 'metric', 'other'], default: '' },
    lastAttemptDurationMs: { type: Number, min: 0, default: null },
    lastDeadLetterError: { type: String, default: '' },
    firstAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    skipReason: { type: String, default: '' },
    deadLetteredAt: { type: Date, default: null },
    replayCount: { type: Number, required: true, default: 0 },
    lastReplayedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true }
}, {
    timestamps: true,
    versionKey: false
});

domainEventDeliverySchema.index({ consumer: 1, eventKey: 1 }, { unique: true });
domainEventDeliverySchema.index({ consumer: 1, status: 1, nextAttemptAt: 1 });
domainEventDeliverySchema.index({ consumer: 1, status: 1, lockedUntil: 1 });
domainEventDeliverySchema.index({ consumer: 1, status: 1, updatedAt: 1, _id: 1 });
domainEventDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DomainEventDeliverySchema = model<IDomainEventDelivery>(
    'domain_event_delivery',
    domainEventDeliverySchema
);
