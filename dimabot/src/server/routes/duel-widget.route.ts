import express, { type Request, type Response, type NextFunction } from 'express';
import { configureDuel, duelSnapshot, rotateDuelToken } from '../../duel/service.js';
import { duelLeaderboard } from '../../duel/stats.js';
import { integer, text } from '../../roulette/model.js';

// Mounted inside the widget owner's authenticated Premium route boundary.
export const duelWidgetRoute = express.Router({ mergeParams: true });
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
const channel = (req: Request) => text(req.params.channelID, 'channelID', 30);
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
duelWidgetRoute.get('/', wrap(async (req, res) => ok(res, await duelSnapshot(channel(req)))));
duelWidgetRoute.get('/leaderboard', wrap(async (req, res) => ok(res, await duelLeaderboard(channel(req)))));
duelWidgetRoute.post('/configure', wrap(async (req, res) => {
  await configureDuel(channel(req), req.body, integer(Number(req.header('If-Match')), 'If-Match', 0), text(req.header('Idempotency-Key'), 'Idempotency-Key', 128));
  return ok(res, await duelSnapshot(channel(req)));
}));
duelWidgetRoute.post('/overlay-token', wrap(async (req, res) => ok(res, { token: await rotateDuelToken(channel(req)) })));
