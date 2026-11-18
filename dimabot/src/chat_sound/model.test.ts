import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_SOUND_DEFAULTS, ChatSoundError, normalizeSettings, parseSettings, popDecision, type ChatLike, type ChatSoundSettings, type PopClock } from './model.js';
import { TWITCH_BOT_ACCOUNT_ID } from '../utils/header.js';

const CHANNEL = '533538623';
const settings = (patch: Partial<ChatSoundSettings> = {}): ChatSoundSettings => ({ ...CHAT_SOUND_DEFAULTS, ...patch });
const chat = (patch: Partial<{ id: string; login: string; text: string; shared: string }> = {}): ChatLike => ({
  user: { id: patch.id ?? '111', login: patch.login ?? 'viewer' }, text: patch.text ?? 'hi',
  sharedChat: patch.shared ? { channelId: patch.shared } : null
});
const clock = (): PopClock => ({ lastPopAt: 0, lastChatAt: 0 });

test('parseSettings accepts the full form and rejects anything else', () => {
  assert.deepEqual(parseSettings({ ...CHAT_SOUND_DEFAULTS }), CHAT_SOUND_DEFAULTS);
  assert.deepEqual(parseSettings({ ...CHAT_SOUND_DEFAULTS, cooldownSeconds: 0.25, quietMinutes: 120, volume: 0 }), { ...CHAT_SOUND_DEFAULTS, cooldownSeconds: 0.25, quietMinutes: 120, volume: 0 });
  const bad: unknown[] = [null, [], 'x', { ...CHAT_SOUND_DEFAULTS, extra: 1 }, { ...CHAT_SOUND_DEFAULTS, enabled: 'yes' },
    { ...CHAT_SOUND_DEFAULTS, volume: 101 }, { ...CHAT_SOUND_DEFAULTS, volume: 50.5 }, { ...CHAT_SOUND_DEFAULTS, volume: '70' },
    { ...CHAT_SOUND_DEFAULTS, cooldownSeconds: 0.1 }, { ...CHAT_SOUND_DEFAULTS, cooldownSeconds: 61 }, { ...CHAT_SOUND_DEFAULTS, cooldownSeconds: Number.NaN },
    { ...CHAT_SOUND_DEFAULTS, quietMinutes: -1 }, { ...CHAT_SOUND_DEFAULTS, quietMinutes: 1.5 }, { ...CHAT_SOUND_DEFAULTS, quietMinutes: 121 }];
  const { ignoreSharedChat: _omit, ...missing } = CHAT_SOUND_DEFAULTS;
  bad.push(missing);
  for (const input of bad) assert.throws(() => parseSettings(input), (e: unknown) => e instanceof ChatSoundError && e.status === 400, JSON.stringify(input));
});

test('normalizeSettings repairs stored fields one by one', () => {
  assert.deepEqual(normalizeSettings(undefined), CHAT_SOUND_DEFAULTS);
  assert.deepEqual(normalizeSettings({ volume: 300, enabled: false, cooldownSeconds: 5, quietMinutes: 'x' }), { ...CHAT_SOUND_DEFAULTS, enabled: false, cooldownSeconds: 5 });
});

test('a viewer message pops; cooldown holds back a burst', () => {
  const c = clock();
  assert.deepEqual(popDecision(CHANNEL, chat(), settings(), c, 10_000), { pop: true });
  assert.deepEqual(popDecision(CHANNEL, chat(), settings(), c, 10_500), { pop: false, reason: 'cooldown' });
  assert.deepEqual(popDecision(CHANNEL, chat(), settings(), c, 11_000), { pop: true });
  assert.deepEqual(popDecision(CHANNEL, chat(), settings({ cooldownSeconds: 0.25 }), c, 11_250), { pop: true });
});

test('filters: bots, own messages, commands, shared chat; off means silent', () => {
  for (const [message, reason] of [[chat({ id: TWITCH_BOT_ACCOUNT_ID, login: 'domdimabot' }), 'bot'], [chat({ login: 'Nightbot' }), 'bot'],
    [chat({ id: CHANNEL, login: 'cdom201' }), 'self']] as const) assert.deepEqual(popDecision(CHANNEL, message, settings(), clock(), 5000), { pop: false, reason });
  assert.deepEqual(popDecision(CHANNEL, chat({ login: 'nightbot' }), settings({ ignoreBots: false }), clock(), 5000), { pop: true });
  assert.deepEqual(popDecision(CHANNEL, chat({ id: CHANNEL }), settings({ ignoreSelf: false }), clock(), 5000), { pop: true });
  assert.deepEqual(popDecision(CHANNEL, chat({ text: '  !duel @x' }), settings(), clock(), 5000), { pop: true }, 'commands pop by default');
  assert.deepEqual(popDecision(CHANNEL, chat({ text: '  !duel @x' }), settings({ ignoreCommands: true }), clock(), 5000), { pop: false, reason: 'command' });
  assert.deepEqual(popDecision(CHANNEL, chat({ shared: '42' }), settings(), clock(), 5000), { pop: true }, 'shared chat pops by default');
  assert.deepEqual(popDecision(CHANNEL, chat({ shared: '42' }), settings({ ignoreSharedChat: true }), clock(), 5000), { pop: false, reason: 'shared' });
  assert.deepEqual(popDecision(CHANNEL, chat(), settings({ enabled: false }), clock(), 5000), { pop: false, reason: 'disabled' });
  assert.deepEqual(popDecision(CHANNEL, { user: null, text: 42 } as ChatLike, settings(), clock(), 5000), { pop: true }, 'odd payloads never throw');
});

test('quiet mode pops only the first message after the silence; ignored messages do not break the silence', () => {
  const c = clock(), quiet = settings({ quietMinutes: 2 });
  assert.equal(popDecision(CHANNEL, chat(), quiet, c, 1_000).pop, true, 'first message since the source connected');
  assert.deepEqual(popDecision(CHANNEL, chat(), quiet, c, 60_000), { pop: false, reason: 'quiet' });
  assert.deepEqual(popDecision(CHANNEL, chat(), quiet, c, 170_000), { pop: false, reason: 'quiet' }, 'the held message still counts as chat');
  assert.deepEqual(popDecision(CHANNEL, chat({ login: 'nightbot' }), quiet, c, 280_000), { pop: false, reason: 'bot' });
  assert.equal(popDecision(CHANNEL, chat(), quiet, c, 290_001).pop, true, 'two quiet minutes after the last real message');
});
