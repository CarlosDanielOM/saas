import express, { type RequestHandler } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessDecisions } from '../../middleware/admin.middleware.js';
import UsersSchema from '../../schemas/users.schema.js';
import { StreamActivityAggregateSchema } from '../../schemas/stream_activity.schema.js';
import AiUsageReceiptSchema from '../../schemas/ai_usage_receipt.schema.js';
import { StreamMarkerSchema } from '../../schemas/stream_timeline.schema.js';
import { getStreamTimeline, getTimelineSession, listTimelineStreams, TIMELINE_RETENTION_MS } from '../../utils/stream_timeline.js';

const router = express.Router();
const objectID = /^[a-f0-9]{24}$/i;
const fail = (res: express.Response, status: number, message: string) => res.status(status).json({ error: true, status, message });
const run = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (error) { console.error('Stream timeline request failed', error); fail(res, 500, 'Unable to load stream timeline'); }
};
router.use('/streams/:channelID', authMiddleware as RequestHandler, run(async (req, res, next) => {
    const channelID = String(req.params.channelID);
    const requesterID = (req as express.Request & { user?: { id: string } }).user?.id;
    if (!requesterID) { fail(res, 401, 'Authentication required'); return; }
    if (!/^\d{1,30}$/.test(channelID)) { fail(res, 400, 'Invalid channel'); return; }
    const access = await getChannelAccessDecisions(requesterID, channelID, ['analytics:view', 'billing:view']);
    if (!access.permissions['analytics:view']) { fail(res, 403, 'Analytics access required'); return; }
    const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } })
        .select('plan_tier polar_sh_customer_id').maxTimeMS(1500).lean();
    res.set('Cache-Control', 'no-store');
    res.locals.channelID = channelID;
    res.locals.canAnnotate = requesterID === channelID;
    res.locals.tier = owner?.plan_tier === 'pro' ? 'pro' : owner?.plan_tier === 'premium' ? 'premium' : 'free';
    res.locals.canSeeCredits = access.permissions['billing:view'];
    res.locals.customerID = owner?.polar_sh_customer_id;
    next();
}));
router.get('/streams/:channelID', run(async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isInteger(page) || page < 1 || page > 1000) { fail(res, 400, 'Invalid page'); return; }
    res.json({ error: false, data: await listTimelineStreams(res.locals.channelID, page) });
}));
router.get('/streams/:channelID/:sessionID', run(async (req, res) => {
    const sessionID = String(req.params.sessionID);
    if (!objectID.test(sessionID)) { fail(res, 400, 'Invalid stream'); return; }
    const data = await getStreamTimeline(res.locals.channelID, sessionID, res.locals.tier);
    if (!data) { fail(res, 404, 'Stream unavailable'); return; }
    res.json({ error: false, data: { ...data, canAnnotate: res.locals.canAnnotate,
        canSeeCredits: res.locals.canSeeCredits && res.locals.tier === 'pro' } });
}));

router.get('/streams/:channelID/:sessionID/compare/:otherID', run(async (req, res) => {
    if (res.locals.tier === 'free') { fail(res, 403, 'Comparison requires Premium'); return; }
    const id = String(req.params.sessionID), other = String(req.params.otherID);
    if (!objectID.test(id) || !objectID.test(other)) { fail(res, 400, 'Invalid stream'); return; }
    const data = await getStreamTimeline(res.locals.channelID, other, res.locals.tier);
    if (!data || !await getTimelineSession(res.locals.channelID, id)) { fail(res, 404, 'Stream unavailable'); return; }
    res.json({ error: false, data: { ...data, canAnnotate: false } });
}));

router.get('/streams/:channelID/:sessionID/people', run(async (req, res) => {
    if (res.locals.tier !== 'pro') { fail(res, 403, 'User breakdown requires Pro'); return; }
    const id = String(req.params.sessionID), kind = String(req.query.kind || ''), key = String(req.query.key || '');
    if (!objectID.test(id) || !['command', 'emote'].includes(kind) || !key || key.length > 100) { fail(res, 400, 'Invalid breakdown'); return; }
    if (!await getTimelineSession(res.locals.channelID, id)) { fail(res, 404, 'Stream unavailable'); return; }
    let after: { count: number; id: string } | null = null;
    if (req.query.cursor) {
        try {
            if (String(req.query.cursor).length > 256) throw new Error();
            after = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString());
            if (!after || !Number.isFinite(after.count) || after.count < 0 || !/^[a-f0-9]{64}$/.test(after.id)) throw new Error();
        } catch { fail(res, 400, 'Invalid cursor'); return; }
    }
    const rows = await StreamActivityAggregateSchema.find({ channelID: res.locals.channelID, session_id: id,
        scope: 'actor', kind, key, expiresAt: { $gt: new Date() }, ...(after ? {
            $or: [{ count: { $lt: after.count } }, { count: after.count, _id: { $gt: after.id } }]
        } : {}) }).sort({ count: -1, _id: 1 }).limit(51).maxTimeMS(1500).lean();
    const last = rows[49];
    res.json({ error: false, data: { items: rows.slice(0, 50).map(row => ({ id: row.actor, label: row.label, count: row.count, errors: row.failures })),
        cursor: rows.length > 50 ? Buffer.from(JSON.stringify({ count: last.count, id: last._id })).toString('base64url') : null } });
}));

router.get('/streams/:channelID/:sessionID/moments', run(async (req, res) => {
    const id = String(req.params.sessionID);
    if (!objectID.test(id)) { fail(res, 400, 'Invalid stream'); return; }
    const session = await getTimelineSession(res.locals.channelID, id);
    if (!session) { fail(res, 404, 'Stream unavailable'); return; }
    const from = Number(req.query.from ?? 0), to = Number(req.query.to ?? ((session.ended_at?.getTime() || Date.now()) - session.started_at.getTime()) / 1000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > 90 * 86400) { fail(res, 400, 'Invalid time range'); return; }
    const kind = String(req.query.kind || 'all');
    if (!['all', 'note', 'redemption', 'follow', 'sub', 'gift', 'bits', 'raid'].includes(kind)) { fail(res, 400, 'Invalid kind'); return; }
    let after: { at: Date; id: string } | null = null;
    if (req.query.cursor) {
        const parts = String(req.query.cursor).split('|');
        if (parts.length !== 2 || !objectID.test(parts[1]) || !Number.isFinite(Date.parse(parts[0]))) { fail(res, 400, 'Invalid cursor'); return; }
        after = { at: new Date(parts[0]), id: parts[1] };
    }
    const rows = await StreamMarkerSchema.find({ channelID: res.locals.channelID, session_id: id,
        occurredAt: { $gte: new Date(session.started_at.getTime() + from * 1000), $lte: new Date(session.started_at.getTime() + to * 1000) },
        expiresAt: { $gt: new Date() }, ...(kind === 'all' ? {} : { kind }),
        ...(after ? { $or: [{ occurredAt: { $gt: after.at } }, { occurredAt: after.at, _id: { $gt: after.id } }] } : {})
    }).sort({ occurredAt: 1, _id: 1 }).limit(101).maxTimeMS(1500).lean();
    const last = rows[99];
    res.json({ error: false, data: { events: rows.slice(0, 100).map(row => ({ id: String(row._id), kind: row.kind,
        offsetSeconds: (row.occurredAt.getTime() - session.started_at.getTime()) / 1000, label: row.label,
        value: row.value, rewardID: row.rewardID, cost: row.cost, status: row.status })),
        cursor: rows.length > 100 ? `${last.occurredAt.toISOString()}|${last._id}` : null } });
}));

router.get('/streams/:channelID/:sessionID/credits', run(async (req, res) => {
    if (res.locals.tier !== 'pro' || !res.locals.canSeeCredits) { fail(res, 403, 'Pro and billing access required'); return; }
    const id = String(req.params.sessionID);
    if (!objectID.test(id)) { fail(res, 400, 'Invalid stream'); return; }
    const session = await getTimelineSession(res.locals.channelID, id);
    if (!session) { fail(res, 404, 'Stream unavailable'); return; }
    const rows = res.locals.customerID ? await AiUsageReceiptSchema.find({ channelID: res.locals.channelID,
        customerId: res.locals.customerID, occurredAt: { $gte: session.started_at, $lt: session.ended_at || new Date() },
        expiresAt: { $gt: new Date() } }).sort({ occurredAt: -1, entryId: -1 }).limit(101).maxTimeMS(1500).lean() : [];
    res.json({ error: false, data: { items: rows.slice(0, 100).map(row => ({ id: row.entryId,
        offsetSeconds: (row.occurredAt.getTime() - session.started_at.getTime()) / 1000,
        category: row.category, operation: row.operation, provider: row.provider, model: row.model,
        credits: row.credits, entryKind: row.entryKind })), truncated: rows.length > 100 } });
}));
router.put('/streams/:channelID/:sessionID/markers/:key', run(async (req, res) => {
    if (!res.locals.canAnnotate) { fail(res, 403, 'Only the channel owner can add markers'); return; }
    const sessionID = String(req.params.sessionID), key = String(req.params.key);
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const seconds = req.body?.offsetSeconds;
    if (!objectID.test(sessionID) || !/^[a-z0-9-]{16,64}$/i.test(key) || !label || label.length > 120 || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        fail(res, 400, 'Invalid marker'); return;
    }
    const session = await getTimelineSession(res.locals.channelID, sessionID);
    if (!session) { fail(res, 404, 'Stream unavailable'); return; }
    const at = new Date(session.started_at.getTime() + seconds * 1000);
    if (at > (session.ended_at || new Date())) { fail(res, 400, 'Marker must be within the stream'); return; }
    const filter = { channelID: res.locals.channelID, session_id: session._id, key: `note:${key}` };
    try {
        await StreamMarkerSchema.updateOne(filter, { $setOnInsert: { kind: 'note', label, occurredAt: at,
            expiresAt: new Date(session.started_at.getTime() + TIMELINE_RETENTION_MS) } }, { upsert: true });
    } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    res.json({ error: false, data: { saved: true } });
}));
router.delete('/streams/:channelID/:sessionID/markers/:markerID', run(async (req, res) => {
    if (!res.locals.canAnnotate) { fail(res, 403, 'Only the channel owner can remove markers'); return; }
    const sessionID = String(req.params.sessionID), markerID = String(req.params.markerID);
    if (!objectID.test(sessionID) || !objectID.test(markerID)) { fail(res, 400, 'Invalid marker'); return; }
    await StreamMarkerSchema.deleteOne({ _id: markerID, channelID: res.locals.channelID, session_id: sessionID, kind: 'note' });
    res.json({ error: false, data: { deleted: true } });
}));
export const streamTimelineRoute = router;
