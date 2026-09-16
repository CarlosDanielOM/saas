import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapsRule, stripEmoteTexts } from './caps.rule.js';

const baseRule = {
    capsThresholdMode: 'count' as const,
    minCapsCount: 8,
    maxCapsPercentage: 70,
    minMessageLength: 10
};

test('count mode: triggers when caps count reaches the threshold', () => {
    const result = evaluateCapsRule(baseRule, { text: 'THIS IS WAY TOO LOUD' });
    assert.equal(result.triggered, true);
    assert.equal(result.capsCount, 16);
    assert.equal(result.letterCount, 16);
});

test('count mode: does not trigger below the threshold', () => {
    const result = evaluateCapsRule(baseRule, { text: 'HELLO how are you today friend' });
    assert.equal(result.triggered, false);
    assert.equal(result.capsCount, 5);
});

test('count mode: ignores digits and symbols for length and caps', () => {
    const result = evaluateCapsRule(baseRule, { text: 'GG123!!!????' });
    assert.equal(result.triggered, false);
    assert.equal(result.letterCount, 2);
});

test('count mode: short all-caps messages like GG or LOL never trigger', () => {
    assert.equal(evaluateCapsRule(baseRule, { text: 'GG' }).triggered, false);
    assert.equal(evaluateCapsRule(baseRule, { text: 'LOL OMG' }).triggered, false);
});

test('percentage mode: triggers when caps percentage reaches the threshold', () => {
    const rule = { ...baseRule, capsThresholdMode: 'percentage' as const };
    const result = evaluateCapsRule(rule, { text: 'THIS IS MOSTLY CAPS now ok' });
    // 16 caps / 21 letters ≈ 76%
    assert.equal(result.triggered, true);
    assert.ok(result.capsPercentage >= 70);
});

test('percentage mode: does not trigger below the threshold', () => {
    const rule = { ...baseRule, capsThresholdMode: 'percentage' as const };
    const result = evaluateCapsRule(rule, { text: 'This is a totally normal sentence with A FEW caps words' });
    assert.equal(result.triggered, false);
});

test('percentage mode: min message length still applies', () => {
    const rule = { ...baseRule, capsThresholdMode: 'percentage' as const };
    const result = evaluateCapsRule(rule, { text: 'LOL' });
    assert.equal(result.triggered, false);
    assert.equal(result.capsPercentage, 100);
});

test('unicode: accented uppercase letters count as caps', () => {
    const result = evaluateCapsRule(baseRule, { text: 'ÁÉÍÓÚ ÜÑÇ ĤÊĽĻÕ' });
    assert.equal(result.triggered, true);
    assert.equal(result.capsCount, result.letterCount);
});

test('unicode: lowercase accented letters do not count as caps', () => {
    const result = evaluateCapsRule(baseRule, { text: 'áéíóú üñç ça va très bien' });
    assert.equal(result.triggered, false);
    assert.equal(result.capsCount, 0);
});

test('emotes are stripped before counting', () => {
    const result = evaluateCapsRule(baseRule, {
        text: 'KAPPA KAPPA KAPPA KAPPA hello there friend',
        emoteTexts: ['KAPPA']
    });
    assert.equal(result.triggered, false);
    assert.equal(result.capsCount, 0);
});

test('stripEmoteTexts handles missing or empty emote lists', () => {
    assert.equal(stripEmoteTexts('HELLO WORLD', undefined), 'HELLO WORLD');
    assert.equal(stripEmoteTexts('HELLO WORLD', []), 'HELLO WORLD');
    assert.equal(stripEmoteTexts('KAPPA hello', ['KAPPA']), '  hello');
});

test('empty message never triggers', () => {
    const result = evaluateCapsRule(baseRule, { text: '' });
    assert.equal(result.triggered, false);
    assert.equal(result.letterCount, 0);
});
