import assert from 'node:assert/strict';
import test from 'node:test';
import {
    TIMER_FREQUENCY_UNIT,
    convertLegacyTimerFrequency,
    getTimerIntervalMinutes,
    getTimerHeartbeatMinutes,
    validateTimerEditInterval,
    parseTimerFrequencyInput,
    validateTimerInterval
} from './timer_policy.js';

test('parses bare numbers, minute suffixes, and hour suffixes as minutes', () => {
    assert.equal(parseTimerFrequencyInput('7'), 7);
    assert.equal(parseTimerFrequencyInput('7m'), 7);
    assert.equal(parseTimerFrequencyInput('2h'), 120);
    assert.equal(parseTimerFrequencyInput('0'), null);
    assert.equal(parseTimerFrequencyInput('1.5h'), null);
});

test('validates the free interval allow-list', () => {
    for (const minutes of [15, 30, 45, 60]) {
        assert.equal(validateTimerInterval(minutes, 'free').valid, true);
    }

    for (const minutes of [5, 10, 20, 61]) {
        assert.equal(validateTimerInterval(minutes, 'free').valid, false);
    }
});

test('validates premium five-minute intervals up to three hours', () => {
    assert.equal(validateTimerInterval(5, 'premium').valid, true);
    assert.equal(validateTimerInterval(175, 'premium').valid, true);
    assert.equal(validateTimerInterval(180, 'premium').valid, true);
    assert.equal(validateTimerInterval(7, 'premium').valid, false);
    assert.equal(validateTimerInterval(185, 'premium').valid, false);
});

test('validates pro whole-minute intervals up to three hours', () => {
    assert.equal(validateTimerInterval(1, 'pro').valid, true);
    assert.equal(validateTimerInterval(7, 'pro').valid, true);
    assert.equal(validateTimerInterval(180, 'pro').valid, true);
    assert.equal(validateTimerInterval(181, 'pro').valid, false);
    assert.equal(validateTimerInterval(7.5, 'pro').valid, false);
});

test('normalizes legacy five-minute tick values without changing minute values', () => {
    assert.equal(getTimerIntervalMinutes({ frequency: 7 }), 35);
    assert.equal(getTimerIntervalMinutes({ frequency: 7, frequencyUnit: TIMER_FREQUENCY_UNIT }), 7);
});

test('converts only valid legacy tick values during migration', () => {
    assert.equal(convertLegacyTimerFrequency(1), 5);
    assert.equal(convertLegacyTimerFrequency(288), 1440);
    assert.equal(convertLegacyTimerFrequency(0), null);
    assert.equal(convertLegacyTimerFrequency(289), null);
    assert.equal(convertLegacyTimerFrequency(1.5), null);
    assert.equal(convertLegacyTimerFrequency('12'), null);
});

test('normalizes legacy heartbeat ticks once while preserving minute heartbeats', () => {
    assert.equal(getTimerHeartbeatMinutes({ frequency: 12 }, 2), 10);
    assert.equal(getTimerHeartbeatMinutes({ frequency: 12 }, 2, TIMER_FREQUENCY_UNIT), 2);
    assert.equal(getTimerHeartbeatMinutes({ frequency: 60, frequencyUnit: TIMER_FREQUENCY_UNIT }, 2), 2);
    assert.equal(getTimerHeartbeatMinutes({ frequency: 60, frequencyUnit: TIMER_FREQUENCY_UNIT }, Number.NaN), 0);
});

test('grandfathers running intervals but requires a valid interval for edits', () => {
    const legacyFiveMinuteTimer = { frequency: 1 };
    assert.equal(validateTimerEditInterval(legacyFiveMinuteTimer, undefined, 'free').valid, false);
    assert.equal(validateTimerEditInterval(legacyFiveMinuteTimer, 15, 'free').valid, true);

    const downgradedProTimer = { frequency: 7, frequencyUnit: TIMER_FREQUENCY_UNIT };
    assert.equal(validateTimerEditInterval(downgradedProTimer, undefined, 'free').valid, false);
    assert.equal(validateTimerEditInterval(downgradedProTimer, 30, 'free').valid, true);

    const validLegacyFreeTimer = { frequency: 3 };
    assert.equal(validateTimerEditInterval(validLegacyFreeTimer, undefined, 'free').valid, true);
});
