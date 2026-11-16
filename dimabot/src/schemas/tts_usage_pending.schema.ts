import { Schema, model } from 'mongoose';

import type { AiUsageContextInput } from '../utils/ai_usage_event.js';

/**
 * A paid OpenRouter voice line whose `ai_usage` event waits for OpenRouter's real charge (see
 * `utils/tts/tts_provider_cost.ts`). The credits were already taken from the local balance; the row is
 * deleted once Polar has the event.
 */
export interface ITtsUsagePending {
    /** The usage entry: Polar's external id and the receipt id. */
    entryId: string;
    channelID: string;
    customerId: string;
    provider: 'fish' | 'kokoro';
    /** The model that spoke, e.g. `fish-audio/drama-3`. */
    backend: string;
    generationId: string;
    /** UTF-8 bytes the provider billed, for the list-price fallback. */
    bytes: number;
    characters: number;
    /** Our fixed price, already debited locally. */
    credits: number;
    usage: AiUsageContextInput;
    occurredAt: Date;
    nextAttemptAt: Date;
    attempts: number;
    /** Polar was down: the event is in the channel's durable Dragonfly queue and the worker flushes it. */
    queued: boolean;
    lastError?: string | null;
    created_at?: Date;
    updated_at?: Date;
}

const ttsUsagePendingSchema = new Schema<ITtsUsagePending>({
    entryId: { type: String, required: true },
    channelID: { type: String, required: true },
    customerId: { type: String, required: true },
    provider: { type: String, enum: ['fish', 'kokoro'], required: true },
    backend: { type: String, required: true },
    generationId: { type: String, required: true },
    bytes: { type: Number, required: true },
    characters: { type: Number, required: true },
    credits: { type: Number, required: true },
    usage: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, required: true },
    nextAttemptAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    queued: { type: Boolean, default: false },
    lastError: { type: String, default: null }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, minimize: false });

ttsUsagePendingSchema.index({ entryId: 1 }, { unique: true });
ttsUsagePendingSchema.index({ nextAttemptAt: 1 });

const TtsUsagePending = model<ITtsUsagePending>('tts_usage_pending', ttsUsagePendingSchema, 'tts_usage_pending');

export default TtsUsagePending;
