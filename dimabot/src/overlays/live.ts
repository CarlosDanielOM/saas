import { resyncInteractions } from './interactions.js';
import { widgetStateRegistry, legacyInteractions } from './widget-state-providers.js';
import { getWidgetDefinition, validWidgetModuleConfig } from './widget-contract.js';
import type { WidgetStateReadScope } from './widget-state.js';
import type { InteractionKind, InteractionSnapshot } from './interaction-model.js';
import { selectAlertLayout } from './model.js';
import { ALERT_DOMAIN_TYPES, AlertEventFilter } from './alert-events.js';
import { OVERLAY_ACTIONS, OVERLAY_PLATFORMS, initialQueueState, platformMatches, type OverlayPlatform, type OverlayScope, type OverlayAction, type QueueState, type QueueCommand } from './controls.js';
import { registerStudioBridge, type ReadTtsDelivery } from './bridge.js';
import { randomUUID } from 'node:crypto';
import { deliveries, leases, retainFile, releaseFile, sweepFiles, DELIVERY_TTL_MS, LEASE_MS, MAX_PENDING, MAX_CHANNEL_BYTES, type SavedDelivery } from './delivery-store.js';
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';
import { publicState, load, Studio, OverlayError } from './store.js';
import { renderLayout } from './ast.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { EVENT_KINDS, matchesTrigger, type AlertEvent, type EventKind, type OverlayScene } from './model.js';

export interface ClipMetadata { streamer: string; game: string; description: string; profileImage?: string; streamerColor?: string }
export interface LiveMedia { clip?: ClipMetadata; type: 'video' | 'audio' | 'image'; url?: string; title: string; volume: number; duration?: number }
export interface LiveEvent { tts?: { speechID: string; ownerClientId: string | null; durationMs: number }; platform: OverlayPlatform; id: string; kind: EventKind; triggerId?: string; media?: LiveMedia; text?: string }
type Public = Awaited<ReturnType<typeof publicState>>;
type RuntimeIssue = 'snapshot' | 'event' | 'media' | 'autoplay';
interface Health { revision: number; issue: RuntimeIssue | null; reportedAt: number; issueAt: number | null }
interface Peer { widgetStateVersion?: string; interactionVersion?: string; commands: QueueCommand[]; playback?: { active: string[]; queued: string[] }; connectedAt: number; health?: Health; activationFailed?: boolean; activationRetryAt?: number; dropped?: number; stateFailed?: boolean; key: string; publicId: string; channel: string; socket?: Socket; disconnectedAt?: number; state: Public; since: number }
interface Pending { ttsOwnerKey?: string; ttsEpochs?: Record<string, string>; ttsTerminal?: boolean; speechID?: string; event: LiveEvent; channel: string; recipients: Set<string>; mediaId?: string; bytes?: number; expiresAt: Date; mime?: string; raw?: Record<string, unknown> }
const peers = new Map<string, Peer>();
let pollingFailed = false;
const pending = new Map<string, Pending>();
const channels = new Map<string, { after: Types.ObjectId; busy: boolean }>();
const RECONNECT_GRACE_MS = LEASE_MS;
const reconnecting = (peer: Peer) => !peer.socket?.connected && peer.disconnectedAt !== undefined && Date.now() - peer.disconnectedAt < RECONNECT_GRACE_MS;
// Serialize durable mutations so a late write cannot resurrect an acknowledged delivery.
let writes: Promise<unknown> = Promise.resolve();
function write<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn); writes = next.catch(() => { pollingFailed = true; }); return next;
}
let restoring: Promise<void> | undefined;
async function restore() {
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
function savePeer(peer: Peer) {
  const saved = { _id: peer.key, channel: peer.channel, publicId: peer.publicId, since: peer.since,
    expiresAt: new Date((peer.disconnectedAt ?? Date.now()) + LEASE_MS), commands: structuredClone(peer.commands) };
  return write(async () => (await leases()).replaceOne({ _id: saved._id }, saved, { upsert: true }));
}
function saveDelivery(item: Pending) {
  const saved: SavedDelivery = { ...item, _id: item.event.id, recipients: [...item.recipients] };
  return write(async () => (await deliveries()).replaceOne({ _id: saved._id }, saved, { upsert: true }));
}
const alertFilter = new AlertEventFilter();
const accepts = (peer: Peer, kind: EventKind) => peer.state.snapshot.widgets.some(w => w.visible && (w.kind === kind && (kind !== 'trigger' || w.triggerIds === undefined || w.triggerIds.length > 0) || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)));
export function studioHasSource(channel: string, kind: EventKind): boolean { return [...peers.values()].some(p => p.channel === channel && (p.socket?.connected || reconnecting(p)) && accepts(p, kind)); }
/** Owner-only diagnostics. Browser sources include OBS and ordinary browser tabs. */
export function studioConnections(channel: string, scenes: OverlayScene[]) {
  const now = Date.now();
  return { checkedAt: now, pollingFailed, scenes: scenes.map(scene => ({
    id: scene.id, published: !!scene.published, revision: scene.revision, width: scene.published?.width ?? scene.width, height: scene.published?.height ?? scene.height,
    receives: [...EVENT_KINDS.filter(kind => scene.published?.widgets.some(w => w.visible && (w.kind === kind && (kind !== 'trigger' || w.triggerIds === undefined || w.triggerIds.length > 0) || w.kind === 'alert' && w.events?.includes(kind as AlertEvent)))), ...(scene.published ? interactionKinds(scene.published) : [])],
    sources: [...peers.values()].filter(p => p.channel === channel && p.publicId === scene.publicId).map(p => ({
      connected: !!p.socket?.connected, connectedAt: p.connectedAt, disconnectedAt: p.disconnectedAt ?? null,
      lastReportAt: p.health?.reportedAt ?? null, revision: p.health?.revision ?? null,
      status: !p.socket?.connected ? 'reconnecting' : !p.health ? 'loading' : now - p.health.reportedAt > 45000 ? 'unresponsive' : p.health.revision !== scene.revision ? 'updating' : 'ready',
      issue: p.health?.issue ?? null, issueAt: p.health?.issueAt ?? null,
      activationFailed: !!p.activationFailed, stateFailed: !!p.stateFailed, dropped: p.dropped ?? 0
    }))
  })) };
}
async function discard(id: string) {
  const item = pending.get(id); if (!item) return; pending.delete(id);
  await write(async () => { await (await deliveries()).updateOne({ _id: id }, { $set: { recipients: [] }, $unset: { mediaId: '', bytes: '' } }); if (item.mediaId) await releaseFile(item.mediaId); });
}
function dropPeer(key: string) {
  const peer = peers.get(key); peers.delete(key); peer?.socket?.disconnect(true);
  for (const [id, item] of pending) {
    if (item.event.tts && item.ttsOwnerKey === key && !item.ttsTerminal) { item.ttsTerminal = true; void import('../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.handleSpeechEnded(item.channel, item.speechID, 'studio_removed')).catch(() => { pollingFailed = true; }); }
    if (!item.recipients.delete(key)) continue; if (!item.recipients.size) void discard(id).catch(() => { pollingFailed = true; }); else void saveDelivery(item); }
  void write(async () => (await leases()).deleteOne({ _id: key }));
  if (peer && ![...peers.values()].some(p => p.channel === peer.channel)) channels.delete(peer.channel);
}
function recipients(channel: string, kind: EventKind, retainDisconnected = false): Peer[] { return [...peers.values()].filter(p => p.channel === channel && (p.socket?.connected || retainDisconnected && reconnecting(p)) && accepts(p, kind)); }
async function deliver(item: Pending, selected: Peer[], current: () => boolean = () => true) {
  if (!current()) { if (item.mediaId) await releaseFile(item.mediaId); return; }
  while ([...pending.values()].filter(p => p.channel === item.channel).reduce((n, p) => n + (p.bytes ?? 0), 0) + (item.bytes ?? 0) > MAX_CHANNEL_BYTES) {
    const oldest = [...pending.values()].find(p => p.channel === item.channel && p.bytes);
    if (!oldest) break;
    for (const key of oldest.recipients) { const peer = peers.get(key); peer?.socket?.emit('overlay-expired', [oldest.event.id]); if (peer) peer.dropped = (peer.dropped ?? 0) + 1; }
    await discard(oldest.event.id);
  }
  // Bound retained media and backlog. Notify sources to release evicted playback slots.
  for (const peer of selected) {
    const backlog = [...pending.values()].filter(p => p.recipients.has(peer.key));
    while (backlog.length >= MAX_PENDING) {
      const old = backlog.shift()!;
      old.recipients.delete(peer.key); peer.dropped = (peer.dropped ?? 0) + 1;
      peer.socket?.emit('overlay-expired', [old.event.id]);
      if (!old.recipients.size) await discard(old.event.id); else await saveDelivery(old);
    }
  }
  if (!current()) { if (item.mediaId) await releaseFile(item.mediaId); return; }
  pending.set(item.event.id, item);
  try { await saveDelivery(item); }
  catch (error) { pending.delete(item.event.id); if (item.mediaId) await releaseFile(item.mediaId); throw error; }
  if (!current() || pending.get(item.event.id) !== item) {
    if (pending.get(item.event.id) === item) await discard(item.event.id);
    else if (item.mediaId) await releaseFile(item.mediaId);
    return;
  }
  for (const peer of selected) {
    if (item.event.tts && item.ttsEpochs?.[peer.key] !== peer.socket?.id) continue;
    peer.socket?.emit('overlay-event', recipientEvent(item, peer.key));
  }
}
function recipientEvent(item: Pending, key: string) {
  if (!item.event.tts || item.ttsOwnerKey === key) return item.event;
  const { media: _media, ...event } = item.event;
  return { ...event, tts: { ...item.event.tts, ownerClientId: null } };
}
export async function publishStudioReadTts(channel: string, input: ReadTtsDelivery): Promise<void> {
  await restore();
  const selected = recipients(channel, 'tts').sort((a, b) => a.key.localeCompare(b.key));
  if (!selected.length) return;
  const owner = !input.legacy && input.file ? selected[0] : undefined;
  const ownerClientId = owner ? String(owner.socket!.handshake.auth.clientId) : null;
  const epochs = Object.fromEntries(selected.map(peer => [peer.key, peer.socket!.id]));
  const current = () => !input.cancelled?.() && (!owner || !!owner.socket?.connected && owner.socket.id === epochs[owner.key]);
  if (!current()) return;
  const retained = owner && input.file ? await retainFile(input.file) : {};
  await deliver({ channel, speechID: input.speechID, ttsOwnerKey: owner?.key,
    ttsEpochs: epochs,
    event: { id: randomUUID(), kind: 'tts', platform: 'twitch', text: input.text,
      tts: { speechID: input.speechID, ownerClientId, durationMs: Math.max(1, Math.min(60_000, input.durationMs || 60_000)) },
      ...(owner ? { media: { type: 'audio' as const, title: input.text, volume: 1 } } : {}) },
    ...retained, mime: input.mime, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), recipients: new Set(selected.map(peer => peer.key)) }, selected, current);
}
export async function endStudioReadTts(channel: string, speechID: string) {
  for (const item of [...pending.values()]) if (item.channel === channel && item.event.tts && item.speechID === speechID) {
    for (const key of item.recipients) peers.get(key)?.socket?.emit('overlay-expired', [item.event.id]);
    await discard(item.event.id);
  }
}
function correlated(item: Pending, publicId: string, clientId: unknown, socketId: unknown) {
  if (typeof clientId !== 'string' || typeof socketId !== 'string') return null;
  const key = `${publicId}:${clientId}`, peer = peers.get(key);
  return item.recipients.has(key) && item.ttsEpochs?.[key] === socketId && peer?.socket?.connected && peer.socket.id === socketId ? key : null;
}
async function reportTts(item: Pending, peer: Peer, raw: unknown, ended: boolean) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const report = raw as Record<string, unknown>;
  if (!item.event.tts || item.ttsTerminal || item.ttsOwnerKey !== peer.key || !peer.socket?.connected ||
      item.ttsEpochs?.[peer.key] !== peer.socket.id || !item.recipients.has(peer.key) || report.speechID !== item.speechID) return;
  if (!ended && (!['loading', 'playing', 'progress', 'recovering'].includes(String(report.phase)) || typeof report.position !== 'number' || !Number.isFinite(report.position) || report.position < 0 || report.position > 3600)) return;
  if (ended) item.ttsTerminal = true; // Claim before first await; generic ACK cannot remove the correlation.
  const { ttsQueueHandler } = await import('../handlers/tts_queue.handler.js');
  if (ended) await ttsQueueHandler.handleSpeechEnded(item.channel, item.speechID, typeof report.reason === 'string' ? report.reason.slice(0, 64) : 'ended');
  else ttsQueueHandler.handleSpeechPlayback(item.channel, { speechID: item.speechID, phase: String(report.phase), position: Number(report.position) }, `studio:${peer.socket!.id}`);
}
/** Copy generated media BEFORE releasing its producer. Files live until every subscriber finishes. */
export async function publishStudioMedia(channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string, platform: OverlayPlatform = 'twitch', speechID?: string): Promise<void> {
  await restore();
  const selected = recipients(channel, kind, true); if (!selected.length) return;
  const id = randomUUID();
  const retained = await retainFile(file);
  await deliver({ channel, speechID, event: { id, kind, media, text, platform }, ...retained, mime, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), recipients: new Set(selected.map(p => p.key)) }, selected);
}
export async function publishStudioTrigger(channel: string, body: Record<string, unknown>, platform: OverlayPlatform = 'twitch'): Promise<void> {
  await restore();
  const triggerId = typeof body.triggerId === 'string' && /^[a-f0-9]{24}$/.test(body.triggerId) ? body.triggerId : undefined;
  const selected = recipients(channel, 'trigger', true).filter(peer => peer.state.snapshot.widgets.some(w => w.visible && w.kind === 'trigger' && matchesTrigger(w, triggerId))); if (!selected.length) return;
  const mime = String(body.mediaType || ''); const type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image';
  const url = String(body.url || ''); if (!/^https?:\/\//i.test(url)) return;
  const id = randomUUID(); const volume = Number(body.volume ?? 100);
  await deliver({ channel, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), event: { id, platform, kind: 'trigger', triggerId, media: { type, url, title: String(body.name || ''), volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1 } }, recipients: new Set(selected.map(p => p.key)) }, selected);
}
export async function publishStudioAlert(channel: string, kind: AlertEvent, raw: Record<string, unknown>, sourceId: string = randomUUID(), since = Date.now(), platform: OverlayPlatform = 'twitch', retainDisconnected = false): Promise<number> {
  await restore();
  const selected = recipients(channel, kind, retainDisconnected).filter(p => p.since <= since); if (!selected.length) return 0;
  // Journal alerts retain recipients during their reconnect lease; manual tests still require a live source.
  // Provider receipt IDs protect clients against duplicate poll delivery.
  const id = `alert-${sourceId}`; if (pending.has(id) || await (await deliveries()).findOne({ _id: id })) return 0;
  await deliver({ channel, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), event: { id, kind, platform }, raw, recipients: new Set(selected.map(p => p.key)) }, selected);
  return selected.length;
}
/** A test targets one published scene; it never enters the producers' live queues. */
export async function publishTest(channel: string, publicId: string, kind: EventKind, prepared: { media?: LiveMedia; triggerId?: string; text?: string; file?: string; mime?: string }, raw?: Record<string, unknown>) {
  await restore();
  const selected = recipients(channel, kind).filter(peer => peer.publicId === publicId
    && (kind !== 'trigger' || peer.state.snapshot.widgets.some(w => w.visible && w.kind === 'trigger' && matchesTrigger(w, prepared.triggerId))));
  if (!selected.length) throw new OverlayError('Open this published overlay in OBS before testing', 409);
  const retained = prepared.file ? await retainFile(prepared.file) : {};
  await deliver({ channel, event: { id: randomUUID(), kind, platform: 'other', media: prepared.media, triggerId: prepared.triggerId, text: prepared.text },
    ...retained, mime: prepared.mime, raw, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), recipients: new Set(selected.map(peer => peer.key)) }, selected);
  return selected.length;
}
export async function eventFor(publicId: string, eventId: string, clientId?: unknown, socketId?: unknown) {
  const state = await publicState(publicId); const item = pending.get(eventId);
  if (!item || item.channel !== state.channel || ![...item.recipients].some(k => k.startsWith(`${publicId}:`))) return null;
  const key = item.event.tts ? correlated(item, publicId, clientId, socketId) : null;
  if (item.event.tts && !key) return null;
  const layouts: Record<string, unknown> = {};
  if (item.raw) for (const design of state.snapshot.designs) {
    const layout = selectAlertLayout(design, item.event.kind as AlertEvent, item.raw);
    if (layout) layouts[design.id] = await renderLayout(layout, state.channel, item.raw);
  }
  const event = key ? recipientEvent(item, key) : item.event;
  const query = key ? `?clientId=${encodeURIComponent(String(clientId))}&socketId=${encodeURIComponent(String(socketId))}` : '';
  return { ...event, snapshot: state.snapshot, revision: state.revision, ...(item.mediaId && (!item.event.tts || key === item.ttsOwnerKey) ? { media: { ...item.event.media!, url: `/overlay-studio/public/${publicId}/media/${eventId}${query}` } } : {}), layouts };
}
export async function fileFor(publicId: string, eventId: string, clientId?: unknown, socketId?: unknown) {
  const state = await publicState(publicId); const item = pending.get(eventId);
  if (item?.event.tts && correlated(item, publicId, clientId, socketId) !== item.ttsOwnerKey) return null;
  if (item?.event.tts && !item.ttsOwnerKey) return null;
  return item?.channel === state.channel && [...item.recipients].some(k => k.startsWith(`${publicId}:`)) && item.mediaId ? { mediaId: item.mediaId, mime: item.mime!, bytes: item.bytes! } : null;
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
export async function queueStatus(channel: string) {
  await load(channel);
  const stored = await Studio.findById(channel).lean();
  const sources = [...peers.values()].filter(peer => peer.channel === channel && peer.socket?.connected);
  const active = new Set(sources.flatMap(peer => peer.playback?.active ?? []));
  const queued = new Set(sources.flatMap(peer => peer.playback?.queued ?? []));
  const events = [...new Set([...active, ...queued])].flatMap(id => {
    const item = pending.get(id);
    return item?.channel === channel ? [{ id, kind: item.event.kind, platform: item.event.platform, status: active.has(id) ? 'playing' : 'queued' }] : [];
  });
  return { state: { ...initialQueueState(), ...stored?.controls }, events, connected: sources.length, needsRefresh: sources.filter(peer => !peer.playback).length };
}

export async function controlStudio(channel: string, rawAction: unknown, rawPlatform: unknown) {
  if (!OVERLAY_ACTIONS.includes(rawAction as OverlayAction) || !['all', ...OVERLAY_PLATFORMS].includes(rawPlatform as OverlayScope)) throw new OverlayError('Invalid overlay control');
  const action = rawAction as OverlayAction, platform = rawPlatform as OverlayScope;
  await load(channel);
  const selected = [...peers.values()].filter(peer => peer.channel === channel);
  if (action === 'pause' || action === 'resume') {
    const paused = action === 'pause';
    const fields = platform === 'all' ? { 'controls.all': paused, 'controls.platforms': {} } : { [`controls.platforms.${platform}`]: paused };
    const stored = await Studio.findByIdAndUpdate(channel, { $set: fields, $inc: { 'controls.revision': 1 } }, { new: true }).lean();
    const state = { ...initialQueueState(), ...stored!.controls };
    for (const peer of selected) {
      peer.state.controls = state;
      peer.socket?.emit('overlay-queue-state', state);
    }
  } else {
    // Capture IDs at request time: replayed controls cannot affect later arrivals.
    const deliveries = selected.map(peer => ({ peer, eventIds: [...pending.values()].filter(item => item.recipients.has(peer.key) && platformMatches(platform, item.event.platform)).map(item => item.event.id) })).filter(delivery => delivery.eventIds.length);
    if (deliveries.some(({ peer }) => peer.commands.length >= 256)) throw new OverlayError('A browser source must reconnect before accepting more controls', 409);
    for (const { peer, eventIds } of deliveries) {
      const command: QueueCommand = { id: randomUUID(), action, platform, eventIds };
      peer.commands.push(command);
      await savePeer(peer);
      peer.socket?.emit('overlay-control', command);
    }
  }
  return queueStatus(channel);
}

/** Read the retained TTS ledger without creating Studio configuration or changing playback. */
export async function studioTtsStatus(channel: string, currentSpeechID?: string) {
  await restore();
  const sources = [...peers.values()].filter(peer => peer.channel === channel && accepts(peer, 'tts')
    && (peer.socket?.connected || reconnecting(peer)));
  const connected = sources.some(peer => peer.socket?.connected);
  const active = new Set(sources.filter(peer => peer.socket?.connected).flatMap(peer => peer.playback?.active ?? []));
  const keys = new Set(sources.map(peer => peer.key));
  const speech = [...pending.values()].filter(item => item.channel === channel && item.event.kind === 'tts'
    && item.expiresAt.getTime() > Date.now() && [...item.recipients].some(key => keys.has(key)));
  return { connected, playing: speech.some(item => active.has(item.event.id)),
    queueLength: new Set(speech.filter(item => !active.has(item.event.id) && (!currentSpeechID || item.speechID !== currentSpeechID))
      .map(item => item.speechID ?? item.event.id)).size };
}

/** Scope speech controls to TTS deliveries; alerts, clips and triggers keep playing. */
export async function controlStudioTts(channel: string, action: 'skip' | 'clear' | 'refresh'): Promise<void> {
  await restore();
  for (const peer of [...peers.values()].filter(p => p.channel === channel)) {
    const active = new Set(peer.playback?.active ?? []);
    const selected = [...pending.values()].filter(item => item.channel === channel && item.event.kind === 'tts'
      && item.recipients.has(peer.key) && (action === 'clear' || active.has(item.event.id)));
    // The existing expiry protocol stops both active and queued IDs. Removing
    // recipients durably also prevents reconnect from replaying cancelled speech.
    peer.socket?.emit('overlay-expired', selected.map(item => item.event.id));
    for (const item of selected) {
      item.recipients.delete(peer.key);
      if (item.recipients.size) await saveDelivery(item);
      else await discard(item.event.id);
    }
    if (action === 'refresh' && accepts(peer, 'tts')) {
      peer.socket?.emit('overlay-updated', { revision: peer.state.revision });
      peer.socket?.conn.close(); // Transport close lets Socket.IO reconnect automatically.
    }
  }
}

export function interactionKinds(scene: { widgets: { visible: boolean; kind: string }[] }): InteractionKind[] {
  return (['poll', 'prediction'] as const).filter(kind => scene.widgets.some(widget => widget.visible && validWidgetModuleConfig(widget as unknown as Record<string, unknown>, 'scene') && getWidgetDefinition(widget.kind)?.state?.stateKey === kind));
}
export async function publicWidgetStateFor(state: Public, scope?: WidgetStateReadScope) {
  const { widgetStates, serverTime, failedSources } = await widgetStateRegistry.snapshot(state.channel, state.snapshot.widgets, scope);
  // Legacy clients have no failure metadata. An omitted envelope preserves their
  // last known state; fabricated nulls would incorrectly clear it on reconnect.
  const interactions = failedSources.includes('twitch-interactions') ? undefined : legacyInteractions(widgetStates, serverTime);
  return { widgetStates, serverTime, interactions, failedSources };
}
export async function interactionsFor(state: Public): Promise<InteractionSnapshot> {
  const { interactions } = await publicWidgetStateFor(state);
  if (!interactions) throw new OverlayError('Overlay interaction state unavailable', 503);
  return interactions;
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
    const peer: Peer = { commands: previous?.commands ?? [], playback: previous?.playback, connectedAt: Date.now(), key, channel: state.channel, publicId: state.publicId, state, socket, since: previous?.since ?? Date.now() };
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
    for (const [event, ended] of [['overlay-speech-playback', false], ['overlay-speech-ended', true]] as const) socket.on(event, (raw: unknown) => {
      if (peers.get(key) !== peer || !raw || typeof raw !== 'object') return;
      const item = pending.get(String((raw as Record<string, unknown>).eventId));
      if (item) void reportTts(item, peer, raw, ended).catch(() => { pollingFailed = true; });
    });
    socket.on('overlay-ended', (id: unknown, ack?: () => void) => {
      if (peers.get(key) !== peer || typeof id !== 'string') return;
      const item = pending.get(id);
      void (async () => {
        if (item?.recipients.has(key) && !(item.event.tts && item.ttsOwnerKey === key && !item.ttsTerminal)) { item.recipients.delete(key); if (!item.recipients.size) await discard(id); else await saveDelivery(item); }
        if (typeof ack === 'function') ack();
      })().catch(() => { pollingFailed = true; });
    });
    socket.on('disconnect', () => { if (peers.get(key)?.socket === socket) {
      for (const item of [...pending.values()]) if (item.event.tts && item.recipients.has(key)) {
        if (item.ttsOwnerKey === key && !item.ttsTerminal) { item.ttsTerminal = true; void import('../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.handleSpeechEnded(item.channel, item.speechID, 'studio_disconnected')); }
        item.recipients.delete(key);
        if (item.recipients.size) void saveDelivery(item); else void discard(item.event.id);
      }
      peer.socket = undefined; peer.disconnectedAt = Date.now(); void savePeer(peer); } });
    void ensureSources(peer);
    void resyncInteractions(peer.channel, interactionKinds(state.snapshot)).catch(() => { peer.stateFailed = true; });
  }
  let busy = false, lastSweep = 0;
  const timer = setInterval(() => { void (async () => {
    if (busy) return; busy = true;
    try {
      await restore();
      if (Date.now() - lastSweep > 15000) {
        for (const item of pending.values()) if (item.expiresAt.getTime() <= Date.now()) {
          for (const key of item.recipients) { const peer = peers.get(key); peer?.socket?.emit('overlay-expired', [item.event.id]); if (peer) peer.dropped = (peer.dropped ?? 0) + 1; }
          await discard(item.event.id);
        }
        for (const peer of peers.values()) if (peer.socket?.connected) await savePeer(peer);
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
            if (peer.socket?.connected) await ensureSources(peer);
          } else if (peer.socket?.connected && peer.activationFailed && Date.now() >= (peer.activationRetryAt ?? 0)) await ensureSources(peer);
        } catch (e) {
          if ([403, 404].includes((e as { status?: number }).status ?? 0)) { peer.socket?.emit('overlay-revoked'); dropPeer(key); }
          else peer.stateFailed = true;
          // A transient database failure keeps the current version and queue.
        }
      }
      const widgetReadScope = widgetStateRegistry.createReadScope();
      for (const peer of peers.values()) {
        if (!peer.socket?.connected) continue;
        const { widgetStates, serverTime, interactions, failedSources } = await publicWidgetStateFor(peer.state, widgetReadScope);
        if (failedSources.length) peer.stateFailed = true;
        const widgetVersion = JSON.stringify([widgetStates, failedSources]);
        if (widgetVersion !== peer.widgetStateVersion) {
          peer.socket.emit('overlay-widget-states', { widgetStates, serverTime, failedSources }); peer.widgetStateVersion = widgetVersion;
        }
        const kinds = interactionKinds(peer.state.snapshot);
        const overdue = kinds.filter(kind => { const state = interactions?.[kind]; return state?.phase === 'active' && !!state.deadline && Date.parse(state.deadline) + 5000 < Date.now(); });
        if (overdue.length) void resyncInteractions(peer.channel, overdue).catch(() => { peer.stateFailed = true; });
        if (interactions) {
          const version = JSON.stringify([interactions.poll?.revision, interactions.prediction?.revision]);
          if (version !== peer.interactionVersion) { peer.socket.emit('overlay-interactions', interactions); peer.interactionVersion = version; }
        }
      }
      const cache = await getDragonflyClient('overlay-presence');
      for (const [channel, cursor] of channels) {
        if (studioHasSource(channel, 'clip')) { await cache.set(`twitch:${channel}:clips:connected`, 'true'); await cache.set(`twitch:${channel}:clips:last_activity`, Date.now()); }
        if (cursor.busy) continue; cursor.busy = true;
        try {
          const events = await DomainEventSchema.find({ channelID: channel, source: 'twitch-eventsub', schemaVersion: 1, _id: { $gt: cursor.after }, type: { $in: Object.keys(ALERT_DOMAIN_TYPES) } }).sort({ _id: 1 }).limit(100).lean();
          for (const event of events) {
            const raw = event.payload.event as Record<string, unknown>, kind = alertFilter.kind(channel, event.type, raw, event.journaledAt.getTime());
            if (kind) await publishStudioAlert(channel, kind, raw, String(event._id), event.journaledAt.getTime(), 'twitch', true);
            cursor.after = event._id;
          }
        } finally { cursor.busy = false; }
      }
      pollingFailed = false;
    } catch { pollingFailed = true; /* Retry polling; active events and retained files remain intact. */ }
    finally { busy = false; }
  })(); }, 1000);
  io.on('close', () => { clearInterval(timer); pending.clear(); peers.clear(); channels.clear(); restoring = undefined; pollingFailed = false; });
}

registerStudioBridge({ readTts: publishStudioReadTts, endReadTts: endStudioReadTts, hasSource: studioHasSource, media: publishStudioMedia, trigger: publishStudioTrigger, controlTts: controlStudioTts, ttsStatus: studioTtsStatus });
