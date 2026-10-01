import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import EventsubSchema from '/app/dist/schemas/eventsub.schema.js';
import { createUserIdentity } from '/app/dist/utils/permissions/index.js';
import { handleKeywords } from '/app/dist/handlers/keywords.handler.js';
import { commandHandler } from '/app/dist/handlers/commands.handler.js';
import { eventsubHandler } from '/app/dist/handlers/eventsub.handler.js';
import { KeywordIndexCache, matchKeywords } from '/app/dist/utils/keywords.js';
import { keywordIndexCache, refreshKeywordIndex } from '/app/dist/utils/keyword_cache.js';
await getMongoDBConnection('keywords-bot-check');
const redis = await getDragonflyClient('keywords-bot-check');
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'actual bot runtime accepts requests and rejects unsigned events');
await redis.set('app:twitch:token', 'dummy');
const viewer = createUserIdentity(1, []);
const mod = createUserIdentity(7, ['mod']);
const event = text => ({ chatter_user_id: 'viewer', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
  message_id: 'test-message', badges: [], message: { text } });
for (const [tier, min] of [['free', 5], ['premium', 3], ['pro', 1]]) {
  const channel = `keywords-${tier}`;
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: tier, chat_enabled: 'true' });
  const keyword = await CommandsSchema.create({ channelID: channel, channel, name: 'Ant', cmd: 'hormiga', func: 'custom',
    message: '$(upper hello) $(scount)', cooldown: min, activation: 'keyword', keywordSettings: { matchMode: 'anywhere' }, userLevel: 1 });
  const id = String(keyword._id);
  const cooldownKey = `command:execution:cooldown:${channel}:keyword:${id}`;
  await EventsubSchema.create({ channelID: channel, channel, type: 'stream.online', enabled: false,
    id: 'mock-online', status: 'enabled', version: '1', condition: { broadcaster_user_id: channel },
    created_at: new Date().toISOString(), transport: { method: 'webhook', callback: 'http://mock.invalid' }, cost: 0 });
  await eventsubHandler({ type: 'stream.online' }, { broadcaster_user_id: channel }, { durableChatHandled: true });
  assert.equal(JSON.parse(await redis.get(`keywords:index:${channel}`)).length, 1, 'stream-online preloads despite disabled announcements');
  // A fresh local cache recovers from Dragonfly; make Mongo fallback impossible.
  keywordIndexCache.invalidate(channel);
  const originalFind = CommandsSchema.find;
  CommandsSchema.find = () => { throw new Error('unexpected Mongo index fetch'); };
  assert.equal((await keywordIndexCache.get(channel)).size, 1);
  CommandsSchema.find = originalFind;
  const before = await redis.lLen('keywords:test:messages');
  await handleKeywords(channel, event('hormiguero'), viewer);
  assert.equal(await redis.lLen('keywords:test:messages'), before);
  await handleKeywords(channel, event('Vi una HORMIGA! hormiga'), viewer);
  assert.equal(await redis.lLen('keywords:test:messages'), before + 1);
  assert.equal(JSON.parse(await redis.lIndex('keywords:test:messages', -1)).message, 'HELLO 1');
  await Promise.all(Array.from({ length: 30 }, () => handleKeywords(channel, event('hormiga'), viewer)));
  assert.equal(await redis.lLen('keywords:test:messages'), before + 1);
  assert.equal((await CommandsSchema.findById(id)).count, 1, 'cooldown skips AST side effects');
  assert.ok(await redis.pTTL(cooldownKey) <= min * 1000 && await redis.pTTL(cooldownKey) > 0);
  await redis.del(cooldownKey);
  await handleKeywords(channel, event('hormiga'), viewer);
  assert.equal(JSON.parse(await redis.lIndex('keywords:test:messages', -1)).message, 'HELLO 2');

  // Runtime enforces the current tier even after a downgrade or legacy low value.
  await redis.del(cooldownKey);
  await redis.hSet(`accounts:twitch:${channel}:data`, 'plan_tier', 'free');
  await handleKeywords(channel, event('hormiga'), viewer);
  assert.ok(await redis.pTTL(cooldownKey) > 4000);

  await CommandsSchema.updateOne({ _id: id }, { userLevel: 7 });
  await refreshKeywordIndex(channel, id);
  await redis.del(cooldownKey);
  const currentCount = (await CommandsSchema.findById(id)).count;
  await handleKeywords(channel, event('hormiga'), viewer);
  assert.equal((await CommandsSchema.findById(id)).count, currentCount, 'permission denied does not execute');
  await handleKeywords(channel, event('hormiga'), mod);
  assert.equal((await CommandsSchema.findById(id)).count, currentCount + 1);

  await redis.del(cooldownKey);
  await handleKeywords(channel, { ...event('hormiga'), chatter_user_id: '698614112' }, mod);
  assert.equal(await redis.exists(cooldownKey), 0, 'bot cannot trigger its own keyword reply');
  const normal = await commandHandler(channel, event('!hormiga'), 'hormiga', '', { origin: 'chat', identity: mod });
  assert.equal(normal.error, true, '! lookup never executes a keyword');
  // Index updates cover all match modes; disabled keywords remain silent.
  for (const [mode, yes, no] of [['start', 'hormiga hoy', 'hoy hormiga'], ['exact', 'hormiga', 'hormiga hoy']]) {
    await CommandsSchema.updateOne({ _id: id }, { keywordSettings: { matchMode: mode } });
    await refreshKeywordIndex(channel, id);
    const index = await keywordIndexCache.get(channel);
    assert.equal(matchKeywords(index, yes).length, 1);
    assert.equal(matchKeywords(index, no).length, 0);
  }
  await CommandsSchema.create({ channelID: channel, channel, name: 'Normal ant', cmd: 'hormiga',
    func: 'custom', message: 'Nested normal', cooldown: 0, userLevel: 1 });
  await CommandsSchema.updateOne({ _id: id }, { message: '#(hormiga)' });
  await refreshKeywordIndex(channel, id);
  await redis.del(cooldownKey);
  await handleKeywords(channel, event('hormiga'), mod);
  assert.equal(JSON.parse(await redis.lIndex('keywords:test:messages', -1)).message, 'Nested normal',
    'keyword can reference a normal command with the same spelling without false recursion');
  await CommandsSchema.updateOne({ _id: id }, { enabled: false });
  await refreshKeywordIndex(channel, id);
  assert.equal((await keywordIndexCache.get(channel)).size, 0);
}
console.log('PASS: actual bot readiness, stream preload, Dragonfly restart recovery, AST functions, burst cooldowns, counters, tier downgrade, permissions, word rules and self-loop prevention');
process.exit(0);
