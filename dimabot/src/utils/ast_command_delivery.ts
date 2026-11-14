import type { AstMessage, CommandReferenceRequest } from './ast_parser/types.js';
import { chatActor, commandResultOutcome, errorText, recordCommandActivity, type ChatDelivery } from './activity_command.js';

/** `sent`: how many chat messages this delivery (its own text and its references' replies) really sent. */
type SendResult = { error: boolean; message: string; status?: number; sent?: number };
interface DeliveryDependencies {
    send: (channelID: string, text: string, delivery?: ChatDelivery) => Promise<SendResult>;
    execute: (request: CommandReferenceRequest) => Promise<{
        error: boolean; message: string; type?: string; commandReferences?: CommandReferenceRequest[];
    }>;
}
const defaultDependencies: DeliveryDependencies = {
    send: async (channelID, text, delivery) => {
        const { sendTwitchChatMessage } = await import('../functions/chats/send_message.chat.js');
        return sendTwitchChatMessage(channelID, text, null, undefined, delivery);
    },
    execute: async request => {
        const { commandHandler } = await import('../handlers/commands.handler.js');
        return commandHandler(request.channelID, request.eventData, request.commandName,
            request.argument, request.authorization, request.state, request.effectContext);
    }
};

/**
 * A rendered message plus, for the activity log, where it came from and who it answers.
 * `referencePath` names this delivery among the others for the same chat message ('chat',
 * 'keyword:<id>'); references below it get '<path>/<index>', so every invocation has its own,
 * deterministic activity key and a redelivered message maps onto the same rows.
 */
export type DeliveryMessage = AstMessage & ChatDelivery & { referencePath?: string };

/** Send the outer response first, then execute references in authored order.
 * Rendered text is never parsed a second time. Empty outer messages still
 * dispatch references. Drain the queue once to avoid accidental duplicate sends.
 */
export async function deliverAstMessage(
    channelID: string,
    message: DeliveryMessage,
    chatEnabled = true,
    dependencies: DeliveryDependencies = defaultDependencies
): Promise<SendResult> {
    const references = message.commandReferences?.splice(0) ?? [];
    const text = message.parsedText.trim();
    let sentCount = 0;
    if (chatEnabled && text) {
        const sent = await dependencies.send(channelID, text, { origin: message.origin, actor: message.actor });
        if (sent.error) return sent;
        sentCount++;
    }
    const parentPath = message.referencePath ?? '';
    for (const [index, request] of references.entries()) {
        const startedAt = Date.now();
        const path = `${parentPath}/${index}`;
        let recorded = false;
        const record = (outcome: { outcome: 'ok' | 'skipped' | 'blocked' | 'failed'; reason: string | null }, error?: unknown) => {
            recorded = true;
            try {
                recordCommandActivity({
                    channelID: request.channelID, name: `!${request.commandName}`, trigger: 'reference', event: request.eventData,
                    key: `${path}:${String(request.commandName).toLowerCase()}`,
                    ...outcome, durationMs: Date.now() - startedAt,
                    error: outcome.outcome === 'failed' ? errorText(error) : null
                });
            } catch { /* a debug row must never change delivery */ }
        };
        try {
            const result = await dependencies.execute(request);
            const outcome = commandResultOutcome(result.type, result.error);
            if (outcome) record(outcome, result.message);
            if (result.error) continue;
            const sent = await deliverAstMessage(request.channelID, {
                parsedText: result.message, commandReferences: result.commandReferences,
                origin: 'command', actor: chatActor(request.eventData), referencePath: path
            }, chatEnabled, dependencies);
            if (sent.error) return sent;
            sentCount += sent.sent ?? 0;
        } catch (error) {
            if (!recorded) record({ outcome: 'failed', reason: 'error' }, error);
            console.error('AST command reference failed', { channelID, command: request.commandName, error });
        }
    }
    return { error: false, message: 'AST message delivered', status: 200, sent: sentCount };
}
