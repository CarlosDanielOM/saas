import { createHash, randomUUID } from 'node:crypto';
import { FollowDefenseActionSchema as Actions, FollowDefenseControlSchema as Controls, type FollowDefenseAction } from '../schemas/follow_defense_action.schema.js';
import { FollowDefenseSettingsSchema } from '../schemas/follow_defense_settings.schema.js';
import { FollowAttackLogSchema } from '../schemas/follow_attack_log.schema.js';
import type { FollowDefenseFollowPayload } from './follow_defense_queue.js';
import type { BanResponse } from '../functions/moderation/ban.moderation.js';

export const DEFENSE_ACTION_HORIZON_MS = 60 * 60_000;
export const DEFENSE_ACTION_LEASE_MS = 60_000;
const EXECUTOR = '@executor';
const DEFAULT_RATE = 5;
const MAX_RATE = 10;
const BUDGET_RESERVE = 20;
const EPOCH = new Date(0);
let nextPollMs = 250;
export const followDefenseActionPollDelay = () => nextPollMs;

export function defenseActionID(channelID: string, eventID: string, kind = 'ban'): string {
    return createHash('sha256').update(JSON.stringify([channelID, eventID, kind])).digest('hex');
}

async function retainControl(channelID: string, expiresAt: Date): Promise<void> {
    try {
        await Controls.updateOne({ _id: channelID }, { $max: { pendingUntil: expiresAt } }, { upsert: true });
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        await Controls.updateOne({ _id: channelID }, { $max: { pendingUntil: expiresAt } });
    }
}

async function enqueue(data: Pick<FollowDefenseAction, '_id' | 'channelID' | 'eventID' | 'kind' | 'mode' | 'authorizedAt'> & Partial<FollowDefenseAction>): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFENSE_ACTION_HORIZON_MS);
    // Index first: interruption cannot leave an accepted action undiscoverable by the worker.
    await retainControl(data.channelID, expiresAt);
    try {
        await Actions.updateOne({ _id: data._id }, { $setOnInsert: {
            ...data, nextAttemptAt: now, expiresAt, purgeAt: new Date(now.getTime() + 7 * 86400_000)
        } }, { upsert: true });
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        if (!await Actions.exists({ _id: data._id })) throw error;
    }
}

export async function enqueueFollowDefenseBan(follow: FollowDefenseFollowPayload, reason: string, authorizedAt = new Date(follow.followedAt).getTime()): Promise<void> {
    const occurredAt = new Date(follow.followedAt).getTime();
    const now = Date.now();
    if (!Number.isFinite(occurredAt) || occurredAt > now || occurredAt + 60_000 <= now) return;
    if (!follow.channelID || !follow.eventID || !follow.followerID) throw new Error('Invalid defense ban identity');
    await enqueue({
        _id: defenseActionID(follow.channelID, follow.eventID), channelID: follow.channelID,
        eventID: follow.eventID, kind: 'ban', followerID: follow.followerID, reason,
        mode: reason.includes('attack') ? 'attack' : 'protection', followedAt: new Date(occurredAt), authorizedAt: new Date(authorizedAt)
    });
}

export async function enqueueFollowDefenseBans(follows: FollowDefenseFollowPayload[], reason: string, authorizedAt?: number): Promise<void> {
    if (!follows.length) return;
    const now = Date.now();
    const fresh = follows.filter(follow => {
        const time = new Date(follow.followedAt).getTime();
        return Number.isFinite(time) && time <= now && time + 60_000 > now;
    });
    if (!fresh.length) return;
    const channelID = fresh[0].channelID;
    if (fresh.some(follow => follow.channelID !== channelID || !follow.eventID || !follow.followerID)) throw new Error('Invalid defense wave identity');
    const expiresAt = new Date(now + DEFENSE_ACTION_HORIZON_MS);
    await retainControl(channelID, expiresAt);
    await Actions.bulkWrite(fresh.map(follow => ({ updateOne: {
        filter: { _id: defenseActionID(channelID, follow.eventID) }, upsert: true,
        update: { $setOnInsert: {
            channelID, eventID: follow.eventID, followerID: follow.followerID, kind: 'ban', mode: reason.includes('attack') ? 'attack' : 'protection', reason,
            followedAt: new Date(follow.followedAt), authorizedAt: new Date(authorizedAt ?? new Date(follow.followedAt).getTime()),
            status: 'pending', nextAttemptAt: new Date(now), lockedUntil: EPOCH, leaseToken: '', attempts: 0, failures: 0,
            expiresAt, purgeAt: new Date(now + 7 * 86400_000)
        } }
    } })), { ordered: false });
}

export async function enqueueFollowDefenseAnnouncement(channelID: string, eventID: string, mode: 'attack' | 'protection', message: string, authorizedAt: number): Promise<void> {
    await enqueue({ _id: defenseActionID(channelID, eventID, 'announcement'), channelID, eventID,
        kind: 'announcement', mode, message, authorizedAt: new Date(authorizedAt) });
}

export async function followDefenseCancelledThrough(channelID: string): Promise<number> {
    return (await Controls.findById(channelID).lean())?.cancelledThrough.getTime() || 0;
}

export async function cancelFollowDefenseActions(channelID: string): Promise<void> {
    const now = new Date();
    await retainControl(channelID, EPOCH);
    // This fence also covers enqueues racing Reset, retries, and old manual commands.
    await Controls.updateOne({ _id: channelID }, { $max: { cancelledThrough: now } });
    await Actions.updateMany({ channelID, status: 'pending', authorizedAt: { $lte: now } }, {
        $set: { status: 'cancelled', completedAt: now, lastMessage: 'Cancelled by channel control' }
    });
}

export async function getFollowDefenseActionCounts(channelID: string): Promise<Record<string, number>> {
    const counts = await Actions.aggregate<{ _id: string; count: number }>([
        { $match: { channelID, kind: 'ban' } }, { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).option({ maxTimeMS: 2000 });
    return Object.fromEntries(counts.map(row => [row._id, row.count]));
}

export async function getDurableFollowDefenseBanResult(channelID: string, eventID: string) {
    const action = await Actions.findById(defenseActionID(channelID, eventID)).lean();
    return action ? { banned: action.status === 'succeeded', status: action.lastStatus, message: action.lastMessage } : null;
}

export async function refreshFollowDefenseLogActions(channelID: string, eventIDs: string[]): Promise<void> {
    await Actions.updateMany({ channelID, eventID: { $in: eventIDs }, kind: 'ban' }, { $set: { auditPending: true } });
}

export function defenseActionOutcome(result: BanResponse, failures: number, now: number) {
    const succeeded = !result.error || (result.status === 400 && /^(The user specified in the user_id field is already banned|user is already banned)\.?$/i.test(result.message));
    const limited = result.status === 429;
    const failureCount = failures + (result.error && !limited && !succeeded ? 1 : 0);
    const terminal = !succeeded && ([400, 404, 422].includes(result.status || 0) || failureCount >= 8);
    const reset = Math.max(result.rateLimitResetAt || 0, now + (result.retryAfterMs || 0));
    const endpointLimited = limited && result.rateLimitRemaining !== undefined && result.rateLimitRemaining > BUDGET_RESERVE;
    const limitPause = Math.max(now + 30_000, reset + 1000);
    const globalPause = limited && !endpointLimited ? limitPause
        : result.status === 401 ? now + 60_000
        : result.rateLimitRemaining !== undefined && result.rateLimitRemaining <= BUDGET_RESERVE ? Math.max(now + 1000, reset + 1000) : 0;
    const retryAt = Math.max(globalPause, endpointLimited ? limitPause : 0,
        now + (result.status === 403 ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(failureCount, 6))));
    return { status: succeeded ? 'succeeded' as const : terminal ? 'failed' as const : 'pending' as const,
        failures: failureCount, globalPause, retryAt, channelPause: result.status === 403 || endpointLimited ? retryAt : 0 };
}

interface PacingState { ratePerSecond?: number; successStreak?: number }
function currentRate(state: PacingState): number {
    return Math.max(1, Math.min(MAX_RATE, Number(state.ratePerSecond) || DEFAULT_RATE));
}

export function adaptiveDefensePacing(state: PacingState, result: BanResponse, now: number, scope: 'global' | 'channel') {
    let ratePerSecond = currentRate(state);
    let successStreak = state.successStreak || 0;
    const headersAvailable = result.rateLimitRemaining !== undefined && result.rateLimitResetAt !== undefined && result.rateLimitResetAt > now;
    const globalThrottle = result.status === 429 && (result.rateLimitRemaining === undefined || result.rateLimitRemaining <= BUDGET_RESERVE);
    if (result.status === 429 && (scope === 'channel' || globalThrottle)) {
        ratePerSecond = Math.max(1, ratePerSecond / 2);
        successStreak = 0;
    } else if (!result.error && headersAvailable && result.rateLimitRemaining! > BUDGET_RESERVE) {
        successStreak++;
        if (successStreak >= 20) { ratePerSecond = Math.min(MAX_RATE, ratePerSecond + 1); successStreak = 0; }
    } else {
        successStreak = 0;
        if (!headersAvailable) ratePerSecond = Math.min(DEFAULT_RATE, ratePerSecond);
    }
    // Spread the remaining shared-token budget over the reset horizon, preserving capacity for other bot features.
    const budgetInterval = scope === 'global' && headersAvailable
        ? Math.ceil((result.rateLimitResetAt! - now) / Math.max(1, result.rateLimitRemaining! - BUDGET_RESERVE)) : 0;
    return { ratePerSecond, successStreak, intervalMs: Math.max(Math.ceil(1000 / ratePerSecond), budgetInterval) };
}

async function executeAction(action: FollowDefenseAction): Promise<BanResponse> {
    if (action.kind === 'ban') {
        const [{ ban }, { TWITCH_BOT_ACCOUNT_ID }] = await Promise.all([
            import('../functions/moderation/ban.moderation.js'), import('./header.js')
        ]);
        return ban(action.channelID, action.followerID, TWITCH_BOT_ACCOUNT_ID, null, action.reason, AbortSignal.timeout(10_000));
    }
    const { sendTwitchChatMessage } = await import('../functions/chats/send_message.chat.js');
    return sendTwitchChatMessage(action.channelID, action.message, null, { channelID: action.channelID });
}

// A durable audit receipt lets a restart repair attack logs without repeating the Twitch request.
export async function reconcileFollowDefenseActionLogs(): Promise<void> {
    const actions = await Actions.find({ auditPending: true }).limit(100).lean();
    for (const action of actions) {
        await FollowAttackLogSchema.updateMany({ targetChannelID: action.channelID, 'trackedFollows.eventID': action.eventID }, {
            $set: { 'trackedFollows.$[follow].banned': action.status === 'succeeded',
                'trackedFollows.$[follow].banStatus': action.lastStatus, 'trackedFollows.$[follow].banMessage': action.lastMessage }
        }, { arrayFilters: [{ 'follow.eventID': action.eventID }] });
        await Actions.updateOne({ _id: action._id, status: action.status }, { $set: { auditPending: false } });
    }
}

export async function processFollowDefenseAction(execute = executeAction): Promise<boolean> {
    nextPollMs = 250;
    const now = new Date();
    await retainControl(EXECUTOR, EPOCH);
    const leaseToken = randomUUID();
    const executor = await Controls.findOneAndUpdate({ _id: EXECUTOR, lockedUntil: { $lte: now }, nextAllowedAt: { $lte: now } }, {
        $set: { leaseToken, lockedUntil: new Date(now.getTime() + DEFENSE_ACTION_LEASE_MS) }
    }, { new: true }).lean();
    if (!executor) { nextPollMs = 50; return false; }
    const fence = () => ({ _id: EXECUTOR, leaseToken, lockedUntil: { $gt: new Date() } });
    try {
        await Actions.updateMany({ status: { $in: ['pending', 'processing'] }, expiresAt: { $lte: now }, lockedUntil: { $lte: now } }, {
            $set: { status: 'expired', completedAt: now, lastMessage: 'Moderation deadline elapsed' }
        });
        const channels = await Controls.find({ _id: { $ne: EXECUTOR }, pendingUntil: { $gt: now }, nextAllowedAt: { $lte: now } })
            .sort({ lastServedAt: 1, _id: 1 }).limit(25).lean();
        for (const channel of channels) {
            const action = await Actions.findOneAndUpdate({ channelID: channel._id, expiresAt: { $gt: new Date() }, nextAttemptAt: { $lte: new Date() },
                $or: [{ status: 'pending' }, { status: 'processing', lockedUntil: { $lte: new Date() } }] }, {
                $set: { status: 'processing', leaseToken, lockedUntil: executor.lockedUntil }, $inc: { attempts: 1 }
            }, { new: true, sort: { createdAt: 1, _id: 1 } }).lean();
            await Controls.updateOne({ _id: channel._id }, { $set: { lastServedAt: new Date() },
                $max: { nextAllowedAt: new Date(Date.now() + (action ? Math.ceil(1000 / currentRate(channel)) : 5000)) } });
            if (!action) continue;
            const actionFence = () => ({ _id: action._id, leaseToken, status: 'processing', lockedUntil: { $gt: new Date() } });
            const settings = await FollowDefenseSettingsSchema.findOne({ channelID: action.channelID }).lean();
            const cancelled = action.authorizedAt.getTime() <= await followDefenseCancelledThrough(action.channelID)
                || settings?.enabled === false || (action.mode === 'attack' ? settings?.attackModeEnabled === false : settings?.protectionModeEnabled === false);
            if (cancelled || action.expiresAt.getTime() <= Date.now()) {
                await Actions.updateOne(actionFence(), { $set: { status: cancelled ? 'cancelled' : 'expired', completedAt: new Date(), lastMessage: 'Cancelled or expired before execution' } });
                return true;
            }
            // Persist the pacing reservation before external effects; crashes cannot reset the limiter.
            const requestStartedAt = Date.now();
            const reserved = await Controls.updateOne(fence(), { $max: { nextAllowedAt: new Date(requestStartedAt + Math.ceil(1000 / currentRate(executor))) } });
            if (!reserved.matchedCount) throw new Error('Follow defense executor lease lost');
            let result: BanResponse;
            try { result = await execute(action); }
            catch (error) { result = { error: true, message: error instanceof Error ? error.message : String(error) }; }
            const outcome = defenseActionOutcome(result, action.failures, Date.now());
            const globalPacing = adaptiveDefensePacing(executor, result, Date.now(), 'global');
            const channelPacing = adaptiveDefensePacing(channel, result, Date.now(), 'channel');
            const paused = await Controls.updateOne(fence(), {
                $set: { ratePerSecond: globalPacing.ratePerSecond, successStreak: globalPacing.successStreak },
                $max: { nextAllowedAt: new Date(Math.max(outcome.globalPause, requestStartedAt + globalPacing.intervalMs)) }
            });
            if (!paused.matchedCount) throw new Error('Follow defense executor lease lost after request');
            await Controls.updateOne({ _id: channel._id }, {
                $set: { ratePerSecond: channelPacing.ratePerSecond, successStreak: channelPacing.successStreak },
                $max: { nextAllowedAt: new Date(Math.max(outcome.channelPause, requestStartedAt + channelPacing.intervalMs)) }
            });
            const saved = await Actions.updateOne(actionFence(), { $set: {
                status: outcome.status, failures: outcome.failures, nextAttemptAt: new Date(outcome.retryAt),
                lockedUntil: EPOCH, leaseToken: '', lastStatus: result.status || 0, lastMessage: result.message.slice(0, 1000),
                completedAt: outcome.status === 'pending' ? null : new Date(), auditPending: action.kind === 'ban'
            } });
            if (!saved.matchedCount) throw new Error('Follow defense action lease lost after request');
            return true;
        }
        return false;
    } finally {
        await Controls.updateOne(fence(), { $set: { lockedUntil: EPOCH, leaseToken: '' } });
    }
}
