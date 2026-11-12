export * from 'real:utils/ai/threading/thread_router.ts';
import { R, record, copy } from './rec.mjs';
export async function resolveUserThreadForMessage(params) {
  record('ai.thread', copy(params));
  return R.config.ai?.thread ?? { threadID: null, promptContext: [] };
}
export async function appendAssistantTurnToThread(params) {
  record('ai.append', copy(params));
}
