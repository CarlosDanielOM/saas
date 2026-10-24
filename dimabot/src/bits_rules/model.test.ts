import assert from 'node:assert/strict';
import test from 'node:test';
import { BitsRuleError, bitsChatMessage, matchBitsRule, parseRule, rulesFromLegacyTiers, type BitsRule } from './model.js';

const rule = (id: string, min: number, max: number | null, extra: Partial<BitsRule> = {}): BitsRule =>
    ({ id, name: id, enabled: true, min, max, chat: { mode: 'custom', message: id }, alert: true, ...extra });

test('the most specific enabled rule wins regardless of order', () => {
    const rules = [rule('any', 1, null), rule('hundreds', 100, 999), rule('thousand', 1000, null), rule('nice', 69, 69), rule('wide', 50, 150)];
    assert.equal(matchBitsRule(rules, 69)?.id, 'nice');
    assert.equal(matchBitsRule(rules, 120)?.id, 'wide');
    assert.equal(matchBitsRule(rules, 500)?.id, 'hundreds');
    assert.equal(matchBitsRule(rules, 5000)?.id, 'thousand');
    assert.equal(matchBitsRule(rules, 1)?.id, 'any');
    assert.equal(matchBitsRule([rule('off', 69, 69, { enabled: false }), ...rules.slice(0, 1)], 69)?.id, 'any');
    for (const bad of [0, -5, 1.5, '100', null]) assert.equal(matchBitsRule(rules, bad), null);
});

test('chat message follows the rule mode', () => {
    const rules = [rule('custom', 1, 10), rule('silent', 11, 20, { chat: { mode: 'silent', message: '' } }), rule('default', 21, 30, { chat: { mode: 'default', message: '' } })];
    assert.equal(bitsChatMessage(rules, 'Thanks', 5), 'custom');
    assert.equal(bitsChatMessage(rules, 'Thanks', 15), '');
    assert.equal(bitsChatMessage(rules, 'Thanks', 25), 'Thanks');
    assert.equal(bitsChatMessage(rules, 'Thanks', 99), 'Thanks');
});

test('parseRule validates and merges partial updates', () => {
    const created = parseRule({ name: ' Big ', min: 100, max: null, chat: { mode: 'default' } }, 'r1');
    assert.deepEqual(created, { id: 'r1', name: 'Big', enabled: true, min: 100, max: null, chat: { mode: 'default', message: '' }, alert: true });
    assert.deepEqual(parseRule({ enabled: false }, 'r1', created), { ...created, enabled: false });
    for (const body of [{ min: 0 }, { min: 10, max: 5 }, { min: 1.5 }, { min: 10, chat: { mode: 'custom', message: ' ' } }, { min: 10, extra: 1 }, { min: 10, chat: { mode: 'loud' } }]) {
        assert.throws(() => parseRule(body, 'x'), BitsRuleError, JSON.stringify(body));
    }
});

test('legacy tiers convert, including camelCase amounts and empty messages', () => {
    const rules = rulesFromLegacyTiers([
        { id: 'tier-1', name: 'Nice', message: 'Nice', minAmount: 69, maxAmount: 69 },
        { id: 'tier 2', name: 'Quiet', message: '', min_amount: 0, max_amount: 10 },
        { name: 'broken' }
    ]);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0], { id: 'tier-1', name: 'Nice', enabled: true, min: 69, max: 69, chat: { mode: 'custom', message: 'Nice' }, alert: true });
    assert.equal(rules[1].id, 'legacy-2');
    assert.equal(rules[1].min, 1);
    assert.deepEqual(rules[1].chat, { mode: 'silent', message: '' });
});
