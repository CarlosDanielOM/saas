import type { DimaEvent, DimaSession } from './dima-events';

/**
 * Where a custom widget layer's goal numbers come from (layer config `goalSource`, set in the Studio's "Goal data"):
 * `dima` = the Goals page (default, also for layers saved before the choice existed), `twitch` = the streamer's
 * Twitch goals. The frame host applies it to everything a frame gets, in the Studio and in OBS alike, so frames never
 * see the other source or the server's `goalsBySource` field.
 */
export type GoalSource = 'dima' | 'twitch';
export const layerGoalSource = (config: Record<string, unknown> | undefined): GoalSource => config?.['goalSource'] === 'twitch' ? 'twitch' : 'dima';

/** StreamElements "manual" goal values; a Twitch layer gets all four from Twitch (0 when there's no such Twitch goal). */
export const SE_GOAL_KEYS = ['follower-goal', 'subscriber-goal', 'cheer-goal', 'tip-goal'] as const;
type ServerSession = DimaSession & { goalsBySource?: { twitch?: Record<string, { amount?: unknown }> } };

/** A layer's copy of the session snapshot (a fresh object: layers sharing one widget never share data). */
export function sessionForLayer(session: DimaSession, source: GoalSource): DimaSession {
  const data: Record<string, unknown> = { ...session.data };
  if (source === 'twitch') {
    const twitch = (session as ServerSession).goalsBySource?.twitch ?? {};
    for (const key of SE_GOAL_KEYS) data[key] = { amount: Number(twitch[key]?.amount) || 0 };
  }
  return { data, recents: Array.isArray(session.recents) ? [...session.recents] : [] };
}

/** `Dima.state('goals')` items of the layer's source (items without one are the Goals page's). */
export function goalsForLayer(value: unknown, source: GoalSource): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter(goal => ((goal as { source?: unknown } | null)?.source === 'twitch' ? 'twitch' : 'dima') === source);
}

/** Session snapshots and goal state as this layer should see them; every other event is unchanged. */
export function eventForLayer(event: DimaEvent, source: GoalSource): DimaEvent {
  if (event.type === 'session') return { type: 'session', data: sessionForLayer(event.data, source) };
  if (event.type === 'state' && event.data.name === 'goals') return { type: 'state', data: { name: 'goals', value: goalsForLayer(event.data.value, source) } };
  return event;
}
/** The live states a frame starts with, filtered the same way. */
export function statesForLayer(states: Record<string, unknown>, source: GoalSource): Record<string, unknown> {
  return 'goals' in states ? { ...states, goals: goalsForLayer(states['goals'], source) } : states;
}
