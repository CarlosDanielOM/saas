import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBitsEventsubConfig } from './eventsub_bits_config.js';

test('merges custom bits settings across legacy subscriptions', () => {
    const config = buildBitsEventsubConfig(null, [
        { message: 'Cheer received', minViewers: 2 },
        { enabled: false, delay: 10, clipEnabled: true },
        { cheerTiers: [{ id: 'large', name: 'Large', message: 'Big cheer', min_amount: 100, max_amount: 999 }] }
    ]);

    assert.equal(config.message, 'Cheer received');
    assert.equal(config.enabled, false);
    assert.equal(config.delay, 10);
    assert.equal(config.clipEnabled, true);
    assert.equal(config.cheerTiers?.[0]?.id, 'large');
});

test('keeps customized canonical bits settings over legacy values', () => {
    const config = buildBitsEventsubConfig(
        { message: 'Canonical', enabled: false, delay: 5 },
        [{ message: 'Legacy', enabled: true, delay: 10 }]
    );

    assert.equal(config.message, 'Canonical');
    assert.equal(config.enabled, false);
    assert.equal(config.delay, 5);
});
