import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { GoalError } from '../../goals/model.js';
import { changeGoal, goalSnapshot } from '../../goals/service.js';

export const goalsRoute = express.Router();
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) => (req: AuthRequest, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const channel = (req: Request): string => String(req.params.channelID);
const ok = (res: Response, data: unknown) => res.json({ error: false, message: 'OK', status: 200, data });
goalsRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
goalsRoute.use(authMiddleware);
goalsRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  void (async () => {
    if (!/^\d{1,30}$/.test(channel(req))) throw new GoalError('invalid', 'Invalid channel');
    const access = await getChannelAccessContext(req.user?.id, channel(req), req.method === 'GET' ? 'dashboard:view' : '*');
    if (!access.allowed) throw new GoalError('permission_required', 'Channel permission required', 403);
    next();
  })().catch(next);
});
goalsRoute.get('/:channelID', wrap(async (req, res) => ok(res, { ...await goalSnapshot(channel(req)), canManage: (await getChannelAccessContext(req.user?.id, channel(req), '*')).allowed })));
for (const [method, path, action] of [['post', '/:channelID', 'create'], ['patch', '/:channelID/:id', 'edit'], ['delete', '/:channelID/:id', 'delete']] as const) {
  goalsRoute[method](path, wrap(async (req, res) => {
    const revision = req.header('If-Match');
    if (!revision || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new GoalError('invalid', 'If-Match revision required');
    await changeGoal(channel(req), action, req.body, Number(revision), req.params.id as string | undefined);
    return ok(res, { ...await goalSnapshot(channel(req)), canManage: true });
  }));
}
goalsRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = error instanceof GoalError;
  if (!known) console.error('Goals request failed', error instanceof Error ? error.message : 'Unknown error');
  const status = known ? error.status : 500;
  res.status(status).json({ error: true, status, code: known ? error.code : 'internal', message: known ? error.message : 'Goals request failed' });
});
