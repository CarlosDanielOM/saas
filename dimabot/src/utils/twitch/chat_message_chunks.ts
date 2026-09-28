const TWITCH_AI_RESPONSE_SPLIT_THRESHOLD = 500;
const TWITCH_AI_RESPONSE_CHUNK_SIZE = 400;

/** Remove the reply recipient's redundant tag without touching other chatters. */
export function removeAiReplyRecipientTag(message: string, username: string): string {
    if (!username) return message.trim();
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadingMention = new RegExp(`^\\s*@${escapedUsername}(?=$|[\\s,:;.!?])(?:\\s*[:,;.!?])?\\s*`, 'i');
    const recipientTag = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapedUsername}(?=$|[\\s,:;.!?])`, 'giu');
    return message.replace(leadingMention, '')
        .replace(recipientTag, (tag, prefix: string) => prefix + tag.slice(prefix.length + 1))
        .trim();
}

/**
 * Splits long AI responses into Twitch-safe chat messages.
 *
 * Twitch rejects chat messages over 500 characters, so AI responses that exceed
 * that limit are split into smaller 400-character chunks for extra safety.
 */
export function splitAiResponseForTwitch(message: string): string[] {
    const normalizedMessage = message.trim();

    if (!normalizedMessage) {
        return [];
    }

    if (Array.from(normalizedMessage).length <= TWITCH_AI_RESPONSE_SPLIT_THRESHOLD) {
        return [normalizedMessage];
    }

    const chunks: string[] = [];
    let remainingMessage = normalizedMessage;

    while (Array.from(remainingMessage).length > TWITCH_AI_RESPONSE_CHUNK_SIZE) {
        const candidate = Array.from(remainingMessage)
            .slice(0, TWITCH_AI_RESPONSE_CHUNK_SIZE)
            .join('');
        const lastWhitespaceIndex = Math.max(
            candidate.lastIndexOf(' '),
            candidate.lastIndexOf('\n'),
            candidate.lastIndexOf('\t')
        );
        const minimumUsefulBreakIndex = Math.floor(TWITCH_AI_RESPONSE_CHUNK_SIZE * 0.6);
        const splitIndex = lastWhitespaceIndex > minimumUsefulBreakIndex
            ? lastWhitespaceIndex
            : candidate.length;
        const chunk = remainingMessage.slice(0, splitIndex).trim();

        if (chunk) {
            chunks.push(chunk);
        }

        remainingMessage = remainingMessage.slice(splitIndex).trim();
    }

    if (remainingMessage) {
        chunks.push(remainingMessage);
    }

    return chunks;
}
