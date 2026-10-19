import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { StreamActivitySchema as Activity, StreamActivityAggregateSchema as Aggregate, StreamActivityStateSchema as State } from '../schemas/stream_activity.schema.js';
import { StreamSessionSchema as Sessions } from '../schemas/stream_session.schema.js';
import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';

const RETENTION = 90 * 86_400_000;
const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const bounded = (value: unknown, length = 100) => String(value || '').slice(0, length);
export type ActivityKind = 'message' | 'command' | 'redemption' | 'follow' | 'sub' | 'gift' | 'bits' | 'raid';

export function extractTimelineEmotes(message: IChatMessage['message']) {
    const rows = new Map<string, { key: string; label: string; count: number }>();
    for (const fragment of message.fragments.slice(0, 500)) {
        if (fragment.type !== 'emote' || !fragment.emote?.id) continue;
        const key = `twitch:${bounded(fragment.emote.id, 64)}`;
        const row = rows.get(key) || { key, label: bounded(fragment.text, 64), count: 0 };
        row.count++; rows.set(key, row);
    }
    return [...rows.values()];
}

export async function captureStreamActivity(input: {
    channelID: string; eventID: string; kind: ActivityKind; occurredAt?: Date;
    session?: { _id: Types.ObjectId; started_at: Date }; actor?: string; actorLabel?: string;
    key?: string; label?: string; value?: number; outcome?: string; emotes?: ReturnType<typeof extractTimelineEmotes>;
}) {
    if (!input.eventID || !input.channelID) return;
    const at = input.occurredAt || new Date();
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() - RETENTION || at.getTime() > Date.now() + 60_000) return;
    const session = input.session || await Sessions.findOne({ channelID: input.channelID, started_at: { $lte: at },
        $or: [{ ended_at: { $gt: at } }, { ended_at: null }] }).sort({ started_at: -1 }).select('_id started_at').maxTimeMS(1500).lean();
    if (!session || at < session.started_at) return;
    try {
        await Activity.updateOne({ _id: hash(input.channelID, input.kind, input.eventID) }, { $setOnInsert: {
            channelID: input.channelID, session_id: session._id, occurredAt: at,
            offset: (at.getTime() - session.started_at.getTime()) / 1000,
            kind: input.kind, actor: bounded(input.actor, 64), actorLabel: bounded(input.actorLabel, 64),
            key: bounded(input.key), label: bounded(input.label), value: Math.max(0, Number(input.value ?? 1)),
            outcome: input.outcome === 'error' ? 'error' : 'ok', emotes: input.emotes || [], processed: false,
            expiresAt: new Date(at.getTime() + RETENTION)
        } }, { upsert: true, writeConcern: { w: 1, j: true } });
    } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
}

type Inc = Record<string, number>;
// The persisted batch membership is fixed before any projection writes. After a crash,
// retrying that batch reuses its sequence, and each aggregate applies it at most once.
export async function projectStreamActivityBatch(limit = 500) {
    const owner = randomUUID(), now = new Date();
    await State.updateOne({ _id: 'projector-v1' }, { $setOnInsert: { seq: 0, leaseUntil: new Date(0) } }, { upsert: true });
    const state = await State.findOneAndUpdate({ _id: 'projector-v1', leaseUntil: { $lte: now } }, {
        $set: { owner, leaseUntil: new Date(Date.now() + 60_000) }
    }, { new: true }).lean();
    if (!state) return 0;
    let lost = false;
    const heartbeat = setInterval(() => { void State.updateOne({ _id: state._id, owner }, {
        $set: { leaseUntil: new Date(Date.now() + 60_000) }
    }).then(r => { if (!r.matchedCount) lost = true; }).catch(() => { lost = true; }); }, 10_000);
    heartbeat.unref();
    try {
        let active = state.active;
        if (!active?.ids?.length) {
            const pending = await Activity.find({ processed: false, expiresAt: { $gt: now } }).sort({ occurredAt: 1, _id: 1 })
                .limit(Math.max(1, Math.min(1000, limit))).select('_id').maxTimeMS(2000).lean();
            if (!pending.length) return 0;
            active = { seq: (state.seq || 0) + 1, ids: pending.map(row => row._id!) };
            const saved = await State.updateOne({ _id: state._id, owner }, { $set: { active, seq: active.seq } });
            if (!saved.matchedCount) throw new Error('Timeline projection lease lost');
        }
        const seq = active.seq!, ids = active.ids!;
        const rows = await Activity.find({ _id: { $in: ids } }).lean();
        const changes = new Map<string, { base: Record<string, unknown>; inc: Inc; firstAt: Date; messageAt?: Date; expiresAt: Date }>();
        function add(row: (typeof rows)[number], scope: string, kind: string, key: string, actor: string, bucket: number, inc: Inc, label = '') {
            const id = hash(row.channelID, String(row.session_id), scope, kind, key, actor, bucket);
            const item: { base: Record<string, unknown>; inc: Inc; firstAt: Date; messageAt?: Date; expiresAt: Date } = changes.get(id) || { base: { channelID: row.channelID, session_id: row.session_id, scope, kind, key, actor, bucket, label }, inc: {}, firstAt: row.occurredAt!, expiresAt: row.expiresAt! };
            for (const [name, value] of Object.entries(inc)) item.inc[name] = (item.inc[name] || 0) + value;
            if (row.occurredAt! < item.firstAt) item.firstAt = row.occurredAt!;
            if (row.kind === 'message' && (!item.messageAt || row.occurredAt! < item.messageAt)) item.messageAt = row.occurredAt!;
            if (row.expiresAt! > item.expiresAt) item.expiresAt = row.expiresAt!;
            changes.set(id, item);
        }
        // Distinct chatter receipts are bounded scalar records, never an array in a session document.
        const distinct = new Map<string, { row: (typeof rows)[number]; bucket: number }>();
        for (const row of rows) if (row.kind === 'message' && row.actor && row.actor !== '698614112') {
            const bucket = Math.floor((row.offset || 0) / 300);
            distinct.set(hash(row.channelID, String(row.session_id), 'distinct', row.actor, bucket), { row, bucket });
        }
        if (distinct.size) {
            await Aggregate.bulkWrite([...distinct].map(([id, { row, bucket }]) => ({ updateOne: { filter: { _id: id }, update: { $setOnInsert: {
                channelID: row.channelID, session_id: row.session_id, scope: 'distinct', kind: 'message', actor: row.actor,
                key: '', bucket, firstSeq: seq, expiresAt: row.expiresAt
            } }, upsert: true } })), { ordered: true });
            const inserted = await Aggregate.find({ _id: { $in: [...distinct.keys()] }, firstSeq: seq }).select('_id').lean();
            for (const doc of inserted) { const item = distinct.get(doc._id!)!; add(item.row, 'chart', '', '', '', item.bucket, { chatters: 1 }); }
        }
        for (const row of rows) {
            const bucket = Math.floor((row.offset || 0) / 300), quantity = row.value ?? 1;
            const metric: Inc = {};
            if (row.kind === 'message') {
                metric.messages = 1;
                metric.emotes = row.emotes.reduce((sum, emote) => sum + (emote.count || 0), 0);
                metric.emoteMessages = row.emotes.length ? 1 : 0;
                for (const emote of row.emotes) {
                    add(row, 'rank', 'emote', emote.key || '', '', -1, { count: emote.count || 0, messages: 1 }, emote.label || '');
                    if (row.actor) add(row, 'actor', 'emote', emote.key || '', row.actor, -1, { count: emote.count || 0, messages: 1 }, row.actorLabel || row.actor);
                }
            } else if (row.kind === 'command') {
                metric.commands = 1;
                add(row, 'rank', 'command', row.key || '', '', -1, { count: 1, failures: row.outcome === 'error' ? 1 : 0 }, row.label || row.key || '');
                if (row.actor) add(row, 'actor', 'command', row.key || '', row.actor, -1, { count: 1, failures: row.outcome === 'error' ? 1 : 0 }, row.actorLabel || row.actor);
            } else {
                const name = { redemption: 'redemptions', follow: 'follows', sub: 'subs', gift: 'subs', bits: 'bits', raid: 'raids' }[row.kind!];
                if (name) metric[name] = row.kind === 'raid' ? 1 : quantity;
            }
            add(row, 'chart', '', '', '', bucket, metric);
            add(row, 'summary', '', '', '', -1, metric);
        }
        if (lost) throw new Error('Timeline projection lease lost');
        const operations = [...changes].map(([id, item]) => ({ updateOne: {
            filter: { _id: id, $or: [{ lastSeq: { $lt: seq } }, { lastSeq: { $exists: false } }] },
            update: { $setOnInsert: item.base, $inc: item.inc, $set: { lastSeq: seq, updatedAt: new Date() },
                $min: { firstAt: item.firstAt, ...(item.messageAt ? { messageStartedAt: item.messageAt } : {}) }, $max: { expiresAt: item.expiresAt } }, upsert: true
        } }));
        if (operations.length) {
            try { await Aggregate.bulkWrite(operations, { ordered: false }); }
            catch (error) {
                const failures = (error as { writeErrors?: { code: number }[] }).writeErrors;
                if (!failures?.length || failures.some(failure => failure.code !== 11000)) throw error;
                // Duplicate-key here means this deterministic aggregate already has this/newer batch.
            }
        }
        await Activity.updateMany({ _id: { $in: ids } }, { $set: { processed: true } });
        const completed = await State.updateOne({ _id: state._id, owner }, { $unset: { active: '' }, $set: { updatedAt: new Date() } });
        if (!completed.matchedCount) throw new Error('Timeline projection lease lost');
        return rows.length;
    } finally {
        clearInterval(heartbeat);
        await State.updateOne({ _id: state._id, owner }, { $set: { leaseUntil: new Date(0) } });
    }
}

export async function getStreamActivity(channelID: string, sessionID: Types.ObjectId, tier: string) {
    const scope = { channelID, session_id: sessionID, expiresAt: { $gt: new Date() } };
    const [summary, commands, emotes, series, pending] = await Promise.all([
        Aggregate.findOne({ ...scope, scope: 'summary' }).maxTimeMS(1500).lean(),
        Aggregate.find({ ...scope, scope: 'rank', kind: 'command' }).sort({ count: -1, _id: 1 }).limit(20).maxTimeMS(1500).lean(),
        Aggregate.find({ ...scope, scope: 'rank', kind: 'emote' }).sort({ count: -1, _id: 1 }).limit(20).maxTimeMS(1500).lean(),
        Aggregate.find({ ...scope, scope: 'chart', bucket: { $gte: 0 } }).sort({ bucket: 1 }).limit(2001).maxTimeMS(1500).lean(),
        Activity.exists({ ...scope, processed: false }).maxTimeMS(1500)
    ]);
    const totals = summary ? { messages: summary.messages, commands: summary.commands, emotes: summary.emotes,
        emoteMessages: summary.emoteMessages, redemptions: summary.redemptions, follows: summary.follows,
        subs: summary.subs, bits: summary.bits, raids: summary.raids } : null;
    return { totals, commands: commands.map(row => ({ key: row.key, label: row.label, count: row.count, errors: tier === 'free' ? undefined : row.failures })),
        emotes: emotes.map(row => ({ key: row.key, label: row.label, count: row.count, messages: row.messages })),
        series: series.slice(0, 2000).map(row => ({ offsetSeconds: row.bucket! * 300,
            commands: tier === 'free' ? undefined : row.commands, emotes: tier === 'free' ? undefined : row.emotes,
            messages: row.messages, chatters: row.chatters })),
        coverageStartedAt: summary?.firstAt || null, chatterStartedAt: summary?.messageStartedAt || null, updatedAt: summary?.updatedAt || null,
        pending: Boolean(pending), truncated: series.length > 2000, planTier: tier,
        capabilities: { trends: tier !== 'free', comparison: tier !== 'free', users: tier === 'pro' } };
}
