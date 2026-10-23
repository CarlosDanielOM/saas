/** Actual compiled bot/cron shared AST -> Mongo admission in separate producer processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
assert.ok(['api', 'bot', 'cron'].includes(process.env.SAAS_TARGET));
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/);
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { defaultPetSettings } = await import('/app/dist/server/services/pet_settings.service.js');
const { PetSettingsSchema } = await import('/app/dist/schemas/pet_settings.schema.js');
const { PetRequest, PetRuntime } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { runtimeFor } = await import('/app/dist/pets/state.js');
const mongo = await getMongoDBConnection('dima032-consumers'), redis = await getDragonflyClient('dima032-consumers');
const channel = '99003211';
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
    assert.equal(await redis.lLen('pet:test:provider-calls'), 0, 'producer path starts no runtime or providers');
    console.log(`PASS DIMA032 ${process.env.SAAS_TARGET}: real packaged AST sources/chat+event, separate-process Mongo pending reservation, concurrent admission CAS and independent-source disable; no native worker behavior changed.`);
} finally { await mongo.connection.close(); redis.destroy(); }
process.exit(0);
