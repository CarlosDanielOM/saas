// Disposable saas-ops dependencies and mocked providers only.
// Verifies sendTrigger auth-failure messaging: revoked permissions ask the
// streamer to reauthenticate in the dashboard, transient refresh failures ask
// to retry, and a valid token reaches the trigger API with the streamer bearer.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { TriggerSchema } from '/app/dist/schemas/trigger.schema.js';
import { MediaAssetSchema } from '/app/dist/schemas/media_asset.schema.js';

const mongo = await getMongoDBConnection('trigger-send-auth-check');
const redis = await getDragonflyClient('trigger-send-auth-check');

// Readiness of the actual bot entrypoint, without delivering chat messages.
let ready = process.env.SAAS_TRIGGER_RUNTIME === 'cron';
for (let i = 0; !ready && i < 60; i++) {
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
const validTrigger = await TriggerSchema.create({ name: 'airhorn', channel: 'valid', channelID: '998003', file: 'alert.mp3', mediaType: 'audio', isEnabled: true, volume: 50, assetID: asset._id });

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
assert.equal(JSON.parse(apiCalls[1].init.body).triggerId, String(validTrigger._id));
assert.equal(JSON.parse(apiCalls[1].init.body).name, 'airhorn');
// The bot signs the playback link with its own SECRET_KEY (same signature as the API) and says who fired it.
assert.ok(process.env.SECRET_KEY, 'SECRET_KEY set in the test env');
const k = createHmac('sha256', process.env.SECRET_KEY).update(`media:${asset._id}`).digest('base64url').slice(0, 22);
assert.equal(JSON.parse(apiCalls[1].init.body).url, `https://api.domdimabot.com/media/${asset._id}?k=${k}`);
assert.equal(JSON.parse(apiCalls[1].init.body).mediaType, 'audio/mpeg');
assert.deepEqual(JSON.parse(apiCalls[1].init.body).firedBy, { id: '998003', login: 'valid' }, 'empty display name omitted');
assert.equal(await handler(['airhorn'], createExecutionContext({ broadcasterId: '998003', userId: '555', userLogin: 'ada', userDisplayName: 'Ada' })), '');
assert.deepEqual(JSON.parse(apiCalls.at(-1).init.body).firedBy, { id: '555', login: 'ada', name: 'Ada' }, 'the chatter in the context');
assert.equal(await handler(['airhorn'], createExecutionContext({ broadcasterId: '998003' })), '');
assert.equal(Object.hasOwn(JSON.parse(apiCalls.at(-1).init.body), 'firedBy'), false, 'no user: no firedBy');
// A chat command through the real parser: the chatter from the event data.
const { parseSpecialCommands: parseCommand } = await import('/app/dist/handlers/special_parser.handler.js');
await parseCommand('$(trigger.send airhorn)', { channelID: '998003', scopeType: 'command', scopeName: 'horn', argument: '', userPlan: 'pro', userLevel: 10,
  eventData: { chatter_user_id: '777', chatter_user_login: 'pix', chatter_user_name: 'Pix', broadcaster_user_id: '998003', broadcaster_user_login: 'valid', broadcaster_user_name: 'Valid', badges: [] } });
assert.deepEqual(JSON.parse(apiCalls.at(-1).init.body).firedBy, { id: '777', login: 'pix', name: 'Pix' }, 'chat command chatter');
await TriggerSchema.updateOne({ _id: validTrigger._id }, { $set: { name: 'renamed horn' } });
assert.equal(await handler(['renamed', 'horn'], createExecutionContext({ broadcasterId: '998003', userId: '998003', userLogin: 'valid' })), '');
assert.equal(JSON.parse(apiCalls.at(-1).init.body).triggerId, String(validTrigger._id));
assert.equal(JSON.parse(apiCalls.at(-1).init.body).name, 'renamed horn');
// Scheduled commands use the same producer from the cron timer worker.
const { renderTimerMessage } = await import('/app/dist/utils/timer_runtime.js');
const { parseSpecialCommands } = await import('/app/dist/handlers/special_parser.handler.js');
const timerResult = await renderTimerMessage({ channelID: '998003', streamerName: 'valid', timerName: 'fixture', message: '$(trigger.send renamed horn)', planTier: 'pro', parse: parseSpecialCommands });
assert.equal(timerResult.parsedText, '');
assert.equal(JSON.parse(apiCalls.at(-1).init.body).triggerId, String(validTrigger._id));
assert.equal(Object.hasOwn(JSON.parse(apiCalls.at(-1).init.body), 'firedBy'), false, 'timers have no real chatter: no firedBy');

await mongo.connection.close();
await redis.quit();
console.log('PASS: runtime readiness, stable trigger IDs through AST commands, renames and scheduled timer rendering, revoked permissions reauthenticate message, transient renew message, success path, AST trigger.send end-to-end for revoked and valid accounts, signed playback link, firedBy from the chatter (context and chat command), none without a user or from a timer');
process.exit(0);
