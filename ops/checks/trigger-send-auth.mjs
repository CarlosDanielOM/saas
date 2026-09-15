// Disposable saas-ops dependencies and mocked providers only.
// Verifies sendTrigger auth-failure messaging: revoked permissions ask the
// streamer to reauthenticate in the dashboard, transient refresh failures ask
// to retry, and a valid token reaches the trigger API with the streamer bearer.
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { TriggerSchema } from '/app/dist/schemas/trigger.schema.js';
import { MediaAssetSchema } from '/app/dist/schemas/media_asset.schema.js';

const mongo = await getMongoDBConnection('trigger-send-auth-check');
const redis = await getDragonflyClient('trigger-send-auth-check');

// Readiness of the actual bot entrypoint, without delivering chat messages.
let ready = false;
for (let i = 0; i < 60; i++) {
  try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, 'bot webhook ready and rejects unsigned events');

// Outbound HTTP stub: Twitch refresh fails transiently, the trigger API succeeds.
const apiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('id.twitch.tv')) return new Response('upstream down', { status: 500 });
  if (u.includes('/triggers/')) { apiCalls.push({ url: u, init }); return new Response(JSON.stringify({ error: false, message: 'Trigger sent', status: 200 }), { status: 200 }); }
  return realFetch(url, init);
};

const { sendTrigger } = await import('/app/dist/functions/triggers/send_trigger.trigger.js');
const data = { url: 'https://cdn.example.com/alert.mp3', mediaType: 'audio/mpeg', volume: 50 };
const REAUTH = "I don't have the permissions to perform this action. Please reauthenticate in the dashboard.";
const RENEW = 'Failed to renew permissions. Please try again later.';

// Revoked: tokens wiped (as invalidateStoredTwitchTokens leaves them), has_permissions=false.
await redis.hSet('accounts:twitch:998001:data', { id: '998001', name: 'revoked', has_permissions: 'false', access_token: '', refresh_token: '', expires_at: '' });
let result = await sendTrigger('998001', data);
assert.equal(result.error, true);
assert.equal(result.message, REAUTH);
assert.equal(apiCalls.length, 0, 'revoked account must not reach the trigger API');

// Transient: permissions granted, expired access token, Twitch refresh endpoint down.
await redis.hSet('accounts:twitch:998002:data', { id: '998002', name: 'transient', has_permissions: 'true', access_token: 'old', refresh_token: 'rt-present', expires_at: '1' });
result = await sendTrigger('998002', data);
assert.equal(result.error, true);
assert.equal(result.message, RENEW);
assert.equal(apiCalls.length, 0, 'failed refresh must not reach the trigger API');

// Success: usable cached token posts to the channel trigger endpoint.
const future = String(Math.floor(Date.now() / 1000) + 3600);
await redis.hSet('accounts:twitch:998003:data', { id: '998003', name: 'valid', has_permissions: 'true', access_token: 'streamer-token', refresh_token: 'rt-present', expires_at: future });
result = await sendTrigger('998003', data, true);
assert.equal(result.error, false, JSON.stringify(result));
assert.equal(result.message, 'Trigger sent');
assert.equal(apiCalls.length, 1);
assert.ok(apiCalls[0].url.endsWith('/triggers/998003/send'), apiCalls[0].url);
assert.equal(apiCalls[0].init.headers.Authorization, 'Bearer streamer-token');
assert.deepEqual(JSON.parse(apiCalls[0].init.body), { ...data, queue: true });

// End-to-end through the AST trigger.send handler for both account states.
const asset = await MediaAssetSchema.create({
  ownerUserID: 'u1', ownerChannelID: '998001', ownerChannelName: 'revoked', uploadedByUserID: 'u1',
  originalName: 'alert.mp3', displayName: 'alert', fileName: 'alert.mp3', extension: 'mp3',
  mimeType: 'audio/mpeg', mediaType: 'audio', bytes: 1234, bucket: 'test', s3Key: 'test/alert.mp3',
  storageUrl: 'https://cdn.example.com/alert.mp3', scope: 'private'
});
await TriggerSchema.create({ name: 'airhorn', channel: 'revoked', channelID: '998001', file: 'alert.mp3', mediaType: 'audio', isEnabled: true, volume: 50, assetID: asset._id });
await TriggerSchema.create({ name: 'airhorn', channel: 'valid', channelID: '998003', file: 'alert.mp3', mediaType: 'audio', isEnabled: true, volume: 50, assetID: asset._id });

const { registerTriggerFunctions } = await import('/app/dist/utils/ast_parser/functions/trigger.functions.js');
const { getFunctionHandler, createExecutionContext } = await import('/app/dist/utils/ast_parser/evaluator.js');
registerTriggerFunctions();
const handler = getFunctionHandler('trigger.send');
assert.ok(handler, 'trigger.send handler registered');

const revokedReply = await handler(['airhorn'], createExecutionContext({ broadcasterId: '998001', userId: '998001', userLogin: 'revoked' }));
assert.equal(revokedReply, REAUTH);
const validReply = await handler(['airhorn'], createExecutionContext({ broadcasterId: '998003', userId: '998003', userLogin: 'valid' }));
assert.equal(validReply, '', 'successful trigger.send stays silent in chat');
assert.equal(apiCalls.length, 2, 'AST path emitted the trigger to the API');
assert.ok(apiCalls[1].url.endsWith('/triggers/998003/send'), apiCalls[1].url);

await mongo.connection.close();
await redis.quit();
console.log('PASS: bot readiness, revoked permissions reauthenticate message, transient renew message, success path, AST trigger.send end-to-end for revoked and valid accounts');
process.exit(0);
