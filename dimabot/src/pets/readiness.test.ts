import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
const owner = '111111111111111111111111';
const clearing = Promise.withResolvers<void>(), releaseClear = Promise.withResolvers<void>();
let available = false;
interface Row { peerId: string; expiresAt: Date; authorizationExpiresAt: Date }
let row: Row | null = null;
const writes: string[] = [];
const query = <T>(value: T) => ({ lean: async () => value });
mock.module('../schemas/pet_settings.schema.js', { namedExports: { PetSettingsSchema: { findOne: () => ({ select: () => query({ revision: 4, settings: { appearance: { kind: 'vts' }, playback: { vtsSessionId: 'session-a' } } }) }) } } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: { PetRuntime: { findById: () => query({ generation: 7 }) } } });
mock.module('./peers.js', { namedExports: { selectedVtsController: async () => available ? {
    id: 'replacement-peer', socket: { connected: true }, validatedAt: Date.now(), authorizationExpiresAt: Date.now() + 2000
} : null } });
mock.module('./readiness.schema.js', { namedExports: { PetReadiness: {
    init: async () => {}, deleteMany: async () => { row = null; },
    deleteOne: async () => { clearing.resolve(); await releaseClear.promise; row = null; writes.push('clear'); },
    updateOne: async (filter: { _id: string }, update: { $set: Row }) => { if (filter._id !== 'api-instance') { row = update.$set; writes.push('ready'); } }
} } });
const { initializePetReadiness, refreshPetReadiness, stopPetReadiness } = await import('./readiness.js');

test('older disconnect clear cannot delete newer overlapping-socket readiness; expiry stays inside token validity', async context => {
    context.after(stopPetReadiness);
    await initializePetReadiness();
    const old = refreshPetReadiness(owner); await clearing.promise;
    available = true;
    const replacement = refreshPetReadiness(owner);
    assert.equal(old, replacement, 'one in-flight observation plus dirty bit, no unbounded refresh queue');
    releaseClear.resolve(); await replacement;
    assert.deepEqual(writes, ['clear', 'ready']);
    assert.equal(row?.peerId, 'replacement-peer');
    assert.ok(row!.expiresAt.getTime() <= row!.authorizationExpiresAt.getTime());
    assert.ok(row!.expiresAt.getTime() - Date.now() <= 2000);
    await initializePetReadiness();
    assert.equal(row, null, 'API restart clears prior process readiness without reviving it');
});
