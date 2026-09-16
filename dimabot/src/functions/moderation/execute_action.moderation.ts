import { ban } from './ban.moderation.js';
import { warnUser } from './warn.moderation.js';
import { deleteMessage } from '../chats/delete_message.chat.js';
import { sendTwitchChatMessage } from '../chats/send_message.chat.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../../utils/header.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { error as logError } from '../../utils/logger.js';
import { ModerationActionLogSchema } from '../../schemas/moderation_action_log.schema.js';
import type { IModerationOffenseStep, IModerationRule } from '../../schemas/channel_moderation_settings.schema.js';

const NOTICE_COOLDOWN_SECONDS = 60;

export interface ModerationExecutionInput {
    channelID: string;
    userID: string;
    username: string;
    messageID: string;
    messageText: string;
    rule: IModerationRule;
    step: IModerationOffenseStep;
    offenseNumber: number;
}

export interface ModerationExecutionResult {
    error: boolean;
    message: string;
    action: IModerationOffenseStep['action'];
}

function noticeCooldownKey(channelID: string, userID: string): string {
    return `moderation:${channelID}:notice:${userID}`;
}

/**
 * Sends the public "@user reason" notice at most once per user per minute.
 * The moderation action itself always runs; only the chat notice is
 * rate-limited so a spammer can't make the bot spam the chat.
 */
async function sendNoticeThrottled(channelID: string, userID: string, username: string, reason: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('moderation.sendNoticeThrottled');
        const acquired = await cache.set(noticeCooldownKey(channelID, userID), '1', { NX: true, EX: NOTICE_COOLDOWN_SECONDS });
        if (acquired === null) return;

        const notice = `@${username} ${reason}`.slice(0, 490);
        await sendTwitchChatMessage(channelID, notice);
    } catch (err) {
        await logError({
            function: 'moderation.sendNoticeThrottled',
            channelID,
            userID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: channelID, destination: 'both' });
    }
}

async function writeActionLog(input: ModerationExecutionInput, success: boolean, errorMessage: string | null): Promise<void> {
    try {
        await ModerationActionLogSchema.create({
            channelID: input.channelID,
            userID: input.userID,
            username: input.username,
            ruleID: input.rule.id,
            ruleType: input.rule.type,
            action: input.step.action,
            offenseNumber: input.offenseNumber,
            reason: input.rule.reason,
            messageID: input.messageID,
            messageExcerpt: input.messageText.slice(0, 200),
            success,
            errorMessage
        });
    } catch (err) {
        await logError({
            function: 'moderation.writeActionLog',
            channelID: input.channelID,
            userID: input.userID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: input.channelID, destination: 'both' });
    }
}

/**
 * Executes one escalation-ladder step against a chat message:
 *   off     → logged only, message untouched
 *   warn    → official Twitch warning + public notice
 *   delete  → delete the message + public notice
 *   timeout → timeout via ban(duration); Twitch purges the user's messages
 *   ban     → permanent ban via ban(null); Twitch purges the user's messages
 */
export async function executeModerationAction(input: ModerationExecutionInput): Promise<ModerationExecutionResult> {
    const { channelID, userID, username, messageID, rule, step } = input;
    const action = step.action;

    if (action === 'off') {
        await writeActionLog(input, true, null);
        return { error: false, message: 'No action configured for this offense', action };
    }

    let result: { error: boolean; message: string };

    switch (action) {
        case 'warn':
            result = await warnUser(channelID, userID, rule.reason);
            break;
        case 'delete':
            result = await deleteMessage(messageID, channelID, TWITCH_BOT_ACCOUNT_ID);
            break;
        case 'timeout':
            result = await ban(channelID, userID, TWITCH_BOT_ACCOUNT_ID, step.timeoutSeconds, rule.reason);
            break;
        case 'ban':
            result = await ban(channelID, userID, TWITCH_BOT_ACCOUNT_ID, null, rule.reason);
            break;
        default:
            result = { error: true, message: `Unknown moderation action: ${action}` };
    }

    if (!result.error) {
        await sendNoticeThrottled(channelID, userID, username, rule.reason);
    } else {
        await logError({
            function: 'executeModerationAction',
            channelID,
            userID,
            action,
            ruleType: rule.type,
            error: result.message
        }, { channelId: channelID, destination: 'both' });
    }

    await writeActionLog(input, !result.error, result.error ? result.message : null);

    return { error: result.error, message: result.message, action };
}
