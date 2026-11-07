import { goalCurrency, type GoalCurrency } from './currency.js';
import { goalTimeZone } from './monthly.js';
import type { TwitchGoalType } from './twitch.js';

export type GoalMetric = 'follows' | 'subs' | 'bits' | 'currency';
// Keep `total` as the persisted since-creation mode for existing goals.
export type GoalMode = 'total' | 'current' | 'fixed' | 'rolling' | 'monthly';
export type GoalPlan = 'free' | 'premium' | 'pro';
export interface GoalAction { type: 'message' | 'ast'; text: string }
export interface GoalActions { completion?: GoalAction; failure?: GoalAction }
export interface GoalOutcome {
  phase: 'completed' | 'failed';
  sequence: number;
  at: number;
  actionStatus: 'none' | 'running' | 'finished' | 'error' | 'unknown';
  /** `not_seen`: a Twitch goal we only saw after it got there; `plan`: a Premium Twitch goal action on Free. */
  actionSuppressed?: 'historical_catchup' | 'not_seen' | 'plan';
}
/** An action on a Twitch goal; `armedAt`: when it was saved like this (it only runs for what happens later). */
export interface TwitchGoalAction extends GoalAction { armedAt: number }
/** Actions for every Twitch goal of one type (Twitch gives each new goal a new id). Outside the goal quota. */
export interface TwitchGoalRule { type: TwitchGoalType; completion?: TwitchGoalAction; failure?: TwitchGoalAction }
export interface Goal {
  id: string;
  name: string;
  metric: GoalMetric;
  mode: GoalMode;
  target: number;
  createdAt: number;
  startsAt: number;
  actions?: GoalActions;
  endsAt?: number;
  windowSeconds?: number;
  currency?: GoalCurrency;
  timeZone?: string;
}
export class GoalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const goalLimit = (plan: GoalPlan): number => ({ free: 2, premium: 3, pro: 4 })[plan];
export const goalMetrics = (plan: GoalPlan): GoalMetric[] => plan === 'free' ? ['follows', 'subs'] : ['follows', 'subs', 'bits', 'currency'];
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
  if (!['follows', 'subs', 'bits', 'currency'].includes(metric)) throw new GoalError('invalid', 'Unknown metric');
  if (!goalMetrics(plan).includes(metric)) throw new GoalError('plan_required', 'Bits and currency goals require Premium', 403);
  if (!['total', 'current', 'fixed', 'rolling', 'monthly'].includes(mode)) throw new GoalError('invalid', 'Unknown counting mode');
  if (mode === 'current' && (metric === 'bits' || metric === 'currency')) throw new GoalError('invalid', 'Current total is only available for follows and subscriptions');
  const goal: Goal = { id, name: goalLabel(input.name), metric, mode, target: goalInteger(input.target), createdAt: now, startsAt: now };
  if (metric === 'currency') goal.currency = goalCurrency(input.currency);
  else if (input.currency !== undefined) throw new GoalError('invalid', 'Currency settings require a currency goal');
  if (mode === 'monthly') goal.timeZone = goalTimeZone(input.timeZone);
  else if (input.timeZone !== undefined) throw new GoalError('invalid', 'Time zone requires a monthly goal');
  if (mode === 'fixed') {
    goal.startsAt = timestamp(input.startsAt);
    goal.endsAt = timestamp(input.endsAt);
    if (goal.startsAt < now - 60_000 || goal.endsAt <= Math.max(now, goal.startsAt)) throw new GoalError('invalid', 'Choose a current or future period with an end after its start');
    goal.startsAt = Math.max(now, goal.startsAt);
  }
  if (mode === 'rolling') goal.windowSeconds = goalInteger(input.windowSeconds, 90 * 86400);
  goal.actions = goalActions(input.actions, mode);
  return goal;
}
export function eligible(goal: Goal, occurredAt: number, now: number): boolean {
  if (goal.mode === 'current') return false; // Read active ledgers; never add event contributions.
  if (occurredAt < goal.startsAt || occurredAt > now) return false;
  if (goal.mode === 'fixed') return occurredAt < goal.endsAt!;
  if (goal.mode === 'rolling') return occurredAt > now - goal.windowSeconds! * 1000;
  return true;
}

export function goalActions(value: unknown, mode: GoalMode): GoalActions {
  if (value === undefined) return {};
  const input = object(value), actions: GoalActions = {};
  if (Object.keys(input).some(key => !['completion', 'failure'].includes(key))) throw new GoalError('invalid', 'Unknown goal action');
  for (const key of ['completion', 'failure'] as const) {
    if (input[key] === undefined) continue;
    if (key === 'failure' && mode !== 'fixed' && mode !== 'rolling' && mode !== 'monthly') throw new GoalError('invalid', 'Failure actions require a fixed, rolling or monthly goal');
    const action = object(input[key]);
    if (Object.keys(action).some(key => !['type', 'text'].includes(key)) || (action.type !== 'message' && action.type !== 'ast')) throw new GoalError('invalid', 'Choose a message or AST action');
    const max = action.type === 'message' ? 500 : 4000;
    if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > max) throw new GoalError('invalid', `Action text must be 1–${max} characters`);
    actions[key] = { type: action.type as GoalAction['type'], text: action.text.trim() };
  }
  return actions;
}

// Terminal outcomes latch except rolling goals, which can recover and fail again.
export function nextGoalOutcome(goal: Goal, current: number, previous: GoalOutcome | undefined, now: number): GoalOutcome['phase'] | null {
  if (now < goal.startsAt) return null;
  if (previous && goal.mode !== 'rolling') return null;
  if (current >= goal.target) return previous?.phase === 'completed' ? null : 'completed';
  if (goal.mode === 'fixed' && now >= goal.endsAt!) return 'failed';
  if (goal.mode === 'rolling' && previous?.phase === 'completed') return 'failed';
  return null;
}

/**
 * The saved rule for one Twitch goal type: completion = "when reached", failure = "when it ends without being reached".
 * An action keeps its `armedAt` while unchanged; a new or edited one only runs for what happens after `now`.
 */
export function twitchGoalRule(type: TwitchGoalType, value: unknown, previous: TwitchGoalRule | undefined, now: number): TwitchGoalRule | null {
  const input = object(value);
  if (Object.keys(input).some(key => key !== 'actions')) throw new GoalError('invalid', 'Only actions can be saved for a Twitch goal');
  const actions = goalActions(input.actions ?? {}, 'fixed'), rule: TwitchGoalRule = { type };
  for (const key of ['completion', 'failure'] as const) {
    const next = actions[key], old = previous?.[key];
    if (next) rule[key] = { ...next, armedAt: old && old.type === next.type && old.text === next.text ? old.armedAt : now };
  }
  return rule.completion || rule.failure ? rule : null;
}
