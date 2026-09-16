import crypto from 'crypto';
import { Schema, model } from 'mongoose';

export type ModerationRuleType = 'caps' | 'links' | 'emote_spam' | 'blacklist';
export type ModerationAction = 'off' | 'warn' | 'delete' | 'timeout' | 'ban';
export type CapsThresholdMode = 'count' | 'percentage';

export interface IModerationOffenseStep {
    action: ModerationAction;
    timeoutSeconds: number;
}

export interface IModerationRule {
    id: string;
    type: ModerationRuleType;
    enabled: boolean;
    firstOffense: IModerationOffenseStep;
    secondOffense: IModerationOffenseStep;
    thirdOffense: IModerationOffenseStep;
    reason: string;
    exemptUserLevel: number;
    capsThresholdMode: CapsThresholdMode;
    minCapsCount: number;
    maxCapsPercentage: number;
    minMessageLength: number;
    allowlistDomains: string[];
    maxEmoteCount: number;
    terms: string[];
}

export interface IChannelModerationSettings {
    channelID: string;
    channel: string;
    enabled: boolean;
    offenseWindowSeconds: number;
    rules: IModerationRule[];
    settingsVersion: number;
    createdAt: Date;
    updatedAt: Date;
}

export const MODERATION_OFFENSE_DEFAULTS: { first: IModerationOffenseStep; second: IModerationOffenseStep; third: IModerationOffenseStep } = {
    first: { action: 'warn', timeoutSeconds: 60 },
    second: { action: 'delete', timeoutSeconds: 60 },
    third: { action: 'timeout', timeoutSeconds: 60 }
};

export const MODERATION_RULE_DEFAULTS = {
    reason: 'Message blocked by channel moderation',
    exemptUserLevel: 7,
    capsThresholdMode: 'count' as CapsThresholdMode,
    minCapsCount: 8,
    maxCapsPercentage: 70,
    minMessageLength: 10,
    maxEmoteCount: 10
};

export const MODERATION_SETTINGS_DEFAULTS = {
    enabled: false,
    offenseWindowSeconds: 3600,
    settingsVersion: 1
};

export const MAX_TIMEOUT_SECONDS = 1209600;
export const MIN_OFFENSE_WINDOW_SECONDS = 60;
export const MAX_OFFENSE_WINDOW_SECONDS = 86400;
export const MAX_RULES_PER_CHANNEL = 20;
export const MAX_BLACKLIST_TERMS = 200;
export const MAX_ALLOWLIST_DOMAINS = 50;

/**
 * The default rule set seeded for NEW streamers on first activation:
 * caps, links and emote spam enabled with the standard warn → delete →
 * timeout(60s) ladder; blacklist present but disabled with no terms.
 * Existing channels are never seeded — their lazily created settings stay
 * disabled with no rules so nothing about their chat changes.
 */
export function buildDefaultModerationRules(): IModerationRule[] {
    const base = {
        enabled: true,
        firstOffense: { ...MODERATION_OFFENSE_DEFAULTS.first },
        secondOffense: { ...MODERATION_OFFENSE_DEFAULTS.second },
        thirdOffense: { ...MODERATION_OFFENSE_DEFAULTS.third },
        reason: MODERATION_RULE_DEFAULTS.reason,
        exemptUserLevel: MODERATION_RULE_DEFAULTS.exemptUserLevel,
        capsThresholdMode: MODERATION_RULE_DEFAULTS.capsThresholdMode,
        minCapsCount: MODERATION_RULE_DEFAULTS.minCapsCount,
        maxCapsPercentage: MODERATION_RULE_DEFAULTS.maxCapsPercentage,
        minMessageLength: MODERATION_RULE_DEFAULTS.minMessageLength,
        allowlistDomains: [] as string[],
        maxEmoteCount: MODERATION_RULE_DEFAULTS.maxEmoteCount,
        terms: [] as string[]
    };

    return [
        { ...base, id: crypto.randomUUID(), type: 'caps', reason: 'Please do not use so many caps' },
        { ...base, id: crypto.randomUUID(), type: 'links', reason: 'Please do not post links' },
        { ...base, id: crypto.randomUUID(), type: 'emote_spam', reason: 'Please do not spam emotes' },
        { ...base, id: crypto.randomUUID(), type: 'blacklist', enabled: false, reason: 'You used a blocked word or phrase' }
    ];
}

const offenseStepSchema = new Schema<IModerationOffenseStep>({
    action: { type: String, enum: ['off', 'warn', 'delete', 'timeout', 'ban'], default: 'warn' },
    timeoutSeconds: { type: Number, default: 60, min: 1, max: MAX_TIMEOUT_SECONDS }
}, { _id: false });

const moderationRuleSchema = new Schema<IModerationRule>({
    id: { type: String, required: true },
    type: { type: String, enum: ['caps', 'links', 'emote_spam', 'blacklist'], required: true },
    enabled: { type: Boolean, default: true },
    firstOffense: { type: offenseStepSchema, default: () => ({ ...MODERATION_OFFENSE_DEFAULTS.first }) },
    secondOffense: { type: offenseStepSchema, default: () => ({ ...MODERATION_OFFENSE_DEFAULTS.second }) },
    thirdOffense: { type: offenseStepSchema, default: () => ({ ...MODERATION_OFFENSE_DEFAULTS.third }) },
    reason: { type: String, default: MODERATION_RULE_DEFAULTS.reason, maxlength: 500 },
    exemptUserLevel: { type: Number, default: MODERATION_RULE_DEFAULTS.exemptUserLevel, min: 1, max: 10 },
    capsThresholdMode: { type: String, enum: ['count', 'percentage'], default: MODERATION_RULE_DEFAULTS.capsThresholdMode },
    minCapsCount: { type: Number, default: MODERATION_RULE_DEFAULTS.minCapsCount, min: 1, max: 500 },
    maxCapsPercentage: { type: Number, default: MODERATION_RULE_DEFAULTS.maxCapsPercentage, min: 1, max: 100 },
    minMessageLength: { type: Number, default: MODERATION_RULE_DEFAULTS.minMessageLength, min: 1, max: 500 },
    allowlistDomains: { type: [String], default: [] },
    maxEmoteCount: { type: Number, default: MODERATION_RULE_DEFAULTS.maxEmoteCount, min: 1, max: 100 },
    terms: { type: [String], default: [] }
}, { _id: false });

const channelModerationSettingsSchema = new Schema<IChannelModerationSettings>({
    channelID: { type: String, required: true, unique: true, index: true },
    channel: { type: String, default: '' },
    enabled: { type: Boolean, default: MODERATION_SETTINGS_DEFAULTS.enabled },
    offenseWindowSeconds: { type: Number, default: MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds, min: MIN_OFFENSE_WINDOW_SECONDS, max: MAX_OFFENSE_WINDOW_SECONDS },
    rules: { type: [moderationRuleSchema], default: [] },
    settingsVersion: { type: Number, default: MODERATION_SETTINGS_DEFAULTS.settingsVersion }
}, {
    timestamps: true
});

export const ChannelModerationSettingsSchema = model<IChannelModerationSettings>('channel_moderation_settings', channelModerationSettingsSchema);
