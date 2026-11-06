import { goalSnapshot } from '../goals/service.js';

type SnapshotGoal = Awaited<ReturnType<typeof goalSnapshot>>['goals'][number];
/** A goal as custom widgets see it: progress and timing only (never completion actions or their outcomes). */
export interface PublicGoal {
  id: string; name: string; metric: 'follows' | 'subs' | 'bits' | 'currency'; mode: string;
  /** Money goals in currency units (e.g. 12.5); everything else in counts. */
  target: number; current: number; percent: number; currency: string | null;
  status: string; startsAt: number; endsAt: number | null; windowSeconds: number | null;
  period: { key: string; startsAt: number; endsAt: number } | null;
}

const inflight = new Map<string, Promise<SnapshotGoal[]>>();
/** The channel's goals with progress; concurrent readers (session data, goal state) share one read. */
export function channelGoals(channel: string, now = Date.now()): Promise<SnapshotGoal[]> {
  let pending = inflight.get(channel);
  if (!pending) {
    pending = goalSnapshot(channel, now).then(snapshot => snapshot.goals).finally(() => inflight.delete(channel));
    inflight.set(channel, pending);
  }
  return pending;
}

export function publicGoals(goals: readonly SnapshotGoal[]): PublicGoal[] {
  return goals.map(goal => {
    const money = goal.metric === 'currency', unit = (value: number) => money ? value / 100 : value;
    const period = (goal as { period?: { key: string; startsAt: number; endsAt: number } }).period;
    return { id: goal.id, name: goal.name, metric: goal.metric, mode: goal.mode, target: unit(goal.target), current: unit(goal.current),
      percent: Math.round(goal.percent * 10) / 10, currency: money ? goal.currency?.code ?? null : null, status: goal.status,
      startsAt: goal.startsAt, endsAt: goal.endsAt ?? null, windowSeconds: goal.windowSeconds ?? null,
      period: period ? { key: period.key, startsAt: period.startsAt, endsAt: period.endsAt } : null };
  });
}
