import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeChatHistories, type ChatContextMessage } from './chat_context.js';
import { getThreadLimitsForTier } from './threading/thread_limits.js';

const message = (timestamp: number, overrides: Partial<ChatContextMessage> = {}): ChatContextMessage => ({
    source: 'live', timestamp, username: 'Alice', message: `Message ${timestamp}`, ...overrides
});

test('busy channel cannot evict the selected direct conversation', () => {
    const thread = [message(1, { source: 'thread' }), message(2, { source: 'thread', role: 'assistant' })];
    const live = Array.from({ length: 20 }, (_, i) => message(100 + i));
    const result = mergeChatHistories(thread, live, [], 15);
    assert.deepEqual(result.filter(item => item.source === 'thread'), thread);
    assert.equal(result.filter(item => item.source === 'live').length, 15);
    assert.deepEqual(thread.map(item => item.timestamp), [1, 2], 'inputs stay unchanged');
});

test('identical text from different speakers or different moments remains distinct', () => {
    const live = [message(1, { message: 'yes' }), message(1, { username: 'Bob', message: 'yes' }), message(2, { message: 'yes' })];
    assert.equal(mergeChatHistories([], live, [], 15).length, 3);
});

test('copies of the same event across sources retain the thread version', () => {
    const original = message(1, { source: 'thread', role: 'assistant', sourceMessageId: 'event-1' });
    const duplicate = { ...original, source: 'live' as const, timestamp: 2 };
    assert.deepEqual(mergeChatHistories([original], [duplicate], [], 15), [original]);
    const legacy = message(3, { message: 'Same historical event' });
    assert.equal(mergeChatHistories([], [legacy], [{ ...legacy, source: 'semantic' }], 15).length, 1);
});

test('background budget selects newest events without consuming the thread budget', () => {
    const thread = [message(1, { source: 'thread' })];
    const result = mergeChatHistories(thread, [message(10)], [message(5, { source: 'semantic' })], 1);
    assert.deepEqual(result.map(item => item.timestamp).sort((a, b) => a - b), [1, 10]);
    assert.deepEqual(mergeChatHistories(thread, [message(10)], [], 0), thread);
});

test('tier storage supports all 10/40/100 individual prompt messages', () => {
    for (const [tier, count] of [['free', 10], ['premium', 40], ['pro', 100]] as const) {
        const limits = getThreadLimitsForTier(tier);
        assert.equal(limits.promptTurns, count);
        assert.ok(limits.maxTurnsStored >= count);
    }
});
