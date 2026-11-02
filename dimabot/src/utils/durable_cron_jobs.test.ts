import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableCronJobs, DURABLE_CRON_LEASE_MS } from './durable_cron_jobs.js';
import type { CronQueueJob } from './cron_jobs_queue.js';

// Dependency-injected in-memory Mongo/Redis fixtures. The candidate check also
// exercises the actual Mongo indexes and Redis publication script.
function fixture() {
    let clock = new Date('2026-11-02T00:00:00Z');
    let sequence = 0;
    const rows: any[] = [];
    const queues = new Map<string, string[]>();
    const markers = new Set<string>();
    let failPublish = false;
    let losePublishResponse = false;
    const field = (row: any, path: string) => path.split('.').reduce((value, key) => value?.[key], row);
    function matches(row: any, filter: any): boolean {
        return Object.entries(filter).every(([key, value]: [string, any]) => {
            if (key === '$or') return value.some((f: any) => matches(row, f));
            const actual = field(row, key);
            if (value === null) return actual == null;
            if (value && typeof value === 'object' && !(value instanceof Date)) {
                return Object.entries(value).every(([op, operand]: [string, any]) => {
                    if (op === '$lte') return actual <= operand;
                    if (op === '$gt') return actual > operand;
                    throw new Error(`Unsupported operator ${op}`);
                });
            }
            return actual instanceof Date && value instanceof Date ? +actual === +value : actual === value;
        });
    }
    function apply(row: any, update: any) {
        Object.assign(row, structuredClone(update.$set || {}));
        for (const key of Object.keys(update.$unset || {})) delete row[key];
    }
    const query = (fn: () => any) => ({ lean: async () => structuredClone(fn()), then: (ok: any, bad: any) => Promise.resolve(fn()).then(ok, bad) });
    const model = {
        async init() {},
        findOne: (filter: any) => query(() => rows.find(row => matches(row, filter)) || null),
        findById: (id: string) => query(() => rows.find(row => row._id === id) || null),
        exists: async (filter: any) => rows.find(row => matches(row, filter)) || null,
        async create([input]: any[]) {
            if (rows.some(row => row.jobID === input.jobID || (input.activeKey && row.activeKey === input.activeKey) ||
                (input.automaticKey && row.automaticKey === input.automaticKey))) throw Object.assign(new Error('duplicate'), { code: 11000 });
            const row = { ...structuredClone(input), _id: `intent-${++sequence}` };
            rows.push(row);
            return [row];
        },
        async updateOne(filter: any, update: any) {
            const row = rows.find(row => matches(row, filter));
            if (!row) return { matchedCount: 0, modifiedCount: 0 };
            apply(row, update);
            return { matchedCount: 1, modifiedCount: 1 };
        },
        findOneAndUpdate(filter: any, update: any, options: any) {
            return query(() => {
                const candidates = rows.filter(row => matches(row, filter));
                if (options?.sort) {
                    const sortFields = Object.keys(options.sort);
                    candidates.sort((a, b) => {
                        for (const key of sortFields) {
                            if (a[key] < b[key]) return -1;
                            if (a[key] > b[key]) return 1;
                        }
                        return 0;
                    });
                }
                if (!candidates[0]) return null;
                apply(candidates[0], update);
                return candidates[0];
            });
        }
    };
    const cache = {
        async eval(_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) {
            if (failPublish) throw new Error('Redis unavailable');
            const list = queues.get(keys[0]) || [];
            queues.set(keys[0], list);
            const found = list.slice(0, Number(args[1])).includes(args[0]);
            if (!found) list.unshift(args[0]);
            if (keys[1]) markers.add(keys[1]);
            if (losePublishResponse) { losePublishResponse = false; throw new Error('lost publication response'); }
            return found ? 0 : 1;
        }
    };
    const service = createDurableCronJobs({ model: model as never, cache: async () => cache as never,
        now: () => new Date(clock), uuid: () => `token-${++sequence}` });
    return { service, rows, queues, markers, now: () => new Date(clock),
        advance: (ms: number) => { clock = new Date(+clock + ms); },
        failPublish: (value: boolean) => { failPublish = value; },
        loseResponse: () => { losePublishResponse = true; } };
}

const queue = 'cron:stream-memory:queue';
function job(id: string, overrides: Partial<CronQueueJob> = {}): CronQueueJob {
    return { id, job: 'stream-memory-summary', channelID: 'channel', requestedAt: '2026-11-02T00:00:00Z',
        dedupeKey: 'dedupe:one', data: { source: 'stream_offline', sessionID: 'session' }, ...overrides };
}

test('Mongo acceptance precedes Redis failure and bounded recovery restores a lost queue', async () => {
    const h = fixture();
    const input = job('one');
    const accepted = await h.service.prepare(input, queue, { dedupeSeconds: 60 });
    assert.equal(accepted.created, true);
    h.failPublish(true);
    await assert.rejects(h.service.publish(input, queue), /Redis unavailable/);
    assert.equal(h.rows[0].status, 'queued');
    h.failPublish(false);
    h.advance(30_001);
    assert.deepEqual(await h.service.recover(queue, { limit: 5 }), { examined: 1, published: 1, uncertain: 0 });
    h.queues.delete(queue); // Simulates loss even though the acceptance marker survived.
    h.advance(30_001);
    assert.deepEqual(await h.service.recover(queue, { limit: 5 }), { examined: 1, published: 1, uncertain: 0 });
    assert.equal(h.queues.get(queue)?.length, 1);
});

test('a lost publish acknowledgement and concurrent duplicate deliveries yield one fenced claim', async () => {
    const h = fixture();
    const input = job('one');
    await h.service.prepare(input, queue, { dedupeSeconds: 60 });
    h.loseResponse();
    await assert.rejects(h.service.publish(input, queue), /lost publication response/);
    assert.equal(await h.service.publish(input, queue), false);
    const [a, b] = await Promise.all([h.service.claim(input, queue, 'worker-a'), h.service.claim(input, queue, 'worker-b')]);
    assert.deepEqual([a.status, b.status].sort(), ['busy', 'claimed']);
    const claim = a.status === 'claimed' ? a.claim : b.status === 'claimed' ? b.claim : assert.fail('missing claim');
    assert.equal(await h.service.complete({ ...claim, token: 'wrong' }), false);
    assert.equal(await h.service.complete(claim), true);
    assert.equal((await h.service.claim(input, queue, 'worker-c')).status, 'terminal');
});

test('a legacy marker is preserved without replay; a real old payload adopts its stable automatic identity', async () => {
    const h = fixture();
    const modern = job('modern');
    const accepted = await h.service.prepare(modern, queue, { dedupeSeconds: 60, legacyAccepted: true });
    assert.equal(accepted.status, 'legacy_accepted');
    assert.equal(await h.service.publish(modern, queue), false);
    assert.equal((await h.service.recover(queue, { limit: 5 })).examined, 0);
    const old = job('legacy', { dedupeKey: 'old-stream-id' });
    const claimed = await h.service.claim(old, queue, 'worker');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.job.id, 'legacy');
    assert.equal((await h.service.claim(modern, queue, 'other')).status, 'busy');
    if (claimed.status === 'claimed') assert.equal(await h.service.complete(claimed.claim), true);
    const duplicate = await h.service.prepare(job('later'), queue, { dedupeSeconds: 60 });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, 'legacy');
});

test('processing lease expiry is uncertain and is never automatically replayed', async () => {
    const h = fixture();
    const input = job('one');
    await h.service.prepare(input, queue, { dedupeSeconds: 60 });
    const claimed = await h.service.claim(input, queue, 'worker');
    if (claimed.status !== 'claimed') assert.fail('expected claim');
    h.advance(DURABLE_CRON_LEASE_MS + 1);
    assert.equal(await h.service.renew(claimed.claim), false);
    assert.equal(await h.service.assertActive(claimed.claim), false);
    assert.deepEqual(await h.service.recover(queue, { limit: 5 }), { examined: 0, published: 0, uncertain: 1 });
    assert.equal(h.rows[0].status, 'uncertain');
    assert.equal((await h.service.claim(input, queue, 'other')).status, 'terminal');
    assert.equal(await h.service.complete(claimed.claim), false);
});

test('known retry retains its updated canonical payload and waits until due', async () => {
    const h = fixture();
    const input = job('one');
    await h.service.prepare(input, queue, { dedupeSeconds: 60 });
    const claimed = await h.service.claim(input, queue, 'worker');
    if (claimed.status !== 'claimed') assert.fail('expected claim');
    const retry = { ...claimed.job, data: { ...claimed.job.data, attempts: 2 } };
    assert.equal(await h.service.retry(claimed.claim, retry, new Date(+h.now() + 60_000)), true);
    assert.equal((await h.service.claim(input, queue, 'worker')).status, 'busy');
    assert.equal((await h.service.recover(queue, { limit: 5 })).examined, 0);
    h.advance(60_000);
    assert.equal((await h.service.recover(queue, { limit: 5 })).published, 1);
    const next = await h.service.claim(input, queue, 'worker');
    assert.equal(next.status, 'claimed');
    assert.equal(next.job.data?.attempts, 2);
});

test('ordinary terminal dedupe expires but pending and uncertain work stay authoritative', async () => {
    const h = fixture();
    const manual = job('one', { data: { source: 'manual' } });
    await h.service.prepare(manual, queue, { dedupeSeconds: 60 });
    h.advance(61_000);
    assert.equal((await h.service.prepare(job('two', { data: { source: 'manual' } }), queue, { dedupeSeconds: 60 })).created, false);
    const claimed = await h.service.claim(manual, queue, 'worker');
    if (claimed.status !== 'claimed') assert.fail('expected claim');
    assert.equal(await h.service.complete(claimed.claim), true);
    assert.equal((await h.service.prepare(job('two', { data: { source: 'manual' } }), queue, { dedupeSeconds: 60 })).created, true);
    assert.equal(h.rows.length, 2);
});

test('a later old-producer payload is adopted when ordinary terminal dedupe has expired', async () => {
    const h = fixture();
    const first = job('one', { data: { source: 'manual' } });
    await h.service.prepare(first, queue, { dedupeSeconds: 60 });
    const original = await h.service.claim(first, queue, 'worker');
    if (original.status !== 'claimed') assert.fail('expected claim');
    assert.equal(await h.service.complete(original.claim), true);
    h.advance(60_001);
    const later = await h.service.claim(job('two', { requestedAt: h.now().toISOString(), data: { source: 'manual' } }), queue, 'worker');
    assert.equal(later.status, 'claimed');
    assert.equal(later.job.id, 'two');
    assert.equal(h.rows.length, 2);
});

test('a delayed legacy alias cannot replay completed work after ordinary dedupe expires', async () => {
    const h = fixture();
    const original = job('modern', { data: { source: 'manual' } });
    await h.service.prepare(original, queue, { dedupeSeconds: 60 });
    const claimed = await h.service.claim(original, queue, 'worker');
    if (claimed.status !== 'claimed') assert.fail('expected claim');
    assert.equal(await h.service.complete(claimed.claim), true);
    h.advance(60_001);
    assert.equal((await h.service.claim({ ...original, id: 'old-producer-alias' }, queue, 'worker')).status, 'terminal');
    assert.equal(h.rows.length, 1);
});

test('retry cannot change an automatic job identity', async () => {
    const h = fixture();
    const input = job('one');
    await h.service.prepare(input, queue, { dedupeSeconds: 60 });
    const claimed = await h.service.claim(input, queue, 'worker');
    if (claimed.status !== 'claimed') assert.fail('expected claim');
    assert.equal(await h.service.retry(claimed.claim, { ...input, data: { source: 'stream_offline', sessionID: 'other' } }, h.now()), false);
    assert.equal(await h.service.assertActive(claimed.claim), true);
});

test('bounded recovery progresses across ready backlog without being blocked by a future job', async () => {
    const h = fixture();
    for (let i = 0; i < 5; i++) {
        const scheduled = i === 0 ? { notBeforeUnix: +h.now() / 1000 + 3600 } : {};
        await h.service.prepare(job(`job-${i}`, { dedupeKey: `dedupe-${i}`, data: { source: 'manual', ...scheduled } }),
            queue, { dedupeSeconds: 60 });
    }
    assert.deepEqual(await h.service.recover(queue, { limit: 2 }), { examined: 2, published: 2, uncertain: 0 });
    assert.deepEqual(await h.service.recover(queue, { limit: 2 }), { examined: 2, published: 2, uncertain: 0 });
    assert.equal(h.queues.get(queue)?.length, 4);
});
