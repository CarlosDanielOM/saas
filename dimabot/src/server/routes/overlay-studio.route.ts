import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { change, load, publicState, validateState, object, string, token, OverlayError, requirePro } from '../../overlays/store.js';
import { eventFor, fileFor, publishStudioAlert } from '../../overlays/live.js';
import { renderTemplate, sampleEvent } from '../../overlays/ast.js';
import { ALERT_EVENTS, type AlertEvent } from '../../overlays/model.js';
import { AssetError, withAssetLibrary } from '../../assets/library.js';
import { serveAsset } from '../../assets/http.js';
import { snapshotAssets, validateAssets } from '../../overlays/assets.js';
export const overlayStudioRoute = express.Router();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const param = (req: Request, key: string) => string(req.params[key]);
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
overlayStudioRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
overlayStudioRoute.get('/public/:publicId', wrap(async (req, res) => { const state = await publicState(param(req, 'publicId')); return ok(res, { publicId: state.publicId, revision: state.revision, snapshot: state.snapshot }); }));
overlayStudioRoute.get('/public/:publicId/assets/:assetId', wrap(async (req, res) => {
  const state = await publicState(param(req, 'publicId'));
  const id = param(req, 'assetId');
  if (!snapshotAssets(state.snapshot).some(w => w.assetId === id)) throw new OverlayError('Asset unavailable', 404);
  return serveAsset(req, res, state.channel, id);
}));
overlayStudioRoute.get('/public/:publicId/events/:eventId', wrap(async (req, res) => { const event = await eventFor(param(req, 'publicId'), param(req, 'eventId')); if (!event) throw new OverlayError('Event unavailable', 404); return ok(res, event); }));
overlayStudioRoute.get('/public/:publicId/media/:eventId', wrap(async (req, res) => { const file = await fileFor(param(req, 'publicId'), param(req, 'eventId')); if (!file) throw new OverlayError('Media unavailable', 404); res.type(file.mime); return res.sendFile(file.path); }));
overlayStudioRoute.use(authMiddleware);
overlayStudioRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  if (req.user?.id !== req.params.channelID) { res.status(403).json({ error: true, message: 'Channel owner required', status: 403 }); return; }
  void requirePro(param(req, 'channelID')).then(() => next(), next);
});
overlayStudioRoute.get('/:channelID', wrap(async (req, res) => ok(res, await load(param(req, 'channelID')))));
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
  const event = sampleEvent(kind, string(body.user || 'Luna', 80), Math.min(1000000, Math.max(0, Number(body.amount) || 0)));
  try { return ok(res, await Promise.all(body.texts.map(text => renderTemplate(typeof text === 'string' ? text : '', param(req, 'channelID'), event)))); }
  catch (e) { throw new OverlayError((e as Error).message); }
}));
overlayStudioRoute.post('/:channelID/test-alert', wrap(async (req, res) => {
  const kind = req.body.kind as AlertEvent; if (!ALERT_EVENTS.includes(kind)) throw new OverlayError('Invalid alert event');
  const count = publishStudioAlert(param(req, 'channelID'), kind, sampleEvent(kind));
  if (!count) throw new OverlayError('Open a published browser source with this alert enabled first', 409);
  return ok(res, { sent: true, clients: count });
}));
overlayStudioRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return _next(error);
  const status = error instanceof OverlayError || error instanceof AssetError ? error.status : 500;
  if (status === 500) console.error('Overlay Studio request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(status).json({ error: true, status, message: error instanceof AssetError ? 'The selected asset is unavailable or incompatible. Choose another asset.' : error instanceof OverlayError ? error.message : 'Overlay Studio is temporarily unavailable' });
});
