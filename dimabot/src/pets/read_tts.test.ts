import assert from 'node:assert/strict';
import { mock, test, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerReadTtsBridge, prepareReadTts, releaseReadTts, reportReadTts, readTtsTerminal, invalidateReadTts, readTtsAvailable } from './tts_bridge.js';
const owner = '012345678901234567890123', channel = '123456';
let runtime: any, config: any, rows: Map<string, any>, events: any[], endings: string[];
let ticketFails = false, attemptedFails = false;
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
        return current === value;
    });
}
function apply(row: any, update: any) { for (const [key, value] of Object.entries(update.$set ?? {})) {
    const parts = key.split('.'); let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = structuredClone(value);
} }
const query = (read: () => any) => ({ lean: async () => structuredClone(read()) });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => ({ select: () => query(() => ({ _id: owner })) }) } });
mock.module('../server/services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => structuredClone(config) } });
mock.module('./peers.js', { namedExports: { petPeers: peers, selectedVtsController: async () => null } });
mock.module('./tokens.js', { namedExports: { issueAudioTicket: async () => { if (ticketFails) throw new Error('ticket rejected before delivery'); return 'private-ticket'; } } });
mock.module('./tts_envelope.js', { namedExports: { inspectTtsAudio: async () => 500, ttsEnvelope: async () => ({ stepMs: 40, values: [0, 0.7, 0.2] }) } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PetRuntime: {
        findById: () => query(() => runtime),
        findOneAndUpdate: (filter: any, update: any) => query(() => { if (!matches(runtime, filter)) return null; apply(runtime, update); return runtime; }),
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
    requestView: (row: any) => ({ requestId: row._id, operation: row.operation, status: row.status, version: row.version, text: row.outputText }) } });
const { startReadTts } = await import('./read_tts.js');
let close = startReadTts();
async function reset() {
    await close(); close = startReadTts();
    runtime = { _id: owner, generation: 4, activeRequestId: null, ttsReservation: null,
        lease: { leaseId: 'lease', holderPeerId: peer.id, expiresAt: new Date(Date.now() + 15000) } };
    config = { revision: 1, settings: { enabled: true, sources: { independent: false, readTts: true }, ttsAudio: 'pet',
        tts: { enabled: false }, personality: { source: 'profile', profileId: 'missing' }, appearance: { kind: 'png' }, playback: { target: 'browser' } }, runtime: { enabled: false, readTtsEnabled: true } };
    rows = new Map(); events = []; endings = []; ticketFails = attemptedFails = false; peer.socket.connected = peer.audioReady = peer.renderReady = true;
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
