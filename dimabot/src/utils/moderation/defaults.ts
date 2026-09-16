import { error as logError } from '../logger.js';
import {
    ChannelModerationSettingsSchema,
    MODERATION_SETTINGS_DEFAULTS,
    buildDefaultModerationRules
} from '../../schemas/channel_moderation_settings.schema.js';

/**
 * Seeds the default moderation settings for a NEW streamer on first
 * activation: moderation enabled with the default rule set (caps, links,
 * emote spam on; blacklist off) and the warn → delete → timeout(60s) ladder.
 *
 * $setOnInsert makes this idempotent and non-destructive: if the channel
 * already has a settings document (e.g. an existing streamer re-running the
 * auth flow), it is left completely untouched.
 */
export async function seedDefaultModerationSettings(channelID: string, channelName: string): Promise<void> {
    try {
        await ChannelModerationSettingsSchema.findOneAndUpdate({
            channelID
        }, {
            $setOnInsert: {
                channelID,
                channel: channelName,
                enabled: true,
                offenseWindowSeconds: MODERATION_SETTINGS_DEFAULTS.offenseWindowSeconds,
                rules: buildDefaultModerationRules(),
                settingsVersion: MODERATION_SETTINGS_DEFAULTS.settingsVersion
            }
        }, {
            upsert: true
        });
    } catch (err) {
        // Seeding must never fail registration.
        await logError({
            function: 'seedDefaultModerationSettings',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: channelID, destination: 'both' });
    }
}
