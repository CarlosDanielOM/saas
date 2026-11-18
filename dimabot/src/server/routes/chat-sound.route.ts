import express, { type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { getChannelAccessContext } from '../../middleware/admin.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { ChatSoundError, fail } from '../../chat_sound/model.js';
import { channelId, configureChatSound, overlayTokenState, readChatSound, requireRegisteredChannel, updateOverlayToken } from '../../chat_sound/service.js';
import { chatSoundStatus, refreshChatSound, sendChatSoundTest } from '../services/chat-sound-overlay.service.js';

/** Chat sound settings and its OBS link. Free on every plan; owners and full-access channel admins manage it. */
export const chatSoundRoute = express.Router();
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
const channel = (req: Request) => channelId(req.params.channelID);
const ok = (res: Response, data: unknown) => res.json({ error: false, status: 200, message: 'OK', data });
async function snapshot(id: string) {
  return { ...await readChatSound(id), status: chatSoundStatus(id) };
}
chatSoundRoute.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
chatSoundRoute.use(authMiddleware);
chatSoundRoute.use('/:channelID', (req: AuthRequest, res, next) => {
  void (async () => {
    const access = await getChannelAccessContext(req.user?.id, req.params.channelID as string, '*');
    if (!access.allowed) { res.status(403).json({ error: true, status: 403, code: 'permission_required', message: 'Channel owner or full-access admin required' }); return; }
    next();
  })().catch(next);
});
chatSoundRoute.get('/:channelID', wrap(async (req, res) => ok(res, await snapshot(channel(req)))));
chatSoundRoute.put('/:channelID/settings', wrap(async (req, res) => {
  const header = req.header('If-Match');
  if (!header || !/^\d{1,15}$/.test(header)) fail('invalid', 'If-Match must be the settings revision');
  await requireRegisteredChannel(channel(req));
  await configureChatSound(channel(req), req.body, Number(header));
  await refreshChatSound(channel(req));
  return ok(res, await snapshot(channel(req)));
}));
chatSoundRoute.get('/:channelID/overlay-token', wrap(async (req, res) => ok(res, await overlayTokenState(channel(req)))));
chatSoundRoute.post('/:channelID/overlay-token', wrap(async (req, res) => {
  await requireRegisteredChannel(channel(req));
  const state = await updateOverlayToken(channel(req), req.body ?? {});
  await refreshChatSound(channel(req)); // a replaced link drops the old sources now
  return ok(res, state);
}));
/** One pop on the channel's open sources (draft volume allowed), so the streamer can hear it in OBS before saving. */
chatSoundRoute.post('/:channelID/test', wrap(async (req, res) => {
  const id = channel(req), volume = (req.body ?? {}).volume;
  if (volume !== undefined && !(typeof volume === 'number' && Number.isInteger(volume) && volume >= 0 && volume <= 100)) fail('invalid', 'volume must be a whole number from 0 to 100');
  return ok(res, { sent: sendChatSoundTest(id, volume), status: chatSoundStatus(id) });
}));
chatSoundRoute.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = error instanceof ChatSoundError;
  if (!known) console.error('Chat sound request failed', error instanceof Error ? error.message : 'Unknown error');
  res.status(known ? error.status : 500).json({ error: true, status: known ? error.status : 500, code: known ? error.code : 'internal', message: known ? error.message : 'Chat sound request failed' });
});
