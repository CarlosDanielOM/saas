import { createHash, randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import Users from '../schemas/users.schema.js';
import Eventsub from '../schemas/eventsub.schema.js';
import { FollowRelationshipLedgerSchema } from '../schemas/follow_relationship_ledger.schema.js';
import { StreamSubscriptionLedgerSchema } from '../schemas/stream_subscription_ledger.schema.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import { CANONICAL_BITS_EVENT_TYPE, isLegacyBitsEventType } from '../utils/eventsub.js';
import { eligible, goalActions, GoalError, goalInteger, goalLabel, goalLimit, goalMetrics, newGoal, object, type Goal, type GoalOutcome, type GoalMetric, type GoalPlan } from './model.js';

interface StoredGoals { _id: string; revision: number; goals: Goal[]; outcomes?: Record<string, GoalOutcome> }
interface Contribution { _id: string; channel: string; goal: string; occurredAt: number; amount: number; expiresAt?: Date }
export const GoalSet = model<StoredGoals>('ChannelGoals', new Schema<StoredGoals>({ _id: String, revision: Number, goals: [Schema.Types.Mixed], outcomes: { type: Schema.Types.Mixed, default: {} } }, { collection: 'channel_goals', versionKey: false }));
const contributionSchema = new Schema<Contribution>({ _id: String, channel: String, goal: String, occurredAt: Number, amount: Number, expiresAt: Date }, { collection: 'goal_contributions', versionKey: false });
contributionSchema.index({ channel: 1, goal: 1, occurredAt: 1 });
contributionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const GoalContribution = model<Contribution>('GoalContribution', contributionSchema);
const durable = { w: 1 as const, j: true };

export async function goalPlan(channel: string): Promise<GoalPlan> {
  await getMongoDBConnection('goals');
  const user = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channel } } }).select('plan_tier').lean();
  if (!user) throw new GoalError('not_found', 'Channel not found', 404);
  return user.plan_tier === 'premium' || user.plan_tier === 'pro' ? user.plan_tier : 'free';
}
export async function goalSnapshot(channel: string, now = Date.now()) {
  const plan = await goalPlan(channel), state = await GoalSet.findById(channel).lean();
  // Use the dashboard's active ledgers, including relationships predating the goal.
  // Query each requested metric once, even if several goals share it.
  const needsTotal = (metric: GoalMetric) => state?.goals.some(goal => goal.mode === 'current' && goal.metric === metric);
  const [follows, subs] = await Promise.all([
    needsTotal('follows') ? FollowRelationshipLedgerSchema.countDocuments({ platform: 'twitch', followed_id: channel, status: 'active' }) : 0,
    needsTotal('subs') ? StreamSubscriptionLedgerSchema.countDocuments({ platform: 'twitch', streamer_id: channel, status: 'active' }) : 0
  ]);
  const goals = await Promise.all((state?.goals ?? []).map(async goal => {
    const rows = goal.mode === 'current' ? [{ total: goal.metric === 'follows' ? follows : subs }] : await GoalContribution.aggregate<{ total: number }>([
      { $match: { channel, goal: goal.id, occurredAt: { $gte: goal.startsAt, ...(goal.mode === 'rolling' ? { $gt: now - goal.windowSeconds! * 1000 } : {}), $lte: now, ...(goal.mode === 'fixed' ? { $lt: goal.endsAt } : {}) } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const current = rows[0]?.total ?? 0;
    const outcome = state?.outcomes?.[goal.id];
    return { ...goal, outcome: outcome?.actionStatus === 'running' && now - outcome.at > 300_000 ? { ...outcome, actionStatus: 'unknown' as const } : outcome, current, percent: Math.min(100, current / goal.target * 100), status: now < goal.startsAt ? 'scheduled' : current >= goal.target ? 'reached' : goal.mode === 'fixed' && now >= goal.endsAt! ? 'ended' : 'active' };
  }));
  return { plan, limit: goalLimit(plan), metrics: goalMetrics(plan), revision: state?.revision ?? 0, goals, serverTime: now };
}

// A single channel document provides atomic slot allocation and stale-edit detection.
export async function changeGoal(channel: string, action: 'create' | 'edit' | 'delete', input: unknown, expectedRevision: number, id?: string): Promise<void> {
  const plan = await goalPlan(channel), state = await GoalSet.findById(channel).lean();
  if ((state?.revision ?? 0) !== expectedRevision) throw new GoalError('conflict', 'Goals changed. Refresh and try again.', 409);
  const goals = [...(state?.goals ?? [])];
  if (action === 'create') {
    if (goals.length >= goalLimit(plan)) throw new GoalError('limit', 'Your plan goal limit has been reached', 409);
    goals.push(newGoal(input, plan, randomUUID(), Date.now()));
  } else {
    const index = goals.findIndex(goal => goal.id === id);
    if (index < 0) throw new GoalError('not_found', 'Goal not found', 404);
    if (action === 'delete') goals.splice(index, 1);
    else {
      const value = object(input);
      if (Object.keys(value).some(key => !['name', 'target', 'actions'].includes(key))) throw new GoalError('invalid', 'Only name, target and actions can be edited');
      goals[index] = { ...goals[index], name: goalLabel(value.name), target: goalInteger(value.target), ...(value.actions !== undefined ? { actions: goalActions(value.actions, goals[index].mode) } : {}) };
    }
  }
  try {
    if (!state) await GoalSet.create([{ _id: channel, goals, revision: 1 }], { writeConcern: durable });
    else if (!(await GoalSet.updateOne({ _id: channel, revision: expectedRevision }, { $set: { goals }, $inc: { revision: 1 }, ...(action === 'delete' ? { $unset: { [`outcomes.${id}`]: 1 } } : {}) }, { writeConcern: durable })).modifiedCount) throw new GoalError('conflict', 'Goals changed. Refresh and try again.', 409);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new GoalError('conflict', 'Goals changed. Refresh and try again.', 409);
    throw error;
  }
  // Deleted goal IDs never return. A concurrent delivery may leave an unreachable receipt,
  // but cannot affect another goal or resurrect deleted configuration.
  if (action === 'delete') await GoalContribution.deleteMany({ channel, goal: id }, { writeConcern: durable });
}

export async function applyGoalEvent(event: DomainEventEnvelope): Promise<void> {
  if (event.source !== 'twitch-eventsub' || !event.channelID || event.expiresAt.getTime() <= Date.now()) return;
  await getMongoDBConnection('goals-events');
  const raw = object(event.payload.event), original = String(event.metadata.originalEventType ?? '');
  let metric: GoalMetric, amount: number;
  switch (event.type) {
    case 'channel.follow.received': metric = 'follows'; amount = 1; break;
    case 'channel.subscription.received':
      if (raw.is_gift) return; // The gift batch counts these recipients once.
      metric = 'subs'; amount = 1; break;
    case 'channel.subscription.gifted': metric = 'subs'; amount = goalInteger(raw.total); break;
    case 'channel.bits.received': {
      if (isLegacyBitsEventType(original)) {
        const canonical = await Eventsub.findOne({ channelID: event.channelID, type: CANONICAL_BITS_EVENT_TYPE, enabled: true }).sort({ created_at: 1 }).select('created_at').lean();
        if (canonical && (!Number.isFinite(Date.parse(canonical.created_at)) || Date.parse(canonical.created_at) <= event.occurredAt.getTime())) return;
      }
      metric = 'bits'; amount = goalInteger(raw.bits); break;
    }
    default: return;
  }
  const state = await GoalSet.findById(event.channelID).lean(), now = Date.now();
  for (const goal of state?.goals ?? []) {
    // No historical backfill, including when the new consumer scans retained history.
    if (goal.metric !== metric || event.journaledAt.getTime() < goal.createdAt || !eligible(goal, event.occurredAt.getTime(), now)) continue;
    const id = createHash('sha256').update(`${goal.id}:${event.eventKey}`).digest('hex');
    await GoalContribution.updateOne({ _id: id }, { $setOnInsert: {
      channel: event.channelID, goal: goal.id, occurredAt: event.occurredAt.getTime(), amount,
      ...(goal.mode === 'rolling' ? { expiresAt: new Date(event.occurredAt.getTime() + goal.windowSeconds! * 1000) } : {})
    } }, { upsert: true, writeConcern: durable });
  }
}
