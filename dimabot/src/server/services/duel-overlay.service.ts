import type { Server, Socket } from 'socket.io';
import { authorizeDuelOverlay, DuelChannel, duelSnapshot, presenceKey, tokenHash } from '../../duel/service.js';
import { duelLeaderboard } from '../../duel/stats.js';
import { hasPremium } from '../../widgets/service.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';

export function registerDuelOverlay(io: Server): void {
  const pattern = /^\/overlays\/duel\/[0-9]{1,30}$/;
  io.on('new_namespace', child => { if (pattern.test(child.name)) child.adapter.persistSession = () => {}; });
  const namespace = io.of(pattern);
  namespace.use(async (socket, next) => {
    try {
      const channel = socket.nsp.name.split('/').at(-1)!;
      if (!await authorizeDuelOverlay(channel, socket.handshake.auth?.token)) return next(new Error('Invalid duel overlay token'));
      socket.data.duelTokenHash = tokenHash(socket.handshake.auth.token);
      // The vertical K/D leaderboard shares the private link's token but never
      // receives fights and never counts as a ready duel source.
      socket.data.leaderboard = socket.handshake.auth?.view === 'leaderboard';
      next();
    } catch { next(new Error('Duel overlay authentication unavailable')); }
  });
  const groups = new Map<string, { sockets: Set<Socket>; timer: NodeJS.Timeout; busy: boolean }>();
  namespace.on('connection', socket => {
    const channel = socket.nsp.name.split('/').at(-1)!;
    let group = groups.get(channel);
    if (!group) {
      group = { sockets: new Set(), busy: false, timer: setInterval(() => { void poll(); }, 500) };
      const owned = group;
      async function poll() {
        if (owned.busy) return; owned.busy = true;
        try {
          const doc = await DuelChannel.findById(channel).lean();
          const premium = await hasPremium(channel);
          let board: Awaited<ReturnType<typeof duelLeaderboard>> | null = null;
          for (const client of owned.sockets) {
            if (!doc || !premium || client.data.duelTokenHash !== doc.tokenHash) { client.disconnect(true); continue; }
            if (client.data.leaderboard) {
              const key = `${doc.statsRevision ?? 0}:${doc.settings.enabled}:${doc.settings.language}`;
              if (client.data.leaderboardKey !== key) {
                board ??= await duelLeaderboard(channel);
                client.emit('duel-leaderboard', { ...board, enabled: doc.settings.enabled, language: doc.settings.language });
                client.data.leaderboardKey = key;
              }
              continue;
            }
            if (client.data.duelRevision !== doc.revision) {
              client.emit('duel-state', await duelSnapshot(channel)); client.data.duelRevision = doc.revision;
            }
          }
          const ready = doc?.settings.enabled && [...owned.sockets].some(client => client.connected && !client.data.leaderboard && client.data.duelTokenHash === doc.tokenHash && Date.now() - (client.data.duelReadyAt ?? 0) < 10000);
          const cache = await getDragonflyClient('duel-overlay');
          if (ready && premium) await cache.set(presenceKey(channel), JSON.stringify({ hash: doc!.tokenHash, at: Date.now() }), { EX: 5 });
          else await cache.del(presenceKey(channel));
        } catch {
          for (const client of owned.sockets) {
            client.data.duelReadyAt = 0;
            client.data.duelRevision = undefined; client.data.leaderboardKey = undefined; // Force a fresh snapshot after recovery.
            client.emit('duel-error', { message: 'Duel state temporarily unavailable' });
          }
          await getDragonflyClient('duel-unavailable').then(cache => cache.del(presenceKey(channel))).catch(() => {});
        }
        finally { owned.busy = false; }
      }
      groups.set(channel, group);
    }
    group.sockets.add(socket);
    socket.on('duel-ready', (data: unknown) => {
      if (!socket.data.leaderboard && data && typeof data === 'object' && (data as { version?: unknown }).version === 1) socket.data.duelReadyAt = Date.now();
    });
    socket.on('disconnect', () => {
      group!.sockets.delete(socket);
      if (!group!.sockets.size) {
        clearInterval(group!.timer); groups.delete(channel);
        void getDragonflyClient('duel-disconnect').then(cache => cache.del(presenceKey(channel))).catch(() => {});
      }
    });
  });
  io.on('close', () => { for (const group of groups.values()) clearInterval(group.timer); groups.clear(); });
}
