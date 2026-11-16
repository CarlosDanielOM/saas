/**
 * Overlay Studio TTS: one connected source owns each speech (plays its audio and reports progress), the others show
 * captions only. Skip/clear/refresh controls and the status the TTS queue reads.
 */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { retainFile, DELIVERY_TTL_MS } from '../delivery-store.js';
import type { ReadTtsDelivery, ReadTtsPublication } from '../bridge.js';
import { accepts, peers, reconnecting, recipients, restore, studioStatus, type Peer } from './connections.live.js';
import { deliver, discard, pending, saveDelivery, type Pending } from './delivery.live.js';

export async function publishStudioReadTts(channel: string, input: ReadTtsDelivery): Promise<ReadTtsPublication> {
  await restore();
  const selected = recipients(channel, 'tts').sort((a, b) => a.key.localeCompare(b.key));
  if (!selected.length) return input.cancelled?.() ? 'cancelled' : 'unavailable';
  const owner = !input.legacy && input.file ? selected[0] : undefined;
  const ownerClientId = owner ? String(owner.socket!.handshake.auth.clientId) : null;
  const epochs = Object.fromEntries(selected.map(peer => [peer.key, peer.socket!.id]));
  const current = () => !input.cancelled?.() && (!owner || !!owner.socket?.connected && owner.socket.id === epochs[owner.key]);
  const beforeEmit = () => {
    if (!current() || input.beforeEmit?.() === false) return false;
    if (owner) input.onOwner?.(`studio:${epochs[owner.key]}`);
    return true;
  };
  if (!current()) return input.cancelled?.() ? 'cancelled' : 'unavailable';
  const retained = owner && input.file ? await retainFile(input.file) : {};
  const emitted = await deliver({ channel, speechID: input.speechID, ttsOwnerKey: owner?.key,
    ttsEpochs: epochs,
    event: { id: randomUUID(), kind: 'tts', platform: 'twitch', text: input.text,
      tts: { speechID: input.speechID, ownerClientId, durationMs: Math.max(1, Math.min(60_000, input.durationMs || 60_000)) },
      ...(owner ? { media: { type: 'audio' as const, title: input.text, volume: 1 } } : {}) },
    ...retained, mime: input.mime, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), recipients: new Set(selected.map(peer => peer.key)) }, selected, current, beforeEmit);
  return emitted ? 'emitted' : input.cancelled?.() ? 'cancelled' : 'unavailable';
}
export async function endStudioReadTts(channel: string, speechID: string) {
  for (const item of [...pending.values()]) if (item.channel === channel && item.event.tts && item.speechID === speechID) {
    for (const key of item.recipients) peers.get(key)?.socket?.emit('overlay-expired', [item.event.id]);
    await discard(item.event.id);
  }
}
export function correlated(item: Pending, publicId: string, clientId: unknown, socketId: unknown) {
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
  const { ttsQueueHandler } = await import('../../handlers/tts_queue.handler.js');
  if (ended) await ttsQueueHandler.handleOverlayEnded(item.channel, item.speechID, typeof report.reason === 'string' ? report.reason.slice(0, 64) : 'ended', `studio:${peer.socket!.id}`, report.reason === 'ended');
  else ttsQueueHandler.handleSpeechPlayback(item.channel, { speechID: item.speechID, phase: String(report.phase), position: Number(report.position) }, `studio:${peer.socket!.id}`);
}
/** The speech owner's playback reports (progress and end) for the TTS queue. */
export function onSpeechReports(socket: Socket, peer: Peer, key: string): void {
  for (const [event, ended] of [['overlay-speech-playback', false], ['overlay-speech-ended', true]] as const) socket.on(event, (raw: unknown) => {
    if (peers.get(key) !== peer || !raw || typeof raw !== 'object') return;
    const item = pending.get(String((raw as Record<string, unknown>).eventId));
    if (item) void reportTts(item, peer, raw, ended).catch(() => { studioStatus.pollingFailed = true; });
    else if (ended && (raw as Record<string, unknown>).reason === 'ended' && typeof (raw as Record<string, unknown>).speechID === 'string') {
      // A reset may have discarded the original delivery before its actual
      // stop report arrived. The activity ledger still requires the exact
      // original socket and speech ID before it releases anything.
      const speech = String((raw as Record<string, unknown>).speechID);
      void import('../../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) =>
        ttsQueueHandler.handleOverlayEnded(peer.channel, speech, 'stopped', `studio:${socket.id}`, true)).catch(() => { studioStatus.pollingFailed = true; });
    }
  });
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
