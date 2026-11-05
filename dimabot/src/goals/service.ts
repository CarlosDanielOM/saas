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
import { customGoalDelta, goalItemKey, goalWeightedAmount } from './currency.js';
import { goalMonthAt, type GoalMonth } from './monthly.js';
import { requestWidgetSessionRefresh } from '../widget_feed/session-refresh.js';

interface StoredGoals { _id: string; revision: number; goals: Goal[]; outcomes?: Record<string, GoalOutcome>; monthlyCursors?: Record<string, string> }
interface Contribution { _id: string; channel: string; goal: string; occurredAt: number; amount: number; expiresAt?: Date }
interface CustomReceipt { _id: string; channel: string; fingerprint: string; itemKey: string; quantity: number; occurredAt: number; journaledAt: number }
export const GoalSet = model<StoredGoals>('ChannelGoals', new Schema<StoredGoals>({ _id: String, revision: Number, goals: [Schema.Types.Mixed], outcomes: { type: Schema.Types.Mixed, default: {} }, monthlyCursors: { type: Schema.Types.Mixed, default: {} } }, { collection: 'channel_goals', versionKey: false }));
const contributionSchema = new Schema<Contribution>({ _id: String, channel: String, goal: String, occurredAt: Number, amount: Number, expiresAt: Date }, { collection: 'goal_contributions', versionKey: false });
contributionSchema.index({ channel: 1, goal: 1, occurredAt: 1 });
contributionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const GoalContribution = model<Contribution>('GoalContribution', contributionSchema);
// Permanent identity fence: domain journal TTL must not permit a later reuse of
// one explicit custom receipt with a different item or quantity.
export const GoalCustomReceipt = model<CustomReceipt>('GoalCustomReceipt', new Schema<CustomReceipt>({
  _id: String, channel: { type: String, required: true }, fingerprint: { type: String, required: true },
  itemKey: { type: String, required: true }, quantity: { type: Number, required: true },
  occurredAt: { type: Number, required: true }, journaledAt: { type: Number, required: true }
}, { collection: 'goal_custom_receipts', versionKey: false }));
const durable = { w: 1 as const, j: true };
export const monthlyOutcomeKey = (goalID: string, periodKey: string): string => `${goalID}:${periodKey}`;
const customReceiptID = (channel: string, eventKey: string): string => createHash('sha256').update(JSON.stringify([channel, eventKey])).digest('hex');
const customFingerprint = (itemKey: string, quantity: number): string => createHash('sha256').update(JSON.stringify([itemKey, quantity])).digest('hex');

async function insertContribution(id: string, contribution: Omit<Contribution, '_id'>): Promise<void> {
  try {
    await GoalContribution.updateOne({ _id: id }, { $setOnInsert: contribution }, { upsert: true, writeConcern: durable });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await GoalContribution.findById(id).lean();
    if (!existing || existing.channel !== contribution.channel || existing.goal !== contribution.goal ||
        existing.occurredAt !== contribution.occurredAt || existing.amount !== contribution.amount) throw error;
  }
}

/** Read-only admission check; projection still enforces the permanent fence atomically. */
export async function assertCustomGoalReceiptCompatible(channel: string, eventKey: string, itemKey: string, quantity: number): Promise<void> {
  if (!channel || !eventKey) throw new GoalError('invalid', 'Custom goal receipt identity is required');
  goalItemKey(itemKey); goalInteger(quantity);
  await getMongoDBConnection('goals-custom-admission');
  const previous = await GoalCustomReceipt.findById(customReceiptID(channel, eventKey)).lean();
  if (previous && previous.fingerprint !== customFingerprint(itemKey, quantity)) {
    throw new GoalError('conflict', 'Custom goal receipt was already used with a different item or quantity', 409);
  }
}

export async function goalContributionTotal(channel: string, goal: Goal, now: number, period?: GoalMonth): Promise<number> {
  const from = period ? Math.max(goal.startsAt, period.startsAt) : goal.startsAt;
  const until = period ? { $lt: period.endsAt, $lte: now } : {
    $lte: now, ...(goal.mode === 'fixed' ? { $lt: goal.endsAt } : {})
  };
  const rows = await GoalContribution.aggregate<{ total: number }>([
    { $match: { channel, goal: goal.id, occurredAt: { $gte: from,
      ...(goal.mode === 'rolling' ? { $gt: now - goal.windowSeconds! * 1000 } : {}), ...until } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const total = rows[0]?.total ?? 0;
  if (!Number.isSafeInteger(total) || total < 0) throw new GoalError('invalid', 'Goal total exceeds the safe integer limit');
  return total;
}

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
    const period = goal.mode === 'monthly' ? goalMonthAt(now, goal.timeZone!) : undefined;
    const current = goal.mode === 'current' ? (goal.metric === 'follows' ? follows : subs) : await goalContributionTotal(channel, goal, now, period);
    const outcome = state?.outcomes?.[period ? monthlyOutcomeKey(goal.id, period.key) : goal.id];
    return { ...goal, ...(period ? { period } : {}), outcome: outcome?.actionStatus === 'running' && now - outcome.at > 300_000 ? { ...outcome, actionStatus: 'unknown' as const } : outcome, current, percent: Math.min(100, current / goal.target * 100), status: now < goal.startsAt ? 'scheduled' : current >= goal.target ? 'reached' : goal.mode === 'fixed' && now >= goal.endsAt! ? 'ended' : 'active' };
  }));
  return { plan, limit: goalLimit(plan), metrics: goalMetrics(plan), revision: state?.revision ?? 0, goals, serverTime: now };
}

// A single channel document provides atomic slot allocation and stale-edit detection.
export async function changeGoal(channel: string, action: 'create' | 'edit' | 'delete', input: unknown, expectedRevision: number, id?: string): Promise<void> {
  const plan = await goalPlan(channel), state = await GoalSet.findById(channel).lean();
  if ((state?.revision ?? 0) !== expectedRevision) throw new GoalError('conflict', 'Goals changed. Refresh and try again.', 409);
  const goals = [...(state?.goals ?? [])];
  let createdMonthly: Goal | undefined;
  if (action === 'create') {
    if (goals.length >= goalLimit(plan)) throw new GoalError('limit', 'Your plan goal limit has been reached', 409);
    const goal = newGoal(input, plan, randomUUID(), Date.now());
    goals.push(goal);
    if (goal.mode === 'monthly') createdMonthly = goal;
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
    const cursor = createdMonthly ? { [createdMonthly.id]: goalMonthAt(createdMonthly.createdAt, createdMonthly.timeZone!).key } : {};
    if (!state) await GoalSet.create([{ _id: channel, goals, revision: 1, monthlyCursors: cursor }], { w: 1, j: true });
    else {
      const unset: Record<string, number> = {};
      if (action === 'delete') {
        unset[`outcomes.${id}`] = 1;
        unset[`monthlyCursors.${id}`] = 1;
        for (const key of Object.keys(state.outcomes ?? {})) if (key.startsWith(`${id}:`)) unset[`outcomes.${key}`] = 1;
      }
      if (!(await GoalSet.updateOne({ _id: channel, revision: expectedRevision }, { $set: { goals,
        ...(createdMonthly ? { [`monthlyCursors.${createdMonthly.id}`]: cursor[createdMonthly.id] } : {}) }, $inc: { revision: 1 },
        ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { writeConcern: durable })).modifiedCount) throw new GoalError('conflict', 'Goals changed. Refresh and try again.', 409);
    }
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
  let changed = false;
  for (const goal of state?.goals ?? []) {
    // No historical backfill, including when the new consumer scans retained history.
    if ((goal.metric !== metric && !(goal.metric === 'currency' && (metric === 'bits' || metric === 'subs'))) || event.journaledAt.getTime() < goal.createdAt || !eligible(goal, event.occurredAt.getTime(), now)) continue;
    const contribution = goal.metric === 'currency'
      ? goalWeightedAmount(metric === 'bits' ? goal.currency!.bitValue : goal.currency!.subscriptionValue, amount)
      : amount;
    if (!contribution) continue;
    const id = createHash('sha256').update(`${goal.id}:${event.eventKey}`).digest('hex');
    await insertContribution(id, {
      channel: event.channelID, goal: goal.id, occurredAt: event.occurredAt.getTime(), amount: contribution,
      ...(goal.mode === 'rolling' ? { expiresAt: new Date(event.occurredAt.getTime() + goal.windowSeconds! * 1000) } : {})
    });
    changed = true;
  }
  if (changed) requestWidgetSessionRefresh(event.channelID);
}

export async function applyCustomGoalEvent(event: DomainEventEnvelope): Promise<void> {
  if (event.source !== 'goals-custom' || event.type !== 'goal.item.added' || event.topic !== 'domain' || !event.channelID || event.expiresAt.getTime() <= Date.now()) return;
  if (!event.eventKey || !Number.isFinite(event.occurredAt.getTime()) || !Number.isFinite(event.journaledAt.getTime())) throw new GoalError('invalid', 'Invalid custom goal receipt identity or time');
  const itemKey = goalItemKey(event.payload.itemKey), quantity = goalInteger(event.payload.quantity);
  await getMongoDBConnection('goals-custom-events');
  const receiptID = customReceiptID(event.channelID, event.eventKey);
  const fingerprint = customFingerprint(itemKey, quantity);
  let receipt: CustomReceipt | null;
  try {
    receipt = await GoalCustomReceipt.findOneAndUpdate({ _id: receiptID, fingerprint }, { $setOnInsert: {
      channel: event.channelID, fingerprint, itemKey, quantity,
      occurredAt: event.occurredAt.getTime(), journaledAt: event.journaledAt.getTime()
    } }, { upsert: true, new: true, writeConcern: durable }).lean();
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // Two identical deliveries can both attempt the first upsert concurrently.
    // Only a differing persisted fingerprint represents a real conflict.
    receipt = await GoalCustomReceipt.findById(receiptID).lean();
    if (!receipt || receipt.fingerprint !== fingerprint) throw new GoalError('conflict', 'Custom goal receipt was already used with a different item or quantity', 409);
  }
  if (!receipt || !Number.isFinite(receipt.occurredAt) || !Number.isFinite(receipt.journaledAt)) throw new Error('Custom goal receipt has invalid timestamps');
  const state = await GoalSet.findById(event.channelID).lean(), now = Date.now();
  let changed = false;
  for (const goal of state?.goals ?? []) {
    if (goal.metric !== 'currency' || !goal.currency || receipt.journaledAt < goal.createdAt || !eligible(goal, receipt.occurredAt, now)) continue;
    const amount = customGoalDelta(goal.currency, itemKey, quantity);
    if (!amount) continue;
    const id = createHash('sha256').update(`${goal.id}:${event.eventKey}`).digest('hex');
    await insertContribution(id, {
      channel: event.channelID, goal: goal.id, occurredAt: receipt.occurredAt, amount,
      ...(goal.mode === 'rolling' ? { expiresAt: new Date(receipt.occurredAt + goal.windowSeconds! * 1000) } : {})
    });
    changed = true;
  }
  if (changed) requestWidgetSessionRefresh(event.channelID);
}
