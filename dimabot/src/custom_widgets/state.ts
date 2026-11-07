import { goalSnapshot } from '../goals/service.js';
import { publicTwitchGoals, type PublicTwitchGoal } from '../goals/twitch.js';

type GoalState = Awaited<ReturnType<typeof goalSnapshot>>;
type SnapshotGoal = GoalState['goals'][number];
/** A goal as custom widgets see it: progress and timing only (never completion actions or their outcomes). */
export interface PublicGoal {
  /** `dima`: the Goals page; Twitch goals are `PublicTwitchGoal` (`source: 'twitch'`). Each layer gets one source. */
  id: string; source: 'dima'; name: string; metric: 'follows' | 'subs' | 'bits' | 'currency'; mode: string;
  /** Money goals in currency units (e.g. 12.5); everything else in counts. */
  target: number; current: number; percent: number; currency: string | null;
  /** Same shape as Twitch goals: always null here. */
  twitchType: null; achieved: null;
  status: string; startsAt: number; endsAt: number | null; windowSeconds: number | null;
  period: { key: string; startsAt: number; endsAt: number } | null;
}

const inflight = new Map<string, Promise<GoalState>>();
/** The channel's goals with progress, and its Twitch goals; concurrent readers (session data, goal state) share one read. */
export function channelGoals(channel: string, now = Date.now()): Promise<GoalState> {
  let pending = inflight.get(channel);
  if (!pending) {
    pending = goalSnapshot(channel, now).finally(() => inflight.delete(channel));
    inflight.set(channel, pending);
  }
  return pending;
}

/** `Dima.state('goals')`: our goals, then Twitch's. The frame host keeps only the layer's source (dimasite goal-source.ts). */
export function publicGoals(state: Pick<GoalState, 'goals' | 'twitch'>): (PublicGoal | PublicTwitchGoal)[] {
  return [...ownGoals(state.goals), ...publicTwitchGoals(state.twitch.goals)];
}
function ownGoals(goals: readonly SnapshotGoal[]): PublicGoal[] {
  return goals.map(goal => {
    const money = goal.metric === 'currency', unit = (value: number) => money ? value / 100 : value;
    const period = (goal as { period?: { key: string; startsAt: number; endsAt: number } }).period;
    return { id: goal.id, source: 'dima', name: goal.name, metric: goal.metric, mode: goal.mode, target: unit(goal.target), current: unit(goal.current),
      percent: Math.round(goal.percent * 10) / 10, currency: money ? goal.currency?.code ?? null : null, twitchType: null, achieved: null, status: goal.status,
      startsAt: goal.startsAt, endsAt: goal.endsAt ?? null, windowSeconds: goal.windowSeconds ?? null,
      period: period ? { key: period.key, startsAt: period.startsAt, endsAt: period.endsAt } : null };
  });
}
