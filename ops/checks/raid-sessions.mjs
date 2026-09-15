// Run only through saas-ops with disposable Mongo/Redis and provider mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { RaidSessionSchema as Sessions, RaidFollowerSchema as Followers, RaidModerationRequestSchema as Requests } from '/app/dist/schemas/raid_session.schema.js';
import { FollowDefenseSettingsSchema as Settings } from '/app/dist/schemas/follow_defense_settings.schema.js';
import { FollowDefenseActionSchema as Actions, FollowDefenseControlSchema as Controls } from '/app/dist/schemas/follow_defense_action.schema.js';
import { applyRaidSessionMarker, recordRaidSession, recordRaidFollow, findRaidSession, requestRaidBans, processRaidModerationRequests, backfillRaidSession, raidRetentionHours, extendRaidHistoryRetention } from '/app/dist/utils/raid_sessions.js';
import { projectFollowDefenseState, getFollowDefenseStatus, followDefenseKeys, triggerFollowDefenseAttackMode } from '/app/dist/utils/follow_defense_queue.js';
import { processDurableFollowDefenseFollow } from '/app/dist/utils/follow_defense.js';
import { enqueueFollowDefenseBan, processFollowDefenseAction } from '/app/dist/utils/follow_defense_actions.js';
const mongo = await getMongoDBConnection('raid-check');
const redis = await getDragonflyClient('raid-check');
await Promise.all([Sessions.init(), Followers.init(), Requests.init(), Settings.init(), Actions.init(), Controls.init()]);
const channel = '533538623';
const keys = followDefenseKeys(channel);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) { const end = Date.now() + timeout; do { if (await check()) return; await sleep(100); } while (Date.now() < end); throw new Error('Timeout: ' + label); }
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl') ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
await Settings.create({ channelID: channel });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'fixture', chat_enabled: 'false' });
await redis.hSet('accounts:twitch:698614112:data', { id: '698614112', access_token: 'dummy-token', expires_at: String(Math.floor(Date.now()/1000)+36000) });
await mongo.connection.db.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: 'fixture' }], plan_tier: 'free' });
const setTier = tier => mongo.connection.db.collection('users').updateOne({'accounts.id':channel},{$set:{plan_tier:tier}});
const marker = (id, at = Date.now(), viewers = 8000) => ({ eventID: id, channelID: channel, channelLogin: 'fixture', channelName: 'Fixture', raiderChannelID: id, raiderChannelLogin: id, raiderChannelName: id, raidViewers: viewers, createdAt: at, expiresAt: at + 300000 });
const follow = (id, at = Date.now()) => ({ eventID: `event-${id}`, channelID: channel, channelLogin: 'fixture', channelName: 'Fixture', followerID: String(id), followerLogin: `viewer${id}`, followerName: `Viewer${id}`, followedAt: new Date(at).toISOString(), receivedAt: Date.now() });
async function resetData() { await Promise.all([Sessions.deleteMany({}), Followers.deleteMany({}), Requests.deleteMany({}), Actions.deleteMany({}), Controls.deleteMany({})]); await redis.del([keys.state, keys.raid, keys.raidProjection, keys.recent, keys.tracked, keys.settings]); }

if (process.env.SAAS_TARGET === 'api') {
    await redis.hSet('token:raid-owner', { id: channel, login: 'fixture', display_name: 'Fixture' });
    const api = (path, body, token = 'raid-owner', method = 'POST') => fetch(`http://127.0.0.1:3000/follow-defense/${channel}/${path}`, {
        method: body === undefined ? 'GET' : method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const a = marker('A', Date.now()-1000);
    await applyRaidSessionMarker(a);
    const session = await findRaidSession(channel, Date.now());
    for (let i=0;i<55;i++) await recordRaidFollow(follow(1000+i));
    const list = await api('raid-sessions'); assert.equal(list.status, 200);
    const data = (await list.json()).data; assert.equal(data.sessions[0].totalFollows, 55); assert.equal(data.canBan, true); assert.equal(data.sessions[0].canIncludeFuture, true);
    const page = await (await api(`raid-sessions/${session._id}/followers?page=2`)).json(); assert.equal(page.data.followers.length, 5);
    assert.equal((await api(`raid-sessions/${session._id}/bans`, {requestID:randomUUID()})).status,400);
    assert.equal((await api('raid-sessions', undefined, 'unknown')).status,401);
    const { AdminSchema } = await import('/app/dist/schemas/admin.schema.js');
    await redis.hSet('token:raid-reader', { id:'600000001',login:'reader' });
    await AdminSchema.create({channelID:channel,adminID:'600000001',permissions:['dashboard:view']});
    assert.equal((await api('raid-sessions',undefined,'raid-reader')).status,200);
    assert.equal((await api(`raid-sessions/${session._id}/bans`,{confirmed:true,requestID:randomUUID()},'raid-reader')).status,403);
    assert.equal((await api('attack',{},'raid-reader')).status,403);
    assert.equal((await api('settings',{resetAttackOnNewRaid:false},'raid-reader','PATCH')).status,403);
    const other = await Sessions.create({_id:'other-session',channelID:'700000001',eventID:'other',raiderID:'raider',startedAt:new Date(),captureUntil:new Date(Date.now()+300000),expiresAt:new Date(Date.now()+86400000),purgeAt:new Date(Date.now()+90000000),backfillUntil:new Date(),retentionHours:24});
    assert.equal((await api(`raid-sessions/${other._id}/bans`,{confirmed:true,requestID:randomUUID()})).status,404);
    assert.equal(data.planTier,'free'); assert.equal(data.canBanSession,false); assert.equal(data.canBanIndividual,false);
    await redis.hSet('token:raid-pro-mod',{id:'600000002',login:'promod'});
    await mongo.connection.db.collection('users').insertOne({accounts:[{type:'twitch',id:'600000002'}],plan_tier:'pro'});
    await AdminSchema.create({channelID:channel,adminID:'600000002',permissions:['dashboard:view','moderation:manage']});
    assert.equal((await api(`raid-sessions/${session._id}/bans`,{confirmed:true,requestID:randomUUID()},'raid-pro-mod')).status,403);

    assert.equal((await api(`raid-sessions/${session._id}/bans`,{confirmed:true,requestID:randomUUID(),origin:'live',includeFuture:true})).status,403);
    assert.equal((await api('attack',{})).status,202);
    assert.equal((await getFollowDefenseStatus(channel)).mode,'attack');
    assert.equal((await Requests.findOne().lean()).origin,'live');
    await redis.del(keys.state);
    assert.equal((await api('attack',{})).status,409);
    await Requests.deleteMany({});
    await setTier('premium');
    const premium=(await (await api('raid-sessions')).json()).data;
    assert.equal(premium.canBanSession,true); assert.equal(premium.canBanIndividual,false);
    assert.equal((await api(`raid-sessions/${session._id}/bans`,{confirmed:true,requestID:randomUUID(),userID:'1001'})).status,403);
    assert.equal((await api(`raid-sessions/${session._id}/bans`,{confirmed:true,requestID:randomUUID()})).status,202);
    await Requests.deleteMany({}); await setTier('pro');
    assert.equal((await (await api('raid-sessions')).json()).data.canBanIndividual,true);
    const requestID = randomUUID(); const body={confirmed:true,requestID,userID:'1001'};
    assert.equal((await api(`raid-sessions/${session._id}/bans`,body)).status,202);
    assert.equal((await api(`raid-sessions/${session._id}/bans`,body)).status,202);
    assert.equal(await Requests.countDocuments(),1);
    assert.equal((await api(`raid-sessions/${session._id}/bans`,{...body,userID:'999999'})).status,404);
    assert.equal((await api('settings', {resetAttackOnNewRaid:false}, 'raid-owner', 'PATCH')).status,200);
    assert.equal((await (await api('settings')).json()).data.resetAttackOnNewRaid,false);
    assert.equal((await api('settings', {resetAttackOnNewRaid:'false'}, 'raid-owner', 'PATCH')).status,400);
    await Sessions.updateOne({_id:session._id},{$set:{expiresAt:new Date(Date.now()-1)}});
    assert.equal((await (await api('raid-sessions')).json()).data.total,0);
    assert.equal((await api(`raid-sessions/${session._id}/bans`,{...body,requestID:randomUUID()})).status,404);
    console.log('PASS API: Free/Premium/Pro entitlements, live Free activation, no client-origin or moderator-plan bypass, owner authorization, pagination, confirmation, idempotency, follower membership, logical retention, new-raid setting persistence/validation'); process.exit(0);
}

if (process.env.SAAS_TARGET === 'bot') {
    const { setFollowDefenseRaidMarker } = await import('/app/dist/utils/follow_defense_queue.js');
    await setFollowDefenseRaidMarker(marker('legacy'));
    const session = await findRaidSession(channel, Date.now()); assert.ok(session);
    await recordRaidFollow(follow(9001));
    await triggerFollowDefenseAttackMode(channel, 'fixture', 'Fixture');
    assert.equal((await getFollowDefenseStatus(channel)).mode, 'attack');
    assert.equal((await Requests.findOne().lean()).includeFuture, true);
    await applyRaidSessionMarker(marker('next', Date.now()));
    assert.equal((await getFollowDefenseStatus(channel)).mode, 'protection');
    console.log('PASS BOT: legacy raid entrypoint records a session; manual command scopes it; next raid returns to protection'); process.exit(0);
}

// Pause only this disposable candidate's moderation workers for deterministic assertions.
await until(() => calls().some(c=>c.raidReady) && calls().some(c=>c.ready), 'supervised workers ready');
const raidPID = calls().find(c=>c.raidReady).raidReady, actionPID=calls().find(c=>c.ready).ready;
process.kill(raidPID,'SIGSTOP'); process.kill(actionPID,'SIGSTOP');

// 5,000 follows in a minute, split 3,000 / 2,000 at the second raid.
const started = Date.now();
const a = marker('A', started-1000);
await applyRaidSessionMarker(a); const A=await findRaidSession(channel,Date.now());
for(let offset=0;offset<3000;offset+=25) await Promise.all(Array.from({length:25},(_,i)=>processDurableFollowDefenseFollow(follow(10000+offset+i))));
await sleep(5); const b=marker('B',Date.now(),7000);
await applyRaidSessionMarker(b); const B=await findRaidSession(channel,Date.now());
for(let offset=0;offset<2000;offset+=25) await Promise.all(Array.from({length:25},(_,i)=>processDurableFollowDefenseFollow(follow(20000+offset+i))));
assert.equal(await Followers.countDocuments({sessionID:A._id}),3000);
assert.equal(await Followers.countDocuments({sessionID:B._id}),2000);
assert.equal(await Actions.countDocuments({kind:'ban'}),0);
assert.notEqual((await getFollowDefenseStatus(channel))?.mode,'attack');
await applyRaidSessionMarker(a); await recordRaidFollow(follow(10000,started));
assert.equal(await Followers.countDocuments({sessionID:A._id}),3000);
assert.equal(await Followers.countDocuments({sessionID:B._id}),2000);
console.log(`PASS: A=3000 / B=2000, no automatic bans, duplicate/late raid stable (${Date.now()-started}ms)`);
await resetData();

// Active A includes new A follows, but B defaults to protection and cannot inherit A's request.
await applyRaidSessionMarker(marker('activeA',Date.now()-3000)); const activeA=await findRaidSession(channel,Date.now());
await recordRaidFollow(follow(1)); await sleep(5);
const reqA=await requestRaidBans(channel,activeA._id,channel,randomUUID(),'',true,'live'); assert.equal(reqA.includeFuture,true);
await recordRaidFollow(follow(2));
await sleep(5); await applyRaidSessionMarker(marker('activeB',Date.now())); const activeB=await findRaidSession(channel,Date.now());
assert.equal((await getFollowDefenseStatus(channel)).mode,'protection');
await recordRaidFollow(follow(3));
await processRaidModerationRequests();
assert.deepEqual((await Actions.find({raidRequestID:reqA._id}).lean()).map(a=>a.followerID).sort(),['1','2']);
assert.equal(await Actions.countDocuments({followerID:'3'}),0);
const reqB=await requestRaidBans(channel,activeB._id,channel,randomUUID(),'',true,'live');
await recordRaidFollow(follow(4)); await processRaidModerationRequests();
assert.equal((await getFollowDefenseStatus(channel)).mode,'attack');
assert.equal(await Actions.countDocuments({raidRequestID:reqB._id}),2);
// Once normal, the same still-recording session is historical-only.
await redis.del(keys.state); await sleep(5);
await assert.rejects(()=>requestRaidBans(channel,activeB._id,channel,randomUUID(),'',true,'live'),error=>error.status===409);
await assert.rejects(()=>requestRaidBans(channel,activeB._id,channel,randomUUID()),error=>error.status===403);
await setTier('premium');
const historical=await requestRaidBans(channel,activeB._id,channel,randomUUID(),'',true); assert.equal(historical.includeFuture,false);
await sleep(5); await recordRaidFollow(follow(5));
await processRaidModerationRequests(); await processRaidModerationRequests();
assert.equal(await Actions.countDocuments({raidRequestID:historical._id,followerID:'5'}),0);
assert.equal(await Actions.countDocuments({raidRequestID:reqB._id,followerID:'5'}),0);
assert.equal(await redis.get(keys.state),null);
const ended=await requestRaidBans(channel,activeA._id,channel,randomUUID(),'',true); assert.equal(ended.includeFuture,false);
console.log('PASS: active future scope, new raid isolation, manual reactivation, normal/ended session recorded-only');
await resetData();

// Explicit carryover setting authorizes a separate B request and survives duplicate delivery.
await Settings.updateOne({channelID:channel},{$set:{resetAttackOnNewRaid:false}});
await applyRaidSessionMarker(marker('carryA',Date.now()-3000)); const carryA=await findRaidSession(channel,Date.now());
await recordRaidFollow(follow(6)); await requestRaidBans(channel,carryA._id,channel,randomUUID(),'',true);
const carryMarker=marker('carryB',Date.now()); await applyRaidSessionMarker(carryMarker);
const carryB=await findRaidSession(channel,Date.now());
assert.equal((await getFollowDefenseStatus(channel)).mode,'attack');
await recordRaidFollow(follow(7)); await processRaidModerationRequests(); await processRaidModerationRequests();
assert.equal(await Actions.countDocuments({raidSessionID:carryB._id,followerID:'7'}),1);
await applyRaidSessionMarker(carryMarker); assert.equal(await Requests.countDocuments({sessionID:carryB._id}),1);
await redis.del(keys.state); await applyRaidSessionMarker(carryMarker); assert.equal(await redis.get(keys.state),null);
console.log('PASS: opt-in carryover keeps attack with a distinct request, replay cannot resurrect expired mode');
await resetData(); await Settings.updateOne({channelID:channel},{$set:{resetAttackOnNewRaid:true}});

// Historical bans bypass event freshness only under an explicit manual request.
const oldAt=Date.now()-3600000;
const old=await recordRaidSession(marker('old',oldAt)); await recordRaidFollow(follow(8,oldAt+1000));
const oldReq=await requestRaidBans(channel,old._id,channel,randomUUID());
await processRaidModerationRequests(); assert.equal(await Actions.countDocuments({raidRequestID:oldReq._id}),1);
// Automatic job queued before a late raid is discovered must recheck membership.
const recent=follow(9); await enqueueFollowDefenseBan(recent,'automatic'); await applyRaidSessionMarker(marker('late',Date.now()-2000));
await recordRaidFollow(recent);
for(let i=0;i<20 && await Actions.countDocuments({status:'pending'});i++) { await processFollowDefenseAction(async action=>{assert.notEqual(action.followerID,'9');return {error:false,message:'banned',status:200};});await sleep(220); }
assert.equal((await Actions.findOne({followerID:'9'}).lean()).status,'cancelled');
assert.equal((await Actions.findOne({followerID:'8'}).lean()).status,'succeeded');
console.log('PASS: explicit historical authority and pre-execution late-raid safeguard');
await resetData();

// A raid delivered after its follows recovers them from the durable global journal.
const { normalizeTwitchEventsubDomainEvent } = await import('/app/dist/domain_events/twitch_eventsub_events.js');
const { journalDomainEvent } = await import('/app/dist/utils/domain_events.js');
const journalAt=Date.now()-10000;
const event=normalizeTwitchEventsubDomainEvent({messageId:'late-journal-follow',messageTimestamp:new Date(journalAt+1000).toISOString(),durableDefenseHandled:true,
 subscription:{type:'channel.follow',version:'2',condition:{broadcaster_user_id:channel}},
 event:{broadcaster_user_id:channel,broadcaster_user_login:'fixture',broadcaster_user_name:'Fixture',user_id:'77',user_login:'viewer77',user_name:'Viewer77',followed_at:new Date(journalAt+1000).toISOString()}});
await journalDomainEvent(event);
const backfilled=await recordRaidSession(marker('backfill',journalAt));await backfillRaidSession();await backfillRaidSession();
assert.equal(await Followers.countDocuments({sessionID:backfilled._id,userID:'77'}),1);
// A newly delivered B boundary moves the follow out of A and invalidates A's pending ban.
const priorReq=await requestRaidBans(channel,backfilled._id,channel,randomUUID());await processRaidModerationRequests();
const repaired=await recordRaidSession(marker('repair-B',journalAt+500));
assert.equal(await Followers.countDocuments({sessionID:backfilled._id}),0);
assert.equal(await Followers.countDocuments({sessionID:repaired._id,userID:'77'}),1);
await processFollowDefenseAction(async()=>assert.fail('Reassigned follower cannot be banned by prior session'));
assert.equal((await Actions.findOne({raidRequestID:priorReq._id}).lean()).status,'cancelled');
console.log('PASS: durable journal backfill, late B attribution repair, queued A ban cancellation');
await resetData();

for(const [tier,hours] of [['free',72],['premium',72],['pro',72]]) {
 await mongo.connection.db.collection('users').updateOne({'accounts.id':channel},{$set:{plan_tier:tier}});
 const session=await recordRaidSession(marker(tier,Date.now())); assert.equal(session.retentionHours,hours);assert.equal(session.expiresAt.getTime()-session.startedAt.getTime(),hours*3600000);
 await Sessions.deleteMany({});
}
assert.equal(raidRetentionHours('unknown'),72);
const widening=await recordRaidSession(marker('widen',Date.now()-10000));
await recordRaidFollow(follow(78,Date.now()-9000));
const originalCapture=widening.captureUntil.getTime();
await Sessions.updateOne({_id:widening._id},{$set:{retentionHours:24,expiresAt:new Date(Date.now()+3600000),purgeAt:new Date(Date.now()+7200000)}});
await Followers.updateMany({sessionID:widening._id},{$set:{purgeAt:new Date(Date.now()+7200000)}});
await extendRaidHistoryRetention(); await extendRaidHistoryRetention();
const widened=await Sessions.findById(widening._id).lean();
assert.equal(widened.retentionHours,72);
assert.equal(widened.expiresAt.getTime()-widened.startedAt.getTime(),72*3600000);
assert.equal((await Followers.findOne({sessionID:widening._id}).lean()).purgeAt.getTime(),widened.purgeAt.getTime());
assert.ok(widened.captureUntil.getTime()>=originalCapture);
await resetData();
// Crash recovery admits only requests whose live state was actually published.
await setTier('free');
await applyRaidSessionMarker(marker('recover',Date.now()-1000)); const recovery=await findRaidSession(channel,Date.now());
await recordRaidFollow(follow(79));
const recovering=await requestRaidBans(channel,recovery._id,channel,randomUUID(),'',true,'live');
await Requests.updateOne({_id:recovering._id},{$set:{status:'authorizing',requestedAt:new Date(Date.now()-11000)}});
await processRaidModerationRequests();
assert.notEqual((await Requests.findById(recovering._id).lean()).status,'authorizing');
assert.notEqual((await Requests.findById(recovering._id).lean()).status,'cancelled');
await redis.del(keys.state);
await Requests.updateOne({_id:recovering._id},{$set:{status:'authorizing'}});
await processRaidModerationRequests(); assert.equal((await Requests.findById(recovering._id).lean()).status,'cancelled');
await resetData(); await setTier('pro');
console.log('PASS: all tiers 72-hour retention, restart-safe extension, live authorization crash recovery');

// Exercise the actual global consumer with chat announcements disabled/minimum-filtered.
const { default: Eventsub } = await import('/app/dist/schemas/eventsub.schema.js');
await Eventsub.collection.insertMany([{channelID:channel,type:'channel.raid',enabled:false,minViewers:999999},{channelID:channel,type:'channel.follow',enabled:false}]);
const pipeStart=Date.now();
const raidEvent=normalizeTwitchEventsubDomainEvent({messageId:'global-raid',messageTimestamp:new Date().toISOString(),durableDefenseHandled:true,
 subscription:{type:'channel.raid',version:'1',condition:{to_broadcaster_user_id:channel}},event:{from_broadcaster_user_id:'999',from_broadcaster_user_login:'global',from_broadcaster_user_name:'Global',to_broadcaster_user_id:channel,to_broadcaster_user_login:'fixture',to_broadcaster_user_name:'Fixture',viewers:15000}});
const raidJournal=await journalDomainEvent(raidEvent);
await until(async()=>await Sessions.countDocuments({eventID:raidJournal.event.eventKey})===1,'global raid bypasses announcement config');
const pipelineSession=await Sessions.findOne({eventID:raidJournal.event.eventKey}).lean();
for(let offset=0;offset<120;offset+=20) await Promise.all(Array.from({length:20},async(_,i)=>{
 const at=new Date().toISOString();
 await journalDomainEvent(normalizeTwitchEventsubDomainEvent({messageId:`global-follow-${offset+i}`,messageTimestamp:at,durableDefenseHandled:true,
 subscription:{type:'channel.follow',version:'2',condition:{broadcaster_user_id:channel}},event:{broadcaster_user_id:channel,broadcaster_user_login:'fixture',broadcaster_user_name:'Fixture',user_id:String(90000+offset+i),user_login:'pipeline',user_name:'Pipeline',followed_at:at}}));
}));
await until(async()=>await Followers.countDocuments({sessionID:pipelineSession._id})===120,'global follows recorded despite disabled chat',60000);
assert.equal(await Actions.countDocuments({kind:'ban'}),0);
console.log(`PASS: real global raid/follow consumer, disabled announcements cannot bypass protection (120 follows in ${Date.now()-pipeStart}ms)`);
await resetData();

// Resume the actual supervised workers and verify request admission + Twitch boundary execution.
await applyRaidSessionMarker(marker('worker',Date.now()-1000)); const workerSession=await findRaidSession(channel,Date.now());
await recordRaidFollow(follow(42)); await requestRaidBans(channel,workerSession._id,channel,randomUUID());
process.kill(raidPID,'SIGCONT');process.kill(actionPID,'SIGCONT');
await until(async()=>await Actions.countDocuments({followerID:'42',status:'succeeded'})===1,'real workers admit and execute');
assert.ok(calls().some(c=>c.user==='42'));
console.log('PASS CRON: actual supervised admission and moderation workers execute against isolated Twitch mock');
process.exit(0);
