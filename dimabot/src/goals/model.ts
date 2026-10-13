export type GoalMetric = 'follows' | 'subs' | 'bits';
// Keep `total` as the persisted since-creation mode for existing goals.
export type GoalMode = 'total' | 'current' | 'fixed' | 'rolling';
export type GoalPlan = 'free' | 'premium' | 'pro';
export interface Goal {
  id: string;
  name: string;
  metric: GoalMetric;
  mode: GoalMode;
  target: number;
  createdAt: number;
  startsAt: number;
  endsAt?: number;
  windowSeconds?: number;
}
export class GoalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const goalLimit = (plan: GoalPlan): number => ({ free: 2, premium: 3, pro: 4 })[plan];
export const goalMetrics = (plan: GoalPlan): GoalMetric[] => plan === 'free' ? ['follows', 'subs'] : ['follows', 'subs', 'bits'];
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalError('invalid', 'Expected an object');
  return value as Record<string, unknown>;
}
export function goalLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new GoalError('invalid', 'Name must be 1–80 characters');
  return value.trim();
}
export function goalInteger(value: unknown, max = 1_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new GoalError('invalid', `Expected an integer between 1 and ${max}`);
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new GoalError('invalid', 'Expected a date with timezone');
  return Date.parse(value);
}
export function newGoal(value: unknown, plan: GoalPlan, id: string, now: number): Goal {
  const input = object(value), metric = input.metric as GoalMetric, mode = input.mode as GoalMode;
  if (!['follows', 'subs', 'bits'].includes(metric)) throw new GoalError('invalid', 'Unknown metric');
  if (!goalMetrics(plan).includes(metric)) throw new GoalError('plan_required', 'Bits goals require Premium', 403);
  if (!['total', 'current', 'fixed', 'rolling'].includes(mode)) throw new GoalError('invalid', 'Unknown counting mode');
  if (mode === 'current' && metric === 'bits') throw new GoalError('invalid', 'Current total is only available for follows and subscriptions');
  const goal: Goal = { id, name: goalLabel(input.name), metric, mode, target: goalInteger(input.target), createdAt: now, startsAt: now };
  if (mode === 'fixed') {
    goal.startsAt = timestamp(input.startsAt);
    goal.endsAt = timestamp(input.endsAt);
    if (goal.startsAt < now - 60_000 || goal.endsAt <= Math.max(now, goal.startsAt)) throw new GoalError('invalid', 'Choose a current or future period with an end after its start');
    goal.startsAt = Math.max(now, goal.startsAt);
  }
  if (mode === 'rolling') goal.windowSeconds = goalInteger(input.windowSeconds, 90 * 86400);
  return goal;
}
export function eligible(goal: Goal, occurredAt: number, now: number): boolean {
  if (goal.mode === 'current') return false; // Read active ledgers; never add event contributions.
  if (occurredAt < goal.startsAt || occurredAt > now) return false;
  if (goal.mode === 'fixed') return occurredAt < goal.endsAt!;
  if (goal.mode === 'rolling') return occurredAt > now - goal.windowSeconds! * 1000;
  return true;
}
