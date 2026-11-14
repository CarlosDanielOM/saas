import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';
import type { UserIdentity } from '../utils/permissions/index.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../utils/header.js';
import { getKeywordBody, keywordIndexCache } from '../utils/keyword_cache.js';
import { keywordMatches, matchKeywords, normalizeKeyword } from '../utils/keywords.js';
import { executeCustomCommand } from './commands.handler.js';
import { deliverAstMessage } from '../utils/ast_command_delivery.js';
import type { AstEffectContext } from '../utils/ast_parser/effects.js';
import { chatActor, commandResultOutcome, errorText, recordCommandActivity } from '../utils/activity_command.js';

export async function handleKeywords(channelID: string, event: IChatMessage, identity: UserIdentity, effectContext?: AstEffectContext): Promise<void> {
    if (event.chatter_user_id === TWITCH_BOT_ACCOUNT_ID) return;
    const index = await keywordIndexCache.get(channelID);
    const matches = matchKeywords(index, event.message.text);
    for (const match of matches) {
        const keyword = await getKeywordBody(channelID, match.id);
        if (!keyword || !keyword.enabled || !keywordMatches(event.message.text, {
            id: match.id, text: normalizeKeyword(keyword.cmd), matchMode: keyword.keywordSettings?.matchMode ?? 'start'
        })) continue;
        const startedAt = Date.now();
        const attempt = { channelID, name: keyword.cmd, trigger: 'keyword' as const, func: keyword.func, event, key: String(match.id) };
        let result: Awaited<ReturnType<typeof executeCustomCommand>>;
        try {
            // The complete message is the keyword's argument; caller/event context stays intact.
            result = await executeCustomCommand(channelID, event, keyword, keyword.cmd, event.message.text,
                { origin: 'chat', identity }, undefined, effectContext);
        } catch (error) {
            recordCommandActivity({ ...attempt, outcome: 'failed', reason: 'error', error: errorText(error), durationMs: Date.now() - startedAt });
            throw error;
        }
        const outcome = commandResultOutcome(result.type, result.error);
        if (outcome) recordCommandActivity({ ...attempt, ...outcome, durationMs: Date.now() - startedAt,
            error: outcome.outcome === 'failed' ? errorText(result.message) : null });
        if (!result.error) await deliverAstMessage(channelID, {
            parsedText: result.message, commandReferences: result.commandReferences,
            origin: 'command', actor: chatActor(event), referencePath: `keyword:${match.id}`
        });
    }
}
