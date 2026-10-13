import express, { type RequestHandler } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
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
    const access = await getChannelAccessContext(requesterID, channelID, 'analytics:view');
    if (!access.allowed) { fail(res, 403, 'Analytics access required'); return; }
    res.set('Cache-Control', 'no-store');
    res.locals.channelID = channelID;
    res.locals.canAnnotate = requesterID === channelID;
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
    const data = await getStreamTimeline(res.locals.channelID, sessionID);
    if (!data) { fail(res, 404, 'Stream unavailable'); return; }
    res.json({ error: false, data: { ...data, canAnnotate: res.locals.canAnnotate } });
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
