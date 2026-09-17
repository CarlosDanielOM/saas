import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Custom-command execution authorization (TAG_PERMISSION_SYSTEM.md §2.4):
 * direct chat and LLM command references keep the real chatter identity as
 * the authorization identity; streamer-authored references (nested command
 * references, events, timers, redemptions) run trusted with the explicit
 * broadcaster identity. Authorization is never derived from synthetic event
 * badges.
 */
import { commandExecutionAllowed, type CommandExecutionAuthorization } from './commands.handler.js';
import { createExecutionContext, resolveCommandRefAuthorization } from '../utils/ast_parser/evaluator.js';
import { createBroadcasterIdentity, createUserIdentity, type UserIdentity } from '../utils/permissions/index.js';

const viewer = createUserIdentity(1, []);
const mod = createUserIdentity(7, ['mod']);
const sub = createUserIdentity(2, ['sub']);
const broadcaster = createBroadcasterIdentity();

const levelCommand = { userLevel: 7 };
const tagCommand = { permissionExpression: { role: 'sub' }, userLevel: 7 };
const invalidCommand = { permissionExpression: { role: 'supermod' }, userLevel: 1 };

test('direct chat: the command policy is evaluated against the real chatter', () => {
    const chat: CommandExecutionAuthorization = { origin: 'chat', identity: mod };

    assert.equal(commandExecutionAllowed(levelCommand, chat), true);
    assert.equal(commandExecutionAllowed(levelCommand, { origin: 'chat', identity: viewer }), false);
    assert.equal(commandExecutionAllowed(tagCommand, { origin: 'chat', identity: sub }), true);
    assert.equal(commandExecutionAllowed(tagCommand, chat), false, 'strict tags: a mod without sub is denied');
});

test('LLM references: the referenced command policy is checked against the real chatter', () => {
    const llm: CommandExecutionAuthorization = { origin: 'llm', identity: sub };

    assert.equal(commandExecutionAllowed(levelCommand, llm), false);
    assert.equal(commandExecutionAllowed(tagCommand, llm), true);
    assert.equal(commandExecutionAllowed(invalidCommand, llm), false, 'invalid trees never authorize');
    assert.equal(
        commandExecutionAllowed(invalidCommand, { origin: 'llm', identity: broadcaster }),
        false,
        'invalid trees deny even the broadcaster so they can be repaired'
    );
});

test('trusted authored references run after the outer gate without an additional command gate', () => {
    const authored: CommandExecutionAuthorization = { origin: 'authored', identity: broadcaster };

    assert.equal(commandExecutionAllowed(levelCommand, authored), true);
    assert.equal(commandExecutionAllowed(tagCommand, authored), true);
    assert.equal(commandExecutionAllowed(invalidCommand, authored), true, 'the outer gate already passed');
});

test('an explicit execution identity/origin is required — missing authorization is denied', () => {
    assert.equal(commandExecutionAllowed(levelCommand, undefined), false);
    assert.equal(commandExecutionAllowed({ userLevel: 1 }, undefined), false);
});

test('authored AST command references resolve to the explicit broadcaster identity', () => {
    const context = createExecutionContext({ broadcasterId: 'channel-1', enforceFunctionPermissions: false });

    const authorization = resolveCommandRefAuthorization(context);
    assert.equal(authorization.origin, 'authored');
    assert.equal(authorization.identity.level, 10);
    assert.deepEqual([...authorization.identity.tags].sort(), ['broadcaster', 'everyone']);
});

test('LLM AST command references retain the real requesting chatter identity', () => {
    const context = createExecutionContext({
        broadcasterId: 'channel-1',
        enforceFunctionPermissions: true,
        userLevel: 7,
        authorization: {
            origin: 'llm',
            identity: { level: 7, tags: ['mod', 'sub'] }
        }
    });

    const authorization = resolveCommandRefAuthorization(context);
    assert.equal(authorization.origin, 'llm');
    assert.equal(authorization.identity.level, 7);
    assert.deepEqual([...authorization.identity.tags].sort(), ['everyone', 'mod', 'sub']);
});

test('nested command references cannot derive authority from empty fake badges', () => {
    // LLM context without a threaded identity: the resolver degrades to the
    // context user level with no extra role tags — synthetic event badges
    // never grant editor/admin/mod tags.
    const context = createExecutionContext({
        broadcasterId: 'channel-1',
        enforceFunctionPermissions: true,
        userLevel: 1,
        userId: 'chatter-1',
        eventData: { badges: [] }
    });

    const authorization = resolveCommandRefAuthorization(context);
    assert.equal(authorization.origin, 'llm');
    assert.equal(authorization.identity.level, 1);
    assert.deepEqual([...authorization.identity.tags], ['everyone']);
    assert.equal(commandExecutionAllowed(levelCommand, authorization), false);
});

test('LLM identity fallback uses the verified context level, not the model-supplied one', () => {
    const context = createExecutionContext({
        broadcasterId: 'channel-1',
        enforceFunctionPermissions: true,
        userLevel: 2
    });

    const authorization = resolveCommandRefAuthorization(context);
    assert.equal(authorization.identity.level, 2);
    assert.equal(commandExecutionAllowed(levelCommand, authorization), false);
});

test('the chatter identity is distinct from the trusted authored identity', () => {
    const identities: UserIdentity[] = [viewer, sub, mod];
    for (const identity of identities) {
        const chat: CommandExecutionAuthorization = { origin: 'chat', identity };
        assert.equal(
            commandExecutionAllowed(tagCommand, chat),
            identity.tags.has('sub'),
            'chat authorization must reflect the chatter, not the broadcaster'
        );
    }
});
