/**
 * Overlay Studio OBS sources: the /overlay-studio/:publicId socket namespace, each source's connection and reconnect
 * lease, reloading published overlays, the 1 s loop that drives the other live modules, and the producer bridge.
 */
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';
import { registerStudioBridge } from '../bridge.js';
import { deliveries, leases, releaseFile, sweepFiles, LEASE_MS } from '../delivery-store.js';
import { publicState, OverlayError } from '../store.js';
import { EVENT_KINDS, type AlertEvent, type EventKind, type OverlayScene } from '../model.js';
import type { QueueCommand } from '../controls.js';
import { resyncInteractions } from '../interactions.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { clientVersion, sawClient, type ClientVersionInfo } from '../client-versions.js';
import { OVERLAY_PROTOCOL } from '../protocol.js';
import { discard, expirePending, pending, publishStudioMedia, publishStudioTrigger, saveDelivery, write } from './delivery.live.js';
import { controlStudioTts, endStudioReadTts, onSpeechReports, publishStudioReadTts, studioTtsStatus } from './tts.live.js';
import { channels, pollChannelAlerts } from './alerts.live.js';
import { feedWidgets, interactionKinds, publicWidgetStateFor, refreshWidgets, sendCustomState, subscribeChatFeed, resetChatDemand, tickChatDemand, tickWidgetFeeds, widgetRpc, widgetUses, type WidgetLayers } from './widget_feeds.live.js';

export type Public = Awaited<ReturnType<typeof publicState>>;
type RuntimeIssue = 'snapshot' | 'event' | 'media' | 'autoplay';
interface Health { revision: number; issue: RuntimeIssue | null; reportedAt: number; issueAt: number | null }
export interface Peer { /** What the page reported when it connected (protocol 0 = a page from before protocols). */ version?: ClientVersionInfo; rouletteSent?: Map<string, 'spinning' | 'result'>; widgets?: WidgetLayers; rpc?: { at: number; count: number }; widgetStateVersion?: string; customStates?: Record<string, string>; interactionVersion?: string; commands: QueueCommand[]; playback?: { active: string[]; queued: string[] }; connectedAt: number; health?: Health; activationFailed?: boolean; activationRetryAt?: number; dropped?: number; stateFailed?: boolean; key: string; publicId: string; channel: string; socket?: Socket; disconnectedAt?: number; state: Public; since: number }
export const peers = new Map<string, Peer>();
/** Shown in the Studio's OBS diagnostics: the last loop pass or a durable write failed. */
export const studioStatus = { pollingFailed: false };
const RECONNECT_GRACE_MS = LEASE_MS;
export const reconnecting = (peer: Peer) => !peer.socket?.connected && peer.disconnectedAt !== undefined && Date.now() - peer.disconnectedAt < RECONNECT_GRACE_MS;
let restoring: Promise<void> | undefined;
export async function restore() {
  if (!restoring) restoring = (async () => {
    const now = Date.now();
    for (const saved of await (await leases()).find({ expiresAt: { $gt: new Date(now) } }).toArray()) {
      try {
        const state = await publicState(saved.publicId);
        peers.set(saved._id, { key: saved._id, channel: saved.channel, publicId: saved.publicId, state, since: saved.since, connectedAt: now, disconnectedAt: saved.expiresAt.getTime() - LEASE_MS, commands: saved.commands });
        if (!channels.has(saved.channel)) channels.set(saved.channel, { after: Types.ObjectId.createFromTime(Math.floor((now - LEASE_MS) / 1000)), busy: false });
      } catch (error) { if (![403, 404].includes((error as {status?: number}).status ?? 0)) throw error; }
    }
    for (const saved of await (await deliveries()).find({ expiresAt: { $gt: new Date(now) } }).sort({ expiresAt: 1 }).toArray()) {
      if (saved.event.tts) { await (await deliveries()).deleteOne({ _id: saved._id }); if (saved.mediaId) await releaseFile(saved.mediaId); continue; }
      const recipients = new Set(saved.recipients.filter(key => peers.has(key)));
      if (recipients.size) pending.set(saved._id, { ...saved, recipients });
    }
  })().catch(error => { restoring = undefined; throw error; });
  await restoring;
}
export function savePeer(peer: Peer) {
  const saved = { _id: peer.key, channel: peer.channel, publicId: peer.publicId, since: peer.since,
    expiresAt: new Date((peer.disconnectedAt ?? Date.now()) + LEASE_MS), commands: structuredClone(peer.commands) };
  return write(async () => (await leases()).replaceOne({ _id: saved._id }, saved, { upsert: true }));
}
export const accepts = (peer: Peer, kind: EventKind) => peer.state.snapshot.widgets.some(w => w.visible && (w.kind === kind && (kind !== 'trigger' || w.triggerIds === undefined || w.triggerIds.length > 0) || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)));
export function studioHasSource(channel: string, kind: EventKind): boolean { return [...peers.values()].some(p => p.channel === channel && (p.socket?.connected || reconnecting(p)) && accepts(p, kind)); }
/** Owner-only diagnostics. Browser sources include OBS and ordinary browser tabs. */
export function studioConnections(channel: string, scenes: OverlayScene[]) {
  const now = Date.now();
  return { checkedAt: now, pollingFailed: studioStatus.pollingFailed, scenes: scenes.map(scene => ({
    id: scene.id, published: !!scene.published, revision: scene.revision, width: scene.published?.width ?? scene.width, height: scene.published?.height ?? scene.height,
    receives: [...EVENT_KINDS.filter(kind => scene.published?.widgets.some(w => w.visible && (w.kind === kind && (kind !== 'trigger' || w.triggerIds === undefined || w.triggerIds.length > 0) || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)))), ...(scene.published ? interactionKinds(scene.published) : [])],
    sources: [...peers.values()].filter(p => p.channel === channel && p.publicId === scene.publicId).map(p => ({
      connected: !!p.socket?.connected, connectedAt: p.connectedAt, disconnectedAt: p.disconnectedAt ?? null,
      lastReportAt: p.health?.reportedAt ?? null, revision: p.health?.revision ?? null,
      status: !p.socket?.connected ? 'reconnecting' : !p.health ? 'loading' : now - p.health.reportedAt > 45000 ? 'unresponsive' : p.health.revision !== scene.revision ? 'updating' : 'ready',
      issue: p.health?.issue ?? null, issueAt: p.health?.issueAt ?? null,
      activationFailed: !!p.activationFailed, stateFailed: !!p.stateFailed, dropped: p.dropped ?? 0,
      // Pages restored after an API restart report again when they reconnect.
      protocol: p.version?.protocol ?? null, build: p.version?.build ?? null, outdated: !!p.version && p.version.protocol < OVERLAY_PROTOCOL
    }))
  })) };
}
function dropPeer(key: string) {
  const peer = peers.get(key); peers.delete(key); peer?.socket?.disconnect(true);
  for (const [id, item] of pending) {
    if (item.event.tts && item.ttsOwnerKey === key && !item.ttsTerminal) { item.ttsTerminal = true; void import('../../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.handleOverlayEnded(item.channel, item.speechID, 'studio_removed', `studio:${peer?.socket?.id ?? ''}`)).catch(() => { studioStatus.pollingFailed = true; }); }
    if (!item.recipients.delete(key)) continue; if (!item.recipients.size) void discard(id).catch(() => { studioStatus.pollingFailed = true; }); else void saveDelivery(item); }
  void write(async () => (await leases()).deleteOne({ _id: key }));
  if (peer && ![...peers.values()].some(p => p.channel === peer.channel)) channels.delete(peer.channel);
}
export function recipients(channel: string, kind: EventKind, retainDisconnected = false): Peer[] { return [...peers.values()].filter(p => p.channel === channel && (p.socket?.connected || retainDisconnected && reconnecting(p)) && accepts(p, kind)); }
async function activateSources(peer: Peer): Promise<void> {
  const { clipQueueHandler } = await import('../../handlers/clip_queue.handler.js');
  const { ttsQueueHandler } = await import('../../handlers/tts_queue.handler.js');
  if (accepts(peer, 'clip')) {
    const cache = await getDragonflyClient('overlay-clips');
    await cache.set(`twitch:${peer.channel}:clips:connected`, 'true');
    await cache.set(`twitch:${peer.channel}:clips:last_activity`, Date.now());
    await clipQueueHandler.subscribeToChannel(peer.channel);
  }
  if (accepts(peer, 'tts')) await ttsQueueHandler.resumeIfIdle(peer.channel);
}
async function ensureSources(peer: Peer): Promise<void> {
  try { await activateSources(peer); peer.activationFailed = false; }
  catch { peer.activationFailed = true; peer.activationRetryAt = Date.now() + 5000; }
}
export function registerStudio(io: Server): void {
  const pattern = /^\/overlay-studio\/[a-f0-9]{48}$/;
  io.on('new_namespace', child => { if (pattern.test(child.name)) child.adapter.persistSession = () => {}; });
  const namespace = io.of(pattern);
  namespace.use(async (socket, next) => {
    try {
      await restore();
      const client = socket.handshake.auth?.clientId;
      if (typeof client !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(client)) throw new Error('Invalid client identity');
      socket.data.studioState = await publicState(socket.nsp.name.split('/').at(-1)!);
      next();
    } catch { next(new Error('Overlay unavailable')); }
  });
  namespace.on('connection', socket => {
    void connectPeer(socket).catch(() => socket.disconnect(true));
  });
  async function connectPeer(socket: Socket) {
    const state = socket.data.studioState as Public; const key = `${state.publicId}:${socket.handshake.auth.clientId}`;
    let previous = peers.get(key);
    // Enforce the lease here too: a reconnect can race the periodic expiry sweep.
    if (previous && !previous.socket?.connected && !reconnecting(previous)) { dropPeer(key); previous = undefined; }
    previous?.socket?.disconnect(true);
    const version = clientVersion(socket.handshake.auth);
    const peer: Peer = { version, commands: previous?.commands ?? [], playback: previous?.playback, connectedAt: Date.now(), key, channel: state.channel, publicId: state.publicId, state, socket, since: previous?.since ?? Date.now() };
    sawClient('overlay', version);
    peers.set(key, peer);
    await savePeer(peer);
    if (!socket.connected) { peer.socket = undefined; peer.disconnectedAt = Date.now(); await savePeer(peer); return; }
    if (!channels.has(peer.channel)) channels.set(peer.channel, { after: Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000)), busy: false });
    const { interactions, widgetStates, serverTime, failedSources } = await publicWidgetStateFor(state);
    peer.stateFailed = failedSources.length > 0;
    peer.widgetStateVersion = JSON.stringify([widgetStates, failedSources]);
    if (interactions) peer.interactionVersion = JSON.stringify([interactions.poll?.revision, interactions.prediction?.revision]);
    socket.emit('overlay-state', { widgetStates, serverTime, failedSources, interactions, publicId: state.publicId, revision: state.revision, snapshot: state.snapshot, controls: state.controls, commands: peer.commands, pendingIds: [...pending.values()].filter(item => !item.event.tts && item.recipients.has(key)).map(item => item.event.id) });
    for (const item of pending.values()) if (!item.event.tts && item.recipients.has(key)) socket.emit('overlay-event', item.event);
    // Custom widgets: what the published layers use, then their session snapshot, live state and requests.
    void refreshWidgets(peer).then(() => { if (peers.get(key) === peer) sendCustomState(peer); }).catch(() => {});
    socket.on('overlay-widget-rpc', (raw: unknown, ack?: (result: unknown) => void) => {
      if (peers.get(key) !== peer || typeof ack !== 'function') return;
      void widgetRpc(peer, raw).then(value => ack({ ok: true, value }), error => ack({ ok: false, error: error instanceof OverlayError ? error.message : 'Request failed' }));
    });
    socket.on('overlay-control-ack', (id: unknown) => {
      if (peers.get(key) === peer && typeof id === 'string') { peer.commands = peer.commands.filter(command => command.id !== id); void savePeer(peer); }
    });
    socket.on('overlay-playback', (raw: unknown) => {
      if (peers.get(key) !== peer || !raw || typeof raw !== 'object') return;
      const report = raw as { active?: unknown; queued?: unknown };
      const valid = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= 5000 && ids.every(id => typeof id === 'string' && pending.get(id)?.recipients.has(key));
      if (valid(report.active) && valid(report.queued)) peer.playback = { active: report.active, queued: report.queued };
    });
    socket.on('overlay-health', (raw: unknown) => {
      if (peers.get(key) !== peer || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const { revision, issue } = raw as Record<string, unknown>;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > peer.state.revision) return;
      if (issue !== null && (typeof issue !== 'string' || !['snapshot', 'event', 'media', 'autoplay'].includes(issue))) return;
      const now = Date.now();
      peer.health = { revision, issue: issue as RuntimeIssue | null, reportedAt: now, issueAt: issue === null ? null : peer.health && peer.health.issue === issue ? peer.health.issueAt : now };
    });
    onSpeechReports(socket, peer, key);
    socket.on('overlay-ended', (id: unknown, ack?: () => void) => {
      if (peers.get(key) !== peer || typeof id !== 'string') return;
      const item = pending.get(id);
      void (async () => {
        if (item?.recipients.has(key) && !(item.event.tts && item.ttsOwnerKey === key && !item.ttsTerminal)) { item.recipients.delete(key); if (!item.recipients.size) await discard(id); else await saveDelivery(item); }
        if (typeof ack === 'function') ack();
      })().catch(() => { studioStatus.pollingFailed = true; });
    });
    socket.on('disconnect', () => { if (peers.get(key)?.socket === socket) {
      for (const item of [...pending.values()]) if (item.event.tts && item.recipients.has(key)) {
        if (item.ttsOwnerKey === key && !item.ttsTerminal) { item.ttsTerminal = true; void import('../../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.handleOverlayEnded(item.channel, item.speechID, 'studio_disconnected', `studio:${socket.id}`)); }
        item.recipients.delete(key);
        if (item.recipients.size) void saveDelivery(item); else void discard(item.event.id);
      }
      peer.socket = undefined; peer.disconnectedAt = Date.now(); void savePeer(peer); } });
    void ensureSources(peer);
    void resyncInteractions(peer.channel, interactionKinds(state.snapshot)).catch(() => { peer.stateFailed = true; });
  }
  let busy = false, lastSweep = 0;
  resetChatDemand();
  subscribeChatFeed();
  const timer = setInterval(() => { void (async () => {
    if (busy) return; busy = true;
    try {
      await restore();
      if (Date.now() - lastSweep > 15000) {
        await expirePending();
        for (const peer of peers.values()) if (peer.socket?.connected) { await savePeer(peer); if (peer.version) sawClient('overlay', peer.version); }
        await (await deliveries()).deleteMany({ expiresAt: { $lte: new Date() } });
        await (await leases()).deleteMany({ expiresAt: { $lte: new Date() } });
        await sweepFiles(); lastSweep = Date.now();
      }
      const states = new Map<string, Public>();
      for (const [key, peer] of peers) {
        if (!peer.socket?.connected && !reconnecting(peer)) { dropPeer(key); continue; }
        try {
          let state = states.get(peer.publicId); if (!state) { state = await publicState(peer.publicId); states.set(peer.publicId, state); }
          peer.stateFailed = false;
          if (state.controls.revision !== peer.state.controls.revision) { peer.socket?.emit('overlay-queue-state', state.controls); peer.state.controls = state.controls; }
          if (peer.state.revision !== state.revision) {
            peer.state = state; peer.socket?.emit('overlay-updated', { revision: state.revision });
            await refreshWidgets(peer);
            sendCustomState(peer);
            if (peer.socket?.connected) await ensureSources(peer);
          } else if (peer.socket?.connected && peer.activationFailed && Date.now() >= (peer.activationRetryAt ?? 0)) await ensureSources(peer);
        } catch (e) {
          if ([403, 404].includes((e as { status?: number }).status ?? 0)) { peer.socket?.emit('overlay-revoked'); dropPeer(key); }
          else peer.stateFailed = true;
          // A transient database failure keeps the current version and queue.
        }
      }
      await tickWidgetFeeds();
      const cache = await getDragonflyClient('overlay-presence');
      await tickChatDemand();
      for (const [channel, cursor] of channels) {
        if (studioHasSource(channel, 'clip')) { await cache.set(`twitch:${channel}:clips:connected`, 'true'); await cache.set(`twitch:${channel}:clips:last_activity`, Date.now()); }
        await pollChannelAlerts(channel, cursor);
      }
      studioStatus.pollingFailed = false;
    } catch { studioStatus.pollingFailed = true; /* Retry polling; active events and retained files remain intact. */ }
    finally { busy = false; }
  })(); }, 1000);
  io.on('close', () => { clearInterval(timer); pending.clear(); peers.clear(); channels.clear(); restoring = undefined; studioStatus.pollingFailed = false; });
}

registerStudioBridge({ queueChannels: function* () {
  const entries = peers.values();
  for (let remaining = peers.size; remaining > 0; remaining--) {
    const entry = entries.next(); if (entry.done) return;
    yield entry.value.socket?.connected ? entry.value.channel : undefined;
  }
}, hasLiveSource: (channel, kind) => recipients(channel, kind).length > 0, readTts: publishStudioReadTts, endReadTts: endStudioReadTts, hasSource: studioHasSource, media: publishStudioMedia, trigger: publishStudioTrigger, controlTts: controlStudioTts, ttsStatus: studioTtsStatus,
  widgetEvent: (channel, use, type, data) => feedWidgets(channel, use, type, data),
  widgetsUse: (channel, use) => [...peers.values()].some(peer => peer.channel === channel && peer.socket?.connected && widgetUses(peer).has(use)),
  // The owner changed how a widget may load (Block outside connections): sources showing it load it again.
  widgetChanged: (channel, widgetId) => {
    let sent = 0;
    for (const peer of peers.values()) {
      if (peer.channel !== channel || !peer.socket?.connected || ![...(peer.widgets?.values() ?? [])].some(layer => layer.widgetId === widgetId)) continue;
      peer.socket.emit('overlay-widget-reload', { widgetId }); sent++;
    }
    return sent;
  } });
/** Versions of the OBS pages connected to this API server right now (admin client versions report). */
export function connectedClientVersions(): ClientVersionInfo[] {
  return [...peers.values()].filter(peer => peer.socket?.connected && peer.version).map(peer => peer.version!);
}
