import type { DimaChat, DimaRoles } from './types.js';

/** One stored chat history entry (classes/chat_history.ts): display name, text, badge labels like "[MOD]", "[SUB 12M]". */
export interface ChatHistoryEntry { username?: unknown; message?: unknown; timestamp?: unknown; messageID?: unknown; badges?: unknown }

/**
 * Studio's "Replay recent chat": stored history becomes Dima chat messages. History keeps only the name, the text and
 * badge labels, so replies are text only (no emotes, colours, badge images or user IDs) and marked `replay` in the id.
 */
export function replayChat(entries: readonly ChatHistoryEntry[], limit = 20): DimaChat[] {
  const out: DimaChat[] = [];
  // History is newest first; replay plays it in the order it happened.
  for (const entry of entries.slice(0, limit).reverse()) {
    const name = typeof entry.username === 'string' ? entry.username.slice(0, 64) : '', text = typeof entry.message === 'string' ? entry.message.slice(0, 500) : '';
    if (!name || !text) continue;
    const labels = Array.isArray(entry.badges) ? entry.badges.filter((label): label is string => typeof label === 'string') : [];
    const has = (label: string) => labels.some(item => item === `[${label}]` || item.startsWith(`[${label} `));
    const months = Number(/\[(?:SUB|FOUNDER) (\d+)M\]/.exec(labels.join(' '))?.[1]) || null;
    const roles: DimaRoles = { broadcaster: has('STREAMER'), moderator: has('MOD'), vip: has('VIP'), subscriber: has('SUB') || has('FOUNDER'), founder: has('FOUNDER'),
      artist: false, staff: has('STAFF'), partner: has('PARTNER'), turbo: has('TURBO'), prime: has('PRIME') };
    const at = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now();
    const id = 'replay-' + (typeof entry.messageID === 'string' && entry.messageID ? entry.messageID.slice(0, 64) : String(at) + '-' + out.length);
    out.push({ id, platform: 'twitch', at, user: { id: '', login: /^\w+$/.test(name) ? name.toLowerCase() : '', name, color: null, badges: [], roles, subMonths: months },
      text, parts: [{ type: 'text', text }], kind: 'text', action: false, firstMessage: false, bits: 0, rewardId: null, reply: null, sharedChat: null });
  }
  return out;
}
