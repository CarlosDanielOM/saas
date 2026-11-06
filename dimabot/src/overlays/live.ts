import { STATE_NAMES } from '../custom_widgets/format.js';
import { resyncHypeTrain, resyncInteractions } from './interactions.js';
import { hypeTrainOverdue, publicAds, publicHypeTrain, type StoredAdBreak, type StoredHypeTrain } from './live-events-model.js';
import { adSchedule, refreshAdSchedule, updateAdSchedules } from './ad-schedule.js';
import { widgetStateRegistry, legacyInteractions } from './widget-state-providers.js';
import { getWidgetDefinition, validWidgetModuleConfig } from './widget-contract.js';
import type { WidgetStateReadScope } from './widget-state.js';
import type { InteractionKind, InteractionSnapshot } from './interaction-model.js';
import { selectAlertLayout } from './model.js';
import { matchBitsRule, type BitsRule } from '../bits_rules/model.js';
import { loadBitsRules } from '../bits_rules/store.js';
import { ALERT_DOMAIN_TYPES, AlertEventFilter } from './alert-events.js';
import { OVERLAY_ACTIONS, OVERLAY_PLATFORMS, initialQueueState, platformMatches, type OverlayPlatform, type OverlayScope, type OverlayAction, type QueueState, type QueueCommand } from './controls.js';
import { registerStudioBridge, type ReadTtsDelivery, type ReadTtsPublication } from './bridge.js';
import { randomUUID } from 'node:crypto';
import { deliveries, leases, retainFile, releaseFile, sweepFiles, DELIVERY_TTL_MS, LEASE_MS, MAX_PENDING, MAX_CHANNEL_BYTES, type SavedDelivery } from './delivery-store.js';
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';
import { publicState, load, Studio, OverlayError } from './store.js';
import { renderLayout } from './ast.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { EVENT_KINDS, matchesTrigger, type AlertEvent, type EventKind, type OverlayScene } from './model.js';
import { publishedLayers, widgetNetworks } from '../custom_widgets/store.js';
import { alertFromEventsub, sessionFor, type DimaAlert } from '../custom_widgets/session.js';
import { channelGoals, publicGoals } from '../custom_widgets/state.js';
import { commandCount, storeGet, storeSet } from '../custom_widgets/widget-store.js';
import { pubSubManager } from '../classes/pubsub_manager.class.js';
import { ensureChatModerationEvents } from '../widget_feed/subscriptions.js';
import { WIDGET_FEED_CHANNEL, widgetFeedDemandKey } from '../widget_feed/types.js';

export interface ClipMetadata { streamer: string; game: string; description: string; profileImage?: string; streamerColor?: string }
export interface LiveMedia { clip?: ClipMetadata; type: 'video' | 'audio' | 'image'; url?: string; title: string; volume: number; duration?: number }
export interface LiveEvent { tts?: { speechID: string; ownerClientId: string | null; durationMs: number }; platform: OverlayPlatform; id: string; kind: EventKind; triggerId?: string; media?: LiveMedia; text?: string }
type Public = Awaited<ReturnType<typeof publicState>>;
type RuntimeIssue = 'snapshot' | 'event' | 'media' | 'autoplay';
interface Health { revision: number; issue: RuntimeIssue | null; reportedAt: number; issueAt: number | null }
interface Peer { rouletteSent?: Map<string, 'spinning' | 'result'>; widgets?: WidgetLayers; rpc?: { at: number; count: number }; widgetStateVersion?: string; customStates?: Record<string, string>; interactionVersion?: string; commands: QueueCommand[]; playback?: { active: string[]; queued: string[] }; connectedAt: number; health?: Health; activationFailed?: boolean; activationRetryAt?: number; dropped?: number; stateFailed?: boolean; key: string; publicId: string; channel: string; socket?: Socket; disconnectedAt?: number; state: Public; since: number }
interface Pending { ttsOwnerKey?: string; ttsEpochs?: Record<string, string>; ttsTerminal?: boolean; speechID?: string; event: LiveEvent; channel: string; recipients: Set<string>; mediaId?: string; bytes?: number; expiresAt: Date; mime?: string; raw?: Record<string, unknown> }
const peers = new Map<string, Peer>();
/** Custom widget layers of a peer's published snapshot: what they use, keyed by layer ID. */
type WidgetLayers = Map<string, { widgetId: string; name: string; engine: 'dima' | 'streamelements'; uses: Set<string> }>;
const DEMAND_TTL_SECONDS = 60, MAX_WIDGET_RPC_PER_SECOND = 20, STORE_WRITES_PER_WINDOW = 60, STORE_WINDOW_MS = 10_000;
const storeWrites = new Map<string, { at: number; count: number }>();
const moderationChecked = new Map<string, number>();
/** Message delete/clear events for chat widgets: subscribed per channel (publish, then at most hourly as a repair). */
export function ensureWidgetModeration(channel: string, force = false): void {
  if (!force && Date.now() - (moderationChecked.get(channel) ?? 0) < 3_600_000) return;
  moderationChecked.set(channel, Date.now());
  void ensureChatModerationEvents(channel).then(result => {
    if (!result.ok) console.warn('Custom widget chat deletes unavailable', channel, result.message ?? result.events.map(e => `${e.type}:${e.status}`).join(','));
  }).catch(() => { moderationChecked.delete(channel); });
}
const widgetUses = (peer: Peer) => new Set([...(peer.widgets?.values() ?? [])].flatMap(layer => [...layer.uses]));
async function refreshWidgets(peer: Peer): Promise<void> {
  try { peer.widgets = await publishedLayers(peer.channel, peer.state.snapshot.widgets); }
  catch { peer.widgets = new Map(); }
  // Each widget's current load rules (Block outside connections): the page reloads widgets it cached under other
  // rules, e.g. after the owner changed one while this source was offline (a reload request it missed).
  const ids = [...new Set([...peer.widgets.values()].map(layer => layer.widgetId))];
  if (ids.length && peer.socket?.connected) void widgetNetworks(peer.channel, ids).then(networks => peer.socket?.emit('overlay-widget-policies', { networks })).catch(() => {});
  // Chat starts flowing right away for a newly connected or updated chat widget (the loop refreshes it later).
  if (peer.socket?.connected && widgetUses(peer).has('chat')) { await markChatDemand(peer.channel).catch(() => {}); ensureWidgetModeration(peer.channel); }
}
async function markChatDemand(channel: string): Promise<void> {
  await (await getDragonflyClient('overlay-presence')).set(widgetFeedDemandKey(channel), '1', { EX: DEMAND_TTL_SECONDS });
}
/** Sends a custom widget event to the channel's connected sources whose published widgets use it. */
function feedWidgets(channel: string, use: string, type: string, data: unknown, only?: (peer: Peer) => boolean): number {
  let sent = 0;
  for (const peer of peers.values()) {
    if (peer.channel !== channel || !peer.socket?.connected || !widgetUses(peer).has(use) || only && !only(peer)) continue;
    peer.socket.emit('overlay-feed', { v: 1, type, data }); sent++;
  }
  return sent;
}
const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
/**
 * Signals reach layers that use "signals" (for widget.signal.to, only those with that published name). The layer IDs
 * travel with the event, so a source holding several widgets delivers only to those layers.
 */
export function feedSignal(channel: string, signal: { target: string | null }, only?: (peer: Peer) => boolean): number {
  let sent = 0;
  for (const peer of peers.values()) {
    if (peer.channel !== channel || !peer.socket?.connected || (only && !only(peer))) continue;
    const layers = [...(peer.widgets ?? [])].filter(([, layer]) => layer.uses.has('signals') && (signal.target === null || sameName(layer.name, signal.target))).map(([id]) => id);
    if (!layers.length) continue;
    peer.socket.emit('overlay-feed', { v: 1, type: 'signal', data: signal, layers }); sent++;
  }
  return sent;
}
const validSignal = (data: unknown): data is { name: string; value: string; target: string | null } => {
  const s = data as { name?: unknown; value?: unknown; target?: unknown } | null;
  return !!s && typeof s.name === 'string' && /^[a-z0-9_]{1,40}$/.test(s.name) && typeof s.value === 'string' && s.value.length <= 500
    && (s.target === null || (typeof s.target === 'string' && s.target.length <= 80));
};
const seenEvents = new Map<string, number>();
/** Bot events delivered more than once (retries) reach widgets once. */
function firstTime(key: string): boolean {
  const now = Date.now();
  if (seenEvents.size > 5000) for (const [old, at] of seenEvents) if (now - at > 600_000) seenEvents.delete(old);
  if (seenEvents.has(key)) return false;
  seenEvents.set(key, now); return true;
}
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
/** A redemption from the bot, rebuilt with known fields only. */
function validReward(raw: unknown): Record<string, unknown> | null {
  const data = raw as { id?: unknown; reward?: { id?: unknown; title?: unknown; cost?: unknown }; user?: { id?: unknown; login?: unknown; name?: unknown }; input?: unknown; at?: unknown } | null;
  if (!data || !text(data.id, 64) || !data.reward || !text(data.reward.id, 64)) return null;
  const cost = Number(data.reward.cost), user = data.user && (text(data.user.name, 64) || text(data.user.login, 64)) ? { id: text(data.user.id, 64), login: text(data.user.login, 64), name: text(data.user.name, 64) || text(data.user.login, 64) } : null;
  return { id: text(data.id, 64), reward: { id: text(data.reward.id, 64), title: text(data.reward.title, 100), cost: Number.isSafeInteger(cost) && cost >= 0 ? cost : 0 },
    user, input: text(data.input, 500) || null, at: typeof data.at === 'number' && Number.isFinite(data.at) ? data.at : Date.now(), test: false };
}
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** Pet replies from any process, known fields only (the producer already left out private desktop requests). */
function validPet(raw: unknown): Record<string, unknown> | null {
  const data = raw as Record<string, unknown> | null;
  if (!data || !text(data.id, 64) || !['talk', 'ask', 'tts'].includes(String(data.kind)) || !['speaking', 'done'].includes(String(data.phase))) return null;
  return { id: text(data.id, 64), kind: data.kind, phase: data.phase, text: text(data.text, 2000), mood: text(data.mood, 20) || null,
    result: data.phase === 'done' ? (data.result === 'completed' ? 'completed' : 'stopped') : null, at: num(data.at) ?? Date.now(), test: false };
}
function validDuel(raw: unknown): Record<string, unknown> | null {
  const data = raw as Record<string, unknown> | null;
  if (!data || !text(data.id, 64) || !['started', 'ended'].includes(String(data.phase)) || !text(data.challenger, 64) || !text(data.opponent, 64)) return null;
  const ended = data.phase === 'ended';
  return { id: text(data.id, 64), phase: data.phase, challenger: text(data.challenger, 64), opponent: text(data.opponent, 64), mode: data.mode === 'chat' ? 'chat' : 'overlay',
    winner: ended ? text(data.winner, 64) || null : null, loser: ended ? text(data.loser, 64) || null : null, endsAt: num(data.endsAt), at: num(data.at) ?? Date.now(), test: false };
}
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const readsSession = (peer: Peer) => widgetUses(peer).has('session') || widgetUses(peer).has('goals');
/** Session snapshots and goal state follow alerts and goal changes; bursts are coalesced per channel. */
function refreshSession(channel: string, delay = 1500): void {
  if (sessionTimers.has(channel) || ![...peers.values()].some(peer => peer.channel === channel && readsSession(peer))) return;
  sessionTimers.set(channel, setTimeout(() => {
    sessionTimers.delete(channel);
    if ([...peers.values()].some(peer => peer.channel === channel && widgetUses(peer).has('session'))) void sessionFor(channel).then(session => feedWidgets(channel, 'session', 'session', session)).catch(() => {});
    void pushGoals(channel);
  }, delay));
}
/** Live state for custom widgets (`uses`: polls, goals), sent to a source only when its value changed. */
function sendState(peer: Peer, name: typeof STATE_NAMES[number], value: unknown): void {
  const version = JSON.stringify(value);
  if (!peer.socket?.connected || (peer.customStates ??= {})[name] === version) return;
  peer.customStates[name] = version;
  peer.socket.emit('overlay-feed', { v: 1, type: 'state', data: { name, value } });
}
/**
 * What a source's custom widgets read, for a source that just connected or whose published layers changed: the session
 * snapshot (also after a republish that adds a widget reading it, or the widget would wait for the next alert) and
 * polls/goals state (unchanged values aren't resent).
 */
function sendCustomState(peer: Peer): void {
  const uses = widgetUses(peer);
  if (uses.has('session')) sendSession(peer);
  if (uses.has('goals')) void pushGoals(peer.channel, peer);
  if (uses.has('polls')) {
    // Like built-in poll widgets: recover a poll or prediction that started or ended while nobody was listening.
    void resyncInteractions(peer.channel, ['poll', 'prediction']).catch(() => { peer.stateFailed = true; });
    void pollsState(peer.channel).then(value => { if (value && peers.get(peer.key) === peer) sendState(peer, 'polls', value); }).catch(() => {});
  }
  // A hype train that started or ended while nobody was listening (Helix; coalesced per channel).
  if (uses.has('hypetrain')) void resyncHypeTrain(peer.channel).catch(() => {});
  if (uses.has('hypetrain') || uses.has('ads')) void sendLiveEvents(peer).catch(() => {});
}
/** One source's session snapshot; a failed read is tried again (2 s, 8 s, 32 s) while that source stays connected. */
function sendSession(peer: Peer, attempt = 0): void {
  const current = () => peers.get(peer.key) === peer && !!peer.socket?.connected;
  void sessionFor(peer.channel).then(session => { if (current()) peer.socket!.emit('overlay-feed', { v: 1, type: 'session', data: session }); })
    .catch(() => { if (attempt < 3) setTimeout(() => { if (current()) sendSession(peer, attempt + 1); }, 2000 * 4 ** attempt).unref?.(); });
}
/** Hype train and ads state (`uses`: hypetrain, ads) from the shared read; ads activity is computed against now. */
async function sendLiveEvents(peer: Peer, scope?: WidgetStateReadScope): Promise<void> {
  const uses = widgetUses(peer), read = widgetStateRegistry.readSource(peer.channel, 'twitch-interactions', scope);
  if (!read) return;
  const entries = await read, now = Date.now();
  if (peers.get(peer.key) !== peer) return;
  const hype = (entries['hypetrain']?.state ?? null) as StoredHypeTrain | null, ad = (entries['adbreak']?.state ?? null) as StoredAdBreak | null;
  if (uses.has('hypetrain')) {
    sendState(peer, 'hypetrain', publicHypeTrain(hype, now));
    // A missed end event would leave it running forever: ask Twitch once it's overdue.
    if (hypeTrainOverdue(hype, now)) void resyncHypeTrain(peer.channel).catch(() => {});
  }
  if (uses.has('ads')) {
    // A new ad break moves the next one: ask Twitch for the schedule again soon.
    if (ad && adBreakSeen.get(peer.channel) !== ad.ad.startedAt) { adBreakSeen.set(peer.channel, ad.ad.startedAt); refreshAdSchedule(peer.channel); }
    sendState(peer, 'ads', publicAds(ad, adSchedule(peer.channel), now));
  }
}
const adBreakSeen = new Map<string, string>();
const ROULETTE_REPLAY_MS = 120_000;
/**
 * Roulette events come from the saved spin (Mongo), not from a timer, so an API restart or an OBS reconnect loses
 * nothing: `spinning` while it runs (never the label), `result` once it ended. A source that connects up to 2 minutes
 * after a spin ended still gets its result. Each source gets each phase once (the OBS page also drops repeats).
 */
// The 20 newest results cover the 2-minute window (a spin lasts at least a few seconds).
async function sendRouletteEvents(channel: string, targets: Peer[]): Promise<void> {
  const { RouletteChannel } = await import('../roulette/service.js');
  const doc = await RouletteChannel.findById(channel, { 'state.draw.id': 1, 'state.draw.rouletteId': 1, 'state.draw.endsAt': 1, 'state.draw.winner.label': 1,
    'state.history': { $slice: 20 }, 'state.roulettes.id': 1, 'state.roulettes.name': 1 }).lean() as { state?: { draw?: RouletteSpin | null; history?: RouletteSpin[];
      roulettes?: { id: string; name?: string }[] } } | null;
  const state = doc?.state, now = Date.now(), byId = new Map<string, RouletteSpin>();
  for (const spin of [...(state?.history ?? []), ...(state?.draw ? [state.draw] : [])]) if (spin?.id && Number.isFinite(spin.endsAt)) byId.set(spin.id, spin);
  const spins = [...byId.values()].filter(spin => now < spin.endsAt || now - spin.endsAt <= ROULETTE_REPLAY_MS).sort((a, b) => a.endsAt - b.endsAt);
  for (const peer of targets) {
    const sent = peer.rouletteSent ??= new Map();
    for (const spin of spins) {
      const phase = now < spin.endsAt ? 'spinning' : 'result';
      if (sent.get(spin.id) === phase || (phase === 'spinning' && sent.has(spin.id))) continue;
      sent.set(spin.id, phase);
      peer.socket?.emit('overlay-feed', { v: 1, type: 'roulette', data: { id: spin.id, rouletteId: spin.rouletteId, name: state?.roulettes?.find(r => r.id === spin.rouletteId)?.name ?? '',
        phase, label: phase === 'result' ? String(spin.winner?.label ?? '').slice(0, 200) : null, endsAt: spin.endsAt, at: Date.now(), test: false } });
    }
    for (const id of [...sent.keys()].slice(0, Math.max(0, sent.size - 50))) sent.delete(id);
  }
}
interface RouletteSpin { id: string; rouletteId: string; endsAt: number; winner?: { label?: string } }
/** Polls and predictions: the same sanitized read built-in poll widgets use (shared per channel per tick). */
async function pollsState(channel: string, scope?: WidgetStateReadScope): Promise<{ poll: unknown; prediction: unknown } | null> {
  const read = widgetStateRegistry.readSource(channel, 'twitch-interactions', scope);
  if (!read) return null;
  const entries = await read;
  return { poll: entries['poll']?.state ?? null, prediction: entries['prediction']?.state ?? null };
}
const goalsPushedAt = new Map<string, number>();
const sampleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Goals with progress (public projection); one read per channel shared with session data. A failed read keeps the last value. */
async function pushGoals(channel: string, only?: Peer): Promise<void> {
  const targets = [...peers.values()].filter(peer => peer.channel === channel && peer.socket?.connected && widgetUses(peer).has('goals') && (!only || peer === only));
  if (!targets.length) return;
  goalsPushedAt.set(channel, Date.now());
  try {
    const value = publicGoals(await channelGoals(channel));
    for (const peer of targets) sendState(peer, 'goals', value);
  } catch { /* keep the last value */ }
}
/** Alerts reach custom widgets as Dima alerts, without the alert queue or acknowledgements. */
async function feedAlert(channel: string, subscriptionType: string, raw: Record<string, unknown>, id: string, at: number, test = false, only?: (peer: Peer) => boolean): Promise<void> {
  // Session-only widgets still get refreshed totals, even when no widget shows alerts.
  if (!test) refreshSession(channel);
  if (![...peers.values()].some(peer => peer.channel === channel && widgetUses(peer).has('alerts'))) return;
  const rule = subscriptionType.includes('bit') || subscriptionType === 'channel.cheer' ? await bitsRuleFor(channel, 'bits', raw).catch(() => null) : null;
  if (rule?.alert === false) return;
  const alert = alertFromEventsub(subscriptionType, raw, id, at, test, rule ? { id: rule.id, name: rule.name ?? '' } : null);
  if (alert) feedWidgets(channel, 'alerts', 'alert', alert, only);
}
/** OBS tests from Studio: alert kinds map to their usual EventSub source. */
const TEST_SOURCES: Record<AlertEvent, string> = { follow: 'channel.follow', sub: 'channel.subscribe', bits: 'channel.bits.use', raid: 'channel.raid' };
export async function feedTestAlert(channel: string, publicId: string, kind: AlertEvent, raw: Record<string, unknown>): Promise<void> {
  const shaped = kind === 'raid' ? { from_broadcaster_user_name: raw.user_name, from_broadcaster_user_login: raw.user_login, from_broadcaster_user_id: raw.user_id, viewers: raw.viewers, ...raw } : raw;
  await feedAlert(channel, TEST_SOURCES[kind], shaped, `test-${randomUUID()}`, Date.now(), true, peer => peer.publicId === publicId);
}
/** Studio "send to OBS" for custom widget tests (chat, alerts, deletes): one published overlay only. */
export function feedTestEvent(channel: string, publicId: string, type: string, data: unknown): number {
  const use = type === 'alert' ? 'alerts' : type.startsWith('chat') ? 'chat' : type === 'session' ? 'session' : type === 'tts' ? 'tts' : type === 'trigger' ? 'triggers'
    : type === 'reward' ? 'rewards' : type === 'state' ? String((data as { name?: unknown }).name) : type === 'pet' ? 'pets' : type === 'duel' ? 'duels'
    : type === 'roulette' ? 'roulette' : type === 'dimafx' ? 'dimafx' : '';
  if (!use) throw new OverlayError('Invalid widget test');
  const sent = feedWidgets(channel, use, type, data, peer => peer.publicId === publicId);
  // Sample state shows for a minute, then the real state comes back (a newer sample restarts the minute).
  if (type === 'state') {
    const key = `${publicId}:${use}`;
    clearTimeout(sampleTimers.get(key));
    sampleTimers.set(key, setTimeout(() => {
      sampleTimers.delete(key);
      for (const peer of peers.values()) if (peer.publicId === publicId && peer.customStates) delete peer.customStates[use];
      if (use === 'goals') void pushGoals(channel); // polls come back on the next loop tick
    }, 60_000).unref());
  }
  return sent;
}
let chatFeed: Promise<void> | undefined;
function subscribeChatFeed(): void {
  chatFeed ??= pubSubManager.subscribe(WIDGET_FEED_CHANNEL, (message: { channel?: unknown; type?: unknown; data?: unknown }) => {
    if (typeof message?.channel !== 'string' || !message.data || typeof message.data !== 'object') return;
    if (message.type === 'signal') { if (validSignal(message.data)) feedSignal(message.channel, message.data); return; }
    // Goal progress or settings changed (cron worker / goals route): StreamElements "*-goal" values follow them.
    if (message.type === 'session.refresh') { refreshSession(message.channel, 300); return; }
    // Channel-point redemptions from the bot (EventSub retries arrive once).
    if (message.type === 'reward') { const reward = validReward(message.data); if (reward && firstTime('reward:' + reward.id)) feedWidgets(message.channel, 'rewards', 'reward', reward); return; }
    // Producers run in different processes: a `speaking` that arrives after its `done` is dropped (widgets would show it forever).
    if (message.type === 'pet') { const pet = validPet(message.data); if (pet && (pet.phase === 'done' || !seenEvents.has(`pet:${pet.id}:done`)) && firstTime(`pet:${pet.id}:${pet.phase}`)) feedWidgets(message.channel, 'pets', 'pet', pet); return; }
    if (message.type === 'duel') { const duel = validDuel(message.data); if (duel && firstTime(`duel:${duel.id}:${duel.phase}`)) feedWidgets(message.channel, 'duels', 'duel', duel); return; }
    if (!['chat', 'chat.delete', 'chat.clear'].includes(String(message.type))) return;
    feedWidgets(message.channel, 'chat', String(message.type), message.data);
  }).catch(() => { chatFeed = undefined; });
}
async function widgetRpc(peer: Peer, raw: unknown): Promise<unknown> {
  const now = Date.now();
  if (!peer.rpc || now - peer.rpc.at > 1000) peer.rpc = { at: now, count: 0 };
  if (++peer.rpc.count > MAX_WIDGET_RPC_PER_SECOND) throw new OverlayError('Too many widget requests');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OverlayError('Invalid request');
  const { layerId, method, params } = raw as { layerId?: unknown; method?: unknown; params?: unknown };
  const layer = typeof layerId === 'string' ? peer.widgets?.get(layerId) : undefined;
  if (!layer) throw new OverlayError('Widget not found');
  const body = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const namespace = layer.engine === 'streamelements' ? 'se' : layer.widgetId;
  if (method === 'store.get' || method === 'store.set') {
    // RPC method names stay internal ("store.*"); widgets ask for "storage" in widget.json.
    if (!layer.uses.has('storage')) throw new OverlayError('This widget did not ask for "storage" in widget.json');
    if (method === 'store.get') return storeGet(peer.channel, namespace, body.key);
    // Channel-wide write budget: every source identity of the channel shares it.
    const window = storeWrites.get(peer.channel);
    if (!window || now - window.at > STORE_WINDOW_MS) storeWrites.set(peer.channel, { at: now, count: 1 });
    else if (++window.count > STORE_WRITES_PER_WINDOW) throw new OverlayError('Too many saves from this channel\'s widgets; try again shortly');
    await storeSet(peer.channel, namespace, body.key, body.value ?? null);
    // Other sources of the channel see the change (StreamElements "kvstore:update").
    // The namespace travels with the update so each layer only applies its own (frames filter on it).
    feedWidgets(peer.channel, 'storage', 'storage', { key: body.key, value: body.value ?? null, namespace }, other => [...(other.widgets?.values() ?? [])].some(item => item.uses.has('storage') && (item.engine === 'streamelements' ? 'se' : item.widgetId) === namespace));
    return true;
  }
  if (method === 'counters.get') {
    if (!layer.uses.has('counters')) throw new OverlayError('This widget did not ask for "counters" in widget.json');
    return commandCount(peer.channel, body.name);
  }
  throw new OverlayError('Unknown widget request');
}
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
    if (item.event.tts && item.ttsOwnerKey === key && !item.ttsTerminal) { item.ttsTerminal = true; void import('../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.handleOverlayEnded(item.channel, item.speechID, 'studio_removed', `studio:${peer?.socket?.id ?? ''}`)).catch(() => { pollingFailed = true; }); }
    if (!item.recipients.delete(key)) continue; if (!item.recipients.size) void discard(id).catch(() => { pollingFailed = true; }); else void saveDelivery(item); }
  void write(async () => (await leases()).deleteOne({ _id: key }));
  if (peer && ![...peers.values()].some(p => p.channel === peer.channel)) channels.delete(peer.channel);
}
function recipients(channel: string, kind: EventKind, retainDisconnected = false): Peer[] { return [...peers.values()].filter(p => p.channel === channel && (p.socket?.connected || retainDisconnected && reconnecting(p)) && accepts(p, kind)); }
async function deliver(item: Pending, selected: Peer[], current: () => boolean = () => true, beforeEmit?: () => boolean) {
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
  if (ended) await ttsQueueHandler.handleOverlayEnded(item.channel, item.speechID, typeof report.reason === 'string' ? report.reason.slice(0, 64) : 'ended', `studio:${peer.socket!.id}`, report.reason === 'ended');
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
/** The shared Bits rule a cheer matches (null for other events or when no rule matches). */
export async function bitsRuleFor(channel: string, kind: EventKind, raw?: Record<string, unknown>): Promise<BitsRule | null> {
  return kind === 'bits' && raw ? matchBitsRule((await loadBitsRules(channel)).rules, raw.bits) : null;
}
export async function publishStudioAlert(channel: string, kind: AlertEvent, raw: Record<string, unknown>, sourceId: string = randomUUID(), since = Date.now(), platform: OverlayPlatform = 'twitch', retainDisconnected = false): Promise<number> {
  await restore();
  // A Bits rule can keep certain amounts chat-only.
  if (kind === 'bits' && (await bitsRuleFor(channel, kind, raw))?.alert === false) return 0;
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
  const bitsRule = await bitsRuleFor(state.channel, item.event.kind, item.raw);
  if (item.raw) for (const design of state.snapshot.designs) {
    const layout = selectAlertLayout(design, item.event.kind as AlertEvent, item.raw, bitsRule);
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
    for (const [event, ended] of [['overlay-speech-playback', false], ['overlay-speech-ended', true]] as const) socket.on(event, (raw: unknown) => {
      if (peers.get(key) !== peer || !raw || typeof raw !== 'object') return;
      const item = pending.get(String((raw as Record<string, unknown>).eventId));
      if (item) void reportTts(item, peer, raw, ended).catch(() => { pollingFailed = true; });
      else if (ended && (raw as Record<string, unknown>).reason === 'ended' && typeof (raw as Record<string, unknown>).speechID === 'string') {
        // A reset may have discarded the original delivery before its actual
        // stop report arrived. The activity ledger still requires the exact
        // original socket and speech ID before it releases anything.
        const speech = String((raw as Record<string, unknown>).speechID);
        void import('../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) =>
          ttsQueueHandler.handleOverlayEnded(peer.channel, speech, 'stopped', `studio:${socket.id}`, true)).catch(() => { pollingFailed = true; });
      }
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
        if (item.ttsOwnerKey === key && !item.ttsTerminal) { item.ttsTerminal = true; void import('../handlers/tts_queue.handler.js').then(({ ttsQueueHandler }) => ttsQueueHandler.handleOverlayEnded(item.channel, item.speechID, 'studio_disconnected', `studio:${socket.id}`)); }
        item.recipients.delete(key);
        if (item.recipients.size) void saveDelivery(item); else void discard(item.event.id);
      }
      peer.socket = undefined; peer.disconnectedAt = Date.now(); void savePeer(peer); } });
    void ensureSources(peer);
    void resyncInteractions(peer.channel, interactionKinds(state.snapshot)).catch(() => { peer.stateFailed = true; });
  }
  let busy = false, lastSweep = 0, lastDemand = 0;
  subscribeChatFeed();
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
        // Custom widgets that use polls: the same shared read, sent when it changed.
        if (widgetUses(peer).has('polls')) {
          try {
            const value = await pollsState(peer.channel, widgetReadScope);
            if (value) {
              sendState(peer, 'polls', value);
              // A missed end event would leave it "active" forever: ask Twitch once it's overdue (coalesced per channel).
              const overdue = (['poll', 'prediction'] as const).filter(kind => { const state = value[kind] as { phase?: string; deadline?: string | null } | null;
                return state?.phase === 'active' && !!state.deadline && Date.parse(state.deadline) + 5000 < Date.now(); });
              if (overdue.length) void resyncInteractions(peer.channel, overdue).catch(() => { peer.stateFailed = true; });
            }
          } catch { peer.stateFailed = true; }
        }
        if (widgetUses(peer).has('hypetrain') || widgetUses(peer).has('ads')) {
          try { await sendLiveEvents(peer, widgetReadScope); } catch { peer.stateFailed = true; }
        }
      }
      const connected = (use: string) => [...peers.values()].filter(peer => peer.socket?.connected && widgetUses(peer).has(use));
      updateAdSchedules(new Set(connected('ads').map(peer => peer.channel)), () => {});
      // Roulette: one saved-spin read per channel with a connected roulette widget.
      const roulettePeers = connected('roulette');
      for (const channel of new Set(roulettePeers.map(peer => peer.channel))) {
        await sendRouletteEvents(channel, roulettePeers.filter(peer => peer.channel === channel)).catch(() => {});
      }
      // Goals also change with time (scheduled → active, rolling windows, monthly rollover): at least once a minute.
      for (const channel of new Set([...peers.values()].filter(peer => peer.socket?.connected && widgetUses(peer).has('goals')).map(peer => peer.channel))) {
        if (Date.now() - (goalsPushedAt.get(channel) ?? 0) > 60_000) void pushGoals(channel);
      }
      const cache = await getDragonflyClient('overlay-presence');
      // The bot only builds chat events for channels whose published widgets read chat.
      if (Date.now() - lastDemand > 20000) {
        lastDemand = Date.now();
        for (const channel of new Set([...peers.values()].filter(peer => peer.socket?.connected && widgetUses(peer).has('chat')).map(peer => peer.channel))) await markChatDemand(channel);
      }
      for (const [channel, cursor] of channels) {
        if (studioHasSource(channel, 'clip')) { await cache.set(`twitch:${channel}:clips:connected`, 'true'); await cache.set(`twitch:${channel}:clips:last_activity`, Date.now()); }
        if (cursor.busy) continue; cursor.busy = true;
        try {
          const events = await DomainEventSchema.find({ channelID: channel, source: 'twitch-eventsub', schemaVersion: 1, _id: { $gt: cursor.after }, type: { $in: Object.keys(ALERT_DOMAIN_TYPES) } }).sort({ _id: 1 }).limit(100).lean();
          for (const event of events) {
            const raw = event.payload.event as Record<string, unknown>, kind = alertFilter.kind(channel, event.type, raw, event.journaledAt.getTime());
            if (kind) await publishStudioAlert(channel, kind, raw, String(event._id), event.journaledAt.getTime(), 'twitch', true);
            if (kind) await feedAlert(channel, String((event.payload as { subscription?: { type?: unknown } })?.subscription?.type ?? ''), raw, String(event._id), event.journaledAt.getTime()).catch(() => {});
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
