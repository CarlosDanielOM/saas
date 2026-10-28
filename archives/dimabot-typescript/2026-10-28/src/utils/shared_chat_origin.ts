/** Only chat messages and notices are shared-chat copies. Other events still target their receiver. */
export function isForeignSharedChatEvent(
    type: string,
    event: { broadcaster_user_id?: unknown; source_broadcaster_user_id?: unknown },
    receiverID: unknown = event.broadcaster_user_id
): boolean {
    return (type === 'channel.chat.message' || type === 'channel.chat.notification')
        && typeof event.source_broadcaster_user_id === 'string'
        && event.source_broadcaster_user_id !== ''
        && event.source_broadcaster_user_id !== receiverID;
}
