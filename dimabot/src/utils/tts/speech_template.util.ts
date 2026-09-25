/** One-time conversion from the retired implicit speech command to an ordinary AST body. */
export const DEFAULT_SPEECH_TEMPLATE = '$(tts $(user) dice: &t)';
export function migrateLegacySpeechTemplate(message: string | null | undefined): string {
    const body = message?.trim() || '';
    if (!body || body === '$(tts &t)') return DEFAULT_SPEECH_TEMPLATE;
    if (/\$\(tts(?:[.\s)])/.test(body)) return message!;
    return `$(tts ${message})`;
}
