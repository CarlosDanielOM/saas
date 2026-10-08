/** Public aggregate data only: never expose predictor identities to browser sources. */
export type InteractionKind = 'poll' | 'prediction';
export type InteractionPhase = 'active' | 'locked' | 'completed' | 'terminated' | 'archived' | 'resolved' | 'canceled';
export interface InteractionChoice { id: string; title: string; votes: number; channelPointsVotes?: number; users: number; points: number; color?: string }
export interface InteractionState {
  kind: InteractionKind; id: string; title: string; phase: InteractionPhase; choices: InteractionChoice[];
  startedAt: string; deadline: string | null; endedAt: string | null; winnerId: string | null;
  occurredAt: string; receipt: string; revision: number;
}
export interface InteractionSnapshot { poll: InteractionState | null; prediction: InteractionState | null; serverTime: number }
export const INTERACTION_EVENT_TYPES = {
  'channel.poll.begin': 'channel.poll.began', 'channel.poll.progress': 'channel.poll.updated', 'channel.poll.end': 'channel.poll.ended',
  'channel.prediction.begin': 'channel.prediction.began', 'channel.prediction.progress': 'channel.prediction.updated',
  'channel.prediction.lock': 'channel.prediction.locked', 'channel.prediction.end': 'channel.prediction.ended'
} as const;
export const INTERACTION_SUBSCRIPTIONS: Record<InteractionKind, readonly string[]> = {
  poll: ['channel.poll.begin', 'channel.poll.progress', 'channel.poll.end'],
  prediction: ['channel.prediction.begin', 'channel.prediction.progress', 'channel.prediction.lock', 'channel.prediction.end']
};
export const RESULT_DURATION_MS = 15_000;
const terminal = (phase: InteractionPhase) => phase !== 'active' && phase !== 'locked';
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid interaction text');
  return value;
}
function time(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error('Invalid interaction timestamp');
  return result;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid interaction count');
  return value;
}
export function parseInteraction(type: string, event: Record<string, unknown>, occurredAt: string, receipt: string): InteractionState {
  if (!Object.hasOwn(INTERACTION_EVENT_TYPES, type)) throw new Error('Invalid interaction event');
  const kind: InteractionKind = type.startsWith('channel.poll.') ? 'poll' : 'prediction';
  const ending = type.endsWith('.end'), beginning = type.endsWith('.begin');
  const statuses = kind === 'poll' ? ['completed', 'terminated', 'archived'] : ['resolved', 'canceled'];
  if (ending && !statuses.includes(String(event.status))) throw new Error('Invalid interaction status');
  const phase = (ending ? event.status : type.endsWith('.lock') ? 'locked' : 'active') as InteractionPhase;
  const raw = event[kind === 'poll' ? 'choices' : 'outcomes'];
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > (kind === 'poll' ? 5 : 10)) throw new Error('Invalid interaction choices');
  const choices = raw.map((raw): InteractionChoice => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid interaction choice');
    const choice = raw as Record<string, unknown>;
    const votes = kind === 'poll' ? count(choice.votes ?? (beginning ? 0 : undefined)) : 0;
    // Twitch's votes includes Channel Points votes; preserve the subset separately.
    const channelPointsVotes = kind === 'poll' ? count(choice.channel_points_votes ?? 0) : 0;
    if (channelPointsVotes > votes) throw new Error('Channel Points votes exceed total votes');
    return { id: text(choice.id, 100), title: text(choice.title),
      votes, ...(kind === 'poll' ? { channelPointsVotes } : {}),
      users: kind === 'prediction' ? count(choice.users ?? (beginning ? 0 : undefined)) : 0,
      points: kind === 'prediction' ? count(choice.channel_points ?? (beginning ? 0 : undefined)) : 0,
      ...(kind === 'prediction' && typeof choice.color === 'string' ? { color: choice.color === 'pink' ? 'pink' : 'blue' } : {}) };
  });
  if (new Set(choices.map(c => c.id)).size !== choices.length) throw new Error('Duplicate interaction choices');
  const winnerId = kind === 'prediction' && phase === 'resolved' ? text(event.winning_outcome_id, 100) : null;
  if (winnerId && !choices.some(c => c.id === winnerId)) throw new Error('Invalid winning outcome');
  if (phase === 'locked') time(event.locked_at);
  return { kind, id: text(event.id, 100), title: text(event.title), phase, choices,
    startedAt: time(event.started_at), deadline: terminal(phase) || phase === 'locked' ? null : time(event[kind === 'poll' ? 'ends_at' : 'locks_at']),
    endedAt: ending ? time(event.ended_at) : null, winnerId,
    occurredAt: time(occurredAt), receipt: text(receipt, 200), revision: 0 };
}
/** Provider snapshots replace totals. Terminal phases never return to voting. */
export function reduceInteraction(current: InteractionState | null, next: InteractionState): InteractionState | null {
  if (current) {
    if (current.receipt === next.receipt) return null;
    if (current.id !== next.id && Date.parse(next.startedAt) <= Date.parse(current.startedAt)) return null;
    if (current.id === next.id) {
      const rank = (phase: InteractionPhase) => terminal(phase) ? 2 : phase === 'locked' ? 1 : 0;
      if (rank(next.phase) < rank(current.phase)) return null;
      if (rank(next.phase) === rank(current.phase) && Date.parse(next.occurredAt) < Date.parse(current.occurredAt)) return null;
      if (terminal(current.phase) && terminal(next.phase)) next = { ...next, endedAt: current.endedAt };
    }
  }
  return { ...next, revision: (current?.revision ?? 0) + 1 };
}
