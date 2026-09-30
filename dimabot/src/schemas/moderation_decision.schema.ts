import { Schema, model } from 'mongoose';
import type { IModerationRule } from './channel_moderation_settings.schema.js';
import type { ModerationMatch } from '../utils/moderation/advanced.js';

export interface ModerationContextMessage { messageID: string; username: string; message: string; timestamp: number; isBroadcaster?: boolean }
export interface IModerationDecision {
    _id: string;
    channelID: string;
    userID: string;
    username: string;
    messageID: string;
    messageText: string;
    ruleID: string;
    rule: IModerationRule;
    settingsVersion: number;
    matches: ModerationMatch[];
    context: ModerationContextMessage[];
    mode: 'literal' | 'regex' | 'semantic';
    reviewSource?: 'rule' | 'first_message' | 'spam_continuous';
    state: 'pending' | 'processing' | 'completed';
    verdict: 'allow' | 'violation' | 'uncertain';
    status: string;
    model: string;
    provider: string;
    decisionPolicyVersion: string;
    scores: Record<string, unknown> | null;
    providerRequestID: string;
    inputTokens: number;
    cost: number;
    latencyMs: number;
    charge: { status: 'none' | 'pending' | 'recorded'; credits: number; billableCostUSD?: number; pricingVersion?: string; usdPerMillionInputTokens?: number; externalID: string; customerID: string };
    consequence: { status: string; action?: string; offenseNumber?: number; success?: boolean; errorMessage?: string | null };
    feedback: { label: 'allow' | 'violation' | 'uncertain'; reviewerID: string; reviewedAt: Date } | null;
    deadline: Date;
    createdAt: Date;
    expiresAt: Date;
}

const schema = new Schema<IModerationDecision>({
    _id: String, channelID: { type: String, required: true }, userID: String, username: String,
    messageID: String, messageText: String, ruleID: String, rule: Schema.Types.Mixed,
    settingsVersion: Number, matches: [Schema.Types.Mixed], context: [Schema.Types.Mixed],
    mode: String, reviewSource: { type: String, enum: ['rule', 'first_message', 'spam_continuous'], default: 'rule' }, state: { type: String, default: 'pending' }, verdict: { type: String, default: 'uncertain' },
    status: { type: String, default: 'pending' }, model: { type: String, default: '' }, provider: { type: String, default: '' },
    decisionPolicyVersion: String, scores: { type: Schema.Types.Mixed, default: null },
    providerRequestID: { type: String, default: '' }, inputTokens: { type: Number, default: 0 },
    cost: { type: Number, default: 0 }, latencyMs: { type: Number, default: 0 },
    charge: { type: Schema.Types.Mixed, default: () => ({ status: 'none', credits: 0, externalID: '', customerID: '' }) },
    consequence: { type: Schema.Types.Mixed, default: () => ({ status: 'none' }) },
    feedback: { type: Schema.Types.Mixed, default: null }, deadline: Date,
    createdAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true }
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ channelID: 1, createdAt: -1 });
schema.index({ state: 1, deadline: 1, createdAt: 1 });
schema.index({ 'charge.status': 1, createdAt: 1 });
export const ModerationDecision = model<IModerationDecision>('moderation_decision', schema);
