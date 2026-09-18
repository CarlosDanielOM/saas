import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { ChannelModerationSettingsSchema, type IChannelModerationSettings, type IModerationRule } from '../schemas/channel_moderation_settings.schema.js';
import { evaluateRule, type ModerationRuleInput } from '../utils/moderation/rules/index.js';
import { compileBlacklistPattern } from '../utils/moderation/rules/blacklist.rule.js';
import { recordOffense, resolveOffenseStep } from '../utils/moderation/offenses.js';
import { hasActivePermit } from '../utils/moderation/permit.js';
import { executeModerationAction } from '../functions/moderation/execute_action.moderation.js';
import { inspectExpression, ruleExempt, shouldLogPermissionError, type UserIdentity } from '../utils/permissions/index.js';
import { error as logError } from '../utils/logger.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../utils/header.js';
import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';

const SETTINGS_CACHE_TTL_SECONDS = 300;
export const NO_SETTINGS_SENTINEL = '{"none":true}';

// Compiled blacklist patterns are CPU objects and can't live in Dragonfly, so
// they stay in process memory keyed by channel + settings version. A settings
// save bumps the version and naturally recompiles on next message.
const compiledBlacklistPatterns = new Map<string, { version: number; patterns: Map<string, RegExp | null> }>();

export function moderationSettingsCacheKey(channelID: string): string {
    return `moderation:${channelID}:settings`;
}

export async function invalidateModerationSettingsCache(channelID: string): Promise<void> {
    const cache = await getDragonflyClient('moderation.invalidateSettings');
    await cache.del(moderationSettingsCacheKey(channelID));
    compiledBlacklistPatterns.delete(channelID);
}

export async function primeModerationSettingsCache(channelID: string, settings: IChannelModerationSettings): Promise<void> {
    const cache = await getDragonflyClient('moderation.primeSettings');
    compiledBlacklistPatterns.delete(channelID);
    await cache.set(moderationSettingsCacheKey(channelID), JSON.stringify(settings), { EX: SETTINGS_CACHE_TTL_SECONDS });
}

async function loadSettings(channelID: string): Promise<IChannelModerationSettings | null> {
    const cache = await getDragonflyClient('moderation.loadSettings');
    const cached = await cache.get(moderationSettingsCacheKey(channelID));

    if (cached) {
        if (cached === NO_SETTINGS_SENTINEL) return null;
        try {
            return JSON.parse(cached) as IChannelModerationSettings;
        } catch {
            // Corrupted cache entry — fall through to the database.
        }
    }

    const doc = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();

    if (!doc) {
        const key = moderationSettingsCacheKey(channelID);
        // NX so a concurrent seed that already wrote real settings cannot be
        // overwritten by this negative cache. If NX loses, read the winner.
        const wroteSentinel = await cache.set(key, NO_SETTINGS_SENTINEL, { EX: SETTINGS_CACHE_TTL_SECONDS, NX: true });
        if (wroteSentinel !== 'OK') {
            const raced = await cache.get(key);
            if (raced && raced !== NO_SETTINGS_SENTINEL) {
                try {
                    return JSON.parse(raced) as IChannelModerationSettings;
                } catch {
                    // Fall through to "no settings" for this message.
                }
            }
        }
        return null;
    }

    await cache.set(moderationSettingsCacheKey(channelID), JSON.stringify(doc), { EX: SETTINGS_CACHE_TTL_SECONDS });
    return doc as unknown as IChannelModerationSettings;
}

function getBlacklistPattern(channelID: string, settings: IChannelModerationSettings, rule: IModerationRule): RegExp | null {
    let entry = compiledBlacklistPatterns.get(channelID);
    if (!entry || entry.version !== settings.settingsVersion) {
        entry = { version: settings.settingsVersion, patterns: new Map() };
        compiledBlacklistPatterns.set(channelID, entry);
    }

    if (!entry.patterns.has(rule.id)) {
        entry.patterns.set(rule.id, compileBlacklistPattern(rule.terms));
    }

    return entry.patterns.get(rule.id) ?? null;
}

export interface ChatModerationResult {
    actionTaken: boolean;
}

/**
 * The moderation gate. Runs inline in the message pipeline after the identity
 * is resolved and before AI/command processing. Detection is synchronous and
 * cheap (cached settings + pure evaluators); the consequence (Helix calls)
 * is fired asynchronously so Twitch API latency never delays the pipeline.
 *
 * Fail-open by design: a moderation infrastructure error must never break
 * chat features — the error is logged and the message proceeds.
 */
export async function runChatModeration(channelID: string, messageEventData: IChatMessage, identity: UserIdentity): Promise<ChatModerationResult> {
    try {
        const chatterID = messageEventData.chatter_user_id || '';
        const chatterLogin = (messageEventData.chatter_user_login || '').toLowerCase();

        // Never moderate the broadcaster or the bot itself.
        if (!chatterID || chatterID === channelID || chatterID === TWITCH_BOT_ACCOUNT_ID) {
            return { actionTaken: false };
        }

        const settings = await loadSettings(channelID);
        if (!settings || !settings.enabled || !settings.rules || settings.rules.length === 0) {
            return { actionTaken: false };
        }

        // An active permit (user or channel-wide) bypasses every rule.
        if (await hasActivePermit(channelID, chatterLogin)) {
            return { actionTaken: false };
        }

        const fragments = messageEventData.message.fragments || [];
        const emoteFragments = fragments.filter(fragment => fragment.type === 'emote');
        const input: ModerationRuleInput = {
            text: messageEventData.message.text || '',
            emoteCount: emoteFragments.length,
            emoteTexts: emoteFragments
                .map(fragment => fragment.text)
                .filter((text): text is string => typeof text === 'string')
        };

        for (const rule of settings.rules) {
            if (!rule.enabled) continue;

            // Exemption mode: numeric fallback, tag expression, or fail
            // closed on a present invalid stored expression.
            const exemptState = inspectExpression(rule.exemptExpression);
            if (
                exemptState.mode === 'invalid'
                && shouldLogPermissionError(`moderation:${channelID}:${settings.settingsVersion}:${rule.id}:${exemptState.error}`)
            ) {
                void logError({
                    function: 'runChatModeration.ruleExemption',
                    message: 'Stored exemption expression is invalid; rule grants no exemption until repaired',
                    channelID,
                    ruleID: rule.id,
                    error: exemptState.error
                }, { channelId: channelID, destination: 'both' }).catch(() => undefined);
            }

            if (ruleExempt(rule, identity)) continue;

            const result = evaluateRule(
                rule,
                input,
                rule.type === 'blacklist' ? getBlacklistPattern(channelID, settings, rule) : undefined
            );
            if (!result.triggered) continue;

            const offenseNumber = await recordOffense(channelID, rule.id, chatterID, settings.offenseWindowSeconds);
            const step = resolveOffenseStep(rule, offenseNumber);

            const executionInput = {
                channelID,
                userID: chatterID,
                username: messageEventData.chatter_user_name || chatterLogin,
                messageID: messageEventData.message_id,
                messageText: input.text,
                rule,
                step,
                offenseNumber
            };

            if (step.action === 'off') {
                // Counted on the ladder but configured to do nothing — the
                // message proceeds to AI/commands normally. Logged async.
                void executeModerationAction(executionInput).catch(() => undefined);
                return { actionTaken: false };
            }

            void executeModerationAction(executionInput).catch((err) => {
                logError({
                    function: 'runChatModeration.execute',
                    channelID,
                    userID: chatterID,
                    ruleType: rule.type,
                    error: err instanceof Error ? err.message : String(err)
                }, { channelId: channelID, destination: 'both' });
            });

            return { actionTaken: true };
        }

        return { actionTaken: false };
    } catch (err) {
        await logError({
            function: 'runChatModeration',
            channelID,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: channelID, destination: 'both' });
        return { actionTaken: false };
    }
}
