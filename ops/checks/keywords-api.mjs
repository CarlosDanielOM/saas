import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { keywordIndexCache, getKeywordBody, startKeywordCacheSubscription } from '/app/dist/utils/keyword_cache.js';
import { matchKeywords } from '/app/dist/utils/keywords.js';
await getMongoDBConnection('keywords-api-check');
const redis = await getDragonflyClient('keywords-api-check');
await startKeywordCacheSubscription();

async function request(channel, method, suffix = '', body, token = `keyword-${channel}`) {
  const response = await fetch(`http://127.0.0.1:3000/commands/${channel}${suffix}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}
for (const [tier, minimum] of [['free', 5], ['premium', 3], ['pro', 1]]) {
  const channel = `keyword-${tier}`;
  await redis.hSet(`token:keyword-${channel}`, { id: channel, login: channel, display_name: channel });
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: channel, plan_tier: tier });
  const body = { name: 'Ant', cmd: 'HORMIGA', func: 'custom', message: '$(upper hello) $(scount)', channel,
    activation: 'keyword', keywordSettings: { matchMode: 'anywhere' }, cooldown: minimum, userLevel: 1 };
  assert.equal((await request(channel, 'POST', '', body, '')).status, 401);
  await redis.hSet('token:outsider', { id: 'outsider', login: 'outsider', display_name: 'Outsider' });
  assert.equal((await request(channel, 'POST', '', body, 'outsider')).status, 403);
  for (const cooldown of [0, minimum - .1, '5']) {
    assert.equal((await request(channel, 'POST', '', { ...body, cooldown })).status, 400);
  }
  assert.equal((await request(channel, 'POST', '', { ...body, cmd: '!bad' })).status, 400);
  assert.equal((await request(channel, 'POST', '', { ...body, keywordSettings: { matchMode: 'regex' } })).status, 400);
  const created = await request(channel, 'POST', '', body);
  assert.equal(created.status, 200, JSON.stringify(created));
  const id = created.data.command._id;
  assert.equal(created.data.command.cmd, 'hormiga');
  assert.equal(created.data.command.cooldown, minimum);
  assert.equal((await request(channel, 'POST', '', body)).status, 409);
  assert.equal(matchKeywords(await keywordIndexCache.get(channel), 'una hormiga hoy').length, 1);
  assert.equal((await getKeywordBody(channel, id)).keywordSettings.matchMode, 'anywhere');

  // A !command and keyword may share the same spelling without sharing settings.
  const normal = await request(channel, 'POST', '', { ...body, cmd: 'hormiga', activation: 'command', keywordSettings: undefined });
  assert.equal(normal.status, 200, JSON.stringify(normal));
  const listed = await request(channel, 'GET');
  assert.equal(listed.data.commands.length, 1);
  assert.equal(listed.data.commands[0].activation, 'command');
  assert.equal((await request(channel, 'GET', '?activation=all')).data.commands.length, 2);
  assert.equal((await request(channel, 'PUT', `/${id}`, { activation: 'command' })).status, 400);
  assert.equal((await request(channel, 'PUT', `/${id}`, { cooldown: 0 })).status, 400);
  assert.equal((await request(channel, 'PUT', `/${id}`, { cmd: 'abeja', keywordSettings: { matchMode: 'start' }, message: 'Updated' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(matchKeywords(await keywordIndexCache.get(channel), 'una hormiga hoy').length, 0);
  assert.equal(matchKeywords(await keywordIndexCache.get(channel), 'abeja hoy').length, 1);
  assert.equal((await getKeywordBody(channel, id)).message, 'Updated');
  await request(channel, 'PUT', `/${id}`, { enabled: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await keywordIndexCache.get(channel)).size, 0);
  await request(channel, 'PUT', `/${id}`, { enabled: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await keywordIndexCache.get(channel)).size, 1);
  assert.equal((await request(channel, 'DELETE', `/${id}`)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await keywordIndexCache.get(channel)).size, 0);
  assert.equal(await getKeywordBody(channel, id), null);
  assert.equal(await CommandsSchema.countDocuments({ channelID: channel, activation: 'keyword' }), 0);
}
console.log('PASS: API authorization, plan cooldowns, validation, separate command/keyword names, add/edit/rename/toggle/delete refresh across Pub/Sub');
process.exit(0);
