import { activateInteraction, interactionReadiness } from '../../overlays/interaction-subscriptions.js';
import { publicWidgetStateFor } from '../../overlays/live.js';
import { prepareTest, previewMedia, testFile, withTestLock } from '../../overlays/test-playback.js';
import { recoverCopies } from '../../overlays/recover.js';
import { pipeline } from 'node:stream/promises';
import { readFileStream } from '../../overlays/delivery-store.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { change, load, publicState, validateState, object, string, token, OverlayError, requireOverlayAccount } from '../../overlays/store.js';
import { bitsRuleFor, ensureWidgetModeration, eventFor, feedSignal, feedTestAlert, feedTestEvent, fileFor, publishStudioAlert, publishTest, studioConnections, queueStatus, controlStudio } from '../../overlays/live.js';
import { renderTemplate, sampleEvent } from '../../overlays/ast.js';
import { ALERT_EVENTS, EVENT_KINDS, type EventKind, type AlertEvent } from '../../overlays/model.js';
import { AssetError, withAssetLibrary } from '../../assets/library.js';
import { serveAsset } from '../../assets/http.js';
import { snapshotAssets, validateAssets } from '../../overlays/assets.js';
import { copyMedia, planMediaCopy } from '../../custom_widgets/media.js';
import { sessionFor } from '../../custom_widgets/session.js';
import { commandCount, storeGet } from '../../custom_widgets/widget-store.js';
import { channelInfo, checkCustomLayers, createWidget, deleteWidget, listWidgets, publishedBundle, publishedLayers, publishedMediaAsset, widgetBundle, pinCustomLayers, pruneRevisions, renameWidget, replaceFiles, widgetFile } from '../../custom_widgets/store.js';
import { buildSignal, signalError, skippedSignals, widgetSignals } from '../../widget_feed/signals.js';
export const overlayStudioRoute = express.Router();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const param = (req: Request, key: string) => string(req.params[key]);
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
overlayStudioRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
overlayStudioRoute.get('/public/:publicId', wrap(async (req, res) => { const state = await publicState(param(req, 'publicId')); return ok(res, { publicId: state.publicId, revision: state.revision, snapshot: state.snapshot, controls: state.controls, ...await publicWidgetStateFor(state) }); }));
overlayStudioRoute.get('/public/:publicId/assets/:assetId', wrap(async (req, res) => {
  const state = await publicState(param(req, 'publicId'));
  const id = param(req, 'assetId');
  if (!snapshotAssets(state.snapshot).some(w => w.assetId === id) && !await publishedMediaAsset(state.channel, state.snapshot.widgets, id)) throw new OverlayError('Asset unavailable', 404);
  return serveAsset(req, res, state.channel, id, true);
}));
// Code of a custom widget revision pinned by this published overlay (OBS runtime).
overlayStudioRoute.get('/public/:publicId/custom-widgets/:widgetId/:revision', wrap(async (req, res) => {
  const state = await publicState(param(req, 'publicId')), revision = Number(req.params.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new OverlayError('Widget unavailable', 404);
  return ok(res, await publishedBundle(state.channel, state.snapshot.widgets, param(req, 'widgetId'), revision));
}));
overlayStudioRoute.get('/public/:publicId/events/:eventId', wrap(async (req, res) => { const event = await eventFor(param(req, 'publicId'), param(req, 'eventId'), req.query.clientId, req.query.socketId); if (!event) throw new OverlayError('Event unavailable', 404); return ok(res, event); }));
overlayStudioRoute.get('/public/:publicId/media/:eventId', wrap(async (req, res) => { const file = await fileFor(param(req, 'publicId'), param(req, 'eventId'), req.query.clientId, req.query.socketId); if (!file) throw new OverlayError('Media unavailable', 404); res.type(file.mime); res.setHeader('Accept-Ranges', 'bytes');
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
/** Tests use the editor's sample viewer, amount and tier so each Bits rule can be tried in OBS. */
function testEvent(kind: AlertEvent, body: Record<string, unknown>) {
  const user = typeof body.user === 'string' && body.user.trim() ? body.user.trim().slice(0, 80) : 'Luna';
  const amount = Number(body.amount), tier = ['1000', '2000', '3000'].includes(body.tier as string) ? body.tier as string : '1000';
  return sampleEvent(kind, user, Number.isSafeInteger(amount) && amount > 0 ? Math.min(1000000000, amount) : 100, tier);
}
async function requireAlertPlays(channel: string, kind: EventKind, raw?: Record<string, unknown>) {
  const rule = await bitsRuleFor(channel, kind, raw);
  if (rule?.alert === false) throw new OverlayError(`No alert plays for ${raw?.bits} Bits: the "${rule.name || 'matching'}" Bits rule has alerts turned off`, 409);
}
overlayStudioRoute.use(authMiddleware);
overlayStudioRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  if (req.user?.id !== req.params.channelID) { res.status(403).json({ error: true, message: 'Channel owner required', status: 403 }); return; }
  void requireOverlayAccount(param(req, 'channelID')).then(() => next(), next);
});
overlayStudioRoute.get('/:channelID', wrap(async (req, res) => ok(res, await load(param(req, 'channelID')))));
overlayStudioRoute.get('/:channelID/twitch-events', wrap(async (req, res) => ok(res, await interactionReadiness(param(req, 'channelID')))));
overlayStudioRoute.post('/:channelID/twitch-events/:kind', wrap(async (req, res) => {
  const kind = param(req, 'kind'); if (kind !== 'poll' && kind !== 'prediction') throw new OverlayError('Invalid Twitch widget');
  return ok(res, await activateInteraction(param(req, 'channelID'), kind));
}));
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
  await checkCustomLayers(param(req, 'channelID'), validated.scenes);
  Object.assign(state, validated);
})))));
overlayStudioRoute.post('/:channelID/scenes/:sceneId/:action', wrap(async (req, res) => {
  const action = param(req, 'action'); if (!['publish', 'rotate'].includes(action)) throw new OverlayError('Unknown action');
  const channel = param(req, 'channelID');
  const result = await withAssetLibrary(channel, () => change(channel, req.body.revision, async state => {
    const scene = state.scenes.find(s => s.id === param(req, 'sceneId')); if (!scene) throw new OverlayError('Overlay not found', 404);
    if (action === 'rotate') scene.publicId = token();
    else {
      await validateAssets(channel, state);
      const published = structuredClone({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor, designs: state.designs.filter(d => scene.widgets.some(w => w.designId === d.id)) });
      await pinCustomLayers(channel, published.widgets);
      scene.revision++; scene.published = published;
    }
  }));
  // Old custom widget revisions are kept only while a published overlay uses them.
  if (action === 'publish') {
    await withAssetLibrary(channel, () => pruneRevisions(channel)).catch(error => console.error('Custom widget cleanup failed', error instanceof Error ? error.message : 'Unknown error'));
    // Chat widgets need Twitch message-delete events; activation runs outside the publish lock.
    const published = result.scenes.find(s => s.id === param(req, 'sceneId'))?.published;
    if (published) void publishedLayers(channel, published.widgets).then(layers => { if ([...layers.values()].some(layer => layer.uses.has('chat'))) ensureWidgetModeration(channel, true); }).catch(() => {});
  }
  return ok(res, result);
}));
// Custom widgets (owner only, through the channel guard above). Code changes never reach OBS until a publish.
overlayStudioRoute.get('/:channelID/custom-widgets', wrap(async (req, res) => ok(res, await listWidgets(param(req, 'channelID')))));
overlayStudioRoute.post('/:channelID/custom-widgets', wrap(async (req, res) => { res.status(201); return ok(res, await createWidget(param(req, 'channelID'), object(req.body))); }));
overlayStudioRoute.put('/:channelID/custom-widgets/:widgetId/files', wrap(async (req, res) => ok(res, await replaceFiles(param(req, 'channelID'), param(req, 'widgetId'), object(req.body)))));
overlayStudioRoute.patch('/:channelID/custom-widgets/:widgetId', wrap(async (req, res) => ok(res, await renameWidget(param(req, 'channelID'), param(req, 'widgetId'), object(req.body)))));
overlayStudioRoute.delete('/:channelID/custom-widgets/:widgetId', wrap(async (req, res) => ok(res, await deleteWidget(param(req, 'channelID'), param(req, 'widgetId')))));
overlayStudioRoute.get('/:channelID/custom-widgets/store/:namespace/:key', wrap(async (req, res) => ok(res, { value: await storeGet(param(req, 'channelID'), param(req, 'namespace'), req.params.key) })));
overlayStudioRoute.get('/:channelID/custom-widgets/counters/:name', wrap(async (req, res) => ok(res, { value: await commandCount(param(req, 'channelID'), req.params.name) })));
overlayStudioRoute.get('/:channelID/custom-widgets/signals', wrap(async (req, res) => ok(res, { skipped: await skippedSignals(param(req, 'channelID')) })));
overlayStudioRoute.get('/:channelID/custom-widgets/session', wrap(async (req, res) => ok(res, await sessionFor(param(req, 'channelID')))));
overlayStudioRoute.get('/:channelID/custom-widgets/:widgetId/media', wrap(async (req, res) => ok(res, await planMediaCopy(param(req, 'channelID'), param(req, 'widgetId')))));
overlayStudioRoute.post('/:channelID/custom-widgets/:widgetId/media', wrap(async (req, res) => ok(res, await copyMedia(param(req, 'channelID'), param(req, 'widgetId'), object(req.body).urls))));
/** Custom widget tests sent to one published overlay in OBS (Studio's "Send to OBS"). */
overlayStudioRoute.post('/:channelID/widget-test', wrap(async (req, res) => {
  const channel = param(req, 'channelID'), body = object(req.body), state = await load(channel);
  const scene = state.scenes.find(s => s.id === body.sceneId);
  if (!scene?.published) throw new OverlayError('Publish this overlay before testing', 409);
  if (!['chat', 'chat.delete', 'chat.clear', 'alert', 'signal'].includes(String(body.type)) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data) || JSON.stringify(body.data).length > 16_000) throw new OverlayError('Invalid widget test');
  if (body.type === 'signal') {
    // Studio test signals: stamped here (source, sender, time) and counted against the channel's signal limit.
    const input = body.data as { name?: unknown; value?: unknown; target?: unknown };
    const name = String(input.name ?? '').trim().toLowerCase(), value = String(input.value ?? '').trim(), target = typeof input.target === 'string' && input.target.trim() ? input.target.trim() : null;
    const invalid = signalError(name, value, target);
    if (invalid) throw new OverlayError(invalid === 'invalid_widget_signal_name' ? 'Signal names use letters, digits and _ (up to 40)' : 'Invalid signal');
    if (!await widgetSignals.admit(channel)) throw new OverlayError('Too many signals for this channel right now; try again in a few seconds', 429);
    const owner = await channelInfo(channel);
    const signal = buildSignal({ name, value, target, source: { kind: 'studio', name: 'Studio test' },
      user: { id: channel, login: owner.login, name: owner.name, roles: { broadcaster: true, moderator: false, vip: false, subscriber: false } } });
    const sent = feedSignal(channel, signal, peer => peer.publicId === scene.publicId);
    if (!sent) throw new OverlayError('Open this published overlay in OBS first. Only widgets that use signals (with that layer name) receive it.', 409);
    return ok(res, { sent: true, clients: sent });
  }
  const data = body.type === 'alert' ? { ...(body.data as Record<string, unknown>), test: true } : body.data;
  const sent = feedTestEvent(channel, scene.publicId, String(body.type), data);
  if (!sent) throw new OverlayError('Open this published overlay in OBS first. Only widgets that use this data receive it.', 409);
  return ok(res, { sent: true, clients: sent });
}));
overlayStudioRoute.get('/:channelID/custom-widgets/:widgetId/bundle', wrap(async (req, res) => ok(res, await widgetBundle(param(req, 'channelID'), param(req, 'widgetId'), req.query.revision))));
overlayStudioRoute.get('/:channelID/custom-widgets/:widgetId/files/:file', wrap(async (req, res) => {
  const text = await widgetFile(param(req, 'channelID'), param(req, 'widgetId'), param(req, 'file'), req.query.revision);
  res.type('text/plain; charset=utf-8'); res.setHeader('X-Content-Type-Options', 'nosniff'); return res.send(text);
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
    const customAlert = ALERT_EVENTS.includes(kind as AlertEvent) && snapshot.widgets.some(w => w.visible && w.kind === 'custom');
    if (!customAlert && !snapshot.widgets.some(w => w.visible && (w.kind === kind || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)))) throw new OverlayError('This overlay does not receive that event', 409);
    if (kind === 'trigger') {
      const widgets = snapshot.widgets.filter(w => w.visible && w.kind === 'trigger');
      body.triggerIds = widgets.some(w => w.triggerIds === undefined) ? undefined : [...new Set(widgets.flatMap(w => w.triggerIds ?? []))];
    }
  }
  return withTestLock(channel, async () => {
    const prepared = await prepareTest(channel, kind, body);
    try {
      if (body.destination === 'obs') {
        const raw = ALERT_EVENTS.includes(kind as AlertEvent) ? testEvent(kind as AlertEvent, body) : undefined;
        await requireAlertPlays(channel, kind, raw);
        // Custom widgets that use alerts get the same test; scenes with only custom widgets skip the alert queue.
        if (raw) await feedTestAlert(channel, scene!.publicId, kind as AlertEvent, raw);
        const alertWidgets = scene!.published!.widgets.some(w => w.visible && (w.kind === kind || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)));
        if (raw && !alertWidgets) { await prepared.cleanup(); return ok(res, { sent: true, clients: 0, sceneId: scene!.id }); }
        const clients = await publishTest(channel, scene!.publicId, kind, prepared, raw);
        await prepared.cleanup(); return ok(res, { sent: true, clients, sceneId: scene!.id });
      }
      return ok(res, { media: await previewMedia(channel, prepared), triggerId: prepared.triggerId, text: prepared.text });
    } catch (error) { await prepared.cleanup(); throw error; }
  });
}));
overlayStudioRoute.post('/:channelID/test-alert', wrap(async (req, res) => {
  const kind = req.body.kind as AlertEvent; if (!ALERT_EVENTS.includes(kind)) throw new OverlayError('Invalid alert event');
  const raw = testEvent(kind, object(req.body));
  await requireAlertPlays(param(req, 'channelID'), kind, raw);
  const count = await publishStudioAlert(param(req, 'channelID'), kind, raw, undefined, undefined, 'other');
  if (!count) throw new OverlayError('Open a published browser source with this alert enabled first', 409);
  return ok(res, { sent: true, clients: count });
}));
overlayStudioRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return _next(error);
  const status = error instanceof OverlayError || error instanceof AssetError ? error.status : 500;
  if (status === 500) console.error('Overlay Studio request failed', error instanceof Error ? error.message : 'Unknown error');
  const code = error instanceof OverlayError ? (error as OverlayError & { code?: string }).code : undefined;
  res.status(status).json({ error: true, status, message: error instanceof AssetError ? 'The selected asset is unavailable or incompatible. Choose another asset.' : error instanceof OverlayError ? error.message : 'Overlay Studio is temporarily unavailable', ...(code ? { code } : {}) });
});
