import { parseSpecialCommands } from '../../handlers/special_parser.handler.js';

export const DEFAULT_SPEECH_TEMPLATE = '$(user) dice: &t';
export function isSpeechCommand(command: { func?: string }): boolean {
    return command.func === 'speach' || command.func === 'speech';
}
export function speechTemplate(message?: string): string {
    return !message?.trim() || message.trim() === '$(tts &t)' ? DEFAULT_SPEECH_TEMPLATE : message;
}

/** Bind viewer text as data, never as executable AST source. */
export async function renderSpeechTemplate(template: string | undefined, text: string, channelID: string,
    eventData: Record<string, unknown>, commandName = 's'): Promise<string> {
    const result = await parseSpecialCommands(speechTemplate(template).replace(/&t\b/g, '%(tts_input)'), {
        channelID, scopeType: 'command', scopeName: commandName, eventData,
        variables: { tts_input: text }, userLevel: 10
    });
    return result.parsedText;
}
