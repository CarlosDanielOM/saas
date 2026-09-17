import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    countExpressionNodes,
    evaluateExpression,
    inspectExpression,
    validateExpression,
    MAX_EXPRESSION_DEPTH,
    MAX_EXPRESSION_NODES,
    type PermissionExpression
} from './expression.js';
import { commandAllowed, ruleExempt, isExpressionAllowed, createUserIdentity, type RoleTag, type UserIdentity } from './index.js';

interface FixtureFile {
    identities: Record<string, { level: number; tags: string[] }>;
    valid: Array<{ name: string; expression: unknown }>;
    invalid: Array<{ name: string; expression: unknown; error: string }>;
    evaluations: Array<{ expression: unknown; identity: string; expected: boolean }>;
}

const fixtures: FixtureFile = JSON.parse(
    readFileSync(new URL('../../../../ops/fixtures/permission-expressions.json', import.meta.url), 'utf8')
) as FixtureFile;

function buildIdentity(name: string): UserIdentity {
    const raw = fixtures.identities[name];
    assert.ok(raw, `fixture identity ${name} must exist`);
    return createUserIdentity(raw.level, raw.tags as RoleTag[]);
}

const viewer = buildIdentity('viewer');
const sub = buildIdentity('sub');
const founder = buildIdentity('founder');
const vip = buildIdentity('vip');
const mod = buildIdentity('mod');
const modSub = buildIdentity('mod_sub');
const editor = buildIdentity('editor');
const admin = buildIdentity('admin');
const broadcaster = buildIdentity('broadcaster');

test('every fixture marked valid passes validation', () => {
    for (const { name, expression } of fixtures.valid) {
        const result = validateExpression(expression);
        assert.equal(result.ok, true, `${name} should be valid (got ${result.ok ? '' : result.error})`);
    }
});

test('every fixture marked invalid fails validation with a reason', () => {
    for (const { name, expression, error } of fixtures.invalid) {
        const result = validateExpression(expression);
        assert.equal(result.ok, false, `${name} should be invalid`);
        if (!result.ok) {
            assert.ok(
                result.error.toLowerCase().includes(error.toLowerCase()),
                `${name} error should mention "${error}", got "${result.error}"`
            );
        }
    }
});

test('fixture evaluation matrix matches evaluateExpression', () => {
    for (const { expression, identity: identityName, expected } of fixtures.evaluations) {
        const identity = buildIdentity(identityName);
        const result = evaluateExpression(expression as never, identity);
        assert.equal(result, expected, `${JSON.stringify(expression)} for ${identityName} should be ${expected}`);
    }
});

test('root-at-depth-1 boundary: depth 4 is valid, depth 5 is rejected', () => {
    const depth4: PermissionExpression = { and: [{ or: [{ not: { role: 'sub' } }] }] };
    assert.equal(validateExpression(depth4).ok, true);

    const depth5: PermissionExpression = { and: [{ or: [{ and: [{ not: { role: 'sub' } }] }] }] };
    const result = validateExpression(depth5);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.error, /maximum depth/);
    }
    assert.equal(MAX_EXPRESSION_DEPTH, 4);
});

test('node bound: 25 nodes validate, 26 fail', () => {
    const at25 = {
        or: [
            { and: [{ role: 'sub' }, { role: 'vip' }, { role: 'founder' }, { role: 'mod' }] },
            { and: [{ role: 'editor' }, { role: 'admin' }, { level: 7 }, { level: 8 }] },
            { and: [{ or: [{ role: 'sub' }, { role: 'vip' }] }, { not: { role: 'mod' } }] },
            { and: [{ level: 2 }, { level: 5 }, { level: 6 }, { role: 'everyone' }] },
            { or: [{ role: 'vip' }, { level: 9 }] }
        ]
    };
    assert.equal(countExpressionNodes(at25), 25);
    assert.equal(validateExpression(at25).ok, true, 'exactly 25 nodes should be valid');

    const at26 = {
        or: [
            ...at25.or,
            { and: [{ role: 'sub' }, { role: 'vip' }] }
        ]
    };
    assert.equal(countExpressionNodes(at26), 28);
    assert.equal(validateExpression(at26).ok, false, 'over 25 nodes should be invalid');
    assert.equal(MAX_EXPRESSION_NODES, 25);
});

test('broadcaster override matches every valid expression, including not(everyone)', () => {
    for (const { expression } of fixtures.valid) {
        assert.equal(
            evaluateExpression(expression as never, broadcaster),
            true,
            `${JSON.stringify(expression)} should match the broadcaster`
        );
    }
});

test('not(everyone) is true for nobody except the broadcaster', () => {
    const expr: PermissionExpression = { not: { role: 'everyone' } };
    assert.equal(evaluateExpression(expr, viewer), false);
    assert.equal(evaluateExpression(expr, sub), false);
    assert.equal(evaluateExpression(expr, mod), false);
    assert.equal(evaluateExpression(expr, admin), false);
    assert.equal(evaluateExpression(expr, broadcaster), true);
});

test('or(not(everyone), mod) behaves like "only mods"', () => {
    const expr: PermissionExpression = { or: [{ not: { role: 'everyone' } }, { role: 'mod' }] };
    assert.equal(evaluateExpression(expr, viewer), false);
    assert.equal(evaluateExpression(expr, sub), false);
    assert.equal(evaluateExpression(expr, vip), false);
    assert.equal(evaluateExpression(expr, mod), true);
    assert.equal(evaluateExpression(expr, editor), false, 'strict tags: editors are not mods');
    assert.equal(evaluateExpression(expr, admin), false, 'strict tags: admins are not mods');
    assert.equal(evaluateExpression(expr, broadcaster), true);
});

test('sub is strict: founders qualify, mods only when also subscribed', () => {
    const expr: PermissionExpression = { role: 'sub' };
    assert.equal(evaluateExpression(expr, founder), true, 'founder implies sub');
    assert.equal(evaluateExpression(expr, mod), false, 'plain mod is not sub');
    assert.equal(evaluateExpression(expr, modSub), true, 'mod+sub holds the sub tag');
});

test('level leaves preserve legacy numeric semantics', () => {
    const level7: PermissionExpression = { level: 7 };
    assert.equal(evaluateExpression(level7, mod), true);
    assert.equal(evaluateExpression(level7, editor), true, 'editors are >= 7');
    assert.equal(evaluateExpression(level7, admin), true, 'admins are >= 7');
    assert.equal(evaluateExpression(level7, broadcaster), true);
    assert.equal(evaluateExpression(level7, vip), false);
});

test('evaluateExpression fails closed on malformed nodes instead of throwing', () => {
    const identity = viewer;
    assert.equal(evaluateExpression({ and: [] } as never, identity), false);
    assert.equal(evaluateExpression({ or: [] } as never, identity), false);
    assert.equal(evaluateExpression({ role: 'nope' } as never, identity), false);
    assert.equal(evaluateExpression({ level: 'x' } as never, identity), false);
    assert.equal(evaluateExpression({} as never, identity), false);
    assert.equal(evaluateExpression(null as never, identity), false);
});

test('inspectExpression distinguishes absent, valid, and present-invalid values', () => {
    assert.deepEqual(inspectExpression(undefined), { mode: 'level' });
    assert.deepEqual(inspectExpression(null), { mode: 'level' });

    const validState = inspectExpression({ role: 'mod' });
    assert.equal(validState.mode, 'tags');

    const invalidState = inspectExpression({ role: 'supermod' });
    assert.equal(invalidState.mode, 'invalid');
    if (invalidState.mode === 'invalid') {
        assert.ok(invalidState.error.length > 0);
    }
});

test('isExpressionAllowed delegates to evaluateExpression', () => {
    assert.equal(isExpressionAllowed({ role: 'mod' }, mod), true);
    assert.equal(isExpressionAllowed({ role: 'mod' }, viewer), false);
});

test('commandAllowed: absent/null expression uses the legacy numeric gate', () => {
    const command = { userLevel: 7 };
    assert.equal(commandAllowed(command, viewer), false);
    assert.equal(commandAllowed(command, mod), true);
    assert.equal(commandAllowed(command, editor), true);
    assert.equal(commandAllowed({ userLevel: '5' }, vip), true, 'numeric strings keep legacy parsing');
    assert.equal(commandAllowed({ userLevel: 0 }, viewer), true, 'legacy level 0 allows everyone');
    assert.equal(commandAllowed(null, viewer), false);
});

test('commandAllowed: valid expression switches to tag mode exclusively', () => {
    const command = { permissionExpression: { role: 'mod' }, userLevel: 1 };
    assert.equal(commandAllowed(command, mod), true);
    assert.equal(commandAllowed(command, viewer), false);
    assert.equal(
        commandAllowed(command, editor),
        false,
        'stored userLevel 1 must stay inert while tag mode is active'
    );
});

test('commandAllowed: present-invalid expression fails closed even when the stored level would allow it', () => {
    const command = { permissionExpression: { role: 'supermod' }, userLevel: 1 };
    assert.equal(commandAllowed(command, broadcaster), false, 'invalid trees never authorize, even for broadcaster');
    assert.equal(commandAllowed(command, mod), false);
});

test('ruleExempt: absent expression falls back to exemptUserLevel', () => {
    const rule = { exemptUserLevel: 7 };
    assert.equal(ruleExempt(rule, viewer), false);
    assert.equal(ruleExempt(rule, mod), true);
    assert.equal(ruleExempt(rule, admin), true);
});

test('ruleExempt: valid expression exempts exactly the matching tags', () => {
    const rule = { exemptExpression: { or: [{ role: 'sub' }, { role: 'vip' }] }, exemptUserLevel: 9 };
    assert.equal(ruleExempt(rule, sub), true);
    assert.equal(ruleExempt(rule, vip), true);
    assert.equal(ruleExempt(rule, viewer), false);
    assert.equal(ruleExempt(rule, mod), false, 'stored exemptUserLevel stays inert in tag mode');
});

test('ruleExempt: present-invalid expression grants no exemption even at level 10', () => {
    const rule = { exemptExpression: {}, exemptUserLevel: 1 };
    assert.equal(ruleExempt(rule, admin), false);
    assert.equal(ruleExempt(rule, broadcaster), false);
});
