import assert from 'node:assert/strict';
import test from 'node:test';
import { createPetDiagnostics, petDiagnosticData } from './diagnostics.js';
const id = '353384f3-080b-4f0d-a9b9-71540dbef2d9';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('diagnostics whitelist excludes secrets, packet text, URLs, arbitrary reason strings and non-finite numbers', () => {
    const data = petDiagnosticData('play_delivery', { requestId: id, generation: 9, peerKind: 'desktop', operation: 'ask',
        emitDelayMs: 4800, startRemainingMs: -100, durationMs: Infinity, reason: 'secret-ticket', text: 'private prompt', url: 'https://secret', token: 'secret-token' } as any);
    assert.deepEqual(Object.keys(data).sort(), ['component','event','observedAt','requestId','generation','peerKind','operation','emitDelayMs','startRemainingMs','reason'].sort());
    assert.equal(data.reason, 'other'); assert.equal(data.startRemainingMs, -100);
    assert.doesNotMatch(JSON.stringify(data), /secret|private/);
    assert.equal(petDiagnosticData('playback_rejected', { requestId: 'private input', phase: 'private input' }).requestId, undefined);
});
test('logging is deferred, bounded and does not propagate sink failure', async () => {
    let count = 0;
    const write = createPetDiagnostics(async () => { count++; throw new Error('private failure'); });
    for (let i=0; i<200; i++) assert.doesNotThrow(() => write('589813891', 'ready', { requestId: id }));
    assert.equal(count, 0, 'no synchronous sink work in playback callback');
    await tick(); await tick(); assert.equal(count, 128, 'bounded pending work');
    write('589813891', 'ready', { requestId: id }); await tick(); await tick(); assert.equal(count,129, 'sink rejection releases capacity');
});
test('hung sink cannot accumulate unbounded diagnostic writes', async () => {
    let count=0;
    const write=createPetDiagnostics(() => { count++; return new Promise(() => {}); });
    for(let i=0;i<200;i++) write('589813891','ready',{});
    await tick(); assert.equal(count,128);
    write('589813891','ready',{}); await tick(); assert.equal(count,128);
});

test('public failed-fetch diagnostics have a global rate cap', async () => {
    let count = 0;
    const write = createPetDiagnostics(async () => { count++; });
    for (let i=0; i<40; i++) write('global', 'audio_fetch', { requestId: id, accepted: false, reason: 'invalid_ticket' });
    await tick(); await tick(); assert.equal(count,5);
    write('589813891','ready',{requestId:id}); await tick(); assert.equal(count,6, 'public requests cannot consume channel lifecycle allowance');
});
