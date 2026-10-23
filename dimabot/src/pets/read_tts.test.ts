import assert from 'node:assert/strict';
import { mock, test, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerReadTtsBridge, prepareReadTts, releaseReadTts, reportReadTts, readTtsTerminal, invalidateReadTts, readTtsAvailable, reserveReadTts, resumeReadTts, scheduleReadTtsResume } from './tts_bridge.js';
const owner = '012345678901234567890123', channel = '123456';
let runtime: any, config: any, rows: Map<string, any>, events: any[], endings: string[];
let ticketFails = false, attemptedFails = false;
let afterConfigurationRead: (() => Promise<void>) | undefined;
let afterClaim: (() => Promise<void>) | undefined;
const resumed: string[] = [];
const fileDir = await mkdtemp(path.join(tmpdir(), 'dima032-unit-'));
const file = path.join(fileDir, 'normal.wav'); await writeFile(file, 'normal TTS bytes');
const peer: any = { id: 'png-peer', ownerId: owner, channelId: channel, kind: 'browser', renderReady: true, audioReady: true,
    revalidate: async () => {}, socket: { connected: true, emit: (event: string, data: any) => events.push({ event, data }) } };
const peers = new Map([[peer.id, peer]]);
const get = (row: any, key: string) => key.split('.').reduce((value, part) => value?.[part], row);
function matches(row: any, filter: any) {
    return Object.entries(filter).every(([key, value]: any) => {
        const current = get(row, key);
        if (value?.$not) return !current || current <= value.$not.$gt;
        if (value?.$gt) return current > value.$gt;
        if (value?.$lte) return current <= value.$lte;
        return current === value;
    });
}
function apply(row: any, update: any) { for (const [key, value] of Object.entries(update.$set ?? {})) {
    const parts = key.split('.'); let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = structuredClone(value);
} }
const query = (read: () => any) => ({ lean: async () => structuredClone(await read()) });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => ({ select: () => query(() => ({ _id: owner })) }) } });
mock.module('../server/services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => { const snapshot = structuredClone(config); const barrier = afterConfigurationRead; afterConfigurationRead = undefined; if (barrier) await barrier(); return snapshot; } } });
mock.module('./peers.js', { namedExports: { petPeers: peers, selectedVtsController: async () => null } });
mock.module('./tokens.js', { namedExports: { issueAudioTicket: async () => { if (ticketFails) throw new Error('ticket rejected before delivery'); return 'private-ticket'; } } });
mock.module('./tts_envelope.js', { namedExports: { inspectTtsAudio: async () => 500, ttsEnvelope: async () => ({ stepMs: 40, values: [0, 0.7, 0.2] }) } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PetRuntime: {
        findById: () => query(() => runtime),
        find: () => ({ limit: () => query(() => runtime.ttsReservation?.token ? [runtime] : []) }),
        findOneAndUpdate: (filter: any, update: any) => query(async () => { if (!matches(runtime, filter)) return null; apply(runtime, update); const claimed = structuredClone(runtime); const barrier = afterClaim; afterClaim = undefined; if (barrier) await barrier(); return claimed; }),
        updateOne: async (filter: any, update: any) => { const match = matches(runtime, filter); if (match) apply(runtime, update); return { modifiedCount: +match, matchedCount: +match }; }
    },
    PetRequest: {
        create: async (value: any) => { rows.set(value._id, structuredClone(value)); return { ...value, toObject: () => structuredClone(value) }; },
        findById: (id: string) => query(() => rows.get(id) ?? null),
        updateOne: async (filter: any, update: any) => { const row = rows.get(filter._id); const match = row && matches(row, filter) && !attemptedFails; if (match) apply(row, update); return { modifiedCount: +!!match, matchedCount: +!!match }; }
    }
} });
async function finish(id: string, status: string) {
    const row = rows.get(id); if (!row || ['completed', 'cancelled', 'failed', 'expired'].includes(row.status)) return;
    row.status = status; if (runtime.activeRequestId === id) runtime.activeRequestId = null;
    await readTtsTerminal(row); return row;
}
mock.module('./state.js', { namedExports: { runtimeFor: async () => structuredClone(runtime), notifyPet: async () => {}, finishRequest: finish,
    invalidatePet: async (_owner: string, _reason: string, expected: any) => {
        assert.equal(expected.generation, runtime.generation); assert.equal(expected.requestId, runtime.activeRequestId);
        if (runtime.lease) { assert.equal(expected.leaseId, runtime.lease.leaseId); assert.deepEqual(expected.leaseExpiresAt, runtime.lease.expiresAt); }
        runtime.notBefore = new Date(Math.max(runtime.notBefore.getTime(), runtime.lease?.expiresAt.getTime() ?? 0));
        runtime.generation++; if (runtime.activeRequestId) await finish(runtime.activeRequestId, 'cancelled');
        runtime.lease = null; runtime.activeRequestId = null; return true;
    },
    requestView: (row: any) => ({ requestId: row._id, operation: row.operation, status: row.status, version: row.version, text: row.outputText }) } });
mock.module('../handlers/tts_queue.handler.js', { namedExports: { ttsQueueHandler: { resumeIfIdle: async (channel: string) => { resumed.push(channel); } } } });
const { startReadTts, reconcileReadTtsStartup } = await import('./read_tts.js');
let close = startReadTts();
async function reset() {
    await close(); close = startReadTts();
    runtime = { _id: owner, generation: 4, activeRequestId: null, ttsReservation: null, notBefore: new Date(0),
        lease: { leaseId: 'lease', holderPeerId: peer.id, expiresAt: new Date(Date.now() + 15000) } };
    config = { revision: 1, settings: { enabled: true, sources: { independent: false, readTts: true }, ttsAudio: 'pet',
        tts: { enabled: false }, personality: { source: 'profile', profileId: 'missing' }, appearance: { kind: 'png' }, playback: { target: 'browser' } }, runtime: { enabled: false, readTtsEnabled: true } };
    rows = new Map(); events = []; endings = []; afterClaim = afterConfigurationRead = undefined; resumed.length = 0; ticketFails = attemptedFails = false; peer.socket.connected = peer.audioReady = peer.renderReady = true;
}
function input(speechId = 'speech') { return { channelId: channel, speechId, file, mime: 'audio/wav', text: 'Existing normal TTS', cancelled: () => false,
    ended: async (reason: string) => { endings.push(reason); await releaseReadTts(channel, speechId); } }; }
after(async () => { await close(); registerReadTtsBridge(); await rm(fileDir, { recursive: true, force: true }); });
test('readTTS-only PNG works without desktop, independent voice/personality, and emits one private play', async () => {
    await reset(); assert.equal(await readTtsAvailable(channel), true);
    assert.equal((await prepareReadTts(input()))?.audio, 'pet');
    assert.equal(rows.size, 1); const row: any = [...rows.values()][0];
    assert.equal(row.operation, 'tts'); assert.equal(row.origin.id, 'speech'); assert.equal(row.deliveryAttempted, true);
    assert.equal(row.audio.path.startsWith('/tmp/dima-pet-'), true);
    assert.equal(events.filter(event => event.event === 'pet:play').length, 1);
    assert.equal(events.some(event => event.data?.audio?.url?.includes('normal.wav')), false);
    await finish(row._id, 'completed'); assert.deepEqual(endings, ['pet:completed']); assert.equal(runtime.ttsReservation, null);
});
for (const fetched of [false, true]) test(`lost start ACK${fetched ? ' with authorized media fetch' : ''} then disconnect never replays or falls back`, async () => {
    await reset(); await prepareReadTts(input()); const row: any = [...rows.values()][0]; row.audioFetched = fetched;
    peer.socket.connected = false;
    await finish(row._id, 'cancelled'); await readTtsTerminal(row);
    assert.deepEqual(endings, ['pet:cancelled']); assert.equal(events.filter(event => event.event === 'pet:play').length, 1);
    assert.equal(runtime.ttsReservation, null);
});
for (const mode of ['offline', 'ticket-rejection', 'stale-CAS']) test(`true pre-delivery ${mode} falls back to original file without pet play`, async () => {
    await reset(); if (mode === 'offline') peer.audioReady = false;
    if (mode === 'ticket-rejection') ticketFails = true;
    if (mode === 'stale-CAS') attemptedFails = true;
    const request = input(); assert.equal((await prepareReadTts(request))?.audio, 'overlay');
    assert.equal(request.file, file); assert.equal(events.filter(event => event.event === 'pet:play').length, 0); assert.deepEqual(endings, []);
    await releaseReadTts(channel, 'speech');
});
test('pending reservation fences ready independent work before bounded wait, then hands off after its terminal', async () => {
    await reset(); runtime.activeRequestId = 'independent'; const pending = prepareReadTts(input());
    while (!runtime.ttsReservation) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(runtime.activeRequestId, 'independent'); assert.equal(events.length, 0);
    runtime.activeRequestId = null; assert.equal((await pending)?.audio, 'pet'); await releaseReadTts(channel, 'speech');
});
test('Path B has no lease/audio, monotonic follow anchors, mandatory end generation, and detached progress renews turn', async () => {
    await reset(); config.settings.ttsAudio = 'overlay'; runtime.lease = null;
    await prepareReadTts(input()); assert.equal(rows.size, 0);
    await reportReadTts(channel, 'speech', 'playing', 0);
    await reportReadTts(channel, 'speech', 'progress', 0);
    await reportReadTts(channel, 'speech', 'progress', 0.5);
    await reportReadTts(channel, 'speech', 'progress', 0.2);
    const follows = events.filter(event => event.event === 'pet:follow');
    assert.equal(follows.length, 2); assert.ok(follows[0].data.envelope); assert.equal(follows[1].data.envelope, undefined);
    assert.ok(follows[1].data.serverTime > follows[0].data.serverTime); assert.equal(follows[1].data.positionMs, 500);
    runtime.generation++; await invalidateReadTts(owner);
    assert.deepEqual(endings, []); assert.ok(runtime.ttsReservation, 'overlay speech retains turn after settings/generation change');
    assert.deepEqual(events.find(event => event.event === 'pet:follow-end')?.data, { v: 1, followId: 'speech', generation: 4 });
    runtime.ttsReservation.expiresAt = new Date(0); await reportReadTts(channel, 'speech', 'progress', 1);
    assert.ok(runtime.ttsReservation.expiresAt.getTime() > Date.now() + 200000);
    assert.equal(events.filter(event => event.event === 'pet:follow').length, 2);
    await releaseReadTts(channel, 'speech'); assert.equal(runtime.ttsReservation, null);
});

for (const kind of ['vts', 'png']) test(`configured readTTS with unavailable ${kind} still reserves and uses one overlay fallback turn`, async () => {
    await reset(); config.settings.appearance.kind = kind; config.runtime.readTtsEnabled = false; config.runtime.issues = [kind === 'vts' ? 'vts_unavailable' : 'appearance_unavailable'];
    assert.equal((await prepareReadTts(input()))?.audio, 'overlay'); assert.equal(rows.size, 0); assert.ok(runtime.ttsReservation);
    assert.equal(events.some(event => event.event === 'pet:play'), false);
    await releaseReadTts(channel, 'speech');
});
for (const action of ['skip', 'clear']) test(`${action} crossing delayed reservation CAS response cleans only its token; next turn is preserved`, async () => {
    await reset(); let cancelled = false, unblock!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    afterClaim = async () => { entered(); await blocked; };
    const pending = reserveReadTts({ ...input('old'), cancelled: () => cancelled }); await reached;
    cancelled = true; await releaseReadTts(channel, 'old');
    const next = reserveReadTts(input('next')); unblock(); assert.equal(await pending, false); assert.equal(await next, true);
    assert.equal(runtime.ttsReservation.speechId, 'next');
    await releaseReadTts(channel, 'old'); assert.equal(runtime.ttsReservation.speechId, 'next');
    await releaseReadTts(channel, 'next'); assert.equal(runtime.ttsReservation, null);
});
test('startup reconciles exact orphan reservation and retains possibly-heard lease barrier before next reservation', async () => {
    await reset(); runtime.ttsReservation = { speechId: 'old-process', token: 'orphan', expiresAt: new Date(Date.now() + 240000) };
    const barrier = Date.now() + 100; runtime.lease.expiresAt = new Date(barrier);
    await reconcileReadTtsStartup(); assert.equal(runtime.generation, 5); assert.equal(runtime.ttsReservation, null);
    assert.equal(runtime.notBefore.getTime(), barrier); assert.equal(events.length, 0, 'startup never replays audio');
    const pending = reserveReadTts(input('backlog')); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runtime.ttsReservation, null, 'new provider turn waits behind old conservative playback lease');
    assert.equal(await pending, true); assert.equal(runtime.ttsReservation.speechId, 'backlog'); await releaseReadTts(channel, 'backlog');
});
test('selected pet readiness/lease resumes normal queue; unavailable PNG peer does not wake it', async () => {
    await reset(); peer.audioReady = false; await resumeReadTts(channel); assert.deepEqual(resumed, []);
    peer.audioReady = true; await resumeReadTts(channel); assert.deepEqual(resumed, [channel]);
});

test('settings generation change during synthesis keeps existing normal speech as overlay fallback and renews its turn', async () => {
    await reset(); assert.equal(await reserveReadTts(input()), true);
    runtime.generation++; runtime.ttsReservation.expiresAt = new Date(Date.now() + 1);
    await invalidateReadTts(owner);
    assert.equal((await prepareReadTts(input()))?.audio, 'overlay');
    assert.ok(runtime.ttsReservation.expiresAt.getTime() > Date.now() + 200000);
    assert.equal(events.some(event => event.event === 'pet:play'), false); await releaseReadTts(channel, 'speech');
});

test('settings revision captured before a new runtime generation cannot emit stale private audio', async () => {
    await reset(); let unblock!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    afterConfigurationRead = async () => { entered(); await blocked; };
    const pending = prepareReadTts(input()); await reached;
    config.revision = 2; runtime.generation = 5; unblock();
    assert.equal((await pending)?.audio, 'overlay'); assert.equal(rows.size, 0); assert.equal(events.some(event => event.event === 'pet:play'), false);
    await releaseReadTts(channel, 'speech');
});
test('resume is coalesced after lease ACK task and does not occupy the socket control queue', async () => {
    await reset(); const order: string[] = [];
    scheduleReadTtsResume(channel); scheduleReadTtsResume(channel);
    order.push('lease-ack'); assert.deepEqual(resumed, []);
    await new Promise<void>(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(order, ['lease-ack']); assert.deepEqual(resumed, [channel]);
});
