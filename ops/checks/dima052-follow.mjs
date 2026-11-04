/** Exact API image: fresh disposable Mongo/Redis, DIMA032 mailbox and dummy providers. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { ObjectId } = createRequire('/app/package.json')('mongodb');
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/);
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
assert.equal(process.env.DIMA032_SEED_STARTUP, 'false', 'fresh fixture must not inherit restart/backlog scenarios');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { PetRequest } = await import('/app/dist/schemas/pet_runtime.schema.js');
const mongo = await getMongoDBConnection('dima052-follow-check'), db = mongo.connection.db;
const redis = await getDragonflyClient('dima052-follow-check');
const base = 'http://127.0.0.1:3000', channel = '99003101', browserToken = 'pet-owner-token';
const sockets = [], clients = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await read(); if (value) return value; await pause(25); }
    throw new Error(`Timeout: ${label}`);
}
async function request(path, { method = 'GET', token = browserToken, body, status = 200 } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, `${method} ${path.split('?')[0]} returned ${response.status}`);
    return status === 302 ? response : response.json();
}
async function call(path, method = 'GET', body) { return (await request(path, { method, body })).data; }
async function command(kind, extra = {}) {
    const id = randomUUID();
    await redis.rPush('dima032:test:commands', JSON.stringify({ id, kind, channelId: channel, ...extra }));
    const result = JSON.parse(await until(() => redis.get(`dima032:test:reply:${id}`), `API mailbox ${kind}`));
    assert.notEqual(result.pid, process.pid, 'the actual API singleton owns queue work');
    assert.equal(result.result?.fixtureError, undefined, 'fixture command succeeds');
    return result.result;
}
async function connect(namespace, auth, first) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/socket.io/?EIO=4&transport=websocket');
    sockets.push(ws);
    const events = [], acks = new Map(); let sequence = 0, socketId, failure;
    ws.on('message', raw => {
        const packet = raw.toString();
        if (packet === '2') return ws.send('3');
        if (packet.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify(auth)}`);
        if (packet.startsWith(`40${namespace},`)) socketId = JSON.parse(packet.slice(`40${namespace},`.length)).sid;
        if (packet.startsWith(`44${namespace},`)) failure = true;
        if (packet.startsWith(`42${namespace},`)) {
            const eventPacket = JSON.parse(packet.slice(`42${namespace},`.length));
            if (namespace === '/pet' || namespace === '/desktop') assert.equal(eventPacket.length, 2, 'pet events have no recovery offset');
            const [event, data] = eventPacket; events.push({ event, data });
        }
        if (packet.startsWith(`43${namespace},`)) {
            const rest = packet.slice(`43${namespace},`.length), bracket = rest.indexOf('['), id = Number(rest.slice(0, bracket));
            acks.get(id)?.(JSON.parse(rest.slice(bracket))[0]); acks.delete(id);
        }
    });
    const client = { ws, events, namespace, auth, get socketId() { return socketId; },
        emit(event, data) { ws.send(`42${namespace},${JSON.stringify([event, data])}`); },
        send(event, data) { const id = ++sequence; return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { acks.delete(id); reject(new Error(`Missing ACK: ${event}`)); }, 5000);
            acks.set(id, value => { clearTimeout(timer); resolve(value); });
            ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`);
        }); },
        event(event, predicate = () => true) { return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event); }
    };
    await until(() => socketId || failure, 'namespace authentication'); assert.equal(failure, undefined, 'namespace accepts fixture credentials');
    clients.push(client); if (first) await client.event(first); return client;
}
async function mintDesktop() {
    const verifier = randomBytes(32).toString('base64url'), redirectUri = 'http://127.0.0.1:42781/oauth/callback';
    const authorization = await request('/oauth/authorize?' + new URLSearchParams({ client_id: 'dima-desktop', response_type: 'code',
        scope: 'profile:read credits:read desktop:connect pet:read pet:receive pet:control pet:playback:select', redirect_uri: redirectUri,
        state: verifier, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', device_name: 'DIMA052 follow fixture' }), { token: null, status: 302 });
    const consentId = new URL(authorization.headers.get('location')).searchParams.get('request');
    const consent = await request(`/oauth/requests/${consentId}/decision`, { method: 'POST', token: 'oauth-beta-browser-owner', body: { approve: true } });
    return request('/oauth/token', { method: 'POST', token: null, body: { client_id: 'dima-desktop', grant_type: 'authorization_code',
        code: new URL(consent.redirect_uri).searchParams.get('code'), code_verifier: verifier, redirect_uri: redirectUri } });
}
try {
    assert.equal(await db.collection('users').countDocuments(), 0, 'dedicated check starts with disposable empty state');
    const inserted = await db.collection('users').insertOne({ name: 'DIMA052 disposable follow', plan_tier: 'premium',
        accounts: [{ type: 'twitch', id: channel, name: 'dima052_fixture' }] });
    const ownerId = String(inserted.insertedId), asset = new ObjectId();
    await redis.hSet(`token:${browserToken}`, { id: channel, login: 'dima052_fixture', display_name: 'Fixture' });
    await db.collection('asset_libraries').insertOne({ _id: channel, usedBytes: 1, assets: [{ id: String(asset), kind: 'image', mime: 'image/gif',
        state: 'ready', name: 'mock.gif', bytes: 1, width: 1, height: 1, createdAt: new Date().toISOString() }] });
    let config = await call(`/pets/${channel}/settings`);
    const save = async change => { config = await call(`/pets/${channel}/settings`, 'PUT', { revision: config.revision, settings: change(config.settings) }); };
    await save(settings => ({ ...settings, enabled: true, sources: { independent: false, readTts: true }, ttsAudio: 'overlay',
        tts: { ...settings.tts, enabled: false }, appearance: { kind: 'png', idleAssetId: String(asset), talkingAssetId: String(asset) },
        behavior: { ...settings.behavior, cooldownSeconds: 0 } }));
    const capability = (await call(`/pets/${channel}/overlay-token`, 'POST', {})).token;
    const png = await connect('/pet', { v: 1, capability }, 'pet:snapshot');
    assert.equal((await png.send('pet:ready', { v: 1, audioReady: false, renderReady: true, vtsReady: false })).ok, true);
    let studio = await call(`/overlay-studio/${channel}`);
    const original = studio.scenes[0], widget = original.widgets.find(item => item.kind === 'tts');
    assert.ok(widget?.visible, 'Studio accepts TTS');
    studio.scenes = ['a', 'b'].map(id => ({ ...structuredClone(original), id, name: id, widgets: [widget] }));
    studio = await call(`/overlay-studio/${channel}`, 'PUT', studio);
    for (const scene of studio.scenes) studio = await call(`/overlay-studio/${channel}/scenes/${scene.id}/publish`, 'POST', { revision: studio.revision });
    const clientId = 'dima052-shared-client-id', sources = [];
    for (const scene of studio.scenes) sources.push({ scene, client: await connect(`/overlay-studio/${scene.publicId}`, { clientId }, 'overlay-state') });
    let audioBytes;
    const usage = async () => Number(await redis.hGet(`${channel}:tts:usage`, 'total_characters') || 0);
    const follows = speechID => clients.flatMap(client => client.events.filter(item => item.event === 'pet:follow' && item.data.followId === speechID)
        .map(item => ({ client, frame: item.data })));
    async function checkClip(mode, recipients) {
        const modern = mode === 'modern', text = `DIMA052 ${mode} follows one unchanged overlay audio`;
        const before = { providers: await redis.lLen('pet:test:provider-calls'), characters: await usage(), billing: await redis.lLen('pet:test:billing-events') };
        const queued = await command('enqueue', { text }); assert.equal(queued.error, false); const speechID = queued.data.speechID;
        const deliveries = await Promise.all(sources.map(async source => ({ ...source,
            event: await source.client.event('overlay-event', event => event.tts?.speechID === speechID) })));
        const elected = deliveries.find(source => source.event.tts.ownerClientId), caption = deliveries.find(source => !source.event.tts.ownerClientId);
        assert.ok(elected && caption, 'one Studio owns audio and the other receives captions');
        assert.equal(caption.event.media, undefined);
        const eventPath = source => `/overlay-studio/public/${source.scene.publicId}/events/${source.event.id}?` + new URLSearchParams({ clientId, socketId: source.client.socketId });
        const full = await call(eventPath(elected)); assert.ok(full.media?.url); assert.equal(full.tts.durationMs, 500);
        assert.equal((await call(eventPath(caption))).media, undefined);
        const response = await fetch(base + full.media.url); assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.length, 16044); assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
        assert.equal(bytes.readUInt32LE(24), 16000); assert.equal(bytes.readUInt16LE(22), 1);
        if (audioBytes) assert.deepEqual(bytes, audioBytes, 'adding smile never changes the original overlay audio'); else audioBytes = bytes;
        elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID, phase: 'playing', position: 0 });
        await until(() => follows(speechID).length, `${mode} initial follow`); await pause(50);
        assert.equal(follows(speechID).length, 1, 'only the elected pet controller receives a follow');
        const { client, frame } = follows(speechID)[0], envelope = frame.envelope;
        assert.ok(recipients.includes(client)); assert.equal(frame.v, 1); assert.equal(frame.positionMs, 0);
        assert.ok(Number.isSafeInteger(frame.generation) && Number.isFinite(frame.serverTime));
        assert.ok(envelope.stepMs >= 20 && envelope.stepMs <= 100);
        assert.ok(envelope.values.length > 0 && envelope.values.length <= (modern ? 1800 : 1500));
        assert.ok(envelope.values.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert.ok(envelope.values.length * envelope.stepMs <= 60_000 + (modern ? envelope.stepMs : 0));
        assert.ok(envelope.values.every(value => value === 0), 'silent mock audio stays closed');
        if (modern) {
            assert.equal(envelope.stepMs, 1000 * Math.ceil(16000 / 30) / 16000);
            assert.equal(Number.isInteger(envelope.stepMs), false, 'modern curve keeps native fractional bin timing');
            assert.deepEqual(Object.keys(envelope).sort(), ['smile', 'stepMs', 'values']);
            assert.equal(envelope.smile.length, envelope.values.length);
            assert.ok(envelope.smile.every(value => Number.isFinite(value) && value >= 0 && value <= 1 && value === .5), 'silent mock smile is neutral');
        } else {
            assert.equal(envelope.stepMs, 40); assert.ok(Number.isInteger(envelope.stepMs));
            assert.deepEqual(Object.keys(envelope).sort(), ['stepMs', 'values'], `${mode} keeps the exact legacy open-only shape`);
        }
        assert.ok(Buffer.byteLength(JSON.stringify(['pet:follow', frame])) < 32 * 1024);
        elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID, phase: 'progress', position: .25 });
        await until(() => follows(speechID).length === 2, `${mode} advancing follow`);
        const advancing = follows(speechID)[1]; assert.equal(advancing.client, client);
        assert.equal(advancing.frame.positionMs, 250); assert.ok(advancing.frame.serverTime > frame.serverTime);
        assert.equal(Object.hasOwn(advancing.frame, 'envelope'), false, 'progress sends no repeated curves');
        elected.client.emit('overlay-speech-playback', { eventId: elected.event.id, speechID, phase: 'progress', position: .25 });
        await pause(100); assert.equal(follows(speechID).length, 2, 'duplicate progress is not forwarded');
        elected.client.emit('overlay-speech-ended', { eventId: elected.event.id, speechID, reason: 'ended' });
        assert.equal((await client.event('pet:follow-end', data => data.followId === speechID)).generation, frame.generation);
        await until(async () => !await redis.get(`twitch:${channel}:tts:processing`), `${mode} queue completes`);
        await until(async () => !await redis.get(`desktop:speech:slot:${channel}`), `${mode} elected-owner end proves silence`);
        assert.equal(await redis.lLen('pet:test:provider-calls'), before.providers + 1, 'one synthesis per original clip');
        assert.equal(await usage(), before.characters + text.length, 'normal usage recorded once');
        assert.equal(await redis.lLen('pet:test:billing-events'), before.billing, 'free mock audio adds no second debit');
        assert.equal(await PetRequest.countDocuments({ ownerId }), 0, 'silent follow creates no pet audio job');
        assert.equal(clients.some(peer => peer.events.some(item => item.event === 'pet:play')), false, 'the pet never plays a second copy');
        console.log(`PASS DIMA-052 ${mode}: elected follow, envelope bounds, initial-only curves, progress/end, original audio and single synthesis/usage`);
    }
    await checkClip('png', [png]);
    const desktopToken = await mintDesktop(), controllers = [];
    for (let i = 0; i < 2; i++) {
        const desktop = await connect('/desktop', { v: 1, accessToken: desktopToken.access_token }, 'desktop:hello');
        assert.ok((await desktop.event('desktop:hello')).features.includes('mouth-smile'));
        assert.deepEqual(await desktop.send('desktop:features', { v: 1, features: ['mouth-smile'] }), { ok: true, data: {} });
        assert.equal((await desktop.send('pet:ready', { v: 1, audioReady: false, renderReady: false, vtsReady: true })).ok, true);
        controllers.push(desktop);
    }
    await save(settings => ({ ...settings, appearance: { kind: 'vts', idleAssetId: null, talkingAssetId: null },
        playback: { ...settings.playback, vtsSessionId: desktopToken.session_id } }));
    assert.equal(config.runtime.readTtsEnabled, true);
    await checkClip('modern', controllers);
    for (const desktop of controllers) assert.deepEqual(await desktop.send('desktop:features', { v: 1, features: ['moods'] }), { ok: true, data: {} });
    await checkClip('legacy', controllers);
    console.log('PASS DIMA-052 exact-image follow: PNG compatibility, native smile negotiation, legacy controller shape and one elected VTS socket');
} finally {
    for (const socket of sockets) socket.close();
    await mongo.connection.close(); redis.destroy();
}
process.exit(0);
