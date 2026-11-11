import { FollowDefenseSettingsSchema, type FollowDefenseLanguage, type IFollowDefenseSettings } from '../../schemas/follow_defense_settings.schema.js';
import { cancelFollowDefenseActions } from '../../utils/follow_defense_actions.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { followDefenseKeys } from '../../utils/follow_defense_queue.js';

/**
 * Follow Defense settings: defaults, patch parsing and the save shared by
 * `PATCH /follow-defense/:channelID/settings` and the site assistant
 * (`site_agent/tools/write/settings/follow_defense.ts`).
 */

export interface FollowDefenseSettingsResponse {
    channelID: string;
    channel: string;
    enabled: boolean;
    silentModeEnabled: boolean;
    protectionModeEnabled: boolean;
    attackModeEnabled: boolean;
    resetAttackOnNewRaid: boolean;
    silentThresholdX: number;
    silentWindowYSeconds: number;
    protectionThresholdB: number;
    attackThreshold: number | null;
    silentDurationSeconds: number;
    baselineFollowsPerHour: number | null;
    language: FollowDefenseLanguage;
    settingsVersion: number;
}

export const DEFAULT_SETTINGS = {
    enabled: true,
    silentModeEnabled: true,
    protectionModeEnabled: true,
    attackModeEnabled: true,
    resetAttackOnNewRaid: true,
    silentThresholdX: 10,
    silentWindowYSeconds: 5,
    protectionThresholdB: 100,
    attackThreshold: null as number | null,
    silentDurationSeconds: 60,
    baselineFollowsPerHour: null as number | null,
    language: 'en' as FollowDefenseLanguage,
    settingsVersion: 1
};

const BOOLEAN_FIELDS = new Set([
    'enabled',
    'silentModeEnabled',
    'protectionModeEnabled',
    'attackModeEnabled', 'resetAttackOnNewRaid'
]);

const NUMBER_FIELDS = new Set([
    'silentThresholdX',
    'silentWindowYSeconds',
    'protectionThresholdB',
    'attackThreshold',
    'silentDurationSeconds',
    'baselineFollowsPerHour'
]);

export function toSettingsResponse(settings: IFollowDefenseSettings | FollowDefenseSettingsResponse): FollowDefenseSettingsResponse {
    return {
        channelID: settings.channelID,
        channel: settings.channel || '',
        enabled: settings.enabled ?? DEFAULT_SETTINGS.enabled,
        silentModeEnabled: settings.silentModeEnabled ?? DEFAULT_SETTINGS.silentModeEnabled,
        protectionModeEnabled: settings.protectionModeEnabled ?? DEFAULT_SETTINGS.protectionModeEnabled,
        attackModeEnabled: settings.attackModeEnabled ?? DEFAULT_SETTINGS.attackModeEnabled,
        resetAttackOnNewRaid: settings.resetAttackOnNewRaid ?? true,
        silentThresholdX: settings.silentThresholdX || DEFAULT_SETTINGS.silentThresholdX,
        silentWindowYSeconds: settings.silentWindowYSeconds || DEFAULT_SETTINGS.silentWindowYSeconds,
        protectionThresholdB: settings.protectionThresholdB || DEFAULT_SETTINGS.protectionThresholdB,
        attackThreshold: settings.attackThreshold ?? null,
        silentDurationSeconds: settings.silentDurationSeconds || DEFAULT_SETTINGS.silentDurationSeconds,
        baselineFollowsPerHour: settings.baselineFollowsPerHour ?? null,
        language: settings.language === 'es' ? 'es' : 'en',
        settingsVersion: settings.settingsVersion || DEFAULT_SETTINGS.settingsVersion
    };
}

export async function cacheSettings(settings: FollowDefenseSettingsResponse): Promise<void> {
    const cache = await getDragonflyClient('followDefenseRoute.cacheSettings');
    await cache.set(followDefenseKeys(settings.channelID).settings, JSON.stringify(settings));
}

export async function getOrCreateSettings(channelID: string, channelName: string): Promise<FollowDefenseSettingsResponse> {
    const settings = await FollowDefenseSettingsSchema.findOneAndUpdate({
        channelID
    }, {
        $setOnInsert: {
            channelID,
            channel: channelName,
            ...DEFAULT_SETTINGS
        }
    }, {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
    });

    const response = toSettingsResponse(settings.toObject() as IFollowDefenseSettings);
    await cacheSettings(response);
    return response;
}

/** Saved settings or the defaults, without creating a document (for read-only callers). */
export async function readFollowDefenseSettings(channelID: string, channelName: string): Promise<FollowDefenseSettingsResponse> {
    const settings = await FollowDefenseSettingsSchema.findOne({ channelID }).lean();
    return toSettingsResponse((settings ?? { channelID, channel: channelName, ...DEFAULT_SETTINGS }) as IFollowDefenseSettings);
}

export function buildSettingsPatch(body: Record<string, unknown>): Partial<IFollowDefenseSettings> {
    const patch: Partial<IFollowDefenseSettings> = {};

    for (const [key, value] of Object.entries(body)) {
        if (BOOLEAN_FIELDS.has(key)) {
            if (typeof value === 'boolean') {
                (patch as Record<string, unknown>)[key] = value;
            }
            continue;
        }

        if (NUMBER_FIELDS.has(key)) {
            if ((key === 'baselineFollowsPerHour' || key === 'attackThreshold') && (value === null || (typeof value === 'string' && value.trim() === ''))) {
                patch[key] = null;
                continue;
            }

            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 0) {
                (patch as Record<string, unknown>)[key] = Math.round(parsed);
            }
            continue;
        }

        if (key === 'language' && (value === 'en' || value === 'es')) {
            patch.language = value;
        }
    }

    return patch;
}

export type FollowDefenseUpdateResult =
    | { ok: true; settings: FollowDefenseSettingsResponse; patch: Partial<IFollowDefenseSettings> }
    | { ok: false; status: number; body: Record<string, unknown> };

/** The PATCH checks after the defaults exist: threshold, field parsing, the extra permission, an empty patch. */
async function prepareSettingsPatch(body: Record<string, unknown>, canManageModeration: () => Promise<boolean>)
    : Promise<{ ok: true; patch: Partial<IFollowDefenseSettings> } | { ok: false; status: number; body: Record<string, unknown> }> {
    if (Object.hasOwn(body, 'attackThreshold')) {
        const value = body.attackThreshold;
        if (value !== null && value !== '' && !(typeof value === 'string' && value.trim() === '')
            && ((typeof value !== 'number' && typeof value !== 'string') || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
            return { ok: false, status: 400, body: { error: true, message: 'Attack threshold must be a positive integer or empty for dynamic sensitivity', status: 400 } };
        }
    }
    const patch = buildSettingsPatch(body);
    if (patch.resetAttackOnNewRaid !== undefined && !(await canManageModeration())) {
        return { ok: false, status: 403, body: { error: true, message: 'Moderation permission required' } };
    }

    if (Object.keys(patch).length === 0) {
        return { ok: false, status: 400, body: {
            error: true,
            message: 'No valid settings fields provided',
            status: 400
        } };
    }
    return { ok: true, patch };
}

/** After a saved patch: cancel pending defense actions when a mode was turned off, refresh the cache. */
async function finishSettingsUpdate(channelID: string, updated: { toObject(): unknown }, patch: Partial<IFollowDefenseSettings>): Promise<FollowDefenseUpdateResult> {
    const settings = toSettingsResponse(updated.toObject() as IFollowDefenseSettings);
    if (patch.enabled === false || patch.attackModeEnabled === false || patch.protectionModeEnabled === false) {
        await cancelFollowDefenseActions(channelID);
    }
    await cacheSettings(settings);
    return { ok: true, settings, patch };
}

/**
 * The PATCH after the access check. `canManageModeration` re-checks `moderation:manage` when the
 * patch changes `resetAttackOnNewRaid` (the route's extra check). Turning off the defense, Attack or
 * Protection cancels pending defense actions.
 */
export async function updateFollowDefenseSettings(channelID: string, channelName: string, body: Record<string, unknown>,
    canManageModeration: () => Promise<boolean>): Promise<FollowDefenseUpdateResult> {
    await getOrCreateSettings(channelID, channelName);
    const prepared = await prepareSettingsPatch(body, canManageModeration);
    if (!prepared.ok) return prepared;
    const { patch } = prepared;

    const updated = await FollowDefenseSettingsSchema.findOneAndUpdate({
        channelID
    }, {
        $set: {
            ...patch,
            channel: channelName
        }
    }, {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
    });

    return await finishSettingsUpdate(channelID, updated, patch);
}

export type FollowDefenseConditionalResult =
    | FollowDefenseUpdateResult
    /** A field in `expected` reads differently now (`current` = the settings as they are). Nothing was written. */
    | { ok: false; conflict: true; current: FollowDefenseSettingsResponse };

/**
 * Compare-and-set PATCH for the site assistant: the same checks and side effects as
 * `updateFollowDefenseSettings`, but it writes only while every `expected` field (response names,
 * e.g. `attackThreshold`) still reads the same. The stored values of those fields are part of the
 * write filter, so an edit that lands in between makes it write nothing.
 */
export async function updateFollowDefenseSettingsIfUnchanged(channelID: string, channelName: string, body: Record<string, unknown>,
    expected: Record<string, unknown>, canManageModeration: () => Promise<boolean>): Promise<FollowDefenseConditionalResult> {
    await getOrCreateSettings(channelID, channelName);
    const prepared = await prepareSettingsPatch(body, canManageModeration);
    if (!prepared.ok) return prepared;
    const { patch } = prepared;
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

    for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await FollowDefenseSettingsSchema.findOne({ channelID }).lean() as Record<string, unknown> | null;
        const current = toSettingsResponse((stored ?? { channelID, channel: channelName, ...DEFAULT_SETTINGS }) as unknown as IFollowDefenseSettings);
        const keys = Object.keys(expected);
        if (!stored || keys.some((key) => !same((current as unknown as Record<string, unknown>)[key], expected[key]))) return { ok: false, conflict: true, current };
        const guard = Object.fromEntries(keys.map((key) => [key, stored[key] ?? null]));
        const updated = await FollowDefenseSettingsSchema.findOneAndUpdate({ channelID, ...guard }, { $set: { ...patch, channel: channelName } }, { new: true });
        if (updated) return await finishSettingsUpdate(channelID, updated, patch);
        // Changed between the read and the write: check it again.
    }
    return { ok: false, conflict: true, current: await readFollowDefenseSettings(channelID, channelName) };
}
