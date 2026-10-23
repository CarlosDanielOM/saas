/** Actual compiled bot/cron shared AST -> Mongo admission in separate producer processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
assert.ok(['api', 'bot', 'cron'].includes(process.env.SAAS_TARGET));
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/);
assert.equal(process.env.DRAGONFLY_HOST, 'redis'); assert.equal(process.env.DRAGONFLY_PORT, '6379');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { defaultPetSettings } = await import('/app/dist/server/services/pet_settings.service.js');
const { PetSettingsSchema } = await import('/app/dist/schemas/pet_settings.schema.js');
const { PetRequest, PetRuntime } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { runtimeFor } = await import('/app/dist/pets/state.js');
const { enqueueTtsSession, popTtsSession } = await import('/app/dist/utils/tts/tts_session.util.js');
const mongo = await getMongoDBConnection('dima032-consumers'), redis = await getDragonflyClient('dima032-consumers');
const channel = '99003211';
const streamChannel = '99' + BigInt('0x' + randomBytes(10).toString('hex')).toString();
const streamPrefix = `twitch:${streamChannel}:tts:`;
const streamDir = path.join('/app/dist/server/routes/public/speech', streamChannel);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const end = Date.now()+5000; while(Date.now()<end) { const value=await fn(); if(value)return value; await pause(25); } throw new Error(`Timeout: ${label}`); }
const user = await mongo.connection.db.collection('users').insertOne({ name: 'DIMA032 producer', plan_tier: 'premium', accounts: [{ type: 'twitch', id: channel }] });
const ownerId = String(user.insertedId), image = '012345678901234567890123';
await mongo.connection.db.collection('asset_libraries').insertOne({ _id: channel, usedBytes: 1, assets: [{ id: image, name: 'fixture.gif', state: 'ready', kind: 'image', mime: 'image/gif', bytes: 1 }] });
await PetSettingsSchema.create({ userId: user.insertedId, revision: 1, updatedAt: new Date(), settings: { ...defaultPetSettings(), enabled: true,
    sources: { independent: true, readTts: true }, appearance: { kind: 'png', idleAssetId: image, talkingAssetId: image }, behavior: { ...defaultPetSettings().behavior, cooldownSeconds: 0 } } });
await runtimeFor(ownerId, channel);
await PetRuntime.updateOne({ _id: ownerId }, { $set: { lease: { leaseId: 'disposable-producer-lease', holderPeerId: 'no-api-provider', expiresAt: new Date(Date.now() + 120000) }, ttsReservation: { speechId: 'pending-normal-tts', token: 'queue-turn', expiresAt: new Date(Date.now() + 120000) } } });
const action = (kind = 'chat-command') => ({ channelId: channel, operation: 'talk', text: 'Scoped producer action', origin: { kind, id: randomUUID(), occurredAt: new Date().toISOString() }, actionKey: 'dima032', actor: { userId: channel, displayName: 'Fixture' } });
async function produce(input) {
    const child = spawn(process.execPath, ['/tmp/saas-fixtures/producer.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000); child.stdin.end(JSON.stringify(input));
    const [code] = await once(child, 'close'); clearTimeout(timer); assert.equal(code, 0, stderr);
    const line = stdout.split('\n').find(line => line.startsWith('DIMA032_PRODUCER:')); assert.ok(line, stdout);
    const result = JSON.parse(line.slice('DIMA032_PRODUCER:'.length)); assert.notEqual(result.pid, process.pid); assert.equal(result.peers, 0); return result;
}
try {
    const pending = await Promise.all([produce({ ast: true, action: action('chat-command') }), produce({ ast: true, action: action('twitch-event') })]);
    assert.ok(pending.every(result => result.result.value === 'Error: busy'), JSON.stringify(pending));
    assert.equal(await PetRequest.countDocuments({ ownerId }), 0, 'pending reservation rejects bot/cron AST before request/provider dispatch');
    await PetRuntime.updateOne({ _id: ownerId }, { $set: { ttsReservation: null } });
    const race = await Promise.all([produce({ ast: false, action: action() }), produce({ ast: false, action: action('twitch-event') })]);
    assert.equal(race.filter(result => result.result.status === 'accepted').length, 1); assert.equal(race.filter(result => result.result.error === 'busy').length, 1);
    assert.equal(await PetRequest.countDocuments({ ownerId, admitted: true }), 1);
    await PetSettingsSchema.updateOne({ userId: user.insertedId }, { $set: { 'settings.sources.independent': false } });
    const disabled = await produce({ ast: true, action: action() }); assert.equal(disabled.result.value, 'Error: pet_source_disabled');
    // Changed cron consumer: actual compiled stream.ended -> clearSpeechFiles,
    // actual declared-key Lua and files inside this container's owned channel.
    const marker=streamPrefix+'session',queue=streamPrefix+'queue',payload=id=>streamPrefix+'queue:data:'+id;
    await redis.set(marker,'consumer-old-session');
    const put=(id,score)=>enqueueTtsSession(redis,streamChannel,id,score,JSON.stringify({channelID:streamChannel,speechID:id}));
    await put('old-playing',0);await put('old-waiting',1);
    const popped=await popTtsSession(redis,streamChannel);assert.equal(popped.value,'old-playing');assert.equal(popped.session,'consumer-old-session');
    await redis.set(streamPrefix+'processing',popped.value);await redis.set(streamPrefix+'connected','true');
    await redis.set(payload('orphan'),'{}');await mkdir(streamDir,{recursive:true});
    await writeFile(path.join(streamDir,'old.wav'),'old consumer fixture audio');
    await redis.del('dima032:test:entered:session-publish');await redis.set('dima032:test:hold:session-publish','true');
    const ending=produce({streamEnd:true,channelId:streamChannel,holdHint:true});
    try {
        await until(()=>redis.get('dima032:test:entered:session-publish'),'real stream cleanup before publication');
        const nextSession=await redis.get(marker);assert.ok(nextSession);assert.notEqual(nextSession,'consumer-old-session');
        assert.equal(await redis.zCard(queue),0);assert.equal(await redis.get(streamPrefix+'processing'),null);
        for(const id of ['old-playing','old-waiting','orphan'])assert.equal(await redis.get(payload(id)),null);
        await assert.rejects(readFile(path.join(streamDir,'old.wav')),{code:'ENOENT'});
        await put('new-after-boundary',2);await mkdir(streamDir,{recursive:true});
        await writeFile(path.join(streamDir,'new.wav'),'new consumer fixture audio');
        await redis.del('dima032:test:hold:session-publish');assert.equal((await ending).result.ok,true);
        assert.equal(await redis.zCard(queue),1);assert.equal(JSON.parse(await redis.get(payload('new-after-boundary'))).queueSession,nextSession);
        assert.equal(await readFile(path.join(streamDir,'new.wav'),'utf8'),'new consumer fixture audio');
        const fresh=await popTtsSession(redis,streamChannel);assert.equal(fresh.value,'new-after-boundary');assert.equal(fresh.session,nextSession);
    } finally {await redis.del('dima032:test:hold:session-publish');await ending;}
    assert.equal(await redis.lLen('pet:test:provider-calls'), 0, 'producer path starts no runtime or providers');
    console.log(`PASS DIMA032 ${process.env.SAAS_TARGET}: real packaged AST sources/chat+event, Mongo pending reservation/concurrent CAS/source disable and real stream consumer atomic Lua/file cleanup with post-boundary work preserved; no provider calls or native worker behavior changed.`);
} finally {
    await redis.del('dima032:test:hold:session-publish','dima032:test:entered:session-publish');
    const ownedKeys=await redis.keys(streamPrefix+'*');if(ownedKeys.length)await redis.del(ownedKeys);
    await rm(streamDir,{recursive:true,force:true});await mongo.connection.close();redis.destroy();
}
process.exit(0);
