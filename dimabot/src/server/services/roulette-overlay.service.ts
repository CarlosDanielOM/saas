import { createHash } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { authorizeOverlay, overlaySnapshot, RouletteChannel } from '../../roulette/service.js';

/** Database revisions recover missed events across API/bot/cron without lossy pubsub. */
export function registerRouletteOverlay(io: Server): void {
  const pattern = /^\/overlays\/roulette\/[\w-]+$/;
  // Socket.IO recovery can skip auth and replay packets before middleware runs.
  // Roulette reconnects always authenticate afresh and receive a Mongo snapshot.
  io.on('new_namespace', child => {
    if (pattern.test(child.name)) child.adapter.persistSession = () => {};
  });
  const namespace = io.of(pattern);
  namespace.use(async (socket, next) => {
    try {
      const channelId = socket.nsp.name.split('/').at(-1)!;
      if (!await authorizeOverlay(channelId, socket.handshake.auth?.token)) return next(new Error('Invalid overlay token'));
      socket.data.rouletteTokenHash = createHash('sha256').update(socket.handshake.auth.token).digest('hex');
      next();
    } catch { next(new Error('Overlay authentication unavailable')); }
  });
  const channels = new Map<string, { sockets: Set<Socket>; timer: NodeJS.Timeout; busy: boolean }>();
  namespace.on('connection', socket => {
    const channelId = socket.nsp.name.split('/').at(-1)!;
    let group = channels.get(channelId);
    if (!group) {
      const sockets = new Set<Socket>();
      group = { sockets, busy: false, timer: setInterval(() => { void poll(); }, 500) };
      const owned = group;
      const poll = async () => {
        if (owned.busy) return; owned.busy = true;
        try {
          const version = await RouletteChannel.findById(channelId, { revision: 1, dueAt: 1, tokenHash: 1 }).lean();
          for (const client of owned.sockets) {
            if (!version || client.data.rouletteTokenHash !== version.tokenHash) { client.disconnect(true); continue; }
            if (client.data.rouletteRevision === version?.revision && !(version?.dueAt && version.dueAt <= Date.now())) continue;
            const state = await overlaySnapshot(channelId);
            if (client.connected) { client.emit('roulette-state', state); client.data.rouletteRevision = state.revision; }
          }
        } catch { for (const client of owned.sockets) client.emit('roulette-error', { code: 'unavailable', message: 'State temporarily unavailable; reconnecting automatically' }); }
        finally { owned.busy = false; }
      };
      channels.set(channelId, group);
    }
    group.sockets.add(socket);
    socket.on('disconnect', () => {
      group!.sockets.delete(socket);
      if (!group!.sockets.size) { clearInterval(group!.timer); channels.delete(channelId); }
    });
  });
  io.on('close', () => { for (const group of channels.values()) clearInterval(group.timer); channels.clear(); });
}
