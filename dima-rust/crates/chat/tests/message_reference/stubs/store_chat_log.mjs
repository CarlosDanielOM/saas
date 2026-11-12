export * from 'real:utils/qdrant/functions/chat_logs/store_chat_log.qdrant.ts';
import { record, copy } from './rec.mjs';
// The embedding queue: what was queued (the batcher is the binary's).
export async function storeChatMessageEmbeddingBatched(data) {
  if (!data?.message?.trim?.()) return;
  record('embedding', copy(data));
}
