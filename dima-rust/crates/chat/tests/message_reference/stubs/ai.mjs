export * from 'real:utils/ai/openrouter/ai.ts';
import { R, record, copy } from './rec.mjs';
export async function getChannelPersonality(channelID) {
  record('ai.personality', { channelID });
  return R.config.ai && 'personality' in R.config.ai ? R.config.ai.personality : { enabled: false };
}
export async function chat(params) {
  record('ai.chat', { channelID: params.channelID, message: params.message, streamer: params.streamer?.name ?? null,
    history: copy(params.history), threadHistory: copy(params.threadHistory),
    tags: { badges: copy(params.tags?.badges), username: params.tags?.username ?? null,
      chatter_user_id: params.tags?.chatter_user_id ?? null, userLevel: params.tags?.userLevel ?? null } });
  return R.config.ai?.answer ?? { error: true, message: 'AI is off in this recording' };
}
