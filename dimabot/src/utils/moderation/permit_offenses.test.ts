import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePermitArgs, PERMIT_DEFAULT_SECONDS, PERMIT_MAX_SECONDS } from './permit.js';
import { resolveOffenseStep } from './offenses.js';
import type { IModerationOffenseStep } from '../../schemas/channel_moderation_settings.schema.js';

test('permit: no arguments permits everyone for the default duration', () => {
    assert.deepEqual(parsePermitArgs([]), { login: null, seconds: PERMIT_DEFAULT_SECONDS });
});

test('permit: a username permits that user for the default duration', () => {
    assert.deepEqual(parsePermitArgs(['SomeUser']), { login: 'someuser', seconds: PERMIT_DEFAULT_SECONDS });
    assert.deepEqual(parsePermitArgs(['@SomeUser']), { login: 'someuser', seconds: PERMIT_DEFAULT_SECONDS });
});

test('permit: a bare number permits everyone for that duration', () => {
    assert.deepEqual(parsePermitArgs(['120']), { login: null, seconds: 120 });
});

test('permit: user plus duration permits that user for that duration', () => {
    assert.deepEqual(parsePermitArgs(['someuser', '300']), { login: 'someuser', seconds: 300 });
    assert.deepEqual(parsePermitArgs(['@someuser', '1']), { login: 'someuser', seconds: 1 });
    assert.deepEqual(parsePermitArgs(['someuser', '600']), { login: 'someuser', seconds: PERMIT_MAX_SECONDS });
});

test('permit: out-of-range durations are rejected', () => {
    assert.ok('error' in parsePermitArgs(['0']));
    assert.ok('error' in parsePermitArgs(['601']));
    assert.ok('error' in parsePermitArgs(['someuser', '0']));
    assert.ok('error' in parsePermitArgs(['someuser', '9999']));
});

test('permit: invalid usages are rejected', () => {
    assert.ok('error' in parsePermitArgs(['120', 'someuser'])); // duration first
    assert.ok('error' in parsePermitArgs(['a', 'b', 'c']));
    assert.ok('error' in parsePermitArgs(['not a user']));
    assert.ok('error' in parsePermitArgs(['!!!']));
});

const ladder: { firstOffense: IModerationOffenseStep; secondOffense: IModerationOffenseStep; thirdOffense: IModerationOffenseStep } = {
    firstOffense: { action: 'warn', timeoutSeconds: 60 },
    secondOffense: { action: 'delete', timeoutSeconds: 60 },
    thirdOffense: { action: 'timeout', timeoutSeconds: 600 }
};

test('ladder: first, second and third offense map to their rungs', () => {
    assert.equal(resolveOffenseStep(ladder, 1).action, 'warn');
    assert.equal(resolveOffenseStep(ladder, 2).action, 'delete');
    assert.equal(resolveOffenseStep(ladder, 3).action, 'timeout');
});

test('ladder: fourth and later offenses repeat the third rung', () => {
    assert.equal(resolveOffenseStep(ladder, 4).action, 'timeout');
    assert.equal(resolveOffenseStep(ladder, 25).action, 'timeout');
});

test('ladder: defensive fallback for zero/negative counts is the first rung', () => {
    assert.equal(resolveOffenseStep(ladder, 0).action, 'warn');
});
