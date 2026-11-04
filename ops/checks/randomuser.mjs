// Exact-candidate check; use --dependency mongo --dependency redis and
// --test-env/--fixtures ops/checks/command-cooldown-fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { RandomUserSettingsSchema } from '/app/dist/schemas/randomuser_settings.schema.js';
import { getRandomUserBlacklist } from '/app/dist/utils/ast_parser/randomuser_settings.js';

assert.ok(['api', 'bot'].includes(process.env.SAAS_TARGET));
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test',
  'dist/utils/ast_parser/functions/user.functions.test.js',
  'dist/utils/ast_parser/randomuser_settings.test.js'], { stdio: 'inherit', timeout: 30000 });

const mongo = await getMongoDBConnection('randomuser-check');
const redis = await getDragonflyClient('randomuser-check');
const db = mongo.connection.db;
const owner = '71000111';
const other = '71000112';
await RandomUserSettingsSchema.updateOne({ channelID: owner }, { $set: { blacklist: ['nightbot'] } }, { upsert: true });
assert.deepEqual(await getRandomUserBlacklist(owner), ['nightbot']);
assert.deepEqual(await getRandomUserBlacklist(other), []);

if (process.env.SAAS_TARGET === 'api') {
  await db.collection('users').insertMany([
    { accounts: [{ type: 'twitch', id: owner, name: 'randomowner', actived: true }], plan_tier: 'free' },
    { accounts: [{ type: 'twitch', id: other, name: 'randomother', actived: true }], plan_tier: 'free' }
  ]);
  for (const [token, id, login] of [['ru-owner', owner, 'randomowner'], ['ru-other', other, 'randomother']]) {
    await redis.hSet(`token:${token}`, { id, login, display_name: login });
    await redis.hSet(`accounts:twitch:${id}:data`, { id, name: login });
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await fetch('http://127.0.0.1:3000/commands?limit=1'); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'API ready');
  const call = async (method, channel, body, token = 'ru-owner') => {
    const response = await fetch(`http://127.0.0.1:3000/commands/${channel}/randomuser-settings`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, json: await response.json() };
  };
  assert.equal((await call('GET', owner, undefined, null)).status, 401);
  assert.equal((await call('GET', owner, undefined, 'ru-other')).status, 403);
  assert.equal((await call('PUT', owner, { blacklist: ['alice'] }, 'ru-other')).status, 403);
  assert.deepEqual((await call('GET', owner)).json.blacklist, ['nightbot']);
  assert.equal((await call('PUT', owner, { blacklist: ['invalid name'] })).status, 400);
  assert.deepEqual((await call('PUT', owner, { blacklist: ['@Alice', 'alice', 'Bot_2'] })).json.blacklist, ['alice', 'bot_2']);
  assert.deepEqual((await call('GET', owner)).json.blacklist, ['alice', 'bot_2']);
  assert.deepEqual((await call('GET', other, undefined, 'ru-other')).json.blacklist, []);
  assert.deepEqual((await call('PUT', owner, { blacklist: [] })).json.blacklist, []);
  assert.deepEqual(await getRandomUserBlacklist(owner), []);
}
await redis.quit();
console.log(`PASS ${process.env.SAAS_TARGET}: randomuser selection, isolation, persistence and settings access`);
process.exit(0);
