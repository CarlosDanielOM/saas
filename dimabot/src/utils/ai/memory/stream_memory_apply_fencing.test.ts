import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
import { applyStreamMemoryActions } from './stream_memory_apply.js';

test('checks durable ownership before each memory action and stops on lease loss', async () => {
    const find = mock.method(ChannelAIPersonalitySchema, 'findOne', () => ({
        select: () => ({ lean: async () => null })
    }) as any);
    let checks = 0;
    try {
        await assert.rejects(applyStreamMemoryActions({
            channelID: 'channel', actions: [{ action: 'noop' }, { action: 'noop' }],
            assertActive: async () => { if (++checks === 2) throw new Error('claim lost'); }
        }), /claim lost/);
        assert.equal(checks, 2);
    } finally { find.mock.restore(); }
});
