import mongoose, { Types } from 'mongoose';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { ClipRecommendationConfigSchema } from '../schemas/clip_recommendation_config.schema.js';
import UsersSchema from '../schemas/users.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { recordStreamOfflineEvent, SNAPSHOT_OFFLINE_MATCH_WINDOW_MS } from '../utils/stream_analytics.js';
import { validateDomainEventContract } from '../domain_events/domain_event_contracts.js';

let cache: Awaited<ReturnType<typeof getDragonflyClient>> | undefined;

// Supply MONGO_URI and DRAGONFLY_HOST/PORT explicitly in the invoking environment.
// Example: node dist/scripts/reconcile_stream_offline.script.js --channel ID
//   --event-key KEY --session-id OBJECT_ID [--execute]
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const allowed = new Set(['--channel', '--event-key', '--session-id']);
    const values = new Map<string, string>();
    let execute = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--execute' && !execute) { execute = true; continue; }
        if (!allowed.has(arg) || values.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) {
            throw new Error('Usage: --channel ID --event-key KEY --session-id OBJECT_ID [--execute]');
        }
        values.set(arg, args[++i]);
    }
    const channelID = values.get('--channel') || '';
    const eventKey = values.get('--event-key') || '';
    const suppliedSessionID = values.get('--session-id') || '';
    if (!channelID || !eventKey || !Types.ObjectId.isValid(suppliedSessionID) || suppliedSessionID.length !== 24) {
        throw new Error('All three explicit selectors are required; session ID must be an ObjectId');
    }
    const sessionID = new Types.ObjectId(suppliedSessionID).toHexString();
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await getMongoDBConnection('reconcileStreamOffline');
    const [event, delivery, session] = await Promise.all([
        DomainEventSchema.findOne({ eventKey, channelID }).lean(),
        DomainEventDeliverySchema.findOne({ eventKey, consumer: 'stream-analytics-v1' }).lean(),
        StreamSessionSchema.findOne({ _id: sessionID, channelID }).select('+applied_domain_event_keys').lean()
    ]);
    if (!event) throw new Error('Retained event does not match the selectors');
    validateDomainEventContract(event);
    if (event.eventKey !== [event.source, event.sourceEventId, event.type].map(encodeURIComponent).join(':') ||
        event.source !== 'twitch-eventsub' || event.type !== 'stream.ended' || event.topic !== 'channel' ||
        event.schemaVersion !== 1 || event.metadata?.originalEventType !== 'stream.offline' ||
        String((event.payload?.event as Record<string, unknown>)?.broadcaster_user_id || '') !== channelID ||
        !Number.isFinite(new Date(event.occurredAt).getTime()) ||
        !Number.isFinite(new Date(event.expiresAt).getTime()) || event.expiresAt <= new Date()) {
        throw new Error('Retained, unexpired Twitch stream.offline event does not match the selectors');
    }
    if (!delivery || String(delivery.eventID) !== String(event._id) || delivery.status !== 'dead' ||
        delivery.topic !== 'channel' || !Number.isFinite(new Date(delivery.expiresAt).getTime()) ||
        delivery.expiresAt <= new Date() || delivery.lastErrorCode !== 'prerequisite_missing') {
        throw new Error('No matching dead stream-analytics prerequisite delivery');
    }
    if (!session) throw new Error('Selected channel/session does not exist');
    const applied = session.applied_domain_event_keys.includes(eventKey);
    const at = new Date(event.occurredAt);
    if (applied) {
        if (session.status !== 'offline' || session.closure_source !== 'eventsub' ||
            session.ended_at?.getTime() !== at.getTime()) throw new Error('Applied receipt has conflicting session state');
    } else if (session.status !== 'orphaned' || (session.closure_source && session.closure_source !== 'snapshot') ||
        session.consecutive_offline_checks < 2 || !session.ended_at || session.started_at > at ||
        Math.abs(session.ended_at.getTime() - at.getTime()) > SNAPSHOT_OFFLINE_MATCH_WINDOW_MS) {
        throw new Error('Session is not a bounded snapshot orphan');
    }
    const conflict = await StreamSessionSchema.findOne({ channelID, _id: { $ne: session._id },
        started_at: { $gte: session.started_at, $lte: at } }).select('_id started_at status closure_source').lean();
    const competing = await StreamSessionSchema.findOne({ channelID, _id: { $ne: session._id },
        status: { $ne: 'live' }, started_at: { $lte: at },
        ended_at: { $gte: new Date(at.getTime() - SNAPSHOT_OFFLINE_MATCH_WINDOW_MS) } }).select('_id').lean();
    if (conflict || competing) throw new Error('Another session makes this offline event ambiguous');
    const otherOffline = await DomainEventSchema.findOne({ channelID, source: 'twitch-eventsub',
        type: 'stream.ended', eventKey: { $ne: eventKey }, occurredAt: { $gte: session.started_at, $lte: at } })
        .select('eventKey occurredAt').lean();
    if (otherOffline) throw new Error('Another retained offline event makes the historical match ambiguous');

    cache = await getDragonflyClient('reconcileStreamOffline');
    const summaryAccepted = Boolean(await cache.exists(`cron:jobs:accepted:stream-memory-summary:${channelID}:${sessionID}`));
    const clipsAccepted = Boolean(await cache.exists(`cron:jobs:accepted:clip-recommendation-analysis:${channelID}:${sessionID}`));
    // Legacy snapshot jobs may predate durable acceptance markers. An absent marker
    // cannot establish that an old job was never accepted, so do not resend it.
    if (!session.offline_summary_enqueued_at && !summaryAccepted) {
        throw new Error('Summary acceptance cannot be established; refusing a potentially duplicate historical job');
    }
    const [config, user] = await Promise.all([
        ClipRecommendationConfigSchema.findOne({ channelID }).lean(),
        UsersSchema.findOne({ 'accounts.id': channelID, 'accounts.type': 'twitch' }).lean()
    ]);
    const clipsEligible = Boolean(config?.autoAnalyzeEnabled && user?.plan_tier === 'pro');
    console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', channelID, eventKey, sessionID,
        occurredAt: at, priorStatus: session.status, priorClosureSource: session.closure_source || 'legacy-unknown',
        priorEndedAt: session.ended_at, alreadyApplied: applied, summaryAccepted,
        summaryReceipt: session.offline_summary_enqueued_at, clipsAccepted, clipsReceipt: session.offline_clips_completed_at,
        expected: { status: 'offline', closureSource: 'eventsub', endedAt: at,
            summary: session.offline_summary_enqueued_at ? 'preserve receipt' : 'existing accepted job; record receipt',
            clips: session.offline_clips_completed_at ? 'preserve receipt' : clipsAccepted ? 'existing accepted job; record receipt' :
                clipsEligible ? 'enqueue automatic clip job and record receipt' : 'record current clip opt-out',
            delivery: 'leave dead delivery and checkpoints unchanged' } }, null, 2));
    if (execute) {
        await recordStreamOfflineEvent({ channelID, endedAt: at, eventKey, repairSessionID: sessionID });
        const readback = await StreamSessionSchema.findById(sessionID).select('+applied_domain_event_keys').lean();
        if (!readback || readback.status !== 'offline' || readback.closure_source !== 'eventsub' ||
            readback.ended_at?.getTime() !== at.getTime() || !readback.applied_domain_event_keys.includes(eventKey) ||
            !readback.offline_summary_enqueued_at || !readback.offline_clips_completed_at) {
            throw new Error('Repair readback did not prove completion; inspect before retrying');
        }
        console.log(JSON.stringify({ outcome: 'reconciled', sessionID, endedAt: readback.ended_at,
            summaryReceipt: readback.offline_summary_enqueued_at, clipsReceipt: readback.offline_clips_completed_at }, null, 2));
    }
}

try { await main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    if (cache?.isOpen) await cache.quit();
    await mongoose.disconnect();
}
