import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomUUID } from 'node:crypto';

const rows = new Map<string, any>(), conversations = new Map<string, any>(), cache = new Map<string, string>(), petRows = new Map<string, any>();
let cancelPet: (id: string) => Promise<{status: string}> = async () => ({ status: 'cancelled' });
let executionCalls = 0, finishCalls = 0, leaseAttempts = 0;
let beforeUpdate: ((filter: any) => void) | undefined;
let runExecution: () => Promise<void> = async () => {};
let startActivity: () => Promise<boolean> = async () => true;
const query = <T>(read: () => T) => ({ lean: async () => read(), select: () => query(read), sort: () => query(read), limit: () => query(read) });
const clone = <T>(value: T): T => structuredClone(value);
function get(object: any, key: string) { return key.split('.').reduce((current, part) => current?.[part], object); }
function set(object: any, key: string, value: unknown) {
    const parts = key.split('.'); let current = object;
    for (const part of parts.slice(0, -1)) current = current[part] ??= {};
    current[parts.at(-1)!] = value;
}
function matches(row: any, filter: any): boolean {
    return Object.entries(filter).every(([key, expected]: [string, any]) => {
        if (key === 'operations.id') return !row.operations.some((op: any) => op.id === expected.$ne);
        if (key === 'operations.status') return !row.operations.some((op: any) => op.status === expected.$ne);
        const value = get(row, key);
        if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
            if ('$in' in expected) return expected.$in.includes(value);
            if ('$ne' in expected) return value !== expected.$ne;
            if ('$gt' in expected) return value > expected.$gt;
            if ('$lte' in expected) return value != null && value <= expected.$lte;
        }
        return value === expected;
    });
}
function apply(row: any, update: any, filter: any) {
    for (const [key, value] of Object.entries(update.$set ?? {})) {
        if (key === 'operations.$.status') row.operations.find((op: any) => op.id === filter['operations.id']).status = value;
        else set(row, key, value);
    }
    for (const [key, value] of Object.entries(update.$inc ?? {})) set(row, key, (get(row, key) ?? 0) + Number(value));
    if (update.$push) row.operations.push(clone(update.$push.operations));
}
const Turn = {
    init: async () => {},
    create: async (row: any) => { if ([...rows.values()].some(item => item.ownerId === row.ownerId && item.clientId === row.clientId && item.requestId === row.requestId)) throw { code: 11000 }; rows.set(row._id, clone(row)); },
    findOne: (filter: any) => query(() => clone([...rows.values()].find(row => matches(row, filter)) ?? null)),
    findById: (id: string) => query(() => clone(rows.get(id) ?? null)),
    exists: async (filter: any) => [...rows.values()].some(row => matches(row, filter)),
    find: (filter: any) => query(() => clone([...rows.values()].filter(row => matches(row, filter)))),
    findOneAndUpdate: (filter: any, update: any) => query(() => { beforeUpdate?.(filter); const row = [...rows.values()].find(item => matches(item, filter)); if (!row) return null; apply(row, update, filter); return clone(row); }),
    updateOne: async (filter: any, update: any) => { const row = [...rows.values()].find(item => matches(item, filter)); if (!row) return { modifiedCount: 0 }; apply(row, update, filter); return { modifiedCount: 1 }; }
};
const Conversation = { init: async () => {}, create: async (row: any) => { conversations.set(row._id, clone(row)); },
    findOne: (filter: any) => query(() => clone([...conversations.values()].find(row => matches(row, filter)) ?? null)) };
mock.module('./schema.js', { namedExports: { DesktopAiTurn: Turn, DesktopAiConversation: Conversation } });
mock.module('./execution.js', { namedExports: {
    executeDesktopTurn: async () => { executionCalls++; await runExecution(); }, cancelPendingSpeech: () => {}, finishBotSpeech: async () => { finishCalls++; }, startBotSpeech: () => startActivity()
} });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({ get: async (key: string) => cache.get(key) ?? null, del: async (key: string) => cache.delete(key), zRem: async () => 1,
    set: async (key: string, value: string, options: any) => { if (options?.NX) leaseAttempts++; if (options?.NX && cache.has(key)) return null; cache.set(key, value); return 'OK'; },
    eval: async (script: string, options: any) => { if (script.includes('ZREMRANGEBYSCORE')) return 1; if (script.includes("redis.call('DEL'")) { if (cache.get(options.keys[0]) === options.arguments[0]) cache.delete(options.keys[0]); return 1; } return 1; } }) } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: { PetRequest: { findOne: (filter: any) => query(() => clone(petRows.get(filter._id) ?? null)) } } });
mock.module('../pets/state.js', { namedExports: { cancelPetRequest: async (_owner: string, id: string) => cancelPet(id) } });
const { submitTurn, getTurn, cancelTurn, cancelSpeech, claimSpeechPreparing, speechStillPreparing, operation, claimAudio, hashTicket, speechEvent, expireCancelledBotSpeech, armBotSpeechExpiry, clearBotSpeechExpiry } = await import('./service.js');
const identity = { session_id: 'session-1', user_id: 'owner-1', client_id: 'dima-desktop', channel_id: '12345', scopes: ['ai:interact', 'pet:interact'] };
const payload = () => ({ request_id: randomUUID(), target: 'bot', text: ' Hey Dima, how are you? ', source: 'asr', silent: false });

test('durable admission is idempotent, scoped, and binds the complete frozen payload', async () => {
    rows.clear(); conversations.clear(); executionCalls = 0;
    const input = payload();
    const first = await submitTurn(identity, input);
    assert.equal(rows.size, 1); assert.equal(first.status, 'queued'); assert.equal(first.revision, 1);
    assert.equal(first.speech?.status, 'queued'); assert.equal(first.speech?.animate_pet, false);
    const duplicate = await submitTurn(identity, input);
    assert.equal(duplicate.turn_id, first.turn_id); assert.equal(rows.size, 1);
    await assert.rejects(() => submitTurn(identity, { ...input, silent: true }), (error: any) => error.code === 'idempotency_conflict');
    await assert.rejects(() => getTurn({ ...identity, user_id: 'another' }, first.turn_id), (error: any) => error.code === 'not_found');
    await assert.rejects(() => getTurn({ ...identity, scopes: [] }, first.turn_id), (error: any) => error.code === 'insufficient_scope');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(executionCalls, 1, 'single atomic claim schedules only one execution');
});

test('silent admission creates no speech; conversation cannot cross owner, channel or target', async () => {
    const input = payload(); const silent = await submitTurn(identity, { ...input, silent: true });
    assert.equal(silent.speech, undefined);
    const reused = await submitTurn(identity, { ...payload(), conversation_id: silent.conversation_id });
    assert.equal(reused.conversation_id, silent.conversation_id);
    await assert.rejects(() => submitTurn(identity, { ...payload(), target: 'pet', conversation_id: silent.conversation_id }), (error: any) => error.code === 'invalid_conversation');
    await assert.rejects(() => submitTurn({ ...identity, user_id: 'another' }, { ...payload(), conversation_id: silent.conversation_id }), (error: any) => error.code === 'invalid_conversation');
});

test('speech-only cancellation fences the queued descriptor and keeps AI running', async () => {
    const first = await submitTurn(identity, payload());
    const speech = first.speech!;
    await assert.rejects(() => cancelSpeech(identity, first.turn_id, { playback_id: randomUUID(), output_generation: 1 }), (error: any) => error.code === 'not_found');
    const result = await cancelSpeech(identity, first.turn_id, { playback_id: speech.playback_id, output_generation: speech.output_generation });
    assert.equal(result.accepted, true); assert.equal(result.snapshot.speech?.status, 'cancelled');
    assert.equal(result.snapshot.status, 'queued');
});

test('whole-turn cancellation stops linked speech even when an action is already in flight', async () => {
    const first = await submitTurn(identity, payload());
    const row = rows.get(first.turn_id)!; row.status = 'running'; row.operations.push({ id: 'action', kind: 'tool', status: 'pending' });
    const result = await cancelTurn(identity, first.turn_id);
    assert.equal(result.accepted, false); assert.equal(result.too_late, true);
    assert.equal(result.snapshot.speech?.status, 'cancelled'); assert.equal(result.snapshot.status, 'running');
});

test('uncertain tool outcome stays pending and cannot execute again', async () => {
    const first = await submitTurn(identity, { ...payload(), silent: true });
    rows.get(first.turn_id)!.status = 'running'; rows.get(first.turn_id)!.executionFence = 'fence'; cache.set('desktop-ai:owner:owner-1', 'fence'); let calls = 0;
    await assert.rejects(() => operation(first.turn_id, 'action:1', 'tool', async () => { calls++; return { success: false, outcomeUnknown: true }; }), (error: any) => error.code === 'operation_outcome_unknown');
    await assert.rejects(() => operation(first.turn_id, 'action:1', 'tool', async () => { calls++; return {}; }), (error: any) => error.code === 'operation_unavailable');
    assert.equal(calls, 1); assert.equal(rows.get(first.turn_id)!.operations[0].status, 'pending');
});

test('audio claim is bearer-session bound and permits only one fetch', async () => {
    const first = await submitTurn(identity, payload()); const row = rows.get(first.turn_id)!;
    const ticket = 'a'.repeat(43); Object.assign(row.speech, { status: 'ready', ticketHash: hashTicket(ticket), startBefore: new Date(Date.now() + 10000),
        privateDir: '/tmp/dima-desktop-ai-example', path: '/tmp/dima-desktop-ai-example/speech.wav', mimeType: 'audio/wav' });
    await assert.rejects(() => claimAudio({ ...identity, session_id: 'other' }, first.turn_id, ticket), (error: any) => error.code === 'invalid_ticket');
    const claimed = await claimAudio(identity, first.turn_id, ticket); assert.equal(claimed.mimeType, 'audio/wav');
    await assert.rejects(() => claimAudio(identity, first.turn_id, ticket), (error: any) => error.code === 'audio_unavailable');
});


test('a duplicate started event cannot release the winning audio slot', async () => {
    const first = await submitTurn(identity, payload());
    const row = rows.get(first.turn_id)!; row.speech.status = 'delivering'; row.speech.startBefore = new Date(Date.now() + 10000); row.speech.durationMs = 3000;
    let entered!: () => void, resume!: (value: boolean) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    startActivity = () => { entered(); return new Promise<boolean>(resolve => { resume = resolve; }); };
    finishCalls = 0;
    const body = { playback_id: row.speech.playbackId, output_generation: 1, event: 'started' };
    const winner = speechEvent(identity, first.turn_id, body); await waiting;
    await assert.rejects(() => speechEvent(identity, first.turn_id, body), (error: any) => error.code === 'audio_unavailable');
    assert.equal(finishCalls, 0, 'losing request must not release active output');
    resume(true); assert.equal((await winner).snapshot.speech?.status, 'playing');
    assert.equal(finishCalls, 0); startActivity = async () => true;
});


test('a busy owner does not spin; completion immediately drains the next turn', async () => {
    rows.clear(); cache.clear(); executionCalls = 0; leaseAttempts = 0;
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    runExecution = () => { entered(); return new Promise<void>(resolve => { resume = resolve; }); };
    const first = await submitTurn(identity, payload()); await waiting;
    const second = await submitTurn(identity, payload());
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(executionCalls, 1); assert.equal(rows.get(second.turn_id)!.status, 'queued');
    assert.ok(leaseAttempts <= 2, 'busy owner must not continuously reacquire a lease');
    runExecution = async () => {}; resume();
    for (let i = 0; i < 20 && executionCalls < 2; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(executionCalls, 2, 'queued next turn starts promptly on release');
    assert.notEqual(first.turn_id, second.turn_id);
});


test('cancellation on either side of the atomic speech claim prevents a provider start', async () => {
    const before = await submitTurn(identity, payload());
    const first = before.speech!;
    await cancelSpeech(identity, before.turn_id, { playback_id: first.playback_id, output_generation: 1 });
    assert.equal(await claimSpeechPreparing(before.turn_id), false);
    assert.equal(await speechStillPreparing(before.turn_id), false);
    const after = await submitTurn(identity, payload());
    assert.equal(await claimSpeechPreparing(after.turn_id), true);
    const second = after.speech!;
    await cancelSpeech(identity, after.turn_id, { playback_id: second.playback_id, output_generation: 1 });
    assert.equal(await speechStillPreparing(after.turn_id), false);
});

test('known paid usage is recorded after cancellation or loss of execution lease', async () => {
    const turn = await submitTurn(identity, { ...payload(), silent: true });
    const row = rows.get(turn.turn_id)!; row.status = 'cancelled'; row.executionFence = 'expired';
    cache.delete('desktop-ai:owner:owner-1'); let calls = 0;
    const result = await operation(turn.turn_id, 'tts:billing', 'billing', async () => { calls++; return { credits: 5 }; });
    assert.equal(result.credits, 5); assert.equal(calls, 1);
    assert.equal(row.operations.find((op: any) => op.id === 'tts:billing').status, 'completed');
    await assert.rejects(() => operation(turn.turn_id, 'tts:billing', 'billing', async () => { calls++; }), (error: any) => error.code === 'operation_unavailable');
    assert.equal(calls, 1);
});

test('Pet cancellation reports too late if the linked playback finishes during the cancellation race', async () => {
    const turn = await submitTurn(identity, payload()); const row = rows.get(turn.turn_id)!;
    row.speech.animatePet = true; row.petRequestId = 'pet-race'; petRows.set('pet-race', { status: 'playing', version: 3 });
    cancelPet = async id => { petRows.set(id, { status: 'completed', version: 4 }); return { status: 'completed' }; };
    const result = await cancelSpeech(identity, turn.turn_id, { playback_id: row.speech.playbackId, output_generation: 1 });
    assert.equal(result.accepted, false); assert.equal(result.too_late, true);
    assert.equal(result.snapshot.speech?.status, 'completed'); assert.equal(row.speech.status, 'completed');
    cancelPet = async () => ({ status: 'cancelled' }); petRows.clear();
});


test('another desktop cancelling audible Bot output retains the slot until the initiating player confirms stop', async () => {
    const first = await submitTurn(identity, payload()); const row = rows.get(first.turn_id)!;
    row.status = 'completed'; row.speech.status = 'playing'; row.speech.playbackDeadline = new Date(Date.now() + 30000); finishCalls = 0;
    const otherSession = { ...identity, session_id: 'session-2' };
    const cancelled = await cancelTurn(otherSession, first.turn_id);
    assert.equal(cancelled.snapshot.speech?.status, 'cancelled');
    assert.equal(finishCalls, 0, 'remote cancellation alone does not prove the audio player stopped');
    const end = { playback_id: row.speech.playbackId, output_generation: 1, event: 'ended' };
    await assert.rejects(() => speechEvent(otherSession, first.turn_id, end), (error: any) => error.code === 'not_found');
    assert.equal(finishCalls, 0, 'a different session cannot release the audio fence');
    const proof = await speechEvent(identity, first.turn_id, end);
    assert.equal(proof.snapshot.speech?.status, 'cancelled'); assert.equal(finishCalls, 1);
    await speechEvent(identity, first.turn_id, end); assert.equal(finishCalls, 1, 'duplicate stop proof is idempotent');
});

test('cancelled playing Bot audio retains its slot until the execution deadline', async () => {
    const first = await submitTurn(identity, payload()); const row = rows.get(first.turn_id)!;
    const deadline = new Date(Date.now() + 30000);
    row.speech.status = 'playing'; row.speech.playbackDeadline = deadline; finishCalls = 0;
    await cancelSpeech(identity, first.turn_id, { playback_id: row.speech.playbackId, output_generation: 1 });
    assert.equal(await expireCancelledBotSpeech(first.turn_id, new Date(deadline.getTime() - 1)), false);
    assert.equal(finishCalls, 0);
    assert.equal(await expireCancelledBotSpeech(first.turn_id, deadline), true);
    assert.equal(finishCalls, 1); assert.equal(row.speech.status, 'cancelled');
    assert.equal(await expireCancelledBotSpeech(first.turn_id, new Date(deadline.getTime() + 1)), false);
    assert.equal(finishCalls, 1);
});

test('cancelling Bot audio before a successful started handshake releases the slot immediately', async () => {
    for (const status of ['ready', 'delivering']) {
        const first = await submitTurn(identity, payload()); const row = rows.get(first.turn_id)!;
        row.speech.status = status; finishCalls = 0;
        const result = await cancelSpeech(identity, first.turn_id, { playback_id: row.speech.playbackId, output_generation: 1 });
        assert.equal(result.accepted, true); assert.equal(finishCalls, 1);
    }
});

test('an ended event crossing cancellation remains stop proof and keeps the cancelled outcome', async () => {
    const first = await submitTurn(identity, payload()); const row = rows.get(first.turn_id)!;
    row.speech.status = 'playing'; row.speech.playbackDeadline = new Date(Date.now() + 30000); finishCalls = 0;
    beforeUpdate = filter => {
        if (filter['speech.status']?.$in?.includes('playing')) { row.speech.status = 'cancelled'; beforeUpdate = undefined; }
    };
    const result = await speechEvent(identity, first.turn_id, { playback_id: row.speech.playbackId, output_generation: 1, event: 'ended' });
    beforeUpdate = undefined;
    assert.equal(result.snapshot.speech?.status, 'cancelled'); assert.equal(finishCalls, 1);
});


test('Bot delivery deadline starts at ready, expires at20 seconds and never expires started playback', async t => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    const id = randomUUID();
    const row: any = { _id: id, revision: 1, operations: [], speech: { status: 'ready', startBefore: new Date(now + 20_000) } };
    rows.set(id, row); armBotSpeechExpiry(id, row.speech.startBefore);
    t.mock.timers.tick(19_999); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(row.speech.status, 'ready', 'time spent before readiness is outside the delivery window');
    t.mock.timers.tick(2); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(row.speech.status, 'expired');
    row.speech.status = 'delivering'; row.speech.startBefore = new Date(Date.now() + 20_000);
    armBotSpeechExpiry(id, row.speech.startBefore);
    row.speech.status = 'playing'; row.speech.playbackDeadline = new Date(Date.now() + 65_000);
    t.mock.timers.tick(20_001); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(row.speech.status, 'playing', 'a successful start wins over the old delivery timer');
    clearBotSpeechExpiry(id); rows.delete(id);
});
