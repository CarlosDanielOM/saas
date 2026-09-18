import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldLogPermissionError } from './error_rate_limit.js';

test('permission errors are logged once per key during the rate-limit window', () => {
    const key = `test:repeated:${Math.random()}`;

    assert.equal(shouldLogPermissionError(key, 1_000, 60_000), true);
    assert.equal(shouldLogPermissionError(key, 30_000, 60_000), false);
    assert.equal(shouldLogPermissionError(key, 61_000, 60_000), true);
});

test('unrelated permission errors have independent rate limits', () => {
    const suffix = Math.random();

    assert.equal(shouldLogPermissionError(`test:command:${suffix}`, 1_000, 60_000), true);
    assert.equal(shouldLogPermissionError(`test:moderation:${suffix}`, 1_000, 60_000), true);
});
