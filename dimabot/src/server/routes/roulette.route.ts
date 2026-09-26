import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { RouletteError, object, text, integer, fail } from '../../roulette/model.js';
import { execute, requirePro, snapshot, rotateToken, authorizeOverlay, overlaySnapshot, type Action } from '../../roulette/service.js';

export const rouletteRoute = express.Router();
const param = (req: Request, name: string) => text(req.params[name], name, 100);
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
const ok = (res: Response, data: unknown) => res.json({ error: false, message: 'OK', status: 200, data });
// Read-only bearer, separate from account authentication. Never accepts mutations.
rouletteRoute.get('/:channelID/overlay', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!await authorizeOverlay(param(req, 'channelID'), token)) fail('unauthorized', 'Invalid overlay token', 401);
  return ok(res, await overlaySnapshot(param(req, 'channelID')));
}));
rouletteRoute.use(authMiddleware);
// V1 management belongs to the broadcaster; no unrelated module permission grants roulette writes.
rouletteRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.user?.id !== req.params.channelID) { res.status(403).json({ error: true, message: 'Channel owner required', status: 403 }); return; }
  void requirePro(param(req, 'channelID')).then(() => next(), next);
});
rouletteRoute.get('/:channelID', wrap(async (req, res) => ok(res, await snapshot(param(req, 'channelID')))));
rouletteRoute.post('/:channelID/overlay-token', wrap(async (req, res) => ok(res, { token: await rotateToken(param(req, 'channelID')), namespace: `/overlays/roulette/${param(req, 'channelID')}` })));
async function action(req: Request, res: Response, operation: Action['operation'], data?: Record<string, unknown>) {
  const revision = req.header('If-Match');
  const expectedRevision = revision === undefined ? undefined : integer(Number(revision.replace(/^"|"$/g, '')), 'If-Match', 0);
  return ok(res, await execute(param(req, 'channelID'), { operation,
    ...(req.params.rouletteID ? { roulette: param(req, 'rouletteID') } : {}),
    ...(req.params.itemID ? { itemId: param(req, 'itemID') } : {}), ...(data ? { data } : {}),
  }, req.header('Idempotency-Key'), expectedRevision));
}
rouletteRoute.post('/:channelID/roulettes', wrap((req, res) => action(req, res, 'create', object(req.body))));
rouletteRoute.patch('/:channelID/roulettes/:rouletteID', wrap((req, res) => action(req, res, 'configure', object(req.body))));
rouletteRoute.delete('/:channelID/roulettes/:rouletteID', wrap((req, res) => action(req, res, 'delete')));
rouletteRoute.post('/:channelID/roulettes/:rouletteID/items', wrap((req, res) => action(req, res, 'add', object(req.body))));
rouletteRoute.patch('/:channelID/roulettes/:rouletteID/items/:itemID', wrap((req, res) => action(req, res, 'update', object(req.body))));
rouletteRoute.delete('/:channelID/roulettes/:rouletteID/items/:itemID', wrap((req, res) => action(req, res, 'remove')));
rouletteRoute.post('/:channelID/actions/:action', wrap((req, res) => {
  const operation = param(req, 'action');
  if (!['show', 'hide', 'start', 'switch', 'shuffle'].includes(operation)) fail('invalid', 'Unknown action');
  const body = object(req.body ?? {});
  if (Object.keys(body).some(k => k !== 'roulette')) fail('invalid', 'Unknown action field');
  if (body.roulette !== undefined) req.params.rouletteID = text(body.roulette, 'roulette');
  if (operation === 'switch' && !body.roulette) fail('invalid', 'roulette is required');
  return action(req, res, operation as Action['operation']);
}));
rouletteRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = error instanceof RouletteError;
  if (!known) console.error('Roulette request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(known ? error.status : 500).json({ error: true, status: known ? error.status : 500,
    code: known ? error.code : 'internal', message: known ? error.message : 'Roulette operation failed' });
});
