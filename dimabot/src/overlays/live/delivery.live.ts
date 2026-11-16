/**
 * Overlay Studio event delivery: the pending queue each OBS source receives (alerts, clips, triggers, TTS, tests),
 * its durable copy for reconnects, retained media files, event details for the page, and queue controls.
 */
import { randomUUID } from 'node:crypto';
import { deliveries, retainFile, releaseFile, DELIVERY_TTL_MS, MAX_PENDING, MAX_CHANNEL_BYTES, type SavedDelivery } from '../delivery-store.js';
import { publicState, load, Studio, OverlayError } from '../store.js';
import { renderLayout } from '../ast.js';
import { matchesTrigger, selectAlertLayout, type AlertEvent, type EventKind } from '../model.js';
import { OVERLAY_ACTIONS, OVERLAY_PLATFORMS, initialQueueState, platformMatches, type OverlayPlatform, type OverlayScope, type OverlayAction, type QueueCommand } from '../controls.js';
import { peers, recipients, restore, savePeer, studioStatus, type Peer } from './connections.live.js';
import { correlated } from './tts.live.js';
import { bitsRuleFor } from './alerts.live.js';

export interface ClipMetadata { streamer: string; game: string; description: string; profileImage?: string; streamerColor?: string }
export interface LiveMedia { clip?: ClipMetadata; type: 'video' | 'audio' | 'image'; url?: string; title: string; volume: number; duration?: number }
export interface LiveEvent { tts?: { speechID: string; ownerClientId: string | null; durationMs: number }; platform: OverlayPlatform; id: string; kind: EventKind; triggerId?: string; media?: LiveMedia; text?: string;
  /** Set by the server when the trigger had a look at send time; `eventFor` resolves it (old pages ignore it and play `media`). */
  hasLook?: true }
export interface Pending { ttsOwnerKey?: string; ttsEpochs?: Record<string, string>; ttsTerminal?: boolean; speechID?: string; event: LiveEvent; channel: string; recipients: Set<string>; mediaId?: string; bytes?: number; expiresAt: Date; mime?: string; raw?: Record<string, unknown> }
export const pending = new Map<string, Pending>();
// Serialize durable mutations so a late write cannot resurrect an acknowledged delivery.
let writes: Promise<unknown> = Promise.resolve();
export function write<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn); writes = next.catch(() => { studioStatus.pollingFailed = true; }); return next;
}
export function saveDelivery(item: Pending) {
  const saved: SavedDelivery = { ...item, _id: item.event.id, recipients: [...item.recipients] };
  return write(async () => (await deliveries()).replaceOne({ _id: saved._id }, saved, { upsert: true }));
}
export async function discard(id: string) {
  const item = pending.get(id); if (!item) return; pending.delete(id);
  await write(async () => { await (await deliveries()).updateOne({ _id: id }, { $set: { recipients: [] }, $unset: { mediaId: '', bytes: '' } }); if (item.mediaId) await releaseFile(item.mediaId); });
}
/** Deliveries past their expiry: sources release their playback slots (part of the 15 s sweep). */
export async function expirePending(): Promise<void> {
  for (const item of pending.values()) if (item.expiresAt.getTime() <= Date.now()) {
    for (const key of item.recipients) { const peer = peers.get(key); peer?.socket?.emit('overlay-expired', [item.event.id]); if (peer) peer.dropped = (peer.dropped ?? 0) + 1; }
    await discard(item.event.id);
  }
}
export async function deliver(item: Pending, selected: Peer[], current: () => boolean = () => true, beforeEmit?: () => boolean) {
  if (!current()) { if (item.mediaId) await releaseFile(item.mediaId); return false; }
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
  if (!current()) { if (item.mediaId) await releaseFile(item.mediaId); return false; }
  pending.set(item.event.id, item);
  try { await saveDelivery(item); }
  catch (error) { pending.delete(item.event.id); if (item.mediaId) await releaseFile(item.mediaId); throw error; }
  if (!current() || pending.get(item.event.id) !== item) {
    if (pending.get(item.event.id) === item) await discard(item.event.id);
    else if (item.mediaId) await releaseFile(item.mediaId);
    return false;
  }
  if (beforeEmit && !beforeEmit()) { await discard(item.event.id); return false; }
  for (const peer of selected) {
    if (item.event.tts && item.ttsEpochs?.[peer.key] !== peer.socket?.id) continue;
    peer.socket?.emit('overlay-event', recipientEvent(item, peer.key));
  }
  return true;
}
function recipientEvent(item: Pending, key: string) {
  if (!item.event.tts || item.ttsOwnerKey === key) return item.event;
  const { media: _media, ...event } = item.event;
  return { ...event, tts: { ...item.event.tts, ownerClientId: null } };
}
/** Copy generated media BEFORE releasing its producer. Files live until every subscriber finishes. */
export async function publishStudioMedia(channel: string, kind: 'clip' | 'tts', media: LiveMedia, file: string, mime: string, text?: string, platform: OverlayPlatform = 'twitch', speechID?: string): Promise<void> {
  await restore();
  const selected = recipients(channel, kind, true); if (!selected.length) return;
  const id = randomUUID();
  const retained = await retainFile(file);
  await deliver({ channel, speechID, event: { id, kind, media, text, platform }, ...retained, mime, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), recipients: new Set(selected.map(p => p.key)) }, selected);
}
/**
 * `hasLook` comes from the server's own trigger lookup, never from the request body. `raw` is the sanitised
 * `{ user_id?, user_login?, user_name? }` for the look's `$(user)`, kept with the delivery only when there is a look.
 */
export async function publishStudioTrigger(channel: string, body: Record<string, unknown>, platform: OverlayPlatform = 'twitch', options: { hasLook?: boolean; raw?: Record<string, unknown> } = {}): Promise<void> {
  await restore();
  const triggerId = typeof body.triggerId === 'string' && /^[a-f0-9]{24}$/.test(body.triggerId) ? body.triggerId : undefined;
  const selected = recipients(channel, 'trigger', true).filter(peer => peer.state.snapshot.widgets.some(w => w.visible && w.kind === 'trigger' && matchesTrigger(w, triggerId))); if (!selected.length) return;
  const mime = String(body.mediaType || ''); const type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image';
  const url = String(body.url || ''); if (!/^https?:\/\//i.test(url)) return;
  const id = randomUUID(); const volume = Number(body.volume ?? 100);
  const look = !!options.hasLook && !!triggerId;
  await deliver({ channel, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), event: { id, platform, kind: 'trigger', triggerId, ...(look ? { hasLook: true as const } : {}), media: { type, url, title: String(body.name || ''), volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1 } },
    ...(look && options.raw ? { raw: options.raw } : {}), recipients: new Set(selected.map(p => p.key)) }, selected);
}
/** A test targets one published scene; it never enters the producers' live queues. */
export async function publishTest(channel: string, publicId: string, kind: EventKind, prepared: { media?: LiveMedia; triggerId?: string; hasLook?: boolean; text?: string; file?: string; mime?: string }, raw?: Record<string, unknown>) {
  await restore();
  const selected = recipients(channel, kind).filter(peer => peer.publicId === publicId
    && (kind !== 'trigger' || peer.state.snapshot.widgets.some(w => w.visible && w.kind === 'trigger' && matchesTrigger(w, prepared.triggerId))));
  if (!selected.length) throw new OverlayError('Open this published overlay in OBS before testing', 409);
  const retained = prepared.file ? await retainFile(prepared.file) : {};
  await deliver({ channel, event: { id: randomUUID(), kind, platform: 'other', media: prepared.media, triggerId: prepared.triggerId, ...(prepared.hasLook && prepared.triggerId ? { hasLook: true as const } : {}), text: prepared.text },
    ...retained, mime: prepared.mime, raw, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), recipients: new Set(selected.map(peer => peer.key)) }, selected);
  return selected.length;
}
export async function eventFor(publicId: string, eventId: string, clientId?: unknown, socketId?: unknown) {
  const state = await publicState(publicId); const item = pending.get(eventId);
  if (!item || item.channel !== state.channel || ![...item.recipients].some(k => k.startsWith(`${publicId}:`))) return null;
  const key = item.event.tts ? correlated(item, publicId, clientId, socketId) : null;
  if (item.event.tts && !key) return null;
  const layouts: Record<string, unknown> = {};
  const bitsRule = await bitsRuleFor(state.channel, item.event.kind, item.raw);
  if (item.raw && item.event.kind !== 'trigger') for (const design of state.snapshot.designs) {
    const layout = selectAlertLayout(design, item.event.kind as AlertEvent, item.raw, bitsRule);
    if (layout) layouts[design.id] = await renderLayout(layout, state.channel, item.raw);
  }
  const event = key ? recipientEvent(item, key) : item.event;
  const query = key ? `?clientId=${encodeURIComponent(String(clientId))}&socketId=${encodeURIComponent(String(socketId))}` : '';
  const look = item.event.kind === 'trigger' && item.event.hasLook && item.event.triggerId ? await triggerLook(state.channel, item.event.triggerId, item.raw) : null;
  return { ...event, snapshot: state.snapshot, revision: state.revision, ...(item.mediaId && (!item.event.tts || key === item.ttsOwnerKey) ? { media: { ...item.event.media!, url: `/overlay-studio/public/${publicId}/media/${eventId}${query}` } } : {}), layouts, ...(look ? { look } : {}) };
}
/**
 * The trigger's look as it is now (resolved per request: after an edit, sources or retries may get different revisions).
 * A deleted trigger or look, or any failure while resolving, means no look: the renderer falls back to `media`.
 */
async function triggerLook(channel: string, triggerId: string, raw?: Record<string, unknown>) {
  try {
    const [{ TriggerSchema }, { resolveLook }] = await Promise.all([import('../../schemas/trigger.schema.js'), import('../trigger-look.js')]);
    const trigger = await TriggerSchema.findOne({ _id: triggerId, channelID: channel }).select('channelID volume look').lean();
    return trigger ? await resolveLook(trigger, raw ?? {}) : null;
  } catch (error) {
    console.warn('Trigger look unavailable', channel, triggerId, error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}
export async function fileFor(publicId: string, eventId: string, clientId?: unknown, socketId?: unknown) {
  const state = await publicState(publicId); const item = pending.get(eventId);
  if (item?.event.tts && correlated(item, publicId, clientId, socketId) !== item.ttsOwnerKey) return null;
  if (item?.event.tts && !item.ttsOwnerKey) return null;
  return item?.channel === state.channel && [...item.recipients].some(k => k.startsWith(`${publicId}:`)) && item.mediaId ? { mediaId: item.mediaId, mime: item.mime!, bytes: item.bytes! } : null;
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
