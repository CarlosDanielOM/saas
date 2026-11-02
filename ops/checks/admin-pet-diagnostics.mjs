/** Exact-candidate read-only admin pet diagnostics; disposable Mongo/Redis and admin-credit-chat-fixtures. */
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { PetSettingsSchema } from '/app/dist/schemas/pet_settings.schema.js';
import { PetRuntime, PetRequest } from '/app/dist/schemas/pet_runtime.schema.js';
import { PetReadiness } from '/app/dist/pets/readiness.schema.js';
import { OAuthSession } from '/app/dist/schemas/oauth_session.schema.js';
import { OAuthGrant } from '/app/dist/schemas/oauth_grant.schema.js';
import { OAuthClient } from '/app/dist/schemas/oauth_client.schema.js';
import { petPeers } from '/app/dist/pets/peers.js';
import { getAdminPetDiagnostics } from '/app/dist/server/services/admin_pet_diagnostics.service.js';
assert.match(process.env.MONGO_URI, /saas_ops_admin_credit_chat_test$/);
const mongo = await getMongoDBConnection('admin-pet-check');
const redis = await getDragonflyClient('admin-pet-check');
const channelID = '99008801';
const user = await Users.create({ name: 'petfixture', plan_tier: 'premium', accounts: [{ type: 'twitch', id: channelID, name: 'petfixture' }] });
const other = await Users.create({ name: 'otherpet', accounts: [{ type: 'twitch', id: '99008809', name: 'otherpet' }] });
for (const login of ['cdom201', 'ordinary']) await redis.hSet(`token:${login}`, { id: login === 'cdom201' ? '99008802' : '99008803', login, display_name: login });
const call = async (channel = channelID, token = 'cdom201') => {
  const response = await fetch(`http://127.0.0.1:3000/admin-site/users/${channel}/pet-diagnostics`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, headers: response.headers, body: await response.json() };
};
assert.equal((await call(channelID, null)).status, 401);
assert.equal((await call(channelID, 'ordinary')).status, 403);
assert.equal((await call('bad')).status, 400);
assert.equal((await call('99009999')).status, 404);
let response = await call();
assert.equal(response.status, 200); assert.equal(response.body.data.configured, false);
assert.match(response.headers.get('cache-control'), /no-store/);
assert.equal(await PetSettingsSchema.countDocuments(), 0, 'observation creates no settings');
const ownerId = String(user._id);
const scopes = ['desktop:connect', 'pet:read', 'pet:receive'];
const grant = await OAuthGrant.create({ user_id: user._id, client_id: 'pet-diagnostic-fixture', channel_id: channelID, scopes });
await OAuthClient.create({ client_id: 'pet-diagnostic-fixture', name: 'Fixture', type: 'public', enabled: true, redirect_uris: [], allowed_scopes: scopes });
const session = await OAuthSession.create({ grant_id: grant._id, user_id: user._id, client_id: 'pet-diagnostic-fixture', channel_id: channelID,
  device_name: 'Fixture desktop', scopes, current_refresh_hash: 'SECRET_REFRESH_HASH', last_used_at: new Date(),
  expires_at: new Date(Date.now() + 86400000), idle_expires_at: new Date(Date.now() + 86400000) });
const sessionId = String(session._id);
await PetSettingsSchema.collection.insertOne({ userId: user._id, revision: 3, updatedAt: new Date(), settings: {
  enabled: true, appearance: { kind: 'vts' }, playback: { target: 'desktop', desktopSessionId: sessionId, vtsSessionId: sessionId }, personality: {prompt:'SECRET_PROMPT'} } });
await PetRuntime.create({ _id: ownerId, channelId: channelID, generation: 5, tokenHash: 'SECRET_OVERLAY_HASH' });
for (let i = 0; i < 12; i++) await PetRequest.collection.insertOne({ _id: `failure-${i}`, ownerId, channelId: channelID, actionKey: `failure-${i}`, status: 'cancelled',
  errorCode: 'player_disconnected', text: 'SECRET_REQUEST_TEXT', outputText: 'SECRET_REPLY', audio: {path:'SECRET_AUDIO'}, createdAt: new Date(Date.now()-i*1000), expiresAt:new Date(Date.now()+86400000) });
await PetRequest.collection.insertMany([
  {_id:'foreign-owner', ownerId:String(other._id), channelId:channelID,actionKey:'foreign-owner',status:'failed',errorCode:'foreign_owner',createdAt:new Date(),expiresAt:new Date(Date.now()+86400000)},
  {_id:'foreign-channel', ownerId,channelId:'99008809',actionKey:'foreign-channel',status:'failed',errorCode:'foreign_channel',createdAt:new Date(),expiresAt:new Date(Date.now()+86400000)}
]);
response = await call();
assert.equal(response.body.data.vts.session.authorization, 'valid'); assert.equal(response.body.data.vts.connected,false);
assert.equal(response.body.data.vts.ready,false); assert.equal(response.body.data.failures.length,10);
assert.ok(response.body.data.failures.every(row=>row.errorCode==='player_disconnected'));
assert.ok(!JSON.stringify(response.body).includes('SECRET_'));
const read = () => getAdminPetDiagnostics(ownerId, channelID);
const api = await PetReadiness.findById('api-instance').lean();
assert.ok(api?.apiInstanceId);
const readyRow = () => ({_id:ownerId,generation:5,settingsRevision:3,sessionId,peerId:'fixture-peer',apiInstanceId:api.apiInstanceId,
  validatedAt:new Date(),authorizationExpiresAt:new Date(Date.now()+60000),expiresAt:new Date(Date.now()+14000)});
await PetReadiness.collection.insertOne(readyRow());
assert.equal((await read()).vts.ready,false,'projection alone never proves a live selected peer');
petPeers.set('fixture-peer',{id:'fixture-peer',ownerId,channelId:channelID,kind:'desktop',sessionId,label:'Fixture desktop',socket:{connected:true},
  scopes,validatedAt:Date.now(),authorizationExpiresAt:Date.now()+60000,vtsReady:true,audioReady:true,
  revalidate:()=>{throw new Error('diagnostics must never revalidate');}});
let result = await read(); assert.equal(result.vts.ready,true); assert.equal(result.audio.ready,true);
const before = JSON.stringify(await Promise.all([PetSettingsSchema.findOne({userId:user._id}).lean(),PetRuntime.findById(ownerId).lean(),OAuthSession.findById(sessionId).lean(),PetReadiness.findById(ownerId).lean()]));
await read();
assert.equal(JSON.stringify(await Promise.all([PetSettingsSchema.findOne({userId:user._id}).lean(),PetRuntime.findById(ownerId).lean(),OAuthSession.findById(sessionId).lean(),PetReadiness.findById(ownerId).lean()])),before,'read leaves settings/runtime/session/readiness unchanged');
for (const update of [
  {expiresAt:new Date(Date.now()-1)}, {apiInstanceId:'previous-api'}, {settingsRevision:2}, {generation:4}, {sessionId:'different'},
]) {
 await PetReadiness.replaceOne({_id:ownerId},{...readyRow(),...update}); result=await read();
 assert.equal(result.vts.ready,false); assert.equal(result.vts.projection.status,'stale');
}
await PetReadiness.replaceOne({_id:ownerId},readyRow());
petPeers.get('fixture-peer').validatedAt=Date.now()-16000;
assert.equal((await read()).vts.ready,false,'stale local authorization is not ready');
petPeers.get('fixture-peer').validatedAt=Date.now();
petPeers.get('fixture-peer').authorizationExpiresAt=Date.now()-1;
assert.equal((await read()).vts.ready,false,'expired access-token proof is not ready');
petPeers.get('fixture-peer').authorizationExpiresAt=Date.now()+60000;
await OAuthGrant.updateOne({_id:grant._id},{$set:{revoked_at:new Date()}});
assert.equal((await read()).vts.session.authorization,'revoked');assert.equal((await read()).vts.ready,false);
await OAuthGrant.updateOne({_id:grant._id},{$set:{revoked_at:null}});
await OAuthClient.updateOne({client_id:session.client_id},{$set:{enabled:false}});
assert.equal((await read()).vts.session.authorization,'client_disabled');
await OAuthClient.updateOne({client_id:session.client_id},{$set:{enabled:true}});
await OAuthSession.updateOne({_id:sessionId},{$set:{idle_expires_at:new Date(Date.now()-1)}});
assert.equal((await read()).vts.session.authorization,'expired');
await OAuthSession.updateOne({_id:sessionId},{$set:{idle_expires_at:new Date(Date.now()+86400000),scopes:['desktop:connect']}});
assert.equal((await read()).vts.session.authorization,'insufficient_scope');
await OAuthSession.updateOne({_id:sessionId},{$set:{user_id:other._id}});
result=await read();assert.equal(result.vts.session,null);assert.equal(result.vts.connected,false);assert.equal(result.vts.ready,false);
await PetSettingsSchema.updateOne({userId:user._id},{$set:{'settings.playback.vtsSessionId':null}});
assert.equal((await read()).vts.selectedSessionId,null);
await PetSettingsSchema.updateOne({userId:user._id},{$set:{'settings.appearance.kind':'png'}});
assert.equal((await read()).appearance,'png');
petPeers.clear();
console.log('PASS admin pet diagnostics: HTTP authorization/validation, privacy, scoped bounded history, no mutation, selected peer plus fenced readiness, stale/expired proof, revoked grant, disabled client, expired/missing/foreign sessions, missing scopes and PNG');
process.exit(0);
