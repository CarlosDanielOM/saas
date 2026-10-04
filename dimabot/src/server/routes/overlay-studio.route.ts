import { prepareTest, previewMedia, testFile, withTestLock } from '../../overlays/test-playback.js';
import { recoverCopies } from '../../overlays/recover.js';
import { pipeline } from 'node:stream/promises';
import { readFileStream } from '../../overlays/delivery-store.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { change, load, publicState, validateState, object, string, token, OverlayError, requireOverlayAccount } from '../../overlays/store.js';
import { eventFor, fileFor, publishStudioAlert, publishTest, studioConnections, queueStatus, controlStudio } from '../../overlays/live.js';
import { renderTemplate, sampleEvent } from '../../overlays/ast.js';
import { ALERT_EVENTS, EVENT_KINDS, type EventKind, type AlertEvent } from '../../overlays/model.js';
import { AssetError, withAssetLibrary } from '../../assets/library.js';
import { serveAsset } from '../../assets/http.js';
import { snapshotAssets, validateAssets } from '../../overlays/assets.js';
export const overlayStudioRoute = express.Router();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const param = (req: Request, key: string) => string(req.params[key]);
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
overlayStudioRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
overlayStudioRoute.get('/public/:publicId', wrap(async (req, res) => { const state = await publicState(param(req, 'publicId')); return ok(res, { publicId: state.publicId, revision: state.revision, snapshot: state.snapshot, controls: state.controls }); }));
overlayStudioRoute.get('/public/:publicId/assets/:assetId', wrap(async (req, res) => {
  const state = await publicState(param(req, 'publicId'));
  const id = param(req, 'assetId');
  if (!snapshotAssets(state.snapshot).some(w => w.assetId === id)) throw new OverlayError('Asset unavailable', 404);
  return serveAsset(req, res, state.channel, id);
}));
overlayStudioRoute.get('/public/:publicId/events/:eventId', wrap(async (req, res) => { const event = await eventFor(param(req, 'publicId'), param(req, 'eventId')); if (!event) throw new OverlayError('Event unavailable', 404); return ok(res, event); }));
overlayStudioRoute.get('/public/:publicId/media/:eventId', wrap(async (req, res) => { const file = await fileFor(param(req, 'publicId'), param(req, 'eventId')); if (!file) throw new OverlayError('Media unavailable', 404); res.type(file.mime); res.setHeader('Accept-Ranges', 'bytes');
  let start = 0, end = file.bytes - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || !match[1] && !match[2]) { res.setHeader('Content-Range', `bytes */${file.bytes}`); return res.sendStatus(416); }
    start = match[1] ? Number(match[1]) : Math.max(0, file.bytes - Number(match[2]));
    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.bytes) { res.setHeader('Content-Range', `bytes */${file.bytes}`); return res.sendStatus(416); }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${file.bytes}`);
  }
  res.setHeader('Content-Length', end - start + 1);
  return pipeline(await readFileStream(file.mediaId, start, end + 1), res); }));
overlayStudioRoute.get('/test-media/:ticket', wrap(async (req, res) => {
  const file = testFile(param(req, 'ticket')); if (!file) throw new OverlayError('Test expired. Run the preview again.', 404);
  res.type(file.mime); return res.sendFile(file.path);
}));
overlayStudioRoute.use(authMiddleware);
overlayStudioRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  if (req.user?.id !== req.params.channelID) { res.status(403).json({ error: true, message: 'Channel owner required', status: 403 }); return; }
  void requireOverlayAccount(param(req, 'channelID')).then(() => next(), next);
});
overlayStudioRoute.get('/:channelID', wrap(async (req, res) => ok(res, await load(param(req, 'channelID')))));
overlayStudioRoute.post('/:channelID/recover', wrap(async (req, res) => ok(res, await recoverCopies(param(req, 'channelID'), req.body))));
overlayStudioRoute.get('/:channelID/queue', wrap(async (req, res) => ok(res, await queueStatus(param(req, 'channelID')))));
overlayStudioRoute.post('/:channelID/queue', wrap(async (req, res) => ok(res, await controlStudio(param(req, 'channelID'), req.body?.action, req.body?.platform))));
overlayStudioRoute.get('/:channelID/connections', wrap(async (req, res) => {
  const channel = param(req, 'channelID'), state = await load(channel);
  return ok(res, studioConnections(channel, state.scenes));
}));
overlayStudioRoute.put('/:channelID', wrap(async (req, res) => ok(res, await withAssetLibrary(param(req, 'channelID'), () => change(param(req, 'channelID'), req.body.revision, async state => {
  const validated = validateState(req.body, state);
  await validateAssets(param(req, 'channelID'), validated);
  Object.assign(state, validated);
})))));
overlayStudioRoute.post('/:channelID/scenes/:sceneId/:action', wrap(async (req, res) => {
  const action = param(req, 'action'); if (!['publish', 'rotate'].includes(action)) throw new OverlayError('Unknown action');
  return ok(res, await withAssetLibrary(param(req, 'channelID'), () => change(param(req, 'channelID'), req.body.revision, async state => {
    const scene = state.scenes.find(s => s.id === param(req, 'sceneId')); if (!scene) throw new OverlayError('Overlay not found', 404);
    if (action === 'rotate') scene.publicId = token();
    else { await validateAssets(param(req, 'channelID'), state); scene.revision++; scene.published = structuredClone({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor, designs: state.designs.filter(d => scene.widgets.some(w => w.designId === d.id)) }); }
  })));
}));
overlayStudioRoute.post('/:channelID/preview', wrap(async (req, res) => {
  const body = object(req.body); const kind = body.kind as AlertEvent; if (!ALERT_EVENTS.includes(kind)) throw new OverlayError('Invalid alert event');
  if (!Array.isArray(body.texts) || body.texts.length > 100) throw new OverlayError('Invalid templates');
  const event = sampleEvent(kind, string(body.user || 'Luna', 80), Math.min(1000000000, Math.max(0, Number(body.amount) || 0)), ['1000', '2000', '3000'].includes(body.tier as string) ? body.tier as string : '1000');
  try { return ok(res, await Promise.all(body.texts.map(text => renderTemplate(typeof text === 'string' ? text : '', param(req, 'channelID'), event)))); }
  catch (e) { throw new OverlayError((e as Error).message); }
}));
overlayStudioRoute.post('/:channelID/test', wrap(async (req, res) => {
  const channel = param(req, 'channelID'), body = object(req.body), kind = body.kind as EventKind;
  if (!EVENT_KINDS.includes(kind) || !['preview', 'obs'].includes(String(body.destination))) throw new OverlayError('Invalid overlay test');
  const state = await load(channel), scene = state.scenes.find(s => s.id === body.sceneId);
  if (body.destination === 'obs') {
    if (!scene?.published) throw new OverlayError('Publish this overlay before testing', 409);
    if (body.confirmed !== true) throw new OverlayError('Confirm playback on this overlay first');
    const snapshot = scene.published;
    if (!snapshot.widgets.some(w => w.visible && (w.kind === kind || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)))) throw new OverlayError('This overlay does not receive that event', 409);
    if (kind === 'trigger') {
      const widgets = snapshot.widgets.filter(w => w.visible && w.kind === 'trigger');
      body.triggerIds = widgets.some(w => w.triggerIds === undefined) ? undefined : [...new Set(widgets.flatMap(w => w.triggerIds ?? []))];
    }
  }
  return withTestLock(channel, async () => {
    const prepared = await prepareTest(channel, kind, body);
    try {
      if (body.destination === 'obs') {
        const clients = await publishTest(channel, scene!.publicId, kind, prepared, ALERT_EVENTS.includes(kind as AlertEvent) ? sampleEvent(kind as AlertEvent) : undefined);
        await prepared.cleanup(); return ok(res, { sent: true, clients, sceneId: scene!.id });
      }
      return ok(res, { media: await previewMedia(channel, prepared), triggerId: prepared.triggerId, text: prepared.text });
    } catch (error) { await prepared.cleanup(); throw error; }
  });
}));
overlayStudioRoute.post('/:channelID/test-alert', wrap(async (req, res) => {
  const kind = req.body.kind as AlertEvent; if (!ALERT_EVENTS.includes(kind)) throw new OverlayError('Invalid alert event');
  const count = await publishStudioAlert(param(req, 'channelID'), kind, sampleEvent(kind), undefined, undefined, 'other');
  if (!count) throw new OverlayError('Open a published browser source with this alert enabled first', 409);
  return ok(res, { sent: true, clients: count });
}));
overlayStudioRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return _next(error);
  const status = error instanceof OverlayError || error instanceof AssetError ? error.status : 500;
  if (status === 500) console.error('Overlay Studio request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(status).json({ error: true, status, message: error instanceof AssetError ? 'The selected asset is unavailable or incompatible. Choose another asset.' : error instanceof OverlayError ? error.message : 'Overlay Studio is temporarily unavailable' });
});
