import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
let row: any = null, petVersion = 0, reads = 0;
let bulkTurns: any[] = [], bulkPets: any[] = [];
const bulkQueries: Array<{ kind: string; filter: any; limit?: number; select?: string }> = [];
function bulkQuery(kind: 'turns' | 'pets', filter: any): any {
    const receipt: any = { kind, filter }; bulkQueries.push(receipt);
    const chain: any = { sort: () => chain, limit: (limit: number) => { receipt.limit = limit; return chain; },
        select: (select: string) => { receipt.select = select; return chain; },
        lean: async () => structuredClone((kind === 'turns' ? bulkTurns : bulkPets).slice(0, receipt.limit)) };
    return chain;
}
let acknowledge: (() => void) | undefined;
let fail = false, matched = true;
const query = (value: () => unknown): any => ({ lean: async () => value(), select: () => query(value) });
mock.module('./schema.js', { namedExports: { DesktopAiTurn: {
    find: (filter: any) => bulkQuery('turns', filter),
    findById: () => query(() => { reads++; return row && structuredClone(row); }),
    updateOne: async (_filter: unknown, update: any) => {
        if (fail) throw new Error('write_failed');
        if (acknowledge) await new Promise<void>(resolve => { acknowledge = resolve; });
        if (!matched) return { modifiedCount: 0 };
        row.revision++; Object.assign(row, update.$set); return { modifiedCount: 1 };
    },
    findOneAndUpdate: (_filter: unknown, update: any) => query(() => {
        if (fail) throw new Error('write_failed');
        if (!matched) return null;
        row.revision++; Object.assign(row, update.$set); return structuredClone(row);
    })
} } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: { PetRequest: { findOne: () => query(() => ({ version: petVersion })), find: (filter: any) => bulkQuery('pets', filter) } } });
const { updateTurn, changeTurn, notifyTurnUpdated, subscribeTurnUpdates, turnWireRevision, refreshPetTurnUpdates, BOT_AUDIO_DELIVERY_MS } = await import('./updates.js');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('turn hints reflect acknowledged visible changes, coalesce rereads and share HTTP revision semantics', async () => {
    assert.equal(BOT_AUDIO_DELIVERY_MS, 20_000);
    assert.equal(turnWireRevision(1), 1);
    assert.equal(turnWireRevision(3, 7), 200008);
    assert.equal(turnWireRevision(3, 999999), 300000);
    row = { _id: 'turn', requestId: 'request', revision: 1, status: 'queued', ownerId: 'owner' };
    notifyTurnUpdated('turn'); await flush(); assert.equal(reads, 0, 'legacy-only deployments do not reread for hints');
    const events: any[] = [], stop = subscribeTurnUpdates(update => events.push(update));
    acknowledge = () => {};
    const write = updateTurn({ _id: 'turn' }, { $set: { status: 'running' } });
    await flush(); assert.equal(events.length, 0, 'no notification before Mongo ACK');
    acknowledge!(); acknowledge = undefined; await write; await flush();
    assert.equal(events.length, 1); assert.equal(events[0].revision, 100001); assert.equal(events[0].turn.status, 'running');
    matched = false;
    await updateTurn({ _id: 'turn' }, { $set: { status: 'failed' } });
    await changeTurn({ _id: 'turn' }, { $set: { status: 'failed' } }); await flush();
    assert.equal(events.length, 1, 'failed compare-and-set never advertises proposed state');
    matched = true; fail = true;
    await assert.rejects(() => updateTurn({ _id: 'turn' }, { $set: { status: 'failed' } }), /write_failed/);
    await flush(); assert.equal(events.length, 1); fail = false;
    await updateTurn({ _id: 'turn' }, { $set: { executionFence: 'private' } }); await flush();
    assert.equal(events.length, 1, 'internal receipt/fence changes do not cause GET traffic');
    row.petRequestId = 'pet'; petVersion = 17;
    await changeTurn({ _id: 'turn' }, { $set: { 'speech.status': 'ready' } }); await flush();
    assert.equal(events.at(-1).revision, turnWireRevision(row.revision, petVersion));
    const before = reads;
    notifyTurnUpdated('turn'); notifyTurnUpdated('turn'); notifyTurnUpdated('turn'); await flush();
    assert.equal(reads - before, 1, 'same-tick invalidations share an authoritative read');
    assert.equal(events.at(-1).revision, turnWireRevision(row.revision, petVersion));
    stop(); notifyTurnUpdated('turn'); await flush(); assert.equal(reads - before, 1);
});


test('Pet owner wake uses two bounded metadata reads for64 rows with exact snapshot revisions', async () => {
    bulkQueries.length = 0;
    bulkTurns = Array.from({ length: 65 }, (_, index) => ({ _id: `turn-${index}`, requestId: `request-${index}`,
        ownerId: 'owner', sessionId: 'session', target: 'pet', clientId: 'desktop', channelId: 'channel',
        revision: index + 1, petRequestId: `pet-${index}` }));
    bulkPets = Array.from({ length: 65 }, (_, index) => ({ _id: `pet-${index}`, version: index ? index + 10 : 999999 }));
    const events: any[] = []; const stop = subscribeTurnUpdates(update => events.push(update));
    const priorReads = reads;
    await refreshPetTurnUpdates('owner', ['session', 'session']);
    assert.equal(bulkQueries.length, 2); assert.equal(reads, priorReads, 'no per-turn rereads');
    assert.equal(events.length, 64);
    assert.equal(bulkQueries[0].limit, 64); assert.equal(bulkQueries[1].limit, 64);
    assert.deepEqual(bulkQueries[0].filter.sessionId, { $in: ['session'] });
    assert.equal(bulkQueries[0].filter.ownerId, 'owner'); assert.equal(bulkQueries[1].filter.ownerId, 'owner');
    assert.equal(bulkQueries[1].filter._id.$in.length, 64);
    assert.equal(bulkQueries[0].select, '_id requestId ownerId clientId channelId sessionId target revision petRequestId');
    assert.equal(bulkQueries[1].select, '_id version');
    for (const [index, event] of events.entries()) assert.equal(event.revision, turnWireRevision(index + 1, index ? index + 10 : 999999));
    stop();
    await refreshPetTurnUpdates('owner', ['session']);
    assert.equal(bulkQueries.length, 2, 'no work without negotiated listeners');
    const noInterest = subscribeTurnUpdates(() => {}, () => false);
    await refreshPetTurnUpdates('owner', ['session']); noInterest();
    assert.equal(bulkQueries.length, 2, 'legacy-only sockets cannot trigger reads');
});
