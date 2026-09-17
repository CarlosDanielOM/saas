import assert from 'node:assert/strict';
import test from 'node:test';

import { visibleCommandNames } from './command_list.command.js';
import { createUserIdentity, type PermissionExpression } from '../utils/permissions/index.js';

const viewer = createUserIdentity(1, []);
const sub = createUserIdentity(2, ['sub']);
const mod = createUserIdentity(7, ['mod']);
const modSub = createUserIdentity(7, ['mod', 'sub']);
const broadcaster = createUserIdentity(10, ['broadcaster']);

test('legacy fallback: commands at or below the caller level are visible (equal-level fix)', () => {
    const commands = [
        { type: 'command', cmd: 'everyonecmd', userLevel: 1 },
        { type: 'command', cmd: 'modcmd', userLevel: 7 },
        { type: 'command', cmd: 'admincmd', userLevel: 9 }
    ];

    // Equal level must be visible (the old >= check hid level-equal commands).
    assert.deepEqual(visibleCommandNames(commands, mod), ['everyonecmd', 'modcmd']);
    assert.deepEqual(visibleCommandNames(commands, viewer), ['everyonecmd']);
    assert.deepEqual(visibleCommandNames(commands, broadcaster), ['everyonecmd', 'modcmd', 'admincmd']);
});

test('timer commands stay hidden from the chat list', () => {
    const commands = [
        { type: 'timer', cmd: 'timercmd', userLevel: 1 },
        { type: 'command', cmd: 'normalcmd', userLevel: 1 }
    ];
    assert.deepEqual(visibleCommandNames(commands, viewer), ['normalcmd']);
});

test('tag expressions drive visibility instead of the inert numeric level', () => {
    const commands: Array<{ type: string; cmd: string; userLevel: number; permissionExpression?: PermissionExpression | null }> = [
        { type: 'command', cmd: 'subonly', userLevel: 1, permissionExpression: { role: 'sub' } },
        { type: 'command', cmd: 'modonly', userLevel: 1, permissionExpression: { role: 'mod' } }
    ];

    assert.deepEqual(visibleCommandNames(commands, sub), ['subonly']);
    assert.deepEqual(visibleCommandNames(commands, mod), ['modonly']);
    assert.deepEqual(visibleCommandNames(commands, modSub), ['subonly', 'modonly']);
    assert.deepEqual(visibleCommandNames(commands, viewer), []);
});

test('a present invalid expression hides the command from the list', () => {
    const commands = [
        { type: 'command', cmd: 'broken', userLevel: 1, permissionExpression: { role: 'supermod' } as unknown }
    ] as never;
    assert.deepEqual(visibleCommandNames(commands, broadcaster), []);
});

test('everyone expression makes a command visible to every identity', () => {
    const commands: Array<{ type: string; cmd: string; userLevel: number; permissionExpression?: PermissionExpression }> = [
        { type: 'command', cmd: 'open', userLevel: 9, permissionExpression: { role: 'everyone' } }
    ];
    assert.deepEqual(visibleCommandNames(commands, viewer), ['open']);
});
