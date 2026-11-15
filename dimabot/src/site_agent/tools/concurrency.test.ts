/** Per-connection MCP call slots: limit at once, FIFO queue, queue cap, wait timeout, abort while waiting. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireCallSlot, CallSlotError, callSlotState } from './concurrency.js';

const limits = { atOnce: 2, queued: 2, waitMs: 200 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('up to atOnce run; the next ones wait in arrival order and start as slots free up', async () => {
    const a = await acquireCallSlot('k1', undefined, limits);
    const b = await acquireCallSlot('k1', undefined, limits);
    const order: string[] = [];
    const c = acquireCallSlot('k1', undefined, limits).then((release) => { order.push('c'); return release; });
    const d = acquireCallSlot('k1', undefined, limits).then((release) => { order.push('d'); return release; });
    await tick();
    assert.deepEqual(callSlotState('k1'), { running: 2, waiting: 2 });
    a();
    a(); // a second release is ignored
    const releaseC = await c;
    assert.deepEqual(order, ['c']);
    b();
    const releaseD = await d;
    assert.deepEqual(order, ['c', 'd']);
    releaseC(); releaseD();
    assert.deepEqual(callSlotState('k1'), { running: 0, waiting: 0 });
});

test('a full queue is refused at once; a long wait times out; other keys are independent', async () => {
    const held = [await acquireCallSlot('k2', undefined, limits), await acquireCallSlot('k2', undefined, limits)];
    const w1 = acquireCallSlot('k2', undefined, limits);
    const w2 = acquireCallSlot('k2', undefined, limits);
    await assert.rejects(acquireCallSlot('k2', undefined, limits), (err: unknown) => err instanceof CallSlotError && err.reason === 'queue_full');
    const other = await acquireCallSlot('k3', undefined, limits);
    other();
    await assert.rejects(w1, (err: unknown) => err instanceof CallSlotError && err.reason === 'timeout');
    await assert.rejects(w2, (err: unknown) => err instanceof CallSlotError && err.reason === 'timeout');
    for (const release of held) release();
    assert.deepEqual(callSlotState('k2'), { running: 0, waiting: 0 });
});

test('a caller that aborts while waiting leaves the queue and frees nothing it never had', async () => {
    const held = [await acquireCallSlot('k4', undefined, limits), await acquireCallSlot('k4', undefined, limits)];
    const controller = new AbortController();
    const waiting = acquireCallSlot('k4', controller.signal, limits);
    await tick();
    controller.abort();
    await assert.rejects(waiting, (err: unknown) => err instanceof CallSlotError && err.reason === 'aborted');
    assert.deepEqual(callSlotState('k4'), { running: 2, waiting: 0 });
    await assert.rejects(acquireCallSlot('k4', controller.signal, limits), (err: unknown) => err instanceof CallSlotError && err.reason === 'aborted');
    for (const release of held) release();
    assert.deepEqual(callSlotState('k4'), { running: 0, waiting: 0 });
});
