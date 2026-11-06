import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getTwitchStreamerHeaderById } from '../utils/header.js';
import { getTwitchHelixUrl } from '../utils/links.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import { parseInteraction, reduceInteraction, type InteractionKind, type InteractionState, type InteractionSnapshot } from './interaction-model.js';
import { clearHypeTrain, HYPE_TRAIN_EVENT_TYPES, parseAdBreak, parseHypeTrain, reduceAdBreak, reduceHypeTrain, type StoredAdBreak, type StoredHypeTrain } from './live-events-model.js';

interface Stored { _id: string; revision: number; state: InteractionState }
export const Interaction = model<Stored>('OverlayInteraction', new Schema<Stored>({ _id: String, revision: Number, state: Schema.Types.Mixed }, { collection: 'overlay_interactions', versionKey: false }));
/** Hype trains (`channel:hypetrain`) and ad breaks (`channel:adbreak`) share the collection, with their own reducers. */
interface StoredLive<T> { _id: string; revision: number; state: T }
const LiveState = Interaction as unknown as import('mongoose').Model<StoredLive<unknown>>;
/**
 * Compare-and-swap save. `expected` fences a recovery read: if anything was saved after it was read, the recovery
 * result is dropped (a newer EventSub update wins over a slow Helix response).
 */
async function saveLive<T>(id: string, reduce: (current: T | null) => T | null, expected?: number): Promise<void> {
  await getMongoDBConnection('overlay-interactions');
  for (let attempt = 0; attempt < 12; attempt++) {
    const old = await LiveState.findById(id).lean() as StoredLive<T> | null;
    if (expected !== undefined && (old?.revision ?? 0) !== expected) return;
    const state = reduce(old?.state ?? null);
    if (!state) return;
    if (!old) {
      try { await LiveState.create({ _id: id, revision: 1, state }); return; }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    } else if ((await LiveState.updateOne({ _id: id, revision: old.revision }, { $set: { state, revision: old.revision + 1 } })).modifiedCount) return;
    if (expected !== undefined) return;
  }
  throw new Error('Concurrent live state update; retry delivery');
}
export async function saveInteraction(channel: string, incoming: InteractionState): Promise<void> {
  await getMongoDBConnection('overlay-interactions');
  const id = `${channel}:${incoming.kind}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const old = await Interaction.findById(id).lean(), state = reduceInteraction(old?.state ?? null, incoming);
    if (!state) return;
    if (!old) {
      try { await Interaction.create({ _id: id, revision: state.revision, state }); return; }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    } else if ((await Interaction.updateOne({ _id: id, revision: old.revision }, { $set: { state, revision: state.revision } })).modifiedCount) return;
  }
  throw new Error('Concurrent interaction update; retry delivery');
}
export async function applyInteractionEvent(event: DomainEventEnvelope): Promise<void> {
  if (event.source !== 'twitch-eventsub' || !event.channelID) return;
  const subscription = event.payload.subscription as Record<string, unknown>;
  const raw = event.payload.event as Record<string, unknown>;
  const timestamp = String(event.metadata.messageTimestamp || event.occurredAt.toISOString()), type = String(subscription.type);
  if (Object.hasOwn(HYPE_TRAIN_EVENT_TYPES, type)) {
    const train = parseHypeTrain(type, raw, timestamp);
    return saveLive<StoredHypeTrain>(`${event.channelID}:hypetrain`, current => reduceHypeTrain(current, train, timestamp, event.sourceEventId));
  }
  if (type === 'channel.ad_break.begin') {
    const ad = parseAdBreak(raw);
    return saveLive<StoredAdBreak>(`${event.channelID}:adbreak`, current => reduceAdBreak(current, ad, timestamp, event.sourceEventId));
  }
  await saveInteraction(event.channelID, parseInteraction(type, raw, timestamp, event.sourceEventId));
}
/** Polls, predictions, hype train and ad break documents for one channel (one read, shared per loop tick). */
export async function channelLiveState(channel: string): Promise<InteractionSnapshot & { hypetrain: { revision: number; state: StoredHypeTrain } | null; adbreak: { revision: number; state: StoredAdBreak } | null }> {
  await getMongoDBConnection('overlay-interactions');
  const docs = await LiveState.find({ _id: { $in: [`${channel}:poll`, `${channel}:prediction`, `${channel}:hypetrain`, `${channel}:adbreak`] } }).lean();
  const doc = (kind: string) => docs.find(item => item._id === `${channel}:${kind}`);
  const live = <T>(kind: string) => { const item = doc(kind); return item ? { revision: item.revision, state: item.state as T } : null; };
  return { poll: (doc('poll')?.state as InteractionState | undefined) ?? null, prediction: (doc('prediction')?.state as InteractionState | undefined) ?? null,
    hypetrain: live<StoredHypeTrain>('hypetrain'), adbreak: live<StoredAdBreak>('adbreak'), serverTime: Date.now() };
}
const hypeResyncs = new Map<string, { until: number; promise: Promise<void> }>();
const HYPE_RESYNC_MS = Math.max(1000, Number(process.env.OVERLAY_HYPE_RESYNC_MS) || 60_000);
/**
 * Hype train recovery from Helix (coalesced per channel for a minute; OVERLAY_HYPE_RESYNC_MS in checks): a running train replaces stale data, and
 * "none running" clears an active one. A failed request changes nothing. Fenced against newer EventSub updates.
 */
export function resyncHypeTrain(channel: string): Promise<void> {
  const old = hypeResyncs.get(channel);
  if (old && old.until > Date.now()) return old.promise;
  const promise = (async () => {
    await getMongoDBConnection('overlay-interactions');
    const id = `${channel}:hypetrain`, before = await LiveState.findById(id, { revision: 1 }).lean();
    const header = await getTwitchStreamerHeaderById(channel);
    if (header.error || !header.header) return;
    const fetchedAt = new Date().toISOString();
    const response = await fetch(getTwitchHelixUrl('hypetrain/status', new URLSearchParams({ broadcaster_id: channel }).toString()), {
      headers: header.header as unknown as Record<string, string>, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Hype train recovery failed: ${response.status}`);
    const result = await response.json() as { data?: { current?: Record<string, unknown> | null; all_time_high?: { level?: unknown; total?: unknown } | null }[] };
    if (!Array.isArray(result.data) || !result.data[0] || !('current' in result.data[0])) throw new Error('Hype train recovery: unexpected response');
    // The channel's own all-time high (not the shared-train one) sits next to `current`; EventSub's begin event carries it flat.
    const high = result.data[0].all_time_high, current = result.data[0].current
      ? { ...result.data[0].current, ...(high ? { all_time_high_level: high.level, all_time_high_total: high.total } : {}) } : null;
    await saveLive<StoredHypeTrain>(id, stored => current ? reduceHypeTrain(stored, parseHypeTrain('channel.hype_train.progress', current, fetchedAt), fetchedAt, `helix:${id}:${fetchedAt}`)
      : clearHypeTrain(stored, fetchedAt), before?.revision ?? 0);
  })();
  hypeResyncs.set(channel, { until: Date.now() + HYPE_RESYNC_MS, promise });
  if (hypeResyncs.size > 2000) for (const [key, entry] of hypeResyncs) if (entry.until < Date.now()) hypeResyncs.delete(key);
  return promise;
}
export async function interactionSnapshot(channel: string): Promise<InteractionSnapshot> {
  await getMongoDBConnection('overlay-interactions');
  const states = await Interaction.find({ _id: { $in: [`${channel}:poll`, `${channel}:prediction`] } }).lean();
  return { poll: states.find(s => s.state.kind === 'poll')?.state ?? null, prediction: states.find(s => s.state.kind === 'prediction')?.state ?? null, serverTime: Date.now() };
}
// Recovery is coalesced across OBS sources, bounded, and never enables subscriptions.
const resyncs = new Map<string, { until: number; promise: Promise<void> }>();
export async function resyncInteractions(channel: string, kinds: readonly InteractionKind[]): Promise<void> {
  await Promise.all(kinds.map(kind => {
    const key = `${channel}:${kind}`, old = resyncs.get(key);
    if (old && old.until > Date.now()) return old.promise;
    const promise = (async () => {
      const header = await getTwitchStreamerHeaderById(channel);
      if (header.error || !header.header) return;
      const occurredAt = new Date().toISOString();
      const response = await fetch(getTwitchHelixUrl(kind === 'poll' ? 'polls' : 'predictions', new URLSearchParams({ broadcaster_id: channel, first: '1' }).toString()), {
        headers: header.header as unknown as Record<string, string>, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Interaction recovery failed: ${response.status}`);
      const result = await response.json() as { data?: Record<string, unknown>[] };
      const raw = result.data?.[0]; if (!raw) return;
      const phase = String(raw.status).toLowerCase();
      // Helix's transitional UNFULFILLED/CANCEL_PENDING states remain awaiting a result.
      const locked = ['locked', 'unfulfilled', 'cancel_pending'].includes(phase);
      const ending = kind === 'poll' ? ['completed', 'terminated', 'archived'].includes(phase) : ['resolved', 'canceled'].includes(phase);
      if (!ending && !locked && phase !== 'active') return;
      const type = `channel.${kind}.${ending ? 'end' : locked ? 'lock' : 'progress'}`;
      const event = { ...raw, status: phase, locks_at: raw.locks_at ?? (typeof raw.started_at === 'string' && typeof raw.prediction_window === 'number' ? new Date(Date.parse(raw.started_at) + raw.prediction_window * 1000).toISOString() : undefined), locked_at: raw.locked_at ?? occurredAt };
      await saveInteraction(channel, parseInteraction(type, event, occurredAt, `helix:${key}:${occurredAt}`));
    })();
    resyncs.set(key, { until: Date.now() + 60_000, promise });
    if (resyncs.size > 2000) for (const [id, entry] of resyncs) if (entry.until < Date.now()) resyncs.delete(id);
    return promise;
  }));
}
