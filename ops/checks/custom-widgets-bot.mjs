// saas-ops only (bot target): disposable Mongo/Redis; stage ops/checks/keywords-fixtures as --fixtures and use its
// test-env.json. Signed EventSub webhooks go to the candidate's own bot runtime (port 3333) and the check listens on the
// Dragonfly `widget-feed` channel: chat is normalized for custom widgets only while a widget wants chat (demand key),
// message deletes and clears are forwarded, and shared-chat copies reach widgets without running bot actions.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';

const secret = process.env.TWITCH_EVENTSUB_SECRET, channel = '990777';
const redis = await getDragonflyClient('custom-widgets-bot-check');
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'bot runtime accepts requests and rejects unsigned events');
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'widgetfixture', plan_tier: 'pro', chat_enabled: 'false' });

const feed = [];
const subscriber = redis.duplicate(); await subscriber.connect();
await subscriber.subscribe('widget-feed', message => feed.push(JSON.parse(message)));
async function webhook(type, event, condition = { broadcaster_user_id: channel, user_id: '698614112' }) {
  const id = randomUUID(), timestamp = new Date().toISOString();
  const body = JSON.stringify({ subscription: { id: randomUUID(), type, version: '1', status: 'enabled', condition, transport: { method: 'webhook' }, created_at: timestamp, cost: 0 }, event });
  const signature = 'sha256=' + createHmac('sha256', secret).update(id + timestamp + body).digest('hex');
  const response = await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', body, headers: { 'Content-Type': 'application/json',
    'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': signature, 'Twitch-Eventsub-Message-Type': 'notification' } });
  assert(response.status < 300, `${type} accepted (${response.status})`);
}
const until = async (fn, label) => { for (let i = 0; i < 100; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out: ' + label); };
const chat = (id, text, extra = {}) => ({ broadcaster_user_id: channel, broadcaster_user_login: 'widgetfixture', broadcaster_user_name: 'WidgetFixture',
  chatter_user_id: '55', chatter_user_login: 'ada', chatter_user_name: 'Ada', message_id: id, color: '#FF0000', message_type: 'text', cheer: null, reply: null,
  badges: [{ set_id: 'subscriber', id: '12', info: '14' }, { set_id: 'moderator', id: '1', info: '' }],
  message: { text, fragments: [{ type: 'text', text: 'hi ', emote: null, cheermote: null, mention: null }, { type: 'emote', text: 'Kappa', emote: { id: '25', emote_set_id: '0', owner_id: '0', format: ['static'] }, cheermote: null, mention: null }] }, ...extra });

try {
  // No widget wants chat yet: nothing is built or published.
  await webhook('channel.chat.message', chat('m0', 'hi Kappa'));
  await new Promise(r => setTimeout(r, 600));
  assert.equal(feed.length, 0, 'no demand, no widget feed');

  // Demand appears (the API sets it while a chat widget is connected); the bot caches a "no" for up to 5 s.
  await redis.set(`widget-feed:demand:${channel}`, '1', { EX: 60 });
  await new Promise(r => setTimeout(r, 5200));
  await webhook('channel.chat.message', chat('m1', 'hi Kappa'));
  const message = await until(() => feed.find(item => item.type === 'chat' && item.data.id === 'm1'), 'normalized chat');
  assert.equal(message.channel, channel);
  assert.deepEqual([message.data.user.name, message.data.user.color, message.data.user.roles.subscriber, message.data.user.roles.moderator, message.data.user.subMonths], ['Ada', '#FF0000', true, true, 14]);
  assert.deepEqual(message.data.parts.map(part => part.type), ['text', 'emote']);
  assert.equal(message.data.parts[1].images['1x'], 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/1.0');
  assert.equal(message.data.firstMessage, false);
  await webhook('channel.chat.message', chat('m2', 'hello', { message_type: 'user_intro' }));
  assert.equal((await until(() => feed.find(item => item.data?.id === 'm2'), 'intro chat')).data.firstMessage, true);
  console.log('PASS chat reaches the widget feed only with demand, normalized (roles, sub months, emotes, first-time) even when the bot\'s chat replies are off.');

  await webhook('channel.chat.message_delete', { broadcaster_user_id: channel, target_user_id: '55', target_user_login: 'ada', target_user_name: 'Ada', message_id: 'm1' });
  assert.deepEqual((await until(() => feed.find(item => item.type === 'chat.delete'), 'delete')).data, { messageId: 'm1', userId: '55' });
  await webhook('channel.chat.clear_user_messages', { broadcaster_user_id: channel, target_user_id: '55', target_user_login: 'ada', target_user_name: 'Ada' });
  assert.deepEqual((await until(() => feed.find(item => item.type === 'chat.clear' && item.data.userId), 'clear user')).data, { userId: '55' });
  await webhook('channel.chat.clear', { broadcaster_user_id: channel });
  await until(() => feed.find(item => item.type === 'chat.clear' && item.data.userId === null), 'clear chat');
  console.log('PASS message deletes, user clears and whole-chat clears are forwarded.');

  // A shared-chat copy from another channel still shows in widgets, without bot actions.
  await webhook('channel.chat.message', chat('m3', 'from a shared chat', { source_broadcaster_user_id: '123', source_message_id: 'orig-3' }));
  const shared = await until(() => feed.find(item => item.data?.id === 'm3'), 'shared chat');
  assert.deepEqual(shared.data.sharedChat, { channelId: '123', messageId: 'orig-3' });
  console.log('PASS shared-chat copies reach widgets.');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await subscriber.quit().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
