import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AI_CREDITS_CACHE_SCHEMA_VERSION,
    AI_CREDITS_METER_ID,
    applyAiCreditUsageToSnapshot,
    buildAiCreditsDataFromMeter,
    isAiCreditsExhausted,
    recordAiCreditUsage,
} from './billing.js';
import { MODELS, selectChatModel } from './ai/constants.js';

test('credit snapshot becomes exhausted exactly when usage reaches the limit', () => {
    const before = buildAiCreditsDataFromMeter(
        { meter_id: AI_CREDITS_METER_ID, consumed_units: 24_999, balance: -24_999 },
        'free',
        '2026-09-09T00:00:00.000Z',
    );

    assert.equal(before.status, 'available');
    const after = applyAiCreditUsageToSnapshot(before, 1, '2026-09-09T00:00:01.000Z');
    assert.deepEqual(after, {
        version: AI_CREDITS_CACHE_SCHEMA_VERSION,
        used: 25_000,
        limit: 25_000,
        balance: 0,
        meterId: AI_CREDITS_METER_ID,
        updatedAt: '2026-09-09T00:00:01.000Z',
        available: true,
        status: 'exhausted',
    });
});

test('meter snapshot is exhausted when Polar usage already equals the limit', () => {
    const snapshot = buildAiCreditsDataFromMeter(
        { meter_id: AI_CREDITS_METER_ID, consumed_units: 125_000, balance: -125_000 },
        'premium',
    );

    assert.equal(snapshot.balance, 0);
    assert.equal(snapshot.status, 'exhausted');
});

test('exhausted chat uses the dedicated exhausted model', () => {
    assert.equal(selectChatModel({ plan_tier: 'pro' }, true), MODELS.exhausted);
    assert.notEqual(MODELS.exhausted, MODELS.pro);
});

test('credit status check repairs missing exhaustion flags from an exhausted snapshot', async t => {
    const exhaustedSnapshot = buildAiCreditsDataFromMeter(
        { meter_id: AI_CREDITS_METER_ID, consumed_units: 25_000, balance: -25_000 },
        'free',
    );
    const cache = {
        exists: t.mock.fn(async () => 0),
        get: t.mock.fn(async () => JSON.stringify(exhaustedSnapshot)),
        set: t.mock.fn(async () => 'OK'),
        del: t.mock.fn(async () => 0),
    };

    const exhausted = await isAiCreditsExhausted('channel-1', cache as never);

    assert.equal(exhausted, true);
    assert.deepEqual(cache.set.mock.calls.map((call) => call.arguments), [
        ['twitch:channel-1:ai:exhaust', 'true'],
        ['channel-1:ai:exhaust', 'true'],
    ]);
});

test('accepted usage atomically updates the snapshot and persistent exhaustion flags', async t => {
    const cache = {
        eval: t.mock.fn(async (
            _script: string,
            _options: { keys: string[]; arguments: string[] },
        ) => 1),
    };

    await recordAiCreditUsage('channel-1', 1, 'usage-event-1', cache as never);

    assert.equal(cache.eval.mock.callCount(), 1);
    const [script, options] = cache.eval.mock.calls[0].arguments;
    assert.deepEqual(options.keys.slice(0, 3), [
        'twitch:channel-1:ai:credits',
        'twitch:channel-1:ai:exhaust',
        'channel-1:ai:exhaust',
    ]);
    assert.equal(options.arguments[0], '1');
    assert.equal(options.arguments[2], String(AI_CREDITS_CACHE_SCHEMA_VERSION));
    assert.equal(options.arguments[4], '1');
    assert.match(script, /data\.balance <= 0 and 'exhausted' or 'available'/);
    assert.match(script, /redis\.call\('SET', KEYS\[2\], 'true'\)/);
    assert.match(script, /redis\.call\('SET', KEYS\[3\], 'true'\)/);
});
