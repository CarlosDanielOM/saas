import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const owner = '111111111111111111111111';
let request = { _id: 'request-a', ownerId: owner, generation: 7, status: 'ready' };
let runtime = { _id: owner, generation: 7, activeRequestId: 'request-a', lease: { leaseId: 'lease-a', holderPeerId: 'peer-a', expiresAt: new Date(Date.now() + 15_000) }, notBefore: new Date(0) };
let interleave = false, readinessDeletes = 0;
const runtimeUpdates: any[] = [];
const terminal = ['completed', 'cancelled', 'failed', 'expired'];
const query = <T>(read: () => T) => ({ lean: async () => read() });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PET_TERMINAL: terminal,
    PetRequest: {
        findOne: () => query(() => structuredClone(request)), findById: () => query(() => structuredClone(request)),
        findOneAndUpdate: (filter: { _id: string; ownerId?: string; generation?: number }, update: { $set: { status: string } }) => query(() => {
            if (filter._id !== request._id || filter.ownerId !== undefined && filter.ownerId !== request.ownerId || filter.generation !== undefined && filter.generation !== request.generation || terminal.includes(request.status)) return null;
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
        updateOne: async (filter: { _id: string; activeRequestId: string; generation?: number }) => {
            runtimeUpdates.push(filter);
            if(runtime._id !== filter._id || runtime.activeRequestId !== filter.activeRequestId || filter.generation !== undefined && runtime.generation !== filter.generation)return {matchedCount:0};
            runtime.activeRequestId = null as any; return {matchedCount:1};
        }
    }
} });
mock.module('./readiness.schema.js', { namedExports: { PetReadiness: { deleteOne: async () => { readinessDeletes++; } } } });
mock.module('./wakeups.js', { namedExports: { PET_WAKE: 'pet:test', petWakeups: { notify: () => {} } } });
const { cancelPetRequest, finishRequest } = await import('./state.js');

test('cancelling A loses its CAS after completion/replacement; B generation and lease remain untouched', async () => {
    interleave = true;
    const expectedB = { ...structuredClone(runtime), activeRequestId: 'request-b', lease: { ...runtime.lease, leaseId: 'lease-b' } };
    assert.deepEqual(await cancelPetRequest(owner, 'request-a', 'command-a'), { requestId: 'request-a', status: 'completed' });
    assert.deepEqual(runtime, expectedB);
    assert.equal(runtimeUpdates.length, 0, 'completed A must not unlink B');
    assert.equal(readinessDeletes, 0, 'a lost request-specific cancellation cannot clear replacement readiness');
});

function resetFinish() {
    interleave=false;runtimeUpdates.length=0;
    request={_id:'request-a',ownerId:owner,generation:7,status:'playing'};
    runtime={_id:owner,generation:7,activeRequestId:'request-a',lease:{leaseId:'lease-a',holderPeerId:'peer-a',expiresAt:new Date(Date.now()+15000)},notBefore:new Date(0)};
}
for(const mismatch of ['owner','generation'] as const)test(`R8 finishRequest rejects a stale ${mismatch} without reporting cancellation`,async()=>{
    resetFinish();const previousRequest=structuredClone(request),previousRuntime=structuredClone(runtime);
    const result=await finishRequest('request-a','cancelled','tts_ended',{ownerId:mismatch==='owner'?'other-owner':owner,generation:mismatch==='generation'?6:7});
    assert.equal(result,null);assert.deepEqual(request,previousRequest);assert.deepEqual(runtime,previousRuntime);assert.equal(runtimeUpdates.length,0);
});
for(const successor of ['request','generation','owner'] as const)test(`R8 finishRequest terminal CAS cannot unlink a successor ${successor}`,async()=>{
    resetFinish();
    if(successor==='request')runtime.activeRequestId='request-b';else if(successor==='generation')runtime.generation=8;else runtime._id='other-owner';
    const current=structuredClone(runtime);
    const result=await finishRequest('request-a','cancelled','tts_ended',{ownerId:owner,generation:7});
    assert.equal(result?.status,'cancelled');assert.equal(request.status,'cancelled');assert.deepEqual(runtime,current);
    assert.deepEqual(runtimeUpdates,[{_id:owner,activeRequestId:'request-a',generation:7}]);
});
test('R8 finishRequest clears its exact runtime link while preserving lease and generation',async()=>{
    resetFinish();const previous=structuredClone(runtime);
    assert.equal((await finishRequest('request-a','cancelled','tts_ended',{ownerId:owner,generation:7}))?.status,'cancelled');
    assert.deepEqual(runtime,{...previous,activeRequestId:null});
});
