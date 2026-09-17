import { error as logError } from '../logger.js';
import {
    ChannelModerationSettingsSchema,
    MODERATION_SETTINGS_DEFAULTS,
    buildDefaultModerationRules,
    type IChannelModerationSettings
} from '../../schemas/channel_moderation_settings.schema.js';
import {
    invalidateModerationSettingsCache,
    primeModerationSettingsCache
} from '../../handlers/moderation.handler.js';
import { planModerationSeed } from './seed_plan.js';

export { isUntouchedLazyStub, planModerationSeed, existingChannelModerationView } from './seed_plan.js';

function newChannelModerationSeed(channelID: string, channelName: string) {
    return {
        channelID,
        channel: channelName,
        enabled: true,
        offenseWindowSeconds: MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds,
        rules: buildDefaultModerationRules(),
        settingsVersion: MODERATION_SETTINGS_DEFAULTS.settingsVersion
    };
}

function isDuplicateKey(err: unknown): boolean {
    return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000);
}

/**
 * First-activation seed for NEW streamers. Existing documents are left
 * alone unless they are the empty disabled stub GET used to insert, which
 * would otherwise permanently block this $setOnInsert-style seed.
 */
export async function seedDefaultModerationSettings(channelID: string, channelName: string): Promise<void> {
    try {
        const seed = newChannelModerationSeed(channelID, channelName);
        let existing = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
        let plan = planModerationSeed(existing);

        if (plan === 'create') {
            try {
                const created = await ChannelModerationSettingsSchema.create(seed);
                existing = typeof created.toObject === 'function' ? created.toObject() : created;
                plan = 'keep';
            } catch (err) {
                if (!isDuplicateKey(err)) throw err;
                existing = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
                plan = planModerationSeed(existing);
            }
        }

        if (plan === 'replace-stub' && existing) {
            const replaced = await ChannelModerationSettingsSchema.findOneAndUpdate({
                channelID,
                enabled: false,
                settingsVersion: 1,
                $or: [{ rules: { $size: 0 } }, { rules: { $exists: false } }]
            }, {
                $set: seed
            }, {
                new: true
            });
            if (replaced) {
                existing = typeof replaced.toObject === 'function' ? replaced.toObject() : replaced;
            } else {
                // Lost a race (concurrent seed, or a save between the read and
                // this update). Re-read so we never prime the stale disabled
                // stub over the winner's settings.
                existing = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
            }
        }

        if (existing) {
            await primeModerationSettingsCache(channelID, existing as IChannelModerationSettings);
        } else {
            await invalidateModerationSettingsCache(channelID);
        }
    } catch (err) {
        // Seeding must never fail registration.
        await logError({
            function: 'seedDefaultModerationSettings',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: channelID, destination: 'both' });
    }
}
