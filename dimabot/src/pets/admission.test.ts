import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
const owner = '111111111111111111111111';
const input = { channelId: '99003101', operation: 'talk' as const, text: 'Same paid action',
    origin: { kind: 'chat-command' as const, id: 'message-1', occurredAt: '2026-10-22T18:00:00.000Z' }, actionKey: 'command:0', actor: { userId: '123', displayName: 'Fixture' } };
const payloadHash = createHash('sha256').update(JSON.stringify({ operation: input.operation, text: input.text, actor: input.actor, occurredAt: input.origin.occurredAt })).digest('hex');
let record = { _id: 'request-a', ...input, ownerId: owner, payloadHash, admitted: false, generation: 7, settingsRevision: 4, status: 'accepted' };
let completedBeforeLink = false;
const query = <T>(read: () => T) => ({ lean: async () => read() });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => ({ select: () => query(() => ({ _id: owner })) }) } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PetRequest: {
        init: async () => {}, findOne: () => query(() => structuredClone(record)), findById: () => query(() => structuredClone(record)),
        findOneAndUpdate: (filter: { admitted?: boolean }, update: { $set: { admitted?: boolean } }) => query(() => {
            if (update.$set.admitted === true) { record = { ...record, admitted: true, status: 'generating' }; return null; }
            assert.equal(filter.admitted, false);
            assert.equal(record.admitted, true, 'another resolver already admitted and completed A');
            return null;
        })
    },
    PetRuntime: {
        updateOne: async () => ({ modifiedCount: 0 }), findOne: () => query(() => {
            if (completedBeforeLink) { record = { ...record, admitted: true, status: 'completed' }; return null; }
            return { activeRequestId: 'request-a' };
        })
    }
} });
mock.module('../server/services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => ({ revision: 4,
    runtime: { enabled: true, issues: [] }, settings: { tts: { enabled: true }, behavior: { cooldownSeconds: 0 } } }) } });
mock.module('./state.js', { namedExports: {
    PetError: class PetError extends Error { constructor(code: string) { super(code); } }, notifyPet: async () => {},
    runtimeFor: async () => ({ generation: 7, lease: { leaseId: 'lease-a', expiresAt: new Date(Date.now() + 15_000) } })
} });
const { admitPetAction } = await import('./admission.js');

test('false-admitted duplicate rereads generating outcome when its accepted update loses the race', async () => {
    assert.deepEqual(await admitPetAction(input), { requestId: 'request-a', status: 'generating' });
});
test('false-admitted duplicate rereads completed A when the runtime slot already belongs to B', async () => {
    record = { ...record, admitted: false, status: 'accepted' }; completedBeforeLink = true;
    assert.deepEqual(await admitPetAction(input), { requestId: 'request-a', status: 'completed' });
});
