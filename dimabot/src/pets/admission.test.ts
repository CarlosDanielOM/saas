import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import type { PetRequestRecord, PetRuntimeRecord } from '../schemas/pet_runtime.schema.js';

const owner = '111111111111111111111111';
const input = { channelId: '99003101', operation: 'talk' as const, text: 'Same paid action',
    origin: { kind: 'chat-command' as const, id: 'message-1', occurredAt: '2026-10-22T18:00:00.000Z' }, actionKey: 'command:0', actor: { userId: '123', displayName: 'Fixture' } };
const terminal = ['completed', 'cancelled', 'failed', 'expired'];
const hash = (value: typeof input) => createHash('sha256').update(JSON.stringify({ operation: value.operation, text: value.text, actor: value.actor, occurredAt: value.origin.occurredAt })).digest('hex');
function record(id = 'request-a', value = input): PetRequestRecord {
    return { _id: id, ...structuredClone(value), ownerId: owner, payloadHash: hash(value), admitted: false,
        generation: 7, settingsRevision: 4, status: 'accepted', version: 1, createdAt: new Date(), phaseDeadline: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 86400_000) };
}
let rows = new Map<string, PetRequestRecord>();
let runtime: PetRuntimeRecord;
let previousCooldown: Date;
let successfulClaims = 0, successfulUnwinds = 0;
let onConfiguration = () => {};
let beforeRequestCAS = () => {};
let beforeUnwind = () => {};
function reset() {
    previousCooldown = new Date(Date.now() - 60_000);
    rows = new Map([['request-a', record()]]);
    runtime = { _id: owner, channelId: input.channelId, generation: 7, activeRequestId: 'request-a',
        lease: { leaseId: 'lease-a', holderPeerId: 'peer-a', expiresAt: new Date(Date.now() + 60_000) },
        notBefore: new Date(0), lastAcceptedAt: previousCooldown, admissionClaimId: null, tokenHash: 'unchanged-token', overlayToken: null };
    successfulClaims = successfulUnwinds = 0;
    onConfiguration = beforeRequestCAS = beforeUnwind = () => {};
}
reset();
const query = <T>(read: () => T) => ({ lean: async () => read() });
function runtimeMatches(filter: Record<string, any>) {
    return runtime._id === filter._id && runtime.activeRequestId === filter.activeRequestId && runtime.generation === filter.generation &&
        (!filter.admissionClaimId || runtime.admissionClaimId === filter.admissionClaimId) &&
        (!filter['lease.leaseId'] || runtime.lease?.leaseId === filter['lease.leaseId']) &&
        (!filter.lastAcceptedAt || runtime.lastAcceptedAt?.getTime() === filter.lastAcceptedAt.getTime());
}
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => ({ select: () => query(() => ({ _id: owner })) }) } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PET_TERMINAL: terminal,
    PetRequest: {
        init: async () => {},
        findOne: (filter: Record<string, unknown>) => query(() => structuredClone([...rows.values()].find(row => row.origin.id === filter['origin.id']) ?? null)),
        findById: (id: string) => query(() => structuredClone(rows.get(id) ?? null)),
        create: async (value: PetRequestRecord) => { rows.set(value._id, structuredClone(value)); },
        findOneAndUpdate: (filter: Record<string, any>, update: Record<string, any>) => query(() => {
            const callback = beforeRequestCAS; beforeRequestCAS = () => {}; callback();
            const row = rows.get(filter._id);
            if (!row || row.admitted !== filter.admitted || row.status !== filter.status) return null;
            Object.assign(row, update.$set); if (update.$inc) row.version++;
            return structuredClone(row);
        })
    },
    PetRuntime: {
        findOneAndUpdate: (filter: Record<string, any>, update: Record<string, any>) => query(() => {
            if (!runtimeMatches(filter) || runtime.lease!.expiresAt <= filter['lease.expiresAt'].$gt ||
                runtime.lastAcceptedAt && runtime.lastAcceptedAt > filter.$or[1].lastAcceptedAt.$lte) return null;
            const previous = structuredClone(runtime); Object.assign(runtime, update.$set); successfulClaims++; return previous;
        }),
        findOne: (filter: Record<string, unknown>) => query(() => runtimeMatches(filter) ? structuredClone(runtime) : null),
        updateOne: async (filter: Record<string, any>, update: Record<string, any>) => {
            const unwind = update.$set && 'lastAcceptedAt' in update.$set;
            if (unwind) {
                assert.deepEqual(Object.keys(update.$set).sort(), ['activeRequestId', 'lastAcceptedAt']);
                assert.equal(filter['lease.expiresAt'], undefined, 'benign renewal must not block claim-owned cleanup');
                const callback = beforeUnwind; beforeUnwind = () => {}; callback();
            }
            if (!runtimeMatches(filter)) return { modifiedCount: 0 };
            if (update.$set) Object.assign(runtime, update.$set);
            if (update.$unset?.admissionClaimId) delete runtime.admissionClaimId;
            if (unwind) successfulUnwinds++;
            return { modifiedCount: 1 };
        }
    }
} });
mock.module('../server/services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => {
    const callback = onConfiguration; onConfiguration = () => {}; callback();
    return { revision: 4, runtime: { enabled: true, issues: [] }, settings: { tts: { enabled: true },
        behavior: { cooldownSeconds: 10, respondToChat: true, respondToEvents: true, maxReplyLength: 280 } } };
} } });
mock.module('./state.js', { namedExports: {
    PetError: class PetError extends Error { constructor(code: string) { super(code); } }, notifyPet: async () => {},
    runtimeFor: async () => structuredClone(runtime)
} });
const { admitPetAction } = await import('./admission.js');
function winnerCompletesAfterDuplicateRead() {
    onConfiguration = () => { const row = rows.get('request-a')!; row.admitted = true; row.status = 'completed'; runtime.activeRequestId = null; };
}

test('false-admitted duplicate rereads generating outcome when its accepted update loses the race', async () => {
    reset();
    beforeRequestCAS = () => { const row = rows.get('request-a')!; row.admitted = true; row.status = 'generating'; };
    assert.deepEqual(await admitPetAction(input), { requestId: 'request-a', status: 'generating' });
    assert.equal(successfulClaims, 0);
});
test('false-admitted duplicate rereads completed A when the runtime slot already belongs to B', async () => {
    reset(); onConfiguration = () => { const row = rows.get('request-a')!; row.admitted = true; row.status = 'completed'; runtime.activeRequestId = 'request-b'; };
    assert.deepEqual(await admitPetAction(input), { requestId: 'request-a', status: 'completed' });
    assert.equal(successfulClaims, 0); assert.equal(runtime.activeRequestId, 'request-b');
});
test('successful stale reclaim of completed A restores the atomic preimage cooldown and permits fresh admission', async () => {
    reset(); winnerCompletesAfterDuplicateRead();
    assert.deepEqual(await admitPetAction(input), { requestId: 'request-a', status: 'completed' });
    assert.equal(successfulClaims, 1, 'exercise the successful runtime CAS missed by the previous mock');
    assert.equal(successfulUnwinds, 1); assert.equal(runtime.activeRequestId, null);
    assert.deepEqual(runtime.lastAcceptedAt, previousCooldown); assert.equal(runtime.admissionClaimId, undefined);
    const fresh = await admitPetAction({ ...input, origin: { ...input.origin, id: 'message-fresh' } });
    assert.equal(fresh.status, 'accepted'); assert.notEqual(fresh.requestId, 'request-a');
    assert.equal(runtime.activeRequestId, fresh.requestId); assert.equal(runtime.admissionClaimId, undefined, 'normal acceptance clears only its own claim');
});
test('replacement B during unwind preserves B slot, cooldown, generation and lease', async () => {
    reset(); winnerCompletesAfterDuplicateRead();
    let replacement: PetRuntimeRecord | undefined;
    beforeUnwind = () => { runtime.activeRequestId = 'request-b'; runtime.admissionClaimId = 'claim-b'; runtime.lastAcceptedAt = new Date(Date.now() + 10); replacement = structuredClone(runtime); };
    assert.equal((await admitPetAction(input)).status, 'completed');
    assert.equal(successfulClaims, 1); assert.equal(successfulUnwinds, 0); assert.deepEqual(runtime, replacement);
});
test('same-millisecond competing resolver for A is protected by unique claim identity', async () => {
    reset(); winnerCompletesAfterDuplicateRead();
    let replacement: PetRuntimeRecord | undefined;
    beforeUnwind = () => { runtime.admissionClaimId = 'another-resolver-same-request-and-millisecond'; replacement = structuredClone(runtime); };
    assert.equal((await admitPetAction(input)).status, 'completed');
    assert.equal(successfulClaims, 1); assert.equal(successfulUnwinds, 0); assert.deepEqual(runtime, replacement);
});
test('lease renewal during unwind keeps renewed expiry while freeing A and restoring prior cooldown', async () => {
    reset(); winnerCompletesAfterDuplicateRead();
    let renewedExpiry: Date | undefined;
    beforeUnwind = () => { renewedExpiry = new Date(runtime.lease!.expiresAt.getTime() + 15_000); runtime.lease!.expiresAt = renewedExpiry; };
    assert.equal((await admitPetAction(input)).status, 'completed');
    assert.equal(successfulClaims, 1); assert.equal(successfulUnwinds, 1); assert.equal(runtime.activeRequestId, null);
    assert.deepEqual(runtime.lastAcceptedAt, previousCooldown); assert.deepEqual(runtime.lease!.expiresAt, renewedExpiry);
    assert.equal(runtime.generation, 7); assert.equal(runtime.lease!.leaseId, 'lease-a'); assert.equal(runtime.tokenHash, 'unchanged-token');
});
