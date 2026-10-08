import { createHash } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { authorizeOverlay, hasPro, snapshot, WidgetChannel } from '../../widgets/service.js';
import { catalog } from '../../widgets/catalog.js';

/** Database revisions recover missed events across API/bot/cron without lossy pubsub. */
export function registerWidgetOverlay(io: Server): void {
  const pattern = /^\/overlays\/widgets\/[\w-]+$/;
  // Socket.IO recovery can skip auth and replay packets before middleware runs.
  // Widget reconnects always authenticate afresh and receive a Mongo snapshot.
  io.on('new_namespace', child => {
    if (pattern.test(child.name)) child.adapter.persistSession = () => {};
  });
  const namespace = io.of(pattern);
  namespace.use(async (socket, next) => {
    try {
      const channelId = socket.nsp.name.split('/').at(-1)!;
      if (!await authorizeOverlay(channelId, socket.handshake.auth?.token)) return next(new Error('Invalid overlay token'));
      socket.data.widgetsTokenHash = createHash('sha256').update(socket.handshake.auth.token).digest('hex');
      next();
    } catch { next(new Error('Overlay authentication unavailable')); }
  });
  const channels = new Map<string, { sockets: Set<Socket>; timer: NodeJS.Timeout; busy: boolean }>();
  namespace.on('connection', socket => {
    socket.emit('widgets-catalog', catalog);
    const channelId = socket.nsp.name.split('/').at(-1)!;
    let group = channels.get(channelId);
    if (!group) {
      const sockets = new Set<Socket>();
      group = { sockets, busy: false, timer: setInterval(() => { void poll(); }, 500) };
      const owned = group;
      const poll = async () => {
        if (owned.busy) return; owned.busy = true;
        try {
          if (!await hasPro(channelId)) { for (const client of owned.sockets) client.disconnect(true); return; }
          const version = await WidgetChannel.findById(channelId, { revision: 1, dueAt: 1, tokenHash: 1 }).lean();
          for (const client of owned.sockets) {
            if (!version || client.data.widgetsTokenHash !== version.tokenHash) { client.disconnect(true); continue; }
            if (client.data.widgetsRevision === version?.revision && !(version?.dueAt && version.dueAt <= Date.now())) continue;
            const state = await snapshot(channelId);
            if (client.connected) { client.emit('widgets-state', state); client.data.widgetsRevision = state.revision; }
          }
        } catch { for (const client of owned.sockets) { client.data.widgetsRevision = undefined; client.emit('widgets-error', { code: 'unavailable', message: 'State temporarily unavailable; reconnecting automatically' }); } }
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
