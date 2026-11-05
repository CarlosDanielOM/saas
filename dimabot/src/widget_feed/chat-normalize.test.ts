import assert from 'node:assert/strict';
import test from 'node:test';
import type { IChatMessage } from '../interfaces/twitch/eventsub.interface.js';
import { normalizeChatMessage, normalizeChatDelete, normalizeChatClear } from './chat-normalize.js';
import type { BadgeLookup } from './badges.js';

const empty: BadgeLookup = new Map();
function message(overrides: Partial<IChatMessage> = {}): IChatMessage {
  return {
    broadcaster_user_id: 'channel', chatter_user_id: 'viewer', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
    message_id: 'message', message: { text: 'hello', fragments: [{ type: 'text', text: 'hello' }] },
    message_type: 'text', badges: [], color: '', cheer: { bits: 0 }, ...overrides
  };
}

test('normalizes text, static/animated emotes, cheermotes and flat Twitch mentions without mutating input', () => {
  const event = message({ message: { text: 'hi Kappa Dance Cheer100 @Friend', fragments: [
    { type: 'text', text: 'hi ' },
    { type: 'emote', text: 'Kappa', emote: { id: '25', emote_set_id: '0', owner_id: '0', format: ['static'] } },
    { type: 'emote', text: 'Dance', emote: { id: 'dance', emote_set_id: '1', owner_id: '1', format: ['static', 'animated'] } },
    { type: 'cheermote', text: 'Cheer100', cheermote: { prefix: 'Cheer', bits: 100, tier: 100 } },
    // Real EventSub mentions are flat, unlike the current legacy IChatMessage definition.
    { type: 'mention', text: '@Friend', mention: { user_id: 'friend', user_login: 'friend', user_name: 'Friend' } } as unknown as IChatMessage['message']['fragments'][number]
  ] }, cheer: { bits: 100 } });
  const original = structuredClone(event);
  const result = normalizeChatMessage(event, empty, 123);
  assert.equal(result.id, 'message');
  assert.equal(result.platform, 'twitch');
  assert.equal(result.at, 123);
  assert.equal(result.text, event.message.text);
  assert.deepEqual(result.parts, [
    { type: 'text', text: 'hi ' },
    { type: 'emote', text: 'Kappa', id: '25', animated: false, images: {
      '1x': 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/1.0',
      '2x': 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0',
      '4x': 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0'
    } },
    { type: 'emote', text: 'Dance', id: 'dance', animated: true, images: {
      '1x': 'https://static-cdn.jtvnw.net/emoticons/v2/dance/animated/dark/1.0',
      '2x': 'https://static-cdn.jtvnw.net/emoticons/v2/dance/animated/dark/2.0',
      '4x': 'https://static-cdn.jtvnw.net/emoticons/v2/dance/animated/dark/3.0'
    } },
    { type: 'cheer', text: 'Cheer100', prefix: 'Cheer', bits: 100, tier: 100 },
    { type: 'mention', text: '@Friend', user: { id: 'friend', login: 'friend', name: 'Friend' } }
  ]);
  assert.equal(result.bits, 100);
  assert.deepEqual(event, original);
});

test('supports legacy nested mention data', () => {
  assert.deepEqual(normalizeChatMessage(message({ message: { text: '@Friend', fragments: [
    { type: 'mention', text: '@Friend', mention: { user: { user_id: 'friend', user_login: 'friend', user_name: 'Friend' } } }
  ] } }), empty).parts, [{ type: 'mention', text: '@Friend', user: { id: 'friend', login: 'friend', name: 'Friend' } }]);
});

test('maps badges, independent roles and subscriber months from info, not badge version', () => {
  const sets = ['broadcaster', 'moderator', 'vip', 'subscriber', 'artist-badge', 'staff', 'partner', 'turbo', 'premium'];
  const images = { '1x': 'one', '2x': 'two', '4x': 'four' };
  const result = normalizeChatMessage(message({ badges: sets.map(set_id => ({ set_id, id: '3000', info: set_id === 'subscriber' ? '18' : '' })) }),
    new Map([['subscriber/3000', { title: 'Subscriber', images }]]));
  assert.deepEqual(result.user.roles, { broadcaster: true, moderator: true, vip: true, subscriber: true, founder: false,
    artist: true, staff: true, partner: true, turbo: true, prime: true });
  assert.equal(result.user.subMonths, 18);
  assert.deepEqual(result.user.badges.find(badge => badge.set === 'subscriber'), { set: 'subscriber', version: '3000', info: '18', title: 'Subscriber', images });
  assert.deepEqual(result.user.badges[0], { set: 'broadcaster', version: '3000', info: '', title: 'broadcaster', images: { '1x': '', '2x': '', '4x': '' } });
});

test('founder counts as subscriber and invalid/missing month info remains null', () => {
  for (const info of ['24', '', 'NaN', '-1', '12oops']) {
    const result = normalizeChatMessage(message({ badges: [{ set_id: 'founder', id: '0', info }] }), empty);
    assert.equal(result.user.roles.founder, true);
    assert.equal(result.user.roles.subscriber, true);
    assert.equal(result.user.subMonths, info === '24' ? 24 : null);
  }
  assert.equal(normalizeChatMessage(message(), empty).user.subMonths, null);
});

test('maps every message kind; only user_intro marks firstMessage', () => {
  const kinds = { text: 'text', channel_points_highlighted: 'highlighted', channel_points_sub_only: 'text',
    user_intro: 'intro', power_ups_message_effect: 'power-up', power_ups_gigantify_emote: 'gigantified' } as const;
  for (const message_type of Object.keys(kinds) as IChatMessage['message_type'][]) {
    const result = normalizeChatMessage(message({ message_type }), empty);
    assert.equal(result.kind, kinds[message_type]);
    assert.equal(result.firstMessage, message_type === 'user_intro');
  }
});

test('strips ACTION wrappers from text and fragment edges, without stripping ordinary text', () => {
  for (const fragments of [[{ type: 'text' as const, text: '\u0001ACTION waves\u0001' }],
    [{ type: 'text' as const, text: '\u0001ACTION ' }, { type: 'text' as const, text: 'waves\u0001' }]]) {
    const result = normalizeChatMessage(message({ message: { text: '\u0001ACTION waves\u0001', fragments } }), empty);
    assert.equal(result.action, true);
    assert.equal(result.text, 'waves');
    assert.equal(result.parts.map(part => part.text).join(''), 'waves');
  }
  const result = normalizeChatMessage(message({ message: { text: 'ACTION waves', fragments: [{ type: 'text', text: 'ACTION waves' }] } }), empty);
  assert.equal(result.action, false);
  assert.equal(result.text, 'ACTION waves');
});

test('preserves reply, reward, color and foreign shared-chat source metadata', () => {
  const result = normalizeChatMessage(message({ color: '#123ABC', channel_points_custom_reward_id: 'reward', reply: {
    parent_message_id: 'parent', parent_message_body: 'quoted', parent_user_id: 'parent-user', parent_user_name: 'Parent', parent_user_login: 'parent',
    thread_user_id: 'thread', thread_user_name: 'Thread', thread_user_login: 'thread'
  }, source_broadcaster_user_id: 'other', source_message_id: 'source' }), empty);
  assert.deepEqual(result.reply, { id: 'parent', text: 'quoted', user: { id: 'parent-user', login: 'parent', name: 'Parent' } });
  assert.deepEqual(result.sharedChat, { channelId: 'other', messageId: 'source' });
  assert.equal(result.rewardId, 'reward');
  assert.equal(result.user.color, '#123ABC');
  for (const source_broadcaster_user_id of [undefined, null, '', 'channel']) {
    const local = normalizeChatMessage(message({ source_broadcaster_user_id }), empty);
    assert.equal(local.sharedChat, null);
    assert.equal(local.reply, null);
    assert.equal(local.rewardId, null);
    assert.equal(local.user.color, null);
  }
});

test('clamps text/fragment content to 2000 characters and parts to 200', () => {
  const long = 'x'.repeat(3000);
  const result = normalizeChatMessage(message({ message: { text: long, fragments: [{ type: 'text', text: long }] } }), empty);
  assert.equal(result.text.length, 2000);
  assert.equal(result.parts[0].text.length, 2000);
  const many = normalizeChatMessage(message({ message: { text: 'x'.repeat(300), fragments: Array.from({ length: 300 }, () => ({ type: 'text', text: 'x' })) } }), empty);
  assert.equal(many.parts.length, 200);
  const noFragments = normalizeChatMessage(message({ message: { text: 'hello', fragments: [] } }), empty);
  assert.deepEqual(noFragments.parts, [{ type: 'text', text: 'hello' }]);
});

test('normalizes targeted deletes and user/whole-chat clears using the target, never the reader user_id', () => {
  assert.deepEqual(normalizeChatDelete({ message_id: 'deleted', target_user_id: 'viewer', user_id: 'bot' }), { messageId: 'deleted', userId: 'viewer' });
  assert.deepEqual(normalizeChatDelete({ message_id: 'deleted' }), { messageId: 'deleted', userId: null });
  assert.deepEqual(normalizeChatClear('channel.chat.clear_user_messages', { target_user_id: 'viewer', user_id: 'bot' }), { userId: 'viewer' });
  assert.deepEqual(normalizeChatClear('channel.chat.clear', { user_id: 'bot', target_user_id: 'ignored' }), { userId: null });
});
