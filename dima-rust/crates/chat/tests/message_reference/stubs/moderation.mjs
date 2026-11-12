export * from 'real:handlers/moderation.handler.ts';
import { R, record, copy } from './rec.mjs';
// runChatModeration(channelID, message, identity, receivedAt): the case's verdict.
export async function runChatModeration(channelID, message, identity, receivedAt) {
  record('moderation', { channelID, messageID: message?.message_id ?? null,
    identity: { level: identity.level, tags: [...identity.tags].sort(), userId: identity.userId ?? null, login: identity.login ?? null },
    receivedAt });
  return { actionTaken: R.config.moderation === 'action' };
}
