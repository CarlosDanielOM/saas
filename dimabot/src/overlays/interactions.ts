import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getTwitchStreamerHeaderById } from '../utils/header.js';
import { getTwitchHelixUrl } from '../utils/links.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import { parseInteraction, reduceInteraction, type InteractionKind, type InteractionState, type InteractionSnapshot } from './interaction-model.js';

interface Stored { _id: string; revision: number; state: InteractionState }
export const Interaction = model<Stored>('OverlayInteraction', new Schema<Stored>({ _id: String, revision: Number, state: Schema.Types.Mixed }, { collection: 'overlay_interactions', versionKey: false }));
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
  const timestamp = String(event.metadata.messageTimestamp || event.occurredAt.toISOString());
  await saveInteraction(event.channelID, parseInteraction(String(subscription.type), raw, timestamp, event.sourceEventId));
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
