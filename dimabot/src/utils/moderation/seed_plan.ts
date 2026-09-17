import {
    MODERATION_SETTINGS_DEFAULTS,
    type IChannelModerationSettings
} from '../../schemas/channel_moderation_settings.schema.js';

export function isUntouchedLazyStub(doc: {
    enabled?: boolean;
    rules?: unknown[] | null;
    settingsVersion?: number | null;
} | null | undefined): boolean {
    if (!doc) return false;
    const rules = doc.rules;
    return doc.enabled === false
        && (!rules || rules.length === 0)
        && (doc.settingsVersion ?? 1) === 1;
}

export type ModerationSeedPlan = 'create' | 'replace-stub' | 'keep';

export function planModerationSeed(existing: {
    enabled?: boolean;
    rules?: unknown[] | null;
    settingsVersion?: number | null;
} | null | undefined): ModerationSeedPlan {
    if (!existing) return 'create';
    if (isUntouchedLazyStub(existing)) return 'replace-stub';
    return 'keep';
}

export function existingChannelModerationView(channelID: string, channelName: string) {
    return {
        channelID,
        channel: channelName,
        enabled: false,
        offenseWindowSeconds: MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds,
        rules: [] as IChannelModerationSettings['rules'],
        settingsVersion: MODERATION_SETTINGS_DEFAULTS.settingsVersion
    };
}
