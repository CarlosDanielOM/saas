import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ITwitchSubscriptionData } from '../interfaces/twitch/eventsub.interface.js';

let stored: Record<string, unknown> | null = null;
const deleted: unknown[] = [];
mock.module('../schemas/eventsub.schema.js', { defaultExport: {
    findOne: async () => stored, deleteOne: async (query: unknown) => { deleted.push(query); }, exists: async () => null
} });
mock.module('../schemas/users.schema.js', { defaultExport: { updateOne: async () => undefined } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({ exists: async () => 0 }) } });
mock.module('../utils/logger.js', { namedExports: { info: async () => undefined, warn: async () => undefined, error: async () => undefined } });

const { revocationHandler } = await import('./revocation.handler.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../utils/activity_log.js');

test('a revocation leaves a system row with Twitch\'s reason before the record is deleted', async () => {
    setActivityLogSinkForTests(async () => undefined);
    stored = { channelID: 'c1', channel: 'chan' };
    const subscription = { id: 'sub-1', type: 'channel.follow', version: '2', status: 'authorization_revoked',
        condition: { broadcaster_user_id: 'c1' } } as unknown as ITwitchSubscriptionData;
    assert.deepEqual(await revocationHandler(subscription), { error: false, message: 'Subscription revoked successfully' });
    assert.equal(deleted.length, 1);
    stored = null;
    await revocationHandler({ ...subscription, id: 'sub-2', status: 'user_removed' } as ITwitchSubscriptionData);
    const rows = pendingActivityRowsForTests().map(row => [row.kind, row.name, row.channelID, row.outcome, row.reason, row.data.type, row.data.subscriptionId]);
    assert.deepEqual(rows, [
        ['system', 'eventsub.revoked', 'c1', 'failed', 'authorization_revoked', 'channel.follow', 'sub-1'],
        ['system', 'eventsub.revoked', 'c1', 'failed', 'user_removed', 'channel.follow', 'sub-2']
    ]);
});
