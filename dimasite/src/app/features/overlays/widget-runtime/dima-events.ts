/** Dima SDK v1 event shapes (dimabot/CUSTOM_WIDGET_ENGINE.md, section 4). Data only; shared by the host, tests and fixtures. */
export type DimaPlatform = 'twitch';
export interface DimaUser { id: string; login: string; name: string }
export interface DimaImages { '1x': string; '2x': string; '4x': string }
export interface DimaBadge { set: string; version: string; info: string; title: string; images: DimaImages }
export interface DimaRoles {
  broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean; founder: boolean;
  artist: boolean; staff: boolean; partner: boolean; turbo: boolean; prime: boolean;
}
export type DimaPart =
  | { type: 'text'; text: string }
  | { type: 'emote'; text: string; id: string; animated: boolean; images: DimaImages }
  | { type: 'cheer'; text: string; prefix: string; bits: number; tier: number }
  | { type: 'mention'; text: string; user: DimaUser };
export interface DimaChat {
  id: string; platform: DimaPlatform; at: number;
  user: DimaUser & { color: string | null; badges: DimaBadge[]; roles: DimaRoles; subMonths: number | null };
  text: string; parts: DimaPart[]; kind: 'text' | 'highlighted' | 'intro' | 'power-up' | 'gigantified';
  action: boolean; firstMessage: boolean; bits: number; rewardId: string | null;
  reply: { id: string; user: DimaUser; text: string } | null;
  sharedChat: { channelId: string; messageId: string } | null;
}
export interface DimaChatDelete { messageId: string; userId: string | null }
export interface DimaChatClear { userId: string | null }
export type DimaAlertType = 'follow' | 'sub' | 'resub' | 'gift' | 'bits' | 'raid' | 'tip';
export interface DimaAlert {
  id: string; type: DimaAlertType; at: number; test: boolean;
  user: DimaUser | null; amount: number;
  tier: '1000' | '2000' | '3000' | 'prime' | null; months: number | null; streak: number | null;
  message: string | null; recipient: DimaUser | null; currency: string | null; rule: { id: string; name: string } | null;
}
export interface DimaButton { field: string; value: unknown }
/** `namespace` is `se` for StreamElements widgets and the widget id for Dima widgets; frames only see their own. */
export interface DimaStorageUpdate { key: string; value: unknown; namespace?: string }
/** A named message from a command (`$(widget.signal …)`) or a Studio test. `value` is viewer text: show it with textContent. */
export interface DimaSignal {
  id: string; name: string; value: string; json: unknown; args: string[]; at: number;
  user: { id: string; login: string; name: string; roles: { broadcaster: boolean; moderator: boolean; vip: boolean; subscriber: boolean } } | null;
  source: { kind: 'command' | 'keyword' | 'event' | 'studio'; name: string };
  /** Layer name for widget.signal.to (null: every layer that uses signals). */
  target: string | null;
}
/** Live state by name (`Dima.state(name, …)`); the name is also the widget.json `uses` entry that allows it. */
export interface DimaState { name: 'polls' | 'goals' | 'hypetrain' | 'ads'; value: unknown }
/** A text-to-speech message started or finished playing (text is the filtered text that was spoken). */
export interface DimaTts { id: string; phase: 'start' | 'end'; text: string; user: DimaUser | null; reason: string | null; at: number; test: boolean }
/** A trigger alert (sound/video/image from Trigger alerts) was sent to the overlay. */
export interface DimaTrigger { id: string; triggerId: string; name: string; mediaType: string; at: number; test: boolean }
/** A channel-point reward was redeemed (input is the viewer's text, if the reward asks for one). */
export interface DimaReward { id: string; reward: { id: string; title: string; cost: number }; user: DimaUser | null; input: string | null; at: number; test: boolean }
/** The channel's pet started (`speaking`) or finished (`done`) a reply; text is what it said. */
export interface DimaPet { id: string; kind: 'talk' | 'ask' | 'tts'; phase: 'speaking' | 'done'; text: string; mood: string | null; result: 'completed' | 'stopped' | null; at: number; test: boolean }
/** A duel started (fighters only) or ended (winner and loser, after the fight). Names are Twitch logins. */
export interface DimaDuel { id: string; phase: 'started' | 'ended'; challenger: string; opponent: string; mode: 'overlay' | 'chat'; winner: string | null; loser: string | null; endsAt: number | null; at: number; test: boolean }
/** A roulette started spinning, then its result (label) when the spin ends. */
export interface DimaRoulette { id: string; rouletteId: string; name: string; phase: 'spinning' | 'result'; label: string | null; endsAt: number; at: number; test: boolean }
/** A DimaFX item was bought and is playing (the buyer only when Twitch shared their identity). */
export interface DimaDimafx { id: string; item: { id: string; name: string; type: string }; source: 'bits' | 'credits' | 'saved' | 'test'; bits: number | null; credits: number | null; user: DimaUser | null; message: string | null; at: number; test: boolean }
/** Live state "hypetrain": the running (or just ended) hype train; null when there is none. Times are ms. */
export interface DimaHypeTrain {
  id: string; phase: 'active' | 'ended'; level: number; total: number; progress: number | null; goal: number | null;
  topContributions: { user: DimaUser; type: 'bits' | 'subscription' | 'other'; total: number }[]; allTimeHigh: { level: number; total: number } | null;
  type: 'regular' | 'golden_kappa' | 'treasure'; shared: boolean; sharedParticipants: DimaUser[];
  startedAt: number; expiresAt: number | null; endedAt: number | null; cooldownEndsAt: number | null;
}
/** Live state "ads": the running ad break (null when none) and Twitch's ad schedule (null when unknown). Times are ms. */
export interface DimaAds {
  active: { startedAt: number; endsAt: number; duration: number; automatic: boolean } | null;
  schedule: { nextAt: number | null; duration: number | null; lastAt: number | null; snoozes: number | null; snoozeRefreshAt: number | null; prerollFreeUntil: number | null } | null;
}
/**
 * StreamElements-style session snapshot: `data` keys like `follower-latest`, `cheer-session`, `subscriber-recent`.
 * The server also sends `goalsBySource.twitch` (the `*-goal` values for Twitch-sourced layers); frames never get it.
 */
export interface DimaSession { data: Record<string, unknown>; recents: unknown[]; goalsBySource?: { twitch?: Record<string, { amount: number }> } }
export type DimaEvent =
  | { type: 'chat'; data: DimaChat }
  | { type: 'chat.delete'; data: DimaChatDelete }
  | { type: 'chat.clear'; data: DimaChatClear }
  | { type: 'alert'; data: DimaAlert }
  | { type: 'button'; data: DimaButton }
  | { type: 'storage'; data: DimaStorageUpdate }
  | { type: 'session'; data: DimaSession }
  | { type: 'signal'; data: DimaSignal }
  | { type: 'state'; data: DimaState }
  | { type: 'tts'; data: DimaTts }
  | { type: 'trigger'; data: DimaTrigger }
  | { type: 'reward'; data: DimaReward }
  | { type: 'pet'; data: DimaPet }
  | { type: 'duel'; data: DimaDuel }
  | { type: 'roulette'; data: DimaRoulette }
  | { type: 'dimafx'; data: DimaDimafx };
export type DimaEventType = DimaEvent['type'];
/** Which manifest `uses` entry lets a widget receive each event. Buttons are editor-only and always allowed. */
export const EVENT_USES: Record<DimaEventType, string | null> = {
  chat: 'chat', 'chat.delete': 'chat', 'chat.clear': 'chat', alert: 'alerts', button: null, storage: 'storage', session: 'session', signal: 'signals',
  // State is allowed per name (`polls`, `goals`): see eventUse().
  state: null, tts: 'tts', trigger: 'triggers', reward: 'rewards', pet: 'pets', duel: 'duels', roulette: 'roulette', dimafx: 'dimafx'
};
/** The `uses` entry an event needs (null: always allowed). */
export const eventUse = (event: DimaEvent): string | null => event.type === 'state' ? event.data.name : EVENT_USES[event.type];
