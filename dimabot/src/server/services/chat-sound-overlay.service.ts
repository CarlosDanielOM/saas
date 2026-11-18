/**
 * Chat sound OBS sources (page /overlays/chat-sound/<channel>#<token>): the page plays a pop when someone chats.
 * The bot already publishes chat to the API for custom widgets (Redis "widget-feed", only for channels that mark
 * demand); this service marks demand while a source is connected and the sound is on, decides here whether a message
 * pops (filters, cooldown, quiet mode) and sends every source of the channel the same tiny event. Chat text never
 * reaches the page.
 *
 * One fixed Socket.IO namespace; the channel travels in the handshake auth with the token. Per-channel namespaces would
 * be created before the token check runs, so every refused channel number would stay allocated in this process.
 */
import type { Server, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { onWidgetChat, subscribeChatFeed } from '../../overlays/live/index.js';
import { widgetFeedDemandKey } from '../../widget_feed/types.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { overlayTokenHash } from '../../utils/overlay-token.js';
import { authorizeChatSoundOverlay, findChatSound } from '../../chat_sound/service.js';
import { popDecision, validVolume, type ChatLike, type ChatSoundSettings, type PopClock } from '../../chat_sound/model.js';

export const CHAT_SOUND_NAMESPACE = '/overlays/chat-sound';
/** Bump when the page/server events change shape; pages send theirs with every ready report. */
export const CHAT_SOUND_PROTOCOL = 1;
const LOOP_MS = 2000, DEMAND_EVERY_MS = 20_000, DEMAND_TTL_SECONDS = 60, READY_FRESH_MS = 15_000;
/** Pages report what their audio can do: playing in a hidden OBS source or before a click can be blocked. */
const AUDIO_STATES = new Set(['running', 'suspended', 'blocked', 'unsupported']);

interface Group {
  sockets: Set<Socket>;
  settings: ChatSoundSettings | null;
  revision: number;
  tokenHash: string | null;
  clock: PopClock;
  demandAt: number;
  /** Refreshes run one after another, so an older read never lands after a newer one. */
  chain: Promise<void>;
}
const groups = new Map<string, Group>();
/** Quiet-mode and cooldown clocks survive a source reconnecting (OBS scene switches, refreshes). */
const clocks = new Map<string, PopClock>();
const clockFor = (channel: string): PopClock => {
  let clock = clocks.get(channel);
  if (!clock) { clock = { lastPopAt: 0, lastChatAt: 0 }; clocks.set(channel, clock); if (clocks.size > 5000) clocks.delete(clocks.keys().next().value!); }
  return clock;
};

function emitPop(group: Group, data: { id: string; at: number; test?: true; volume?: number }): number {
  let sent = 0;
  for (const socket of group.sockets) if (socket.connected && socket.data.chatSoundTokenHash === group.tokenHash) { socket.emit('chat-sound-pop', data); sent++; }
  return sent;
}
function sendSettings(socket: Socket, group: Group): void {
  if (!group.settings) return;
  socket.emit('chat-sound-settings', { v: CHAT_SOUND_PROTOCOL, revision: group.revision, enabled: group.settings.enabled, volume: group.settings.volume });
}
async function markDemand(channel: string): Promise<void> {
  await (await getDragonflyClient('chat-sound-demand')).set(widgetFeedDemandKey(channel), '1', { EX: DEMAND_TTL_SECONDS });
}

/**
 * Called for every chat message the bot publishes (any channel); only channels with a source do work. Chat from a
 * manual EventSub test (`test`) never pops and never counts as chat activity: the OBS test needs full access.
 */
export function chatSoundOnChat(channel: string, chat: ChatLike, test = false, now = Date.now()): boolean {
  const group = groups.get(channel);
  if (test || !group?.settings || !group.sockets.size) return false;
  const decision = popDecision(channel, chat, group.settings, group.clock, now);
  if (!decision.pop) return false;
  return emitPop(group, { id: randomUUID(), at: now }) > 0;
}

/** "Test in OBS": one pop on every source of the channel, at an optional draft volume; skips every filter. */
export function sendChatSoundTest(channel: string, volume?: unknown): number {
  const group = groups.get(channel);
  if (!group) return 0;
  return emitPop(group, { id: randomUUID(), at: Date.now(), test: true, ...(validVolume(volume) ? { volume } : {}) });
}

export interface ChatSoundSourceStatus {
  /** Connected on the current link. */
  sources: number;
  /** Reported in the last 15 s. */
  ready: number;
  /** Ready OBS sources whose audio runs / ready browser tabs whose audio runs. */
  obsPlaying: number; tabPlaying: number;
  /** Ready OBS sources / tabs that cannot play sound yet. */
  obsSilent: number; tabSilent: number;
  /** Ready pages running an older page version. */
  outdated: number;
}
/** What the settings page shows: connected sources, and which of them (OBS or a tab) can actually play sound. */
export function chatSoundStatus(channel: string): ChatSoundSourceStatus {
  const status: ChatSoundSourceStatus = { sources: 0, ready: 0, obsPlaying: 0, tabPlaying: 0, obsSilent: 0, tabSilent: 0, outdated: 0 };
  const group = groups.get(channel), now = Date.now();
  for (const socket of group?.sockets ?? []) {
    if (!socket.connected || socket.data.chatSoundTokenHash !== group!.tokenHash) continue;
    status.sources++;
    if (now - (socket.data.chatSoundReadyAt ?? 0) > READY_FRESH_MS) continue;
    status.ready++;
    const playing = socket.data.chatSoundAudio === 'running', obs = socket.data.chatSoundObs === true;
    if (obs) { if (playing) status.obsPlaying++; else status.obsSilent++; }
    else if (playing) status.tabPlaying++; else status.tabSilent++;
    if (socket.data.chatSoundProtocol !== CHAT_SOUND_PROTOCOL) status.outdated++;
  }
  return status;
}

async function refreshNow(channel: string, group: Group): Promise<void> {
  const startedAt = Date.now();
  const doc = await findChatSound(channel);
  group.tokenHash = doc?.tokenHash ?? null;
  for (const socket of [...group.sockets]) {
    if (doc && socket.data.chatSoundTokenHash === doc.tokenHash) continue;
    // A source that authenticated after this read began was checked against newer data than this read: keep it.
    if ((socket.data.chatSoundAuthAt ?? 0) >= startedAt) continue;
    socket.emit('chat-sound-revoked'); socket.disconnect(true);
  }
  if (!doc) { group.settings = null; return; }
  const changed = !group.settings || group.revision !== doc.revision;
  group.settings = doc.settings; group.revision = doc.revision;
  if (changed) for (const socket of group.sockets) sendSettings(socket, group);
  // Chat only needs to flow while the sound is on; the key expires by itself (Studio widgets may still hold it).
  if (!doc.settings.enabled) group.demandAt = 0;
  else if (Date.now() - group.demandAt > DEMAND_EVERY_MS && group.sockets.size) { await markDemand(channel); group.demandAt = Date.now(); }
}
function refresh(channel: string, group: Group): Promise<void> {
  const run = group.chain.then(() => refreshNow(channel, group));
  group.chain = run.catch(() => { /* the next refresh retries */ });
  return run;
}
/** Saved settings or a replaced link reach open sources right away (the loop is the safety net). */
export async function refreshChatSound(channel: string): Promise<void> {
  const group = groups.get(channel);
  if (group) await refresh(channel, group).catch(() => {});
}

export function registerChatSoundOverlay(io: Server): () => void {
  const namespace = io.of(CHAT_SOUND_NAMESPACE);
  // Reconnects always authenticate afresh (Socket.IO recovery could skip the middleware).
  (namespace.adapter as { persistSession?: unknown }).persistSession = () => {};
  namespace.use(async (socket, next) => {
    try {
      const channel = socket.handshake.auth?.channel, token = socket.handshake.auth?.token, authAt = Date.now();
      if (typeof channel !== 'string' || !/^[0-9]{1,30}$/.test(channel) || !await authorizeChatSoundOverlay(channel, token)) return next(new Error('Invalid chat sound link'));
      socket.data.chatSoundChannel = channel;
      socket.data.chatSoundTokenHash = overlayTokenHash(token as string);
      socket.data.chatSoundAuthAt = authAt;
      next();
    } catch { next(new Error('Chat sound unavailable, retrying')); }
  });
  const stopChat = onWidgetChat((channel, chat, test) => { chatSoundOnChat(channel, chat as ChatLike, test); });
  subscribeChatFeed();
  namespace.on('connection', socket => {
    const channel = socket.data.chatSoundChannel as string;
    let group = groups.get(channel);
    const fresh = !group;
    if (!group) { group = { sockets: new Set(), settings: null, revision: -1, tokenHash: socket.data.chatSoundTokenHash, clock: clockFor(channel), demandAt: 0, chain: Promise.resolve() }; groups.set(channel, group); }
    const owned = group;
    owned.sockets.add(socket);
    // A new group loads its settings now (sent to every source on arrival) and marks chat demand, so chat starts
    // flowing within the bot's 5 s demand cache; a known group answers from memory.
    if (fresh || !owned.settings) void refresh(channel, owned).catch(() => {});
    else sendSettings(socket, owned);
    socket.on('chat-sound-ready', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const data = raw as { v?: unknown; audio?: unknown; obs?: unknown };
      socket.data.chatSoundReadyAt = Date.now();
      socket.data.chatSoundProtocol = typeof data.v === 'number' ? data.v : 0;
      socket.data.chatSoundAudio = typeof data.audio === 'string' && AUDIO_STATES.has(data.audio) ? data.audio : 'unsupported';
      socket.data.chatSoundObs = data.obs === true;
    });
    socket.on('disconnect', () => {
      owned.sockets.delete(socket);
      if (!owned.sockets.size && groups.get(channel) === owned) groups.delete(channel);
    });
  });
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    subscribeChatFeed(); // no-op while subscribed; retries after a failed subscribe
    void (async () => {
      for (const [channel, group] of groups) { try { await refresh(channel, group); } catch { /* Keep the last settings; retry next tick. */ } }
    })().finally(() => { busy = false; });
  }, LOOP_MS);
  timer.unref?.();
  const stop = () => { clearInterval(timer); stopChat(); groups.clear(); };
  io.on('close', stop);
  return stop;
}
