import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const turns: Record<string, { channelId: string; userId: string }> = {
    a: { channelId: '42', userId: '42' },
    b: { channelId: '42', userId: '7' },
    c: { channelId: '9', userId: '42' },
    d: { channelId: '9', userId: '9' },
};
const stopped: string[][] = [];
const removed: unknown[] = [];

mock.module('./runner.js', { namedExports: { stopTurn: async (id: string, requesterId: string) => { stopped.push([id, requesterId]); return 'running'; } } });
mock.module('./store.js', { namedExports: {
    activeTurnIds: async () => Object.keys(turns),
    getTurn: async (id: string) => ({ id, ...turns[id] }),
} });
mock.module('./turn_log.js', { namedExports: { deleteTurnLogs: async (channelId: string) => { removed.push(['turnLogs', channelId]); return 0; } } });
mock.module('./mcp_call_log.js', { namedExports: { deleteMcpCallLogs: async (channelId: string) => { removed.push(['mcpCallLogs', channelId]); return 0; } } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    scanIterator: async function* () { /* no keys */ },
    zRange: async () => [], del: async () => 0, hDel: async () => 0,
}) } });
mock.module('mongoose', { defaultExport: { connection: { collection: (name: string) => ({ deleteMany: async (filter: unknown) => { removed.push([name, filter]); return { deletedCount: 0 }; } }) } } });

const { deleteChannelSiteAgentData } = await import('./cleanup.js');

test('account deletion stops the channel\'s running turns and the person\'s turns on other channels', async () => {
    await deleteChannelSiteAgentData('42');
    assert.deepEqual(stopped, [['a', '42'], ['b', '7'], ['c', '42']], 'each with its own requester; other channels\' turns untouched');
    assert.deepEqual(removed.slice(-2), [['turnLogs', '42'], ['mcpCallLogs', '42']]);
});
