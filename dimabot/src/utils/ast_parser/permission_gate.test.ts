import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from './parser.js';
import { createExecutionContext, evaluate, registerFunction, buildPermissionDeniedMessage } from './evaluator.js';
import { registerChannelFunctions } from './functions/channel.functions.js';

// Verifies the central minUserLevel gate: gated functions must be denied
// before their handler runs when ctx.userLevel is below the metadata level,
// and the denial must be an explicit message (never a silent '').
//
// NOTE: registerAllFunctions() is intentionally not used here because
// registerModerationFunctions() starts a setInterval worker (restore-mod
// jobs) that would keep the test process alive.

registerChannelFunctions();

// Synthetic gated functions to exercise the gate without touching Twitch APIs.
registerFunction('test.gated7', () => Promise.resolve('SHOULD_NEVER_RUN'), {
    description: 'test', syntax: 'test.gated7', category: 'test',
    examples: ['test.gated7'], minUserLevel: 7
});
registerFunction('test.gated8', () => Promise.resolve('SHOULD_NEVER_RUN'), {
    description: 'test', syntax: 'test.gated8', category: 'test',
    examples: ['test.gated8'], minUserLevel: 8
});
registerFunction('test.ungated', () => Promise.resolve('ran-ok'), {
    description: 'test', syntax: 'test.ungated', category: 'test',
    examples: ['test.ungated']
});

async function evalWithLevel(source: string, userLevel: number): Promise<string> {
    const context = createExecutionContext();
    context.userLevel = userLevel;
    const { ast, error } = parse(source);
    assert.equal(error, undefined);
    const result = await evaluate(ast, context);
    return String(result.value);
}

test('denies real set.title for a regular chatter (userLevel 1) before the handler runs', async () => {
    const value = await evalWithLevel('$(set.title hijacked title)', 1);
    assert.match(value, /^Error: permission denied/i);
    assert.match(value, /set\.title/);
    assert.match(value, /userlevel 8/);
});

test('denies level-7 gated function for a regular chatter', async () => {
    const value = await evalWithLevel('$(test.gated7)', 1);
    assert.match(value, /^Error: permission denied/i);
    assert.match(value, /userlevel 7/);
});

test('denies level-8 gated function for a moderator (7 < 8)', async () => {
    const value = await evalWithLevel('$(test.gated8)', 7);
    assert.match(value, /^Error: permission denied/i);
});

test('allows ungated function for a regular chatter', async () => {
    const value = await evalWithLevel('$(test.ungated)', 1);
    assert.equal(value, 'ran-ok');
});

test('denial message matches the AI tool failure classifier shape', () => {
    const message = buildPermissionDeniedMessage('set.game', 8, 1);
    assert.match(message, /^error\b|\berror /i);
    assert.match(message, /permission denied/i);
});
