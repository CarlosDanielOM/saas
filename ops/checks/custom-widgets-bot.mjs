// saas-ops only (bot target): disposable Mongo/Redis; stage ops/checks/keywords-fixtures as --fixtures and use its
// test-env.json. Signed EventSub webhooks go to the candidate's own bot runtime (port 3333) and the check listens on the
// Dragonfly `widget-feed` channel: chat is normalized for custom widgets only while a widget wants chat (demand key),
// message deletes and clears are forwarded, and shared-chat copies reach widgets without running bot actions.
// A chat command with $(widget.signal …) publishes signals (no demand needed) with the verified sender, once per message;
// channel-point redemptions publish reward events.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';

const secret = process.env.TWITCH_EVENTSUB_SECRET, channel = '990777';
const redis = await getDragonflyClient('custom-widgets-bot-check');
await getMongoDBConnection('custom-widgets-bot-check');
await redis.set('app:twitch:token', 'dummy');
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

  // !feed pizza → the real command handler → signals on the widget feed + the chat reply.
  const pets = '990778';
  await redis.hSet(`accounts:twitch:${pets}:data`, { id: pets, name: 'petfixture', plan_tier: 'free', chat_enabled: 'true' });
  await CommandsSchema.create({ channelID: pets, channel: 'petfixture', name: 'Feed', cmd: 'feed', func: 'feed', cooldown: 0, userLevel: 1,
    message: '$(user) fed Mochi! $(widget.signal feed &p1) $(widget.signal.to "Pet corner" focus)' });
  const petChat = (id, text) => chat(id, text, { broadcaster_user_id: pets, broadcaster_user_login: 'petfixture', broadcaster_user_name: 'PetFixture',
    message: { text, fragments: [{ type: 'text', text, emote: null, cheermote: null, mention: null }] } });
  await webhook('channel.chat.message', petChat('p1', '!feed pizza'), { broadcaster_user_id: pets, user_id: '698614112' });
  const fed = await until(() => feed.find(item => item.type === 'signal' && item.data.name === 'feed'), 'feed signal');
  assert.deepEqual([fed.channel, fed.data.value, fed.data.args, fed.data.user.login, fed.data.user.name, fed.data.user.roles.moderator, fed.data.user.roles.subscriber, fed.data.user.roles.broadcaster, fed.data.source, fed.data.target],
    [pets, 'pizza', ['pizza'], 'ada', 'Ada', true, true, false, { kind: 'command', name: 'feed' }, null]);
  assert.equal((await until(() => feed.find(item => item.type === 'signal' && item.data.name === 'focus'), 'focus signal')).data.target, 'Pet corner');
  let replies = [];
  for (let i = 0; i < 100 && !replies.length; i++) { replies = (await redis.lRange('keywords:test:messages', 0, -1)).map(item => JSON.parse(item)).filter(body => body.broadcaster_id === pets); if (!replies.length) await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(replies.map(body => body.message), ['Ada fed Mochi!'], 'the chat reply keeps its text; signals add nothing to chat');
  // The same chat message delivered again (EventSub retry with a new notification ID) sends no second signal.
  await webhook('channel.chat.message', petChat('p1', '!feed pizza'), { broadcaster_user_id: pets, user_id: '698614112' });
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(feed.filter(item => item.type === 'signal' && item.data.name === 'feed').length, 1, 'a redelivered chat message sends no second signal');
  console.log('PASS a chat command with $(widget.signal) sends signals with the verified sender (badge roles) and its chat reply, once per chat message.');

  // A channel-point redemption (signed EventSub) reaches the widget feed for widgets that use rewards (no reward setup needed).
  await webhook('channel.channel_points_custom_reward_redemption.add', { id: 'redeem-77', broadcaster_user_id: pets, broadcaster_user_login: 'petfixture', broadcaster_user_name: 'PetFixture',
    user_id: '55', user_login: 'ada', user_name: 'Ada', user_input: 'pet the cat', status: 'unfulfilled', redeemed_at: new Date().toISOString(),
    reward: { id: 'reward-1', title: 'Pet the cat', cost: 300, prompt: 'Say something nice' } }, { broadcaster_user_id: pets });
  const reward = await until(() => feed.find(item => item.type === 'reward' && item.data.id === 'redeem-77'), 'reward event');
  assert.deepEqual([reward.channel, reward.data.reward, reward.data.user, reward.data.input, 'prompt' in reward.data.reward], [pets, { id: 'reward-1', title: 'Pet the cat', cost: 300 }, { id: '55', login: 'ada', name: 'Ada' }, 'pet the cat', false]);
  console.log('PASS channel-point redemptions reach the widget feed (reward, viewer, their text).');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await subscriber.quit().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
