import type { DimaAlert, DimaBadge, DimaChat, DimaPart, DimaReward, DimaRoles, DimaTrigger, DimaTts, DimaUser } from './dima-events';

/** Studio test presets for custom widgets: realistic Twitch-shaped chat and alerts. */
export const CHAT_TESTS = ['viewer', 'subscriber', 'vip', 'moderator', 'broadcaster', 'first', 'emotes', 'reply', 'long', 'command'] as const;
export const ALERT_TESTS = ['follow', 'sub', 'resub', 'gift', 'giftBulk', 'bits', 'raid', 'tip'] as const;
export type ChatTest = typeof CHAT_TESTS[number];
export type AlertTest = typeof ALERT_TESTS[number];

const badgeImages = (uuid: string) => ({ '1x': `https://static-cdn.jtvnw.net/badges/v1/${uuid}/1`, '2x': `https://static-cdn.jtvnw.net/badges/v1/${uuid}/2`, '4x': `https://static-cdn.jtvnw.net/badges/v1/${uuid}/3` });
const BADGES: Record<string, DimaBadge> = {
  broadcaster: { set: 'broadcaster', version: '1', info: '', title: 'Broadcaster', images: badgeImages('5527c58c-fb7d-422d-b71b-f309dcb85cc1') },
  moderator: { set: 'moderator', version: '1', info: '', title: 'Moderator', images: badgeImages('3267646d-33f0-4b17-b3df-f923a41db1d0') },
  vip: { set: 'vip', version: '1', info: '', title: 'VIP', images: badgeImages('b817aba4-fad8-49e2-b88a-7cc744dfa6ec') },
  subscriber: { set: 'subscriber', version: '12', info: '14', title: '1-Year Subscriber', images: badgeImages('5d9f2208-5dd8-11e7-8513-2ff4adfae661') },
  partner: { set: 'partner', version: '1', info: '', title: 'Verified', images: badgeImages('d12a2e27-16f6-41d0-ab77-b780518f00a3') }
};
const emote = (id: string, text: string, animated = false): DimaPart => {
  const url = (scale: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/${animated ? 'animated' : 'static'}/dark/${scale}`;
  return { type: 'emote', text, id, animated, images: { '1x': url('1.0'), '2x': url('2.0'), '4x': url('3.0') } };
};
const NO_ROLES: DimaRoles = { broadcaster: false, moderator: false, vip: false, subscriber: false, founder: false, artist: false, staff: false, partner: false, turbo: false, prime: false };
const VIEWERS: Record<ChatTest, { login: string; name: string; color: string; badges: string[]; roles: Partial<DimaRoles>; months?: number }> = {
  viewer: { login: 'pixel_fox', name: 'Pixel_Fox', color: '#1E90FF', badges: [], roles: {} },
  subscriber: { login: 'hanayori', name: 'Hanayori', color: '#FF69B4', badges: ['subscriber'], roles: { subscriber: true }, months: 14 },
  vip: { login: 'yuzu', name: 'Yuzu', color: '#FF7F50', badges: ['vip', 'subscriber'], roles: { vip: true, subscriber: true }, months: 14 },
  moderator: { login: 'mod_kitsune', name: 'MOD_kitsune', color: '#00C853', badges: ['moderator', 'subscriber'], roles: { moderator: true, subscriber: true }, months: 14 },
  broadcaster: { login: 'streamer', name: 'Streamer', color: '#9146FF', badges: ['broadcaster', 'partner'], roles: { broadcaster: true, partner: true } },
  first: { login: 'new_bean', name: 'new_bean', color: '#B22222', badges: [], roles: {} },
  emotes: { login: 'nozomi', name: 'nozomi', color: '#DAA520', badges: ['subscriber'], roles: { subscriber: true }, months: 14 },
  reply: { login: 'sora', name: 'sora', color: '#8A2BE2', badges: [], roles: {} },
  long: { login: 'chatty_cat', name: 'chatty_cat', color: '#2E8B57', badges: [], roles: {} },
  command: { login: 'pixel_fox', name: 'Pixel_Fox', color: '#1E90FF', badges: [], roles: {} }
};
const MESSAGES: Record<ChatTest, (DimaPart | string)[]> = {
  viewer: ['the sparkles are everything'],
  subscriber: ['14 months already, love this community'],
  vip: ['VIP check-in, hydrate everyone!'],
  moderator: ['welcome in! remember to hydrate'],
  broadcaster: ['thanks for hanging out tonight'],
  first: ['hi! first time here, found you from a raid'],
  emotes: ['this stream ', emote('25', 'Kappa'), ' ', emote('425618', 'LUL'), ' so good ', emote('64138', 'SeemsGood')],
  reply: ['@hanayori same, the new overlay is so cute'],
  long: ['okay so I have been watching for like three hours now and I just want to say this is one of the coziest streams I have found in a long time, the music, the chat, the art, all of it'],
  command: ['!socials']
};
let sequence = 0;
const id = () => `test-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

export function testChat(kind: ChatTest, reply?: DimaChat | null): DimaChat {
  const viewer = VIEWERS[kind];
  const parts = MESSAGES[kind].map(part => typeof part === 'string' ? { type: 'text' as const, text: part } : part);
  const user: DimaUser = { id: `test-${viewer.login}`, login: viewer.login, name: viewer.name };
  return {
    id: id(), platform: 'twitch', at: Date.now(),
    user: { ...user, color: viewer.color, badges: viewer.badges.map(set => BADGES[set]), roles: { ...NO_ROLES, ...viewer.roles }, subMonths: viewer.months ?? null },
    text: parts.map(part => part.text).join(''), parts, kind: kind === 'first' ? 'intro' : 'text', action: false,
    firstMessage: kind === 'first', bits: 0, rewardId: null,
    reply: kind === 'reply' && reply ? { id: reply.id, user: { id: reply.user.id, login: reply.user.login, name: reply.user.name }, text: reply.text } : null,
    sharedChat: null
  };
}
const person = (login: string, name = login): DimaUser => ({ id: `test-${login}`, login, name });
export function testAlert(kind: AlertTest): DimaAlert {
  const base: DimaAlert = { id: id(), type: 'follow', at: Date.now(), test: true, user: person('luna', 'Luna'), amount: 1, tier: null, months: null, streak: null,
    message: null, recipient: null, currency: null, rule: null };
  switch (kind) {
    case 'follow': return base;
    case 'sub': return { ...base, type: 'sub', user: person('ame', 'Ame'), tier: '1000', months: 1, amount: 1 };
    case 'resub': return { ...base, type: 'resub', user: person('hanayori', 'Hanayori'), tier: '1000', months: 14, streak: 6, amount: 14, message: 'still here, still cozy' };
    case 'gift': return { ...base, type: 'gift', user: person('yuzu', 'Yuzu'), recipient: person('new_bean'), tier: '1000', amount: 1 };
    case 'giftBulk': return { ...base, type: 'gift', user: person('yuzu', 'Yuzu'), tier: '1000', amount: 5 };
    case 'bits': return { ...base, type: 'bits', user: person('ame', 'Ame'), amount: 500, message: 'Cheer500 for the cutest stream' };
    case 'raid': return { ...base, type: 'raid', user: person('sakura_streams', 'Sakura_Streams'), amount: 42 };
    case 'tip': return { ...base, type: 'tip', user: person('yuzu', 'Yuzu'), amount: 5, currency: 'USD', message: 'buy yourself a tea!' };
  }
}

/** Bot events and live state the Test drawer can send (all marked as tests). */
export const BOT_EVENT_TESTS = ['tts', 'trigger', 'reward'] as const;
export type BotEventTest = typeof BOT_EVENT_TESTS[number];
export const STATE_TESTS = ['polls', 'goals'] as const;
export type StateTest = typeof STATE_TESTS[number];

export function testTts(phase: 'start' | 'end', speechId = id()): DimaTts {
  return { id: speechId, phase, text: 'Yuzu says: the cozy stream continues!', user: person('yuzu', 'Yuzu'), reason: phase === 'end' ? 'ended' : null, at: Date.now(), test: true };
}
export function testTrigger(): DimaTrigger { return { id: id(), triggerId: '', name: 'Airhorn', mediaType: 'audio', at: Date.now(), test: true }; }
export function testReward(): DimaReward {
  return { id: id(), reward: { id: 'test-reward', title: 'Hydrate!', cost: 500 }, user: person('pix', 'Pix'), input: 'stay hydrated, chat', at: Date.now(), test: true };
}
/** A poll in progress and no prediction, in the shape Twitch polls arrive in. */
export function testPolls(): { poll: unknown; prediction: unknown } {
  const now = Date.now(), at = new Date(now).toISOString();
  return { poll: { kind: 'poll', id: 'test-poll', title: 'Next game?', phase: 'active', startedAt: at, deadline: new Date(now + 60_000).toISOString(), endedAt: null, winnerId: null,
    occurredAt: at, receipt: 'test', revision: 1, choices: [{ id: 'a', title: 'Celeste', votes: 12, users: 12, points: 0 }, { id: 'b', title: 'Hades', votes: 7, users: 7, points: 0 }, { id: 'c', title: 'Tetris', votes: 3, users: 3, points: 0 }] }, prediction: null };
}
/** Two goals like the Goals page makes (money in currency units). */
export function testGoals(): unknown[] {
  const now = Date.now();
  return [
    { id: 'test-follows', name: 'Road to 100 followers', metric: 'follows', mode: 'total', target: 100, current: 64, percent: 64, currency: null, status: 'active', startsAt: now - 86_400_000, endsAt: null, windowSeconds: null, period: null },
    { id: 'test-money', name: 'New microphone', metric: 'currency', mode: 'monthly', target: 250, current: 87.5, percent: 35, currency: 'USD', status: 'active', startsAt: now - 86_400_000, endsAt: null, windowSeconds: null, period: null }
  ];
}
