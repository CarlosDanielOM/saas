/** Chat context selection, independent of provider and database clients. */
export interface ChatContextMessage {
    source: 'live' | 'semantic' | 'thread';
    timestamp: number;
    badges?: string;
    username: string;
    message: string;
    role?: 'user' | 'assistant';
    sourceMessageId?: string;
    relevanceScore?: number;
}

export function mergeChatHistories(
  threadHistory: ChatContextMessage[],
  liveHistory: ChatContextMessage[],
  semanticHistory: ChatContextMessage[],
  backgroundLimit: number,
): ChatContextMessage[] {
  // Deduplicate events, not phrases: different chatters and repeated answers
  // are distinct turns. Prefer the thread representation of overlapping data.
  const ids = new Set<string>();
  const legacyKeys = new Set<string>();
  const thread: ChatContextMessage[] = [];
  const background: ChatContextMessage[] = [];
  for (const group of [threadHistory, liveHistory, semanticHistory]) {
    for (const item of group) {
      const key = JSON.stringify([item.username.toLowerCase(), item.timestamp, item.message]);
      if ((item.sourceMessageId && ids.has(item.sourceMessageId)) || legacyKeys.has(key)) continue;
      if (item.sourceMessageId) ids.add(item.sourceMessageId);
      legacyKeys.add(key);
      (item.source === 'thread' ? thread : background).push(item);
    }
  }
  // Thread history has already been bounded by the tier's promptTurns. Give
  // ambient chat its own existing budget so recency never evicts that thread.
  return [
    ...thread.sort((a, b) => a.timestamp - b.timestamp),
    ...background.sort((a, b) => b.timestamp - a.timestamp).slice(0, Math.max(0, backgroundLimit)),
  ];
}
