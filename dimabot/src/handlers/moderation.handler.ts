import { DEFAULT_SPAM_THRESHOLD } from '../utils/moderation/spam_categories.js';
import { rulePatterns } from '../utils/moderation/variations.js';
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
import Users from '../schemas/users.schema.js';
import ChatHistory from '../classes/chat_history.js';
import { ModerationDecision, type ModerationContextMessage } from '../schemas/moderation_decision.schema.js';
import { findBlacklistMatches, paidModeration, SEMANTIC_DEADLINE_MS, type ModerationMatch } from '../utils/moderation/advanced.js';
import { createModerationDecision, awaitSemanticDecision } from '../utils/moderation/decisions.js';
import { claimFirstObservedMessage, claimSpamReviewBudget, spamRule, spamRuleForContext, spamProtectionSettings, spamReviewSource, semanticPolicyActive } from '../utils/moderation/spam.js';

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

async function reviewPromotionalSpam(channelID: string, message: IChatMessage, identity: UserIdentity, settings: IChannelModerationSettings, receivedAt: number): Promise<boolean> {
    const protection = spamProtectionSettings(settings);
    if (!protection.enabled || !protection.categories.length || ruleExempt(spamRule, identity) || !message.message_id) return false;
    const first = await claimFirstObservedMessage(channelID, message.chatter_user_id!);
    let tier: unknown;
    if ((!first && protection.reviewAllMessages) || protection.thresholdPercent !== DEFAULT_SPAM_THRESHOLD) {
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
        tier = owner?.plan_tier;
    }
    const reviewSource = spamReviewSource(first, settings, tier);
    if (!reviewSource || !await claimSpamReviewBudget(channelID)) return false;
    const history = await ChatHistory.getRecentMessages(channelID, 30);
    const context = history.filter((item: ModerationContextMessage) => item.messageID !== message.message_id
        && item.timestamp <= receivedAt && item.timestamp >= receivedAt - 60_000)
        .slice(0, 7).reverse().map((item: ModerationContextMessage & { badges?: string[] }) => ({
            messageID: item.messageID || '', username: String(item.username).slice(0, 100),
            message: String(item.message).slice(0, 500), timestamp: item.timestamp,
            isBroadcaster: Array.isArray(item.badges) && item.badges.includes('[STREAMER]')
        }));
    let decision = await createModerationDecision({
        channelID, userID: message.chatter_user_id!, username: message.chatter_user_name || message.chatter_user_login || '',
        messageID: message.message_id, messageText: message.message.text || '',
        ruleID: spamRule.id, rule: spamRuleForContext(context, { spamProtection: { ...protection, thresholdPercent: paidModeration(tier) ? protection.thresholdPercent : DEFAULT_SPAM_THRESHOLD } }), settingsVersion: settings.settingsVersion,
        matches: [], context, mode: 'semantic', reviewSource,
        deadline: new Date(receivedAt + SEMANTIC_DEADLINE_MS)
    });
    decision = await awaitSemanticDecision(decision);
    if (decision.verdict !== 'violation') {
        await ModerationDecision.updateOne({ _id: decision._id }, { $set: {
            'consequence.status': decision.verdict === 'allow' ? 'allowed' : 'allowed_fallback'
        } });
        return false;
    }
    const current = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
    let stillPaid = true;
    if (reviewSource === 'spam_continuous' || decision.rule.semantic?.thresholdPercent !== DEFAULT_SPAM_THRESHOLD) {
        const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
        stillPaid = paidModeration(owner?.plan_tier);
    }
    if (Date.now() >= decision.deadline.getTime() || !semanticPolicyActive(current, decision) || !stillPaid
        || await hasActivePermit(channelID, message.chatter_user_login || '')) {
        await ModerationDecision.updateOne({ _id: decision._id }, { $set: {
            'consequence.status': 'cancelled', 'charge.status': 'none', 'charge.credits': 0, 'charge.billableCostUSD': 0
        } });
        return false;
    }
    const claimed = await ModerationDecision.updateOne({ _id: decision._id, 'consequence.status': 'none' }, { $set: {
        consequence: { status: 'scheduled', action: 'ban', offenseNumber: 1 }
    } });
    if (!claimed.modifiedCount) return false;
    // Advertising bans bypass the normal escalation ladder entirely.
    void executeModerationAction({
        channelID, userID: message.chatter_user_id!, username: message.chatter_user_name || message.chatter_user_login || '',
        messageID: message.message_id, messageText: message.message.text || '', rule: spamRule,
        step: spamRule.firstOffense, offenseNumber: 1, decisionID: decision._id
    }).catch(() => undefined);
    return true;
}

/**
 * The moderation gate. Runs inline in the message pipeline after the identity
 * is resolved and before AI/command processing. Detection uses cached settings and pure evaluators. Contextual candidates
 * await a bounded background-worker review; consequences (Helix calls)
 * execute asynchronously.
 *
 * Fail-open by design: a moderation infrastructure error must never break
 * chat features — the error is logged and the message proceeds.
 */
async function moderateMessage(channelID: string, messageEventData: IChatMessage, identity: UserIdentity, receivedAt: number): Promise<ChatModerationResult> {
    try {
        const chatterID = messageEventData.chatter_user_id || '';
        const chatterLogin = (messageEventData.chatter_user_login || '').toLowerCase();

        // Never moderate the broadcaster or the bot itself.
        if (!chatterID || chatterID === channelID || chatterID === TWITCH_BOT_ACCOUNT_ID) {
            return { actionTaken: false };
        }

        const settings = await loadSettings(channelID);
        if (!settings || !settings.enabled) {
            return { actionTaken: false };
        }

        // An active permit (user or channel-wide) bypasses every rule.
        if (await hasActivePermit(channelID, chatterLogin)) {
            return { actionTaken: false };
        }

        // Delivery retries must not repeat a review, debit, ladder increment or
        // downstream command. A pending receipt also fences overlapping deliveries.
        const cache = await getDragonflyClient('moderation.messageReceipt');
        if (messageEventData.message_id) {
            const receipt = await cache.set(`moderation:${channelID}:message:${messageEventData.message_id}`, '1', { NX: true, EX: 86400 });
            if (!receipt) return { actionTaken: true };
        }

        if (await reviewPromotionalSpam(channelID, messageEventData, identity, settings, receivedAt)) {
            return { actionTaken: true };
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

        for (const rule of settings.rules || []) {
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

            const advanced = rule.type === 'blacklist' && Boolean(rulePatterns(rule).length || rule.variations?.mode && rule.variations.mode !== 'off' || rule.semantic?.enabled);
            let matches: ModerationMatch[] = [];
            const result = evaluateRule(
                rule,
                input,
                rule.type === 'blacklist' ? getBlacklistPattern(channelID, settings, rule) : undefined
            );
            if (rule.type === 'blacklist') matches = findBlacklistMatches(input.text, rule.terms, rulePatterns(rule));
            if (!result.triggered && !matches.length) continue;

            let context: ModerationContextMessage[] = [];
            if (rule.semantic?.enabled) {
                const history = await ChatHistory.getRecentMessages(channelID, 30);
                context = history.filter((item: ModerationContextMessage) => item.messageID !== messageEventData.message_id
                    && item.timestamp <= receivedAt && item.timestamp >= receivedAt - 60_000)
                    .slice(0, 7).reverse().map((item: ModerationContextMessage) => ({
                        messageID: item.messageID || '', username: String(item.username).slice(0, 100),
                        message: String(item.message).slice(0, 500), timestamp: item.timestamp
                    }));
            }
            let decision = await createModerationDecision({
                channelID, userID: chatterID, username: messageEventData.chatter_user_name || chatterLogin,
                messageID: messageEventData.message_id, messageText: input.text,
                ruleID: rule.id, rule, settingsVersion: settings.settingsVersion, matches, context,
                mode: rule.semantic?.enabled ? 'semantic' : rulePatterns(rule).length ? 'regex' : 'literal',
                deadline: new Date(receivedAt + SEMANTIC_DEADLINE_MS)
            });
            if (advanced) {
                const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
                if (!paidModeration(owner?.plan_tier)) {
                    await ModerationDecision.updateOne({ _id: decision._id }, { $set: { state: 'completed', verdict: 'uncertain', status: 'plan_required', 'consequence.status': 'allowed_fallback' } });
                    continue;
                }
            }
            if (rule.semantic?.enabled) {
                decision = await awaitSemanticDecision(decision);
                if (decision.verdict !== 'violation') {
                    await ModerationDecision.updateOne({ _id: decision._id }, { $set: { 'consequence.status': decision.verdict === 'allow' ? 'allowed' : 'allowed_fallback' } });
                    continue;
                }
                // Recheck current policy and permits after the asynchronous review.
                const current = await ChannelModerationSettingsSchema.findOne({ channelID }).lean();
                const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
                if (Date.now() >= decision.deadline.getTime() || !current?.enabled || current.settingsVersion !== settings.settingsVersion
                    || !paidModeration(owner?.plan_tier) || await hasActivePermit(channelID, chatterLogin)) {
                    await ModerationDecision.updateOne({ _id: decision._id }, { $set: { 'consequence.status': 'cancelled', 'charge.status': 'none', 'charge.credits': 0, 'charge.billableCostUSD': 0 } });
                    continue;
                }
            }

            const claim = await ModerationDecision.updateOne({ _id: decision._id, 'consequence.status': 'none' }, { $set: { 'consequence.status': 'claimed' } });
            if (!claim.modifiedCount) continue;

            const offenseNumber = await recordOffense(channelID, rule.id, chatterID, settings.offenseWindowSeconds, decision._id);
            const step = resolveOffenseStep(rule, offenseNumber);

            await ModerationDecision.updateOne({ _id: decision._id }, { $set: { consequence: { status: 'scheduled', action: step.action, offenseNumber } } });

            const executionInput = {
                channelID,
                userID: chatterID,
                username: messageEventData.chatter_user_name || chatterLogin,
                messageID: messageEventData.message_id,
                messageText: input.text,
                rule,
                step,
                offenseNumber,
                decisionID: decision._id
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

// The production bot is a single host. Serialize each chatter's moderation
// gates so a faster second review cannot overtake the first offense. Other
// chatters/channels keep processing; every semantic request has a fixed deadline.
const userGates = new Map<string, Promise<ChatModerationResult>>();
export async function runChatModeration(channelID: string, message: IChatMessage, identity: UserIdentity, receivedAt = Date.now()): Promise<ChatModerationResult> {
    const key = `${channelID}:${message.chatter_user_id}`;
    const preceding = userGates.get(key);
    const task = (preceding ? preceding.catch(() => ({ actionTaken: false })) : Promise.resolve()).then(() => moderateMessage(channelID, message, identity, receivedAt));
    userGates.set(key, task);
    try { return await task; }
    finally { if (userGates.get(key) === task) userGates.delete(key); }
}
