import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { leaseHeartbeat } from './lease_heartbeat.js';

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('renewals never overlap, and stop waits for the one in flight before the caller releases', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const pending: ((renewed: boolean) => void)[] = []; let started = 0;
        const heartbeat = leaseHeartbeat(() => new Promise<boolean>(resolve => { started++; pending.push(resolve); }), 10_000);
        mock.timers.tick(9_999); await settle(); assert.equal(started, 0);
        mock.timers.tick(1); await settle(); assert.equal(started, 1);
        // The first renewal is stalled: no second one starts, however long it takes.
        mock.timers.tick(60_000); await settle(); assert.equal(started, 1);
        let released = false;
        const stopping = heartbeat.stop().then(() => { released = true; });
        await settle(); assert.equal(released, false, 'release waits for the stalled renewal');
        pending[0](true); await stopping;
        assert.deepEqual([released, heartbeat.lost], [true, false]);
        mock.timers.tick(60_000); await settle(); assert.equal(started, 1, 'nothing renews after stop');
    } finally { mock.timers.reset(); }
});

test('a renewal that finds the lease gone, or fails, marks it lost and stops renewing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        for (const outcome of [async () => false, async () => { throw new Error('storage'); }]) {
            let calls = 0;
            const heartbeat = leaseHeartbeat(() => { calls++; return calls === 1 ? Promise.resolve(true) : outcome(); }, 10_000);
            mock.timers.tick(10_000); await settle(); assert.equal(heartbeat.lost, false);
            mock.timers.tick(10_000); await settle(); assert.equal(heartbeat.lost, true);
            mock.timers.tick(60_000); await settle(); assert.equal(calls, 2);
            await heartbeat.stop();
        }
    } finally { mock.timers.reset(); }
});
