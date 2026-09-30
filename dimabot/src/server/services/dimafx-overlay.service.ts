import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Server } from 'socket.io';
import { dimafxQueueHandler } from '../../handlers/dimafx_queue.handler.js';

function overlayToken(channelID: string): string {
  if (!process.env.SECRET_KEY) throw new Error('Overlay signing is unavailable');
  return createHmac('sha256', process.env.SECRET_KEY).update(`dimafx-overlay:${channelID}`).digest('hex');
}

export function authorizeDimafxOverlay(channelID: string, token: unknown): boolean {
  if (!/^\w+$/.test(channelID) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(overlayToken(channelID), 'hex'));
}

export function dimafxOverlayUrl(channelID: string): string {
  const base = (process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').replace(/\/+$/, '');
  return `${base}/overlays/dimafx/${encodeURIComponent(channelID)}?token=${overlayToken(channelID)}`;
}

export function registerDimafxOverlay(io: Server): void {
  const pattern = /^\/overlays\/dimafx\/\w+$/;
  io.on('new_namespace', child => {
    if (pattern.test(child.name)) child.adapter.persistSession = () => {};
  });
  const namespace = io.of(pattern);
  namespace.use((socket, next) => {
    try {
      const channelID = socket.nsp.name.split('/')[3];
      next(authorizeDimafxOverlay(channelID, socket.handshake.auth?.token) ? undefined : new Error('Invalid DimaFX overlay token'));
    } catch { next(new Error('DimaFX overlay authentication unavailable')); }
  });
  namespace.on('connection', socket => {
    const channelID = socket.nsp.name.split('/')[3];
    socket.data.dimafxReady = false;
    socket.on('dimafx-ready', () => { socket.data.dimafxReady = true; void poll(); });
    socket.on('dimafx-ended', (data: { triggerID?: unknown }) => {
      if (!socket.data.dimafxReady || typeof data?.triggerID !== 'string') return;
      void dimafxQueueHandler.handleTriggerEnded(channelID, data.triggerID).catch(error => console.error('DimaFX completion persistence failed', error));
    });
    let recovering = false;
    const poll = async () => {
      if (!socket.connected || !socket.data.dimafxReady) return;
      void dimafxQueueHandler.resumeIfIdle(channelID);
      if (recovering) return;
      recovering = true;
      try {
        const { recoverDimafxPurchases } = await import('../routes/dimafx.route.js');
        await recoverDimafxPurchases(channelID);
      } catch (error) { console.error('DimaFX purchase recovery failed', error); }
      finally { recovering = false; }
    };
    const timer = setInterval(() => { void poll(); }, 2_000);
    socket.on('disconnect', () => { socket.data.dimafxReady = false; clearInterval(timer); });
  });
}
