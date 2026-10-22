import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const owner = '111111111111111111111111';
let request = { _id: 'request-a', ownerId: owner, generation: 7, status: 'ready' };
let runtime = { _id: owner, generation: 7, activeRequestId: 'request-a', lease: { leaseId: 'lease-a', holderPeerId: 'peer-a', expiresAt: new Date(Date.now() + 15_000) }, notBefore: new Date(0) };
let interleave = false, readinessDeletes = 0;
const terminal = ['completed', 'cancelled', 'failed', 'expired'];
const query = <T>(read: () => T) => ({ lean: async () => read() });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PET_TERMINAL: terminal,
    PetRequest: {
        findOne: () => query(() => structuredClone(request)), findById: () => query(() => structuredClone(request)),
        findOneAndUpdate: (_filter: unknown, update: { $set: { status: string } }) => query(() => {
            if (terminal.includes(request.status)) return null;
            request.status = update.$set.status; return structuredClone(request);
        })
    },
    PetRuntime: {
        findById: () => query(() => {
            const old = structuredClone(runtime);
            if (interleave) { request.status = 'completed'; runtime = { ...runtime, activeRequestId: 'request-b', lease: { ...runtime.lease, leaseId: 'lease-b' } }; }
            return old;
        }),
        findOneAndUpdate: (filter: { activeRequestId?: string; generation?: number }) => query(() => {
            assert.equal(filter.activeRequestId, 'request-a', 'cancel must compare the requested identity atomically');
            assert.equal(filter.generation, 7);
            if (runtime.activeRequestId !== filter.activeRequestId || runtime.generation !== filter.generation) return null;
            const old = structuredClone(runtime); runtime.generation++; runtime.activeRequestId = ''; return old;
        }),
        updateOne: async () => { assert.fail('completed A must not unlink B'); }
    }
} });
mock.module('./readiness.schema.js', { namedExports: { PetReadiness: { deleteOne: async () => { readinessDeletes++; } } } });
mock.module('./wakeups.js', { namedExports: { PET_WAKE: 'pet:test', petWakeups: { notify: () => {} } } });
const { cancelPetRequest } = await import('./state.js');

test('cancelling A loses its CAS after completion/replacement; B generation and lease remain untouched', async () => {
    interleave = true;
    const expectedB = { ...structuredClone(runtime), activeRequestId: 'request-b', lease: { ...runtime.lease, leaseId: 'lease-b' } };
    assert.deepEqual(await cancelPetRequest(owner, 'request-a', 'command-a'), { requestId: 'request-a', status: 'completed' });
    assert.deepEqual(runtime, expectedB);
    assert.equal(readinessDeletes, 0, 'a lost request-specific cancellation cannot clear replacement readiness');
});
