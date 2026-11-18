/**
 * Overlay Studio widget feeds: state widgets (polls, predictions) and everything custom widgets receive (chat, alerts,
 * session, goals, hype train, ads, roulette, rewards, pets, duels, signals, storage and counters requests).
 */
import { randomUUID } from 'node:crypto';
import { STATE_NAMES } from '../../custom_widgets/format.js';
import { resyncHypeTrain, resyncInteractions } from '../interactions.js';
import { hypeTrainOverdue, publicAds, publicHypeTrain, type StoredAdBreak, type StoredHypeTrain } from '../live-events-model.js';
import { adSchedule, refreshAdSchedule, updateAdSchedules } from '../ad-schedule.js';
import { widgetStateRegistry, legacyInteractions } from '../widget-state-providers.js';
import { getWidgetDefinition, validWidgetModuleConfig } from '../widget-contract.js';
import type { WidgetStateReadScope } from '../widget-state.js';
import type { InteractionKind, InteractionSnapshot } from '../interaction-model.js';
import { isGiftEvent, type AlertEvent } from '../model.js';
import { OverlayError } from '../store.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { publishedLayers, widgetNetworks } from '../../custom_widgets/store.js';
import { alertFromEventsub, sessionFor } from '../../custom_widgets/session.js';
import { channelGoals, publicGoals } from '../../custom_widgets/state.js';
import { resyncTwitchGoals, twitchGoalsResyncedAt } from '../../goals/twitch-store.js';
import { commandCount, storeGet, storeSet } from '../../custom_widgets/widget-store.js';
import { pubSubManager } from '../../classes/pubsub_manager.class.js';
import { ensureChatModerationEvents } from '../../widget_feed/subscriptions.js';
import { WIDGET_FEED_CHANNEL, widgetFeedDemandKey } from '../../widget_feed/types.js';
import { peers, type Peer, type Public } from './connections.live.js';
import { bitsRuleFor } from './alerts.live.js';

const TWITCH_GOALS_RESYNC_EVERY_MS = Math.max(60_000, Number(process.env.TWITCH_GOALS_RESYNC_EVERY_MS) || 5 * 60_000);
/** Custom widget layers of a peer's published snapshot: what they use, keyed by layer ID. */
export type WidgetLayers = Map<string, { widgetId: string; name: string; engine: 'dima' | 'streamelements'; uses: Set<string> }>;
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
export const widgetUses = (peer: Peer) => new Set([...(peer.widgets?.values() ?? [])].flatMap(layer => [...layer.uses]));
export async function refreshWidgets(peer: Peer): Promise<void> {
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
export function feedWidgets(channel: string, use: string, type: string, data: unknown, only?: (peer: Peer) => boolean): number {
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
export function sendCustomState(peer: Peer): void {
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
  // Twitch goals made or moved while nobody was listening (Helix; coalesced per channel). Changes refresh the session.
  if (readsSession(peer)) void resyncTwitchGoals(peer.channel).catch(() => {});
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
  const { RouletteChannel } = await import('../../roulette/service.js');
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
export async function feedAlert(channel: string, subscriptionType: string, raw: Record<string, unknown>, id: string, at: number, test = false, only?: (peer: Peer) => boolean): Promise<void> {
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
  // A gift sample (it carries the gift count) reaches custom widgets as a gift, like a real channel.subscription.gift.
  const source = kind === 'sub' && isGiftEvent(raw) ? 'channel.subscription.gift' : TEST_SOURCES[kind];
  const shaped = kind === 'raid' ? { from_broadcaster_user_name: raw.user_name, from_broadcaster_user_login: raw.user_login, from_broadcaster_user_id: raw.user_id, viewers: raw.viewers, ...raw } : raw;
  await feedAlert(channel, source, shaped, `test-${randomUUID()}`, Date.now(), true, peer => peer.publicId === publicId);
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
/**
 * Other API features that read the same chat (chat sound). PubSubManager keeps one handler per topic, so they listen
 * here instead of subscribing to WIDGET_FEED_CHANNEL a second time (that would replace this handler).
 */
const chatListeners = new Set<(channel: string, chat: object, test: boolean) => void>();
/** `test` marks chat from a manual EventSub test (the API's test route), not from Twitch. */
export function onWidgetChat(listener: (channel: string, chat: object, test: boolean) => void): () => void {
  chatListeners.add(listener);
  return () => { chatListeners.delete(listener); };
}
export function subscribeChatFeed(): void {
  chatFeed ??= pubSubManager.subscribe(WIDGET_FEED_CHANNEL, (message: { channel?: unknown; type?: unknown; data?: unknown; test?: unknown }) => {
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
    if (message.type === 'chat') for (const listener of chatListeners) { try { listener(message.channel, message.data, message.test === true); } catch { /* A listener never blocks widget chat. */ } }
    feedWidgets(message.channel, 'chat', String(message.type), message.data);
  }).catch(() => { chatFeed = undefined; });
}
export async function widgetRpc(peer: Peer, raw: unknown): Promise<unknown> {
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
/** The 1 s loop's widget part: state widgets (polls, predictions), custom widget live state, roulette, goals. */
export async function tickWidgetFeeds(): Promise<void> {
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
  // Twitch goals: EventSub keeps them current; a missed notification is corrected within 5 minutes while OBS is open.
  for (const channel of new Set([...peers.values()].filter(peer => peer.socket?.connected && readsSession(peer)).map(peer => peer.channel))) {
    if (Date.now() - twitchGoalsResyncedAt(channel) > TWITCH_GOALS_RESYNC_EVERY_MS) void resyncTwitchGoals(channel).catch(() => {});
  }
}
let lastDemand = 0;
/** Each Studio registration starts with a fresh chat demand throttle (as when it lived in registerStudio). */
export function resetChatDemand(): void { lastDemand = 0; }
/** The bot only builds chat events for channels whose published widgets read chat. */
export async function tickChatDemand(): Promise<void> {
  if (Date.now() - lastDemand > 20000) {
    lastDemand = Date.now();
    for (const channel of new Set([...peers.values()].filter(peer => peer.socket?.connected && widgetUses(peer).has('chat')).map(peer => peer.channel))) await markChatDemand(channel);
  }
}
