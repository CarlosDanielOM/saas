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
    for (const minutes of [10, 20, 30, 40, 50, 60]) {
        assert.equal(validateTimerInterval(minutes, 'free').valid, true);
    }

    for (const minutes of [0, 5, 15, 25, 45, 55, 61, 70, 10.5]) {
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
    assert.equal(validateTimerEditInterval(legacyFiveMinuteTimer, 10, 'free').valid, true);

    const downgradedProTimer = { frequency: 7, frequencyUnit: TIMER_FREQUENCY_UNIT };
    assert.equal(validateTimerEditInterval(downgradedProTimer, undefined, 'free').valid, false);
    assert.equal(validateTimerEditInterval(downgradedProTimer, 30, 'free').valid, true);

    const validLegacyFreeTimer = { frequency: 2 };
    assert.equal(validateTimerEditInterval(validLegacyFreeTimer, undefined, 'free').valid, true);
});


test('preserves all paid-plan intervals and falls back to free for unknown tiers', () => {
    for (let minutes = 1; minutes <= 181; minutes++) {
        assert.equal(validateTimerInterval(minutes, 'premium').valid, minutes <= 180 && minutes % 5 === 0);
        assert.equal(validateTimerInterval(minutes, 'pro').valid, minutes <= 180);
        assert.equal(validateTimerInterval(minutes, 'unknown').valid, minutes <= 60 && minutes % 10 === 0);
    }
});

test('keeps old free timers running but requires ten-minute steps when editing', () => {
    for (const minutes of [15, 45]) {
        const timer = { frequency: minutes, frequencyUnit: TIMER_FREQUENCY_UNIT };
        assert.equal(getTimerIntervalMinutes(timer), minutes);
        assert.equal(validateTimerEditInterval(timer, undefined, 'free').valid, false);
        assert.equal(validateTimerEditInterval(timer, 10, 'free').valid, true);
    }
});
