import { createHash, randomUUID } from 'node:crypto';
import { RaidSessionSchema as Sessions, RaidFollowerSchema as Followers, RaidModerationRequestSchema as Requests } from '../schemas/raid_session.schema.js';
import Users from '../schemas/users.schema.js';
import { FollowDefenseSettingsSchema as Settings } from '../schemas/follow_defense_settings.schema.js';
import type { FollowDefenseFollowPayload, FollowDefenseRaidMarker } from './follow_defense_queue.js';

const QUIET_MS = 5 * 60_000;
export const raidRetentionHours = (_tier?: unknown) => 72;
export function raidHistoryPermissions(tier: unknown) {
    return { canBanSession: tier === 'premium' || tier === 'pro', canBanIndividual: tier === 'pro' };
}
export async function getRaidHistoryAccess(channelID: string) {
    const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
    const planTier = owner?.plan_tier === 'pro' ? 'pro' : owner?.plan_tier === 'premium' ? 'premium' : 'free';
    return { planTier, ...raidHistoryPermissions(planTier) };
}
export const raidIdentity = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export async function findRaidSession(channelID: string, at: number) {
    const session = await Sessions.findOne({ channelID, startedAt: { $lte: new Date(at) }, purgeAt: { $gt: new Date() } })
        .sort({ startedAt: -1, _id: -1 }).lean();
    return session && at <= session.captureUntil.getTime() && (!session.endedAt || at < session.endedAt.getTime()) ? session : null;
}

export async function recordRaidSession(marker: FollowDefenseRaidMarker) {
    const id = raidIdentity(marker.channelID, marker.eventID!);
    const hours = raidRetentionHours();
    const expiresAt = new Date(marker.createdAt + hours * 3600_000);
    if (expiresAt.getTime() <= Date.now()) return null;
    let next = await Sessions.findOne({ channelID: marker.channelID, startedAt: { $gt: new Date(marker.createdAt) } }).sort({ startedAt: 1 }).lean();
    await Sessions.updateOne({ _id: id }, { $setOnInsert: {
        channelID: marker.channelID, eventID: marker.eventID, raiderID: marker.raiderChannelID,
        raiderLogin: marker.raiderChannelLogin, raiderName: marker.raiderChannelName, viewers: marker.raidViewers,
        startedAt: new Date(marker.createdAt), endedAt: next?.startedAt || null, captureUntil: new Date(marker.createdAt + QUIET_MS),
        retentionHours: hours, expiresAt, backfillUntil: new Date(), purgeAt: new Date(expiresAt.getTime() + 3600_000)
    } }, { upsert: true });
    // Re-read after insertion to close concurrent, independently delivered raids.
    next = await Sessions.findOne({ channelID: marker.channelID, startedAt: { $gt: new Date(marker.createdAt) } }).sort({ startedAt: 1 }).lean();
    if (next) await Sessions.updateOne({ _id: id }, { $set: { endedAt: next.startedAt } });
    const stored = (await Sessions.findById(id).lean())!;
    // Timestamp boundaries also repair late raid delivery without merging A and B.
    await Sessions.updateMany({ channelID: marker.channelID, startedAt: { $lt: new Date(marker.createdAt) },
        $or: [{ endedAt: null }, { endedAt: { $gt: new Date(marker.createdAt) } }] }, { $set: { endedAt: new Date(marker.createdAt) } });
    await Followers.updateMany({ channelID: marker.channelID,
        followedAt: { $gte: new Date(marker.createdAt), ...(next ? { $lt: next.startedAt } : {}) }, sessionID: { $ne: id } }, {
        $set: { sessionID: id, queuedRequestIDs: [], eligibleRequestIDs: [], purgeAt: new Date(stored.startedAt.getTime() + 73 * 3600_000) }
    });
    const last = await Followers.findOne({ sessionID: id }).sort({ followedAt: -1 }).lean();
    if (last) await Sessions.updateOne({ _id: id }, { $max: { captureUntil: new Date(Math.min(stored.expiresAt.getTime(), last.followedAt.getTime() + QUIET_MS)) } });
    return Sessions.findById(id).lean();
}

export async function recordRaidFollow(follow: FollowDefenseFollowPayload) {
    const at = new Date(follow.followedAt).getTime();
    if (!Number.isFinite(at) || at > Date.now()) return null;
    const session = await findRaidSession(follow.channelID, at);
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    await Followers.updateOne({ _id: raidIdentity(follow.channelID, follow.eventID) }, { $setOnInsert: {
        channelID: follow.channelID, sessionID: session._id, eventID: follow.eventID,
        userID: follow.followerID, login: follow.followerLogin, name: follow.followerName,
        followedAt: new Date(at), purgeAt: new Date(session.startedAt.getTime() + 73 * 3600_000)
    } }, { upsert: true });
    await Sessions.updateOne({ _id: session._id }, { $max: { captureUntil: new Date(Math.min(session.expiresAt.getTime(), at + QUIET_MS)) } });
    const latest = await findRaidSession(follow.channelID, at);
    if (latest && latest._id !== session._id) {
        await Followers.updateOne({ _id: raidIdentity(follow.channelID, follow.eventID) }, { $set: { sessionID: latest._id, queuedRequestIDs: [], eligibleRequestIDs: [], purgeAt: new Date(latest.startedAt.getTime() + 73 * 3600_000) } });
    }
    const resolved = latest || session;
    const { getFollowDefenseStatus } = await import('./follow_defense_queue.js');
    const state = await getFollowDefenseStatus(follow.channelID);
    if (state?.mode === 'attack' && state.expiresAt > Date.now() && state.raidSessionID === resolved._id && state.raidRequestID) {
        await Followers.updateOne({ _id: raidIdentity(follow.channelID, follow.eventID), sessionID: resolved._id }, { $addToSet: { eligibleRequestIDs: state.raidRequestID } });
        await Requests.updateOne({ _id: state.raidRequestID, status: 'completed', expiresAt: { $gt: new Date() } }, { $set: { status: 'active' } });
    }
    return resolved;
}

export async function requestRaidBans(channelID: string, sessionID: string, actorID: string, requestID: string, userID = '', includeFuture = false, origin: 'history' | 'live' = 'history') {
    const session = await Sessions.findOne({ _id: sessionID, channelID, expiresAt: { $gt: new Date() } }).lean();
    if (!session) throw Object.assign(new Error('Raid session expired or not found'), { status: 404 });
    const settings = await Settings.findOne({ channelID }).lean();
    if (settings?.enabled === false || settings?.attackModeEnabled === false) throw Object.assign(new Error('Enable Follow Defense and attack mode first'), { status: 409 });
    if (userID && !await Followers.exists({ sessionID, channelID, userID })) throw Object.assign(new Error('Follower not in this session'), { status: 404 });
    const id = raidIdentity(channelID, sessionID, requestID);
    const { getFollowDefenseStatus, projectFollowDefenseState } = await import('./follow_defense_queue.js');
    const state = await getFollowDefenseStatus(channelID);
    const prior = await Requests.findById(id).lean();
    const access = await getRaidHistoryAccess(channelID);
    if ((origin === 'history' && !access.canBanSession) || (userID && !access.canBanIndividual)) {
        throw Object.assign(new Error(userID ? 'Pro is required to ban individual raid followers from history' : 'Premium is required to ban raid sessions from history'), { status: 403 });
    }
    if (prior && (prior.userID !== userID || (prior.origin || 'history') !== origin)) throw Object.assign(new Error('Request identity already used with different targets'), { status: 409 });
    const live = Boolean(!userID && includeFuture && !session.endedAt && session.captureUntil.getTime() > Date.now()
        && state?.expiresAt && state.expiresAt > Date.now() && state.raidSessionID === sessionID
        && (access.canBanSession ? state.mode !== 'normal' : ['protection', 'attack'].includes(state.mode)));
    const accepted = prior && ['pending', 'active', 'completed'].includes(prior.status);
    if (!access.canBanSession && !accepted && !live) throw Object.assign(new Error('Free channels can activate raid attack mode only while live protection is active'), { status: 409 });
    const future = prior?.includeFuture ?? live;
    const now = new Date();
    await Requests.updateOne({ _id: id }, { $setOnInsert: {
        channelID, sessionID, actorID, userID, includeFuture: future, origin,
        status: future ? 'authorizing' : 'pending',
        requestedAt: now, expiresAt: new Date(now.getTime() + 3600_000), purgeAt: new Date(now.getTime() + 7 * 86400_000)
    } }, { upsert: true });
    const request = (await Requests.findById(id).lean())!;
    const { followDefenseCancelledThrough } = await import('./follow_defense_actions.js');
    if (request.status === 'cancelled' || request.expiresAt.getTime() <= Date.now() || request.requestedAt.getTime() <= await followDefenseCancelledThrough(channelID)) throw Object.assign(new Error('This request expired or was cancelled; confirm a new request'), { status: 409 });
    if (request.userID !== userID || request.includeFuture !== future) throw Object.assign(new Error('Request identity already used with different targets'), { status: 409 });
    if (accepted) return request;
    if (!userID && future) await Sessions.updateOne({ _id: sessionID }, { $set: { manualRequestID: id } });
    if (!userID && future) {
        const projected = await projectFollowDefenseState(channelID, { type: 'session_attack', state: {
            mode: 'attack', channelID, channelLogin: '', channelName: '', modeStartedAt: request.requestedAt.getTime(),
            burstStartedAt: session.startedAt.getTime(), expiresAt: request.requestedAt.getTime() + (settings?.silentDurationSeconds || 60) * 1000, triggeredBy: 'manual',
            lastTransitionReason: 'manual_raid_session', lastUpdatedAt: Date.now(), raidSessionID: sessionID, raidRequestID: id
        } });
        if (projected.changed) {
            // Include arrivals between accepting the request and publishing its active mode.
            await Followers.updateMany({ channelID, sessionID, recordedAt: { $gte: request.requestedAt, $lte: new Date() } },
                { $addToSet: { eligibleRequestIDs: id } });
        }
        if (!projected.changed && (projected.state?.raidRequestID !== id || projected.state.expiresAt <= Date.now())) {
            if (!access.canBanSession) {
                await Requests.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
                throw Object.assign(new Error('Live protection ended before attack mode could be activated'), { status: 409 });
            }
            await Requests.updateOne({ _id: id }, { $set: { includeFuture: false } });
            request.includeFuture = false;
        }
    }
    if (request.status === 'authorizing') {
        await Requests.updateOne({ _id: id, status: 'authorizing' }, { $set: { status: 'pending' } });
        const admitted = await Requests.findById(id).lean();
        if (!admitted || !['pending', 'active', 'completed'].includes(admitted.status)) {
            throw Object.assign(new Error('Attack activation expired or was cancelled; confirm a new request'), { status: 409 });
        }
        return admitted;
    }
    return request;
}

// Admission runs outside detection and HTTP requests, in bounded batches. Accepted
// historical followers use the explicit request's authority, never a replayed event.
export async function processRaidModerationRequests() {
    const { enqueueRaidSessionBan, followDefenseCancelledThrough } = await import('./follow_defense_actions.js');
    const now = new Date();
    await Requests.updateMany({ status: { $in: ['authorizing', 'pending', 'active'] }, expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
    // Recover a crash after publishing the live state but before admitting the request.
    const authorizing = await Requests.findOne({ status: 'authorizing', requestedAt: { $lte: new Date(now.getTime() - 10000) }, expiresAt: { $gt: now } }).lean();
    if (authorizing) {
        const { getFollowDefenseStatus } = await import('./follow_defense_queue.js');
        const state = await getFollowDefenseStatus(authorizing.channelID);
        const activated = state?.raidRequestID === authorizing._id && state.mode === 'attack' && state.expiresAt > Date.now();
        await Requests.updateOne({ _id: authorizing._id, status: 'authorizing' }, { $set: { status: activated ? 'pending' : 'cancelled' } });
    }
    const token = randomUUID();
    const request = await Requests.findOneAndUpdate({ status: { $in: ['pending', 'active'] }, nextAttemptAt: { $lte: now },
        lockedUntil: { $lte: now }, expiresAt: { $gt: now } }, { $set: { leaseToken: token, lockedUntil: new Date(now.getTime() + 60000) } },
    { new: true, sort: { nextAttemptAt: 1, requestedAt: 1 } }).lean();
    if (!request) return;
    const fence = { _id: request._id, leaseToken: token };
    try {
        const settings = await Settings.findOne({ channelID: request.channelID }).lean();
        if (request.requestedAt.getTime() <= await followDefenseCancelledThrough(request.channelID) || settings?.enabled === false || settings?.attackModeEnabled === false) {
            await Requests.updateOne(fence, { $set: { status: 'cancelled' } }); return;
        }
        const followers = await Followers.find({ sessionID: request.sessionID, channelID: request.channelID,
            queuedRequestIDs: { $ne: request._id }, ...(request.userID ? { userID: request.userID } : {}),
            $or: [{ recordedAt: { $lte: request.requestedAt } }, ...(request.includeFuture ? [{ eligibleRequestIDs: request._id }] : [])] }).sort({ followedAt: 1, _id: 1 }).limit(200).lean();
        for (const follower of followers) {
            await enqueueRaidSessionBan(follower, request);
            await Followers.updateOne({ _id: follower._id, sessionID: request.sessionID }, { $addToSet: { queuedRequestIDs: request._id } });
        }
        const { getFollowDefenseStatus } = await import('./follow_defense_queue.js');
        const current = await getFollowDefenseStatus(request.channelID);
        const ongoing = request.includeFuture && current?.raidRequestID === request._id && current.expiresAt > Date.now() && current.mode === 'attack';
        await Requests.updateOne(fence, { $set: { status: followers.length === 200 || ongoing ? 'active' : 'completed', nextAttemptAt: new Date(Date.now() + (followers.length === 200 ? 0 : 1000)) } });
    } finally { await Requests.updateOne(fence, { $set: { lockedUntil: new Date(0), leaseToken: '' } }); }
}


export async function backfillRaidSession() {
    const session = await Sessions.findOne({ backfillDone: false, expiresAt: { $gt: new Date() } }).sort({ startedAt: 1 }).lean();
    if (!session) return;
    const [{ DomainEventSchema }, { Types }] = await Promise.all([import('../schemas/domain_event.schema.js'), import('mongoose')]);
    const events = await DomainEventSchema.find({ channelID: session.channelID, source: 'twitch-eventsub', type: 'channel.follow.received',
        occurredAt: { $gte: session.startedAt, $lte: session.backfillUntil },
        ...(session.backfillCursor ? { _id: { $gt: new Types.ObjectId(session.backfillCursor) } } : {}) }).sort({ _id: 1 }).limit(200).lean();
    for (const event of events) {
        const raw = event.payload.event as Record<string, unknown> | undefined;
        if (!raw?.user_id) continue;
        await recordRaidFollow({ eventID: event.eventKey, channelID: session.channelID, channelLogin: '', channelName: '',
            followerID: String(raw.user_id), followerLogin: String(raw.user_login || ''), followerName: String(raw.user_name || ''),
            followedAt: event.occurredAt.toISOString(), receivedAt: event.journaledAt.getTime() });
    }
    await Sessions.updateOne({ _id: session._id, backfillCursor: session.backfillCursor }, { $set: {
        backfillCursor: events.length ? String(events.at(-1)!._id) : session.backfillCursor, backfillDone: events.length < 200
    } });
}

// The setting grants carryover explicitly; each new raid still owns its own request.
export async function applyRaidSessionMarker(marker: FollowDefenseRaidMarker) {
    if (!marker.eventID || !Number.isFinite(marker.createdAt)) throw new Error('Invalid raid identity');
    if (marker.createdAt > Date.now()) return;
    const session = await recordRaidSession(marker);
    const queue = await import('./follow_defense_queue.js');
    await queue.applyDurableFollowDefenseRaidMarker(marker);
    if (!session || marker.expiresAt <= Date.now() || session.endedAt) return;
    const [settings, current] = await Promise.all([Settings.findOne({ channelID: marker.channelID }).lean(), queue.getFollowDefenseStatus(marker.channelID)]);
    if (settings?.enabled === false) return;
    const carry = settings?.resetAttackOnNewRaid === false && settings?.attackModeEnabled !== false
        && current?.mode === 'attack' && current.expiresAt > Date.now();
    const projected = await queue.projectFollowDefenseState(marker.channelID, { type: 'raid', state: {
        mode: carry ? 'attack' : 'protection', channelID: marker.channelID, channelLogin: marker.channelLogin, channelName: marker.channelName,
        modeStartedAt: marker.createdAt, burstStartedAt: marker.createdAt,
        expiresAt: carry ? current!.expiresAt : Date.now() + (settings?.silentDurationSeconds || 60) * 1000,
        triggeredBy: carry ? 'manual' : 'threshold', lastTransitionReason: carry ? 'configured_raid_carryover' : 'raid_session_tracking', lastUpdatedAt: Date.now(),
        raidSessionID: session._id, raidStartedAt: marker.createdAt
    } });
    if (projected.state?.raidSessionID === session._id && projected.state.mode === 'attack'
        && projected.state.lastTransitionReason === 'configured_raid_carryover' && projected.state.expiresAt > Date.now()) {
        await requestRaidBans(marker.channelID, session._id, 'configured-raid-carryover', `carry:${marker.eventID}`, '', true, 'live');
    }
}

// Widen existing retained sessions in bounded, restart-safe steps. Already purged
// records cannot be restored. Update follower TTLs before advertising the longer window.
export async function extendRaidHistoryRetention() {
    const session = await Sessions.findOne({ retentionHours: { $lt: 72 }, expiresAt: { $gt: new Date() }, startedAt: { $gt: new Date(Date.now() - 72 * 3600_000) } }).lean();
    if (!session) return;
    const expiresAt = new Date(session.startedAt.getTime() + 72 * 3600_000);
    const purgeAt = new Date(expiresAt.getTime() + 3600_000);
    await Followers.updateMany({ sessionID: session._id }, { $max: { purgeAt } });
    await Sessions.updateOne({ _id: session._id }, { $set: { retentionHours: 72 }, $max: { expiresAt, purgeAt } });
}
