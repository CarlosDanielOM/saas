import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Moderation rule exemption gate (TAG_PERMISSION_SYSTEM.md §2.3): the
 * `ruleExempt` helper consumed by runChatModeration. Level mode and tag mode
 * are exclusive; a present invalid stored expression grants no exemption.
 */
import { createUserIdentity, ruleExempt, inspectExpression, type UserIdentity } from '../utils/permissions/index.js';

const viewer = createUserIdentity(1, []);
const sub = createUserIdentity(2, ['sub']);
const vip = createUserIdentity(5, ['vip']);
const mod = createUserIdentity(7, ['mod']);
const admin = createUserIdentity(9, ['admin']);
const broadcaster = createUserIdentity(10, ['broadcaster']);

test('legacy fallback: exemptUserLevel exempts users at or above the numeric level', () => {
    const rule = { exemptUserLevel: 7 };
    assert.equal(ruleExempt(rule, viewer), false);
    assert.equal(ruleExempt(rule, vip), false);
    assert.equal(ruleExempt(rule, mod), true);
    assert.equal(ruleExempt(rule, admin), true);
});

test('null exemption expression keeps the legacy numeric gate', () => {
    const rule = { exemptExpression: null, exemptUserLevel: 5 };
    assert.equal(ruleExempt(rule, vip), true);
    assert.equal(ruleExempt(rule, sub), false);
});

test('missing exemption expression behaves like level mode', () => {
    const rule = { exemptUserLevel: 2 };
    assert.equal(ruleExempt(rule, sub), true);
    assert.equal(ruleExempt(rule, viewer), false);
});

test('tag expressions exempt exactly the matching roles', () => {
    const rule = { exemptExpression: { or: [{ role: 'sub' }, { role: 'vip' }] }, exemptUserLevel: 9 };
    assert.equal(ruleExempt(rule, sub), true);
    assert.equal(ruleExempt(rule, vip), true);
    assert.equal(ruleExempt(rule, viewer), false);
    assert.equal(ruleExempt(rule, mod), false, 'stored exemptUserLevel stays inert in tag mode');
});

test('not(everyone) exempts nobody except the broadcaster', () => {
    const rule = { exemptExpression: { not: { role: 'everyone' } } };
    const identities: UserIdentity[] = [viewer, sub, mod, admin];
    for (const identity of identities) {
        assert.equal(ruleExempt(rule, identity), false);
    }
    assert.equal(ruleExempt(rule, broadcaster), true);
});

test('a present invalid expression grants no exemption even for admins', () => {
    const rule = { exemptExpression: { and: [] }, exemptUserLevel: 1 };
    assert.equal(ruleExempt(rule, admin), false);
    assert.equal(ruleExempt(rule, broadcaster), false);
});

test('inspectExpression surfaces the stored exemption state for logging', () => {
    assert.equal(inspectExpression(undefined).mode, 'level');
    assert.equal(inspectExpression(null).mode, 'level');
    assert.equal(inspectExpression({ role: 'mod' }).mode, 'tags');
    const invalid = inspectExpression({ role: 'nope' });
    assert.equal(invalid.mode, 'invalid');
    if (invalid.mode === 'invalid') {
        assert.match(invalid.error, /unknown role tag/);
    }
});
