/** Canonical bits events carry message.text; legacy channel.cheer uses a string. */
export function getBitsMessageText(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object' && 'text' in message && typeof message.text === 'string') {
        return message.text;
    }
    return '';
}
