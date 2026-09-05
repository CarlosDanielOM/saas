import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { drainDomainEvents, type DomainEventConsumerRuntime } from './domain_event_consumer.js';

function query<T>(value: T) {
    return { sort() { return this; }, limit() { return this; }, lean: async () => value, then: Promise.resolve(value).then.bind(Promise.resolve(value)) };
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function setup(context: TestContext, attempts = 0) {
    const event = new DomainEventSchema({ eventKey: 'isolation-test', topic: 'domain', schemaVersion: 1 });
    const delivery = {
        _id: new Types.ObjectId(), eventID: event._id, eventKey: event.eventKey,
        status: attempts ? 'processing' : 'pending', attempts, leaseToken: 'old', lockedUntil: new Date(0)
    };
    const updates: Array<{ filter: any; update: any }> = [];
    const claims: any[] = [];
    const lifecycle: string[] = [];
    let renewalResult: () => Promise<{ modifiedCount: number }> = async () => ({ modifiedCount: 1 });
    context.mock.method(DomainEventDeliverySchema, 'find', (() => query([delivery])) as never);
    context.mock.method(DomainEventSchema, 'findById', (() => query(event)) as never);
    context.mock.method(DomainEventSchema, 'find', (() => query([])) as never);
    context.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query(null)) as never);
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((filter: any, update: any) => {
        if (update.$setOnInsert) return query(delivery);
        claims.push(filter);
        return query({ ...delivery, ...update.$set, attempts: attempts + 1 });
    }) as never);
    context.mock.method(DomainEventDeliverySchema, 'updateOne', ((filter: any, update: any) => {
        updates.push({ filter, update });
        return update.$set.status ? Promise.resolve({ modifiedCount: 1 }) : renewalResult();
    }) as never);
    const runtime: DomainEventConsumerRuntime = {
        beforeClaim: () => lifecycle.push('beforeClaim'), claimed: () => lifecycle.push('claimed'),
        renewed: () => lifecycle.push('renewed'), leaseLost: () => lifecycle.push('leaseLost'),
        finished: () => lifecycle.push('finished')
    };
    return {
        updates, claims, lifecycle, runtime,
        setRenewal(fn: typeof renewalResult) { renewalResult = fn; },
        drain(handler: () => Promise<void>) {
            return drainDomainEvents({ consumer: 'isolated', topics: ['domain'], maxAttempts: 3, leaseMs: 6000, handler, runtime });
        }
    };
}

for (const failure of ['error', 'zero'] as const) {
    test(`heartbeat ${failure} reports lease loss and prevents completion even if handler resolves later`, async (context) => {
        context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10_000 });
        const h = setup(context);
        const started = deferred();
        const finish = deferred();
        const lost = deferred();
        h.runtime.leaseLost = () => { h.lifecycle.push('leaseLost'); lost.resolve(); };
        h.setRenewal(async () => {
            if (failure === 'error') throw new Error('Mongo renewal unavailable');
            return { modifiedCount: 0 };
        });
        const drain = h.drain(async () => { started.resolve(); await finish.promise; });
        await started.promise;
        context.mock.timers.tick(2000);
        await lost.promise;
        finish.resolve();
        await assert.rejects(drain, /renewal/);
        assert.equal(h.updates.length, 1, 'no completion or failure write after lease loss');
        assert.deepEqual(h.lifecycle, ['beforeClaim', 'claimed', 'leaseLost', 'finished']);
        assert.equal(typeof h.updates[0].filter.leaseToken, 'string');
        assert.notEqual(h.updates[0].filter.leaseToken, 'old');
        assert.ok(h.updates[0].filter.lockedUntil.$gt instanceof Date);
    });
}

test('completion waits for in-flight renewal and is lease-token/expiry guarded', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10_000 });
    const h = setup(context);
    const started = deferred();
    const finish = deferred();
    const renewal = deferred<{ modifiedCount: number }>();
    h.setRenewal(() => renewal.promise);
    const drain = h.drain(async () => { started.resolve(); await finish.promise; });
    await started.promise;
    context.mock.timers.tick(2000);
    finish.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.updates.length, 1);
    renewal.resolve({ modifiedCount: 1 });
    assert.equal((await drain).succeeded, 1);
    assert.deepEqual(h.lifecycle, ['beforeClaim', 'claimed', 'renewed', 'finished']);
    assert.equal(h.updates[1].filter.leaseToken, h.updates[0].filter.leaseToken);
    assert.ok(h.updates[1].filter.lockedUntil.$gt instanceof Date);
    assert.deepEqual(h.claims[0].attempts, { $lt: 3 });
});

test('expired execution cannot complete without a successful heartbeat', async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const h = setup(context);
    await assert.rejects(h.drain(async () => { context.mock.timers.tick(6001); }), /lease expired/);
    assert.equal(h.updates.length, 0, 'processing lease remains for recovery');
    assert.ok(h.lifecycle.includes('leaseLost'));
});

test('an interrupted final attempt is atomically dead-lettered without invoking effects again', async (context) => {
    const h = setup(context, 3);
    const result = await h.drain(async () => assert.fail('exhausted delivery executed'));
    assert.equal(result.dead, 1);
    assert.equal(h.claims.length, 0);
    assert.deepEqual(h.updates[0].filter.attempts, { $gte: 3 });
    assert.ok(h.updates[0].filter.$and[0].$or[1].lockedUntil.$lte instanceof Date);
    assert.equal(h.updates[0].update.$set.status, 'dead');
    assert.equal(h.updates[0].update.$set.lastErrorCode, 'interrupted');
    assert.equal(h.updates[0].update.$set.lastAttemptDurationMs, null, 'do not invent a crashed attempt duration');
    assert.equal(h.updates[0].update.$inc, undefined, 'retirement does not create another attempt');
    assert.deepEqual(h.lifecycle, ['beforeClaim', 'finished']);
});

test('shutdown prevents claiming subsequent deliveries', async (context) => {
    const h = setup(context);
    h.runtime.shouldStop = () => true;
    await h.drain(async () => assert.fail('handler ran during shutdown'));
    assert.equal(h.claims.length, 0);
    assert.equal(h.updates.length, 0);
});

test('repeated crashed attempts stop at maxAttempts without a failure write from the dying handler', async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const h = setup(context);
    let stored: any = { _id: new Types.ObjectId(), status: 'pending', attempts: 0, lockedUntil: null };
    context.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((filter: any, update: any) => {
        if (update.$setOnInsert) return query({ ...stored });
        assert.deepEqual(filter.attempts, { $lt: 3 });
        if (stored.attempts >= filter.attempts.$lt) return query(null);
        stored = { ...stored, ...update.$set, attempts: stored.attempts + 1 };
        return query({ ...stored });
    }) as never);
    context.mock.method(DomainEventDeliverySchema, 'updateOne', ((filter: any, update: any) => {
        assert.equal(update.$set.status, 'dead', 'crashed executions leave no retry/completion write');
        assert.ok(stored.attempts >= filter.attempts.$gte);
        assert.ok(stored.lockedUntil <= filter.$and[0].$or[1].lockedUntil.$lte);
        stored = { ...stored, ...update.$set };
        return Promise.resolve({ modifiedCount: 1 });
    }) as never);
    let effects = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(h.drain(async () => {
            effects++;
            // Lease expiry simulates a hard exit: no completion/failure mutation.
            context.mock.timers.tick(6001);
        }), /lease expired/);
    }
    assert.equal((await h.drain(async () => { effects++; })).dead, 1);
    assert.equal(stored.attempts, 3);
    assert.equal(stored.status, 'dead');
    assert.equal(effects, 3);
    const completed = await h.drain(async () => { effects++; });
    assert.equal(completed.succeeded, 0);
    assert.equal(completed.alreadyComplete, 1);
    assert.equal(effects, 3, 'later scans cannot restart a terminal delivery');
});
