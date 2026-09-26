import type { AstMessage, CommandReferenceRequest } from './ast_parser/types.js';

type SendResult = { error: boolean; message: string; status?: number };
interface DeliveryDependencies {
    send: (channelID: string, text: string) => Promise<SendResult>;
    execute: (request: CommandReferenceRequest) => Promise<{
        error: boolean; message: string; commandReferences?: CommandReferenceRequest[];
    }>;
}
const defaultDependencies: DeliveryDependencies = {
    send: async (channelID, text) => {
        const { sendTwitchChatMessage } = await import('../functions/chats/send_message.chat.js');
        return sendTwitchChatMessage(channelID, text);
    },
    execute: async request => {
        const { commandHandler } = await import('../handlers/commands.handler.js');
        return commandHandler(request.channelID, request.eventData, request.commandName,
            request.argument, request.authorization, request.state);
    }
};

/** Send the outer response first, then execute references in authored order.
 * Rendered text is never parsed a second time. Empty outer messages still
 * dispatch references. Drain the queue once to avoid accidental duplicate sends.
 */
export async function deliverAstMessage(
    channelID: string,
    message: AstMessage,
    chatEnabled = true,
    dependencies: DeliveryDependencies = defaultDependencies
): Promise<SendResult> {
    const references = message.commandReferences?.splice(0) ?? [];
    const text = message.parsedText.trim();
    if (chatEnabled && text) {
        const sent = await dependencies.send(channelID, text);
        if (sent.error) return sent;
    }
    for (const request of references) {
        try {
            const result = await dependencies.execute(request);
            if (result.error) continue;
            const sent = await deliverAstMessage(request.channelID, {
                parsedText: result.message, commandReferences: result.commandReferences
            }, chatEnabled, dependencies);
            if (sent.error) return sent;
        } catch (error) {
            console.error('AST command reference failed', { channelID, command: request.commandName, error });
        }
    }
    return { error: false, message: 'AST message delivered', status: 200 };
}
