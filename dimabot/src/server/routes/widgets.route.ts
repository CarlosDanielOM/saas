import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { catalog } from '../../widgets/catalog.js';
import { duelWidgetRoute } from './duel-widget.route.js';
import { WidgetError, fail, integer, text } from '../../widgets/model.js';
import { execute, requirePremium, snapshot, overlayTokenState, updateOverlayToken, authorizeOverlay, widgetEventSettings, type Action } from '../../widgets/service.js';
export const widgetsRoute = express.Router();
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
const channel = (req: Request) => text(req.params.channelID, 'channelID', 30);
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
widgetsRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
widgetsRoute.get('/:channelID/overlay', wrap(async (req, res) => {
  if (!await authorizeOverlay(channel(req), req.headers.authorization?.replace(/^Bearer /, ''))) fail('unauthorized', 'Invalid widget overlay token', 401);
  return ok(res, { state: await snapshot(channel(req)), catalog });
}));
widgetsRoute.use(authMiddleware);
// Owners and full-access channel admins may manage this module.
widgetsRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  void (async () => {
    const access = await getChannelAccessContext(req.user?.id, req.params.channelID as string, '*');
    if (!access.allowed) { res.status(403).json({ error: true, status: 403, code: 'permission_required', message: 'Channel owner or full-access admin required' }); return; }
    await requirePremium(channel(req));
    next();
  })().catch(next);
});
widgetsRoute.get('/:channelID/catalog', wrap(async (_req, res) => ok(res, catalog)));
widgetsRoute.use('/:channelID/duel', duelWidgetRoute);
widgetsRoute.get('/:channelID/events', wrap(async (req, res) => ok(res, await widgetEventSettings(channel(req)))));
widgetsRoute.get('/:channelID', wrap(async (req, res) => ok(res, await snapshot(channel(req)))));
widgetsRoute.get('/:channelID/overlay-token', wrap(async (req, res) => ok(res, await overlayTokenState(channel(req)))));
widgetsRoute.post('/:channelID/overlay-token', wrap(async (req, res) => ok(res, await updateOverlayToken(channel(req), req.body ?? {}))));
widgetsRoute.post('/:channelID/actions/:action', wrap(async (req, res) => {
  const action = text(req.params.action, 'action');
  if (!['select', 'configure', 'start', 'show', 'hide', 'reset', 'retry-poll', 'role', 'layout', 'progress', 'events'].includes(action)) fail('invalid', 'Unknown widget action');
  await execute(channel(req), action as Action, req.body ?? {}, text(req.header('Idempotency-Key'), 'Idempotency-Key', 128), integer(Number(req.header('If-Match')), 'If-Match', 0));
  return ok(res, await snapshot(channel(req)));
}));
widgetsRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = error instanceof WidgetError;
  if (!known) console.error('Widget request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(known ? error.status : 500).json({ error: true, status: known ? error.status : 500, code: known ? error.code : 'internal', message: known ? error.message : 'Widget operation failed' });
});
