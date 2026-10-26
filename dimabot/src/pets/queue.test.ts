import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { PetRequestRecord, PetRuntimeRecord } from '../schemas/pet_runtime.schema.js';

const owner = '111111111111111111111111';
let runtime: PetRuntimeRecord;
let rows: Map<string, PetRequestRecord>;
let settings: any, runtimeEnabled = true, finished: Array<{ id: string; status: string; code?: string }> = [];
let beforePromote = () => {};
function queued(id: string, extra: Partial<PetRequestRecord> = {}): PetRequestRecord {
    return { _id: id, ownerId: owner, channelId: '99003101', operation: 'talk', text: 'hello', origin: { kind: 'chat-command', id, occurredAt: new Date().toISOString() },
        actionKey: 'command:0', actor: { userId: '1', displayName: 'Fixture' }, payloadHash: 'x', admitted: false, generation: 3, settingsRevision: 1,
        status: 'queued', version: 1, phaseDeadline: new Date(Date.now() + 600_000), createdAt: new Date(), expiresAt: new Date(Date.now() + 86400_000), ...extra };
}
function reset() {
    runtime = { _id: owner, channelId: '99003101', generation: 7, activeRequestId: null, notBefore: new Date(0), lastAcceptedAt: null, admissionClaimId: null,
        lease: { leaseId: 'lease-a', holderPeerId: 'peer', expiresAt: new Date(Date.now() + 15_000) }, tokenHash: null, overlayToken: null };
    rows = new Map();
    settings = { enabled: true, sources: { independent: true }, tts: { enabled: true }, behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 10, maxReplyLength: 280 } };
    runtimeEnabled = true; finished = []; beforePromote = () => {};
}
reset();
const lean = <T>(read: () => T) => ({ lean: async () => read() });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PetRequest: {
        findOne: () => ({ sort: () => lean(() => [...rows.values()].filter(row => row.status === 'queued' && row.lane !== 'tts').sort((a, b) => +a.createdAt - +b.createdAt)[0] ?? null) }),
        findOneAndUpdate: (filter: any, update: any) => lean(() => {
            const callback = beforePromote; beforePromote = () => {}; callback();
            const row = rows.get(filter._id);
            if (!row || row.status !== filter.status) return null;
            Object.assign(row, update.$set); row.version++; return structuredClone(row);
        })
    },
    PetRuntime: {
        findOneAndUpdate: (filter: any, update: any) => lean(() => {
            const now = Date.now();
            if (runtime.activeRequestId !== filter.activeRequestId || runtime.generation !== filter.generation || runtime.lease?.leaseId !== filter['lease.leaseId']) return null;
            if (runtime.ttsReservation && runtime.ttsReservation.expiresAt.getTime() > now) return null;
            if (filter.$or && runtime.lastAcceptedAt && runtime.lastAcceptedAt > filter.$or[1].lastAcceptedAt.$lte) return null;
            const previous = structuredClone(runtime); Object.assign(runtime, update.$set); return previous;
        }),
        updateOne: async (filter: any, update: any) => {
            if (runtime.activeRequestId !== filter.activeRequestId || runtime.admissionClaimId !== filter.admissionClaimId) return { modifiedCount: 0 };
            if (filter.lastAcceptedAt && runtime.lastAcceptedAt?.getTime() !== filter.lastAcceptedAt.getTime()) return { modifiedCount: 0 };
            Object.assign(runtime, update.$set ?? {}); if (update.$unset?.admissionClaimId) runtime.admissionClaimId = null;
            return { modifiedCount: 1 };
        }
    }
} });
mock.module('../server/services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => ({ revision: 9, settings: structuredClone(settings),
    runtime: { enabled: runtimeEnabled, issues: runtimeEnabled ? [] : ['vts_unavailable'] } }) } });
mock.module('./state.js', { namedExports: {
    notifyPet: async () => {}, runtimeFor: async () => structuredClone(runtime),
    finishRequest: async (id: string, status: string, code?: string) => { finished.push({ id, status, code }); const row = rows.get(id); if (row) row.status = status as any; }
} });
const { claimQueued, nextIndependentQueued } = await import('./queue.js');

test('a free pet promotes the request with current generation, settings revision and a fresh phase deadline', async () => {
    reset(); const request = queued('a'); rows.set('a', request);
    const claim = await claimQueued(request, { lane: 'independent' });
    assert.equal(claim.kind, 'promoted');
    const row = rows.get('a')!;
    assert.equal(row.status, 'accepted'); assert.equal(row.admitted, true); assert.equal(row.generation, 7); assert.equal(row.settingsRevision, 9);
    assert.ok(row.phaseDeadline.getTime() <= Date.now() + 60_000);
    assert.equal(runtime.activeRequestId, 'a'); assert.equal(runtime.admissionClaimId, null);
});
test('independent requests wait for the cooldown; TTS-lane requests do not', async () => {
    reset(); runtime.lastAcceptedAt = new Date(Date.now() - 4000);
    const request = queued('b'); rows.set('b', request);
    const waiting = await claimQueued(request, { lane: 'independent' });
    assert.equal(waiting.kind, 'wait'); assert.ok(waiting.kind === 'wait' && Math.abs(waiting.retryAt! - (runtime.lastAcceptedAt!.getTime() + 10_000)) < 5);
    assert.equal((await claimQueued(request, { lane: 'tts' })).kind, 'promoted');
});
test('busy pet or pending TTS turn waits in both lanes', async () => {
    reset(); runtime.activeRequestId = 'other';
    const request = queued('c'); rows.set('c', request);
    assert.equal((await claimQueued(request, { lane: 'independent' })).kind, 'wait');
    assert.equal((await claimQueued(request, { lane: 'tts' })).kind, 'wait');
    runtime.activeRequestId = null; runtime.ttsReservation = { speechId: 's', token: 't', expiresAt: new Date(Date.now() + 5000) };
    const claim = await claimQueued(request, { lane: 'tts' });
    assert.equal(claim.kind, 'wait'); assert.equal(rows.get('c')!.status, 'queued');
});
test('turned-off settings end queued requests instead of keeping them', async () => {
    for (const [change, code] of [[() => { settings.enabled = false; }, 'pet_unavailable'], [() => { settings.behavior.respondToChat = false; }, 'trigger_disabled'],
        [() => { settings.sources.independent = false; }, 'pet_source_disabled'], [() => { settings.behavior.maxReplyLength = 3; }, 'text_too_long']] as const) {
        reset(); change(); const request = queued('d'); rows.set('d', request);
        assert.deepEqual(await claimQueued(request, { lane: 'independent' }), { kind: 'dropped', errorCode: code });
        assert.deepEqual(finished, [{ id: 'd', status: 'failed', code }]);
    }
});
test('temporary readiness problems wait in the pet queue but skip a TTS-lane item so TTS keeps moving', async () => {
    reset(); runtimeEnabled = false; const request = queued('e'); rows.set('e', request);
    assert.equal((await claimQueued(request, { lane: 'independent' })).kind, 'wait');
    assert.deepEqual(await claimQueued(request, { lane: 'tts' }), { kind: 'dropped', errorCode: 'vts_unavailable' });
    reset(); runtime.lease = null; rows.set('e', queued('e'));
    assert.equal((await claimQueued(rows.get('e')!, { lane: 'independent' })).kind, 'wait');
    assert.deepEqual(await claimQueued(rows.get('e')!, { lane: 'tts' }), { kind: 'dropped', errorCode: 'player_unavailable' });
});
test('a request cancelled during the claim gives back the slot and the previous cooldown stamp', async () => {
    reset(); const previous = new Date(Date.now() - 60_000); runtime.lastAcceptedAt = previous;
    const request = queued('f'); rows.set('f', request);
    beforePromote = () => { rows.get('f')!.status = 'cancelled'; };
    assert.deepEqual(await claimQueued(request, { lane: 'independent' }), { kind: 'dropped', errorCode: 'request_not_queued' });
    assert.equal(runtime.activeRequestId, null); assert.deepEqual(runtime.lastAcceptedAt, previous); assert.equal(runtime.admissionClaimId, null);
});
test('the pet queue is first-in, first-out and ignores TTS-lane rows', async () => {
    reset();
    rows.set('late', queued('late', { createdAt: new Date(Date.now() + 10), lane: 'independent' }));
    rows.set('tts', queued('tts', { createdAt: new Date(Date.now() - 100), lane: 'tts' }));
    rows.set('early', queued('early', { createdAt: new Date(Date.now() - 50), lane: 'independent' }));
    assert.equal((await nextIndependentQueued(owner))?._id, 'early');
});
