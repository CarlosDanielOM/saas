import { registerStudioBridge } from './bridge.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';
import { publicState, type StudioState } from './store.js';
import { renderLayout } from './ast.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { EVENT_KINDS, matchesTrigger, type AlertEvent, type EventKind, type OverlayScene } from './model.js';

export interface ClipMetadata { streamer: string; game: string; description: string; profileImage?: string; streamerColor?: string }
export interface LiveMedia { clip?: ClipMetadata; type: 'video' | 'audio' | 'image'; url?: string; title: string; volume: number; duration?: number }
export interface LiveEvent { id: string; kind: EventKind; triggerId?: string; media?: LiveMedia; text?: string }
type Public = Awaited<ReturnType<typeof publicState>>;
type RuntimeIssue = 'snapshot' | 'event' | 'media' | 'autoplay';
interface Health { revision: number; issue: RuntimeIssue | null; reportedAt: number; issueAt: number | null }
interface Peer { connectedAt: number; health?: Health; activationFailed?: boolean; activationRetryAt?: number; stateFailed?: boolean; key: string; publicId: string; channel: string; socket?: Socket; disconnectedAt?: number; state: Public; since: number }
interface Pending { event: LiveEvent; channel: string; recipients: Set<string>; file?: string; mime?: string; raw?: Record<string, unknown> }
const peers = new Map<string, Peer>();
let pollingFailed = false;
const pending = new Map<string, Pending>();
const channels = new Map<string, { after: Types.ObjectId; busy: boolean }>();
const directory = path.join(tmpdir(), 'domdimabot-overlay-media');
const types: Record<string, AlertEvent> = { 'channel.follow.received': 'follow', 'channel.bits.received': 'bits', 'channel.subscription.received': 'sub', 'channel.subscription.gifted': 'sub', 'channel.raid.received': 'raid' };
const accepts = (peer: Peer, kind: EventKind) => peer.state.snapshot.widgets.some(w => w.visible && (w.kind === kind && (kind !== 'trigger' || w.triggerIds === undefined || w.triggerIds.length > 0) || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)));
export function studioHasSource(channel: string, kind: EventKind): boolean { return [...peers.values()].some(p => p.channel === channel && p.socket?.connected && accepts(p, kind)); }
/** Owner-only diagnostics. Browser sources include OBS and ordinary browser tabs. */
export function studioConnections(channel: string, scenes: OverlayScene[]) {
  const now = Date.now();
  return { checkedAt: now, pollingFailed, scenes: scenes.map(scene => ({
    id: scene.id, published: !!scene.published, revision: scene.revision, width: scene.published?.width ?? scene.width, height: scene.published?.height ?? scene.height,
    receives: EVENT_KINDS.filter(kind => scene.published?.widgets.some(w => w.visible && (w.kind === kind && (kind !== 'trigger' || w.triggerIds === undefined || w.triggerIds.length > 0) || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)))),
    sources: [...peers.values()].filter(p => p.channel === channel && p.publicId === scene.publicId).map(p => ({
      connected: !!p.socket?.connected, connectedAt: p.connectedAt, disconnectedAt: p.disconnectedAt ?? null,
      lastReportAt: p.health?.reportedAt ?? null, revision: p.health?.revision ?? null,
      status: !p.socket?.connected ? 'reconnecting' : !p.health ? 'loading' : now - p.health.reportedAt > 45000 ? 'unresponsive' : p.health.revision !== scene.revision ? 'updating' : 'ready',
      issue: p.health?.issue ?? null, issueAt: p.health?.issueAt ?? null,
      activationFailed: !!p.activationFailed, stateFailed: !!p.stateFailed
    }))
  })) };
}
async function discard(id: string) { const item = pending.get(id); if (!item) return; pending.delete(id); if (item.file) await unlink(item.file).catch(() => {}); }
async function dropPeer(key: string) {
  const peer = peers.get(key); peers.delete(key); peer?.socket?.disconnect(true);
  for (const [id, item] of pending) { item.recipients.delete(key); if (!item.recipients.size) await discard(id); }
  if (peer && ![...peers.values()].some(p => p.channel === peer.channel)) channels.delete(peer.channel);
}
function recipients(channel: string, kind: EventKind): Peer[] { return [...peers.values()].filter(p => p.channel === channel && p.socket?.connected && accepts(p, kind)); }
function deliver(item: Pending, selected: Peer[]) { pending.set(item.event.id, item); for (const peer of selected) peer.socket?.emit('overlay-event', item.event); }
/** Copy generated media BEFORE releasing its producer. Files live until every subscriber finishes. */
export async function publishStudioMedia(channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string): Promise<void> {
  const selected = recipients(channel, kind); if (!selected.length) return;
  const id = randomUUID(); await mkdir(directory, { recursive: true }); const retained = path.join(directory, id);
  await copyFile(file, retained);
  deliver({ channel, event: { id, kind, media, text }, file: retained, mime, recipients: new Set(selected.map(p => p.key)) }, selected);
}
export function publishStudioTrigger(channel: string, body: Record<string, unknown>): void {
  const triggerId = typeof body.triggerId === 'string' && /^[a-f0-9]{24}$/.test(body.triggerId) ? body.triggerId : undefined;
  const selected = recipients(channel, 'trigger').filter(peer => peer.state.snapshot.widgets.some(w => w.visible && w.kind === 'trigger' && matchesTrigger(w, triggerId))); if (!selected.length) return;
  const mime = String(body.mediaType || ''); const type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image';
  const url = String(body.url || ''); if (!/^https?:\/\//i.test(url)) return;
  const id = randomUUID(); const volume = Number(body.volume ?? 100);
  deliver({ channel, event: { id, kind: 'trigger', triggerId, media: { type, url, title: String(body.name || ''), volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1 } }, recipients: new Set(selected.map(p => p.key)) }, selected);
}
export function publishStudioAlert(channel: string, kind: AlertEvent, raw: Record<string, unknown>, sourceId: string = randomUUID(), since = Date.now()): number {
  const selected = recipients(channel, kind).filter(p => p.since <= since); if (!selected.length) return 0;
  // Provider receipt IDs protect clients against duplicate poll delivery.
  const id = `alert-${sourceId}`; if (pending.has(id)) return 0;
  deliver({ channel, event: { id, kind }, raw, recipients: new Set(selected.map(p => p.key)) }, selected);
  return selected.length;
}
export async function eventFor(publicId: string, eventId: string) {
  const state = await publicState(publicId); const item = pending.get(eventId);
  if (!item || item.channel !== state.channel || ![...item.recipients].some(k => k.startsWith(`${publicId}:`))) return null;
  const layouts: Record<string, unknown> = {};
  if (item.raw) for (const design of state.snapshot.designs) {
    const layout = design.events[item.event.kind as AlertEvent];
    if (layout) layouts[design.id] = await renderLayout(layout, state.channel, item.raw);
  }
  return { ...item.event, snapshot: state.snapshot, revision: state.revision, ...(item.file ? { media: { ...item.event.media!, url: `/overlay-studio/public/${publicId}/media/${eventId}` } } : {}), layouts };
}
export async function fileFor(publicId: string, eventId: string) {
  const state = await publicState(publicId); const item = pending.get(eventId);
  return item?.channel === state.channel && [...item.recipients].some(k => k.startsWith(`${publicId}:`)) && item.file ? { path: item.file, mime: item.mime! } : null;
}
async function activateSources(peer: Peer): Promise<void> {
  const { clipQueueHandler } = await import('../handlers/clip_queue.handler.js');
  const { ttsQueueHandler } = await import('../handlers/tts_queue.handler.js');
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
      const client = socket.handshake.auth?.clientId;
      if (typeof client !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(client)) throw new Error('Invalid client identity');
      socket.data.studioState = await publicState(socket.nsp.name.split('/').at(-1)!);
      next();
    } catch { next(new Error('Overlay unavailable or Pro access required')); }
  });
  namespace.on('connection', socket => {
    const state = socket.data.studioState as Public; const key = `${state.publicId}:${socket.handshake.auth.clientId}`;
    const previous = peers.get(key); previous?.socket?.disconnect(true);
    const peer: Peer = { connectedAt: Date.now(), key, channel: state.channel, publicId: state.publicId, state, socket, since: previous?.since ?? Date.now() };
    peers.set(key, peer);
    if (!channels.has(peer.channel)) channels.set(peer.channel, { after: Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000)), busy: false });
    socket.emit('overlay-state', { publicId: state.publicId, revision: state.revision, snapshot: state.snapshot });
    for (const item of pending.values()) if (item.recipients.has(key)) socket.emit('overlay-event', item.event);
    socket.on('overlay-health', (raw: unknown) => {
      if (peers.get(key) !== peer || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const { revision, issue } = raw as Record<string, unknown>;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > peer.state.revision) return;
      if (issue !== null && (typeof issue !== 'string' || !['snapshot', 'event', 'media', 'autoplay'].includes(issue))) return;
      const now = Date.now();
      peer.health = { revision, issue: issue as RuntimeIssue | null, reportedAt: now, issueAt: issue === null ? null : peer.health && peer.health.issue === issue ? peer.health.issueAt : now };
    });
    socket.on('overlay-ended', (id: unknown) => {
      if (typeof id !== 'string') return; const item = pending.get(id); if (!item) return;
      item.recipients.delete(key); if (!item.recipients.size) void discard(id);
    });
    socket.on('disconnect', () => { if (peers.get(key)?.socket === socket) { peer.socket = undefined; peer.disconnectedAt = Date.now(); } });
    void ensureSources(peer);
  });
  let busy = false;
  const timer = setInterval(() => { void (async () => {
    if (busy) return; busy = true;
    try {
      const states = new Map<string, Public>();
      for (const [key, peer] of peers) {
        if (!peer.socket && Date.now() - (peer.disconnectedAt ?? 0) > 120000) { await dropPeer(key); continue; }
        try {
          let state = states.get(peer.publicId); if (!state) { state = await publicState(peer.publicId); states.set(peer.publicId, state); }
          peer.stateFailed = false;
          if (peer.state.revision !== state.revision) {
            peer.state = state; peer.socket?.emit('overlay-updated', { revision: state.revision });
            if (peer.socket?.connected) await ensureSources(peer);
          } else if (peer.socket?.connected && peer.activationFailed && Date.now() >= (peer.activationRetryAt ?? 0)) await ensureSources(peer);
        } catch (e) {
          if ([403, 404].includes((e as { status?: number }).status ?? 0)) { peer.socket?.emit('overlay-revoked'); await dropPeer(key); }
          else peer.stateFailed = true;
          // A transient database failure keeps the current version and queue.
        }
      }
      const cache = await getDragonflyClient('overlay-presence');
      for (const [channel, cursor] of channels) {
        if (studioHasSource(channel, 'clip')) { await cache.set(`twitch:${channel}:clips:connected`, 'true'); await cache.set(`twitch:${channel}:clips:last_activity`, Date.now()); }
        if (cursor.busy) continue; cursor.busy = true;
        try {
          const events = await DomainEventSchema.find({ channelID: channel, source: 'twitch-eventsub', schemaVersion: 1, _id: { $gt: cursor.after }, type: { $in: Object.keys(types) } }).sort({ _id: 1 }).limit(100).lean();
          for (const event of events) {
            publishStudioAlert(channel, types[event.type], event.payload.event as Record<string, unknown>, String(event._id), event.journaledAt.getTime());
            cursor.after = event._id;
          }
        } finally { cursor.busy = false; }
      }
      pollingFailed = false;
    } catch { pollingFailed = true; /* Retry polling; active events and retained files remain intact. */ }
    finally { busy = false; }
  })(); }, 1000);
  io.on('close', () => { clearInterval(timer); for (const id of pending.keys()) void discard(id); peers.clear(); channels.clear(); pollingFailed = false; });
}

registerStudioBridge({ hasSource: studioHasSource, media: publishStudioMedia, trigger: publishStudioTrigger });
