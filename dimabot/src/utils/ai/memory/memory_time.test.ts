import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { memoryUnixSeconds } from './memory_time.js';

test('uses the date when present', () => {
    const objectId = new Types.ObjectId();
    const date = new Date('2026-09-03T04:49:56.000Z');
    assert.equal(memoryUnixSeconds(date, objectId), Math.floor(date.getTime() / 1000));
});

test('falls back to ObjectId timestamp when date is missing', () => {
    const objectId = new Types.ObjectId('68b7c8b40000000000000000');
    assert.doesNotThrow(() => memoryUnixSeconds(undefined, objectId));
    assert.equal(
        memoryUnixSeconds(undefined, objectId),
        Math.floor(objectId.getTimestamp().getTime() / 1000)
    );
});
