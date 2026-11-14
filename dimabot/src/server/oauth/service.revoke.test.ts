/** Account deletion ends the user's own OAuth connections and other users' connections to the deleted channel. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const calls: { model: string; op: string; filter: unknown }[] = [];
const model = (name: string) => ({
    updateMany: async (filter: unknown) => { calls.push({ model: name, op: 'updateMany', filter }); },
    deleteMany: async (filter: unknown) => { calls.push({ model: name, op: 'deleteMany', filter }); },
    find: (filter: unknown) => { calls.push({ model: name, op: 'find', filter });
        return { select: () => ({ lean: async () => [{ _id: 's1' }, { _id: 's2' }] }) }; }
});
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({}) } });
mock.module('../../schemas/oauth_client.schema.js', { namedExports: { OAuthClient: {} } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: model('grant') } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: model('session') } });
mock.module('../../schemas/oauth_refresh_token.schema.js', { namedExports: { OAuthRefreshToken: model('refresh') } });
mock.module('../../schemas/users.schema.js', { defaultExport: {} });
mock.module('../../schemas/admin.schema.js', { namedExports: { AdminSchema: {} } });
mock.module('../../site_agent/access.js', { namedExports: { resolveAccess: async () => null } });
mock.module('./cimd.js', { namedExports: { RECOGNIZED_CIMD_CLIENTS: [], isCimdClientId: () => false,
    resolveCimdClient: async () => { throw new Error('unused'); }, isCimdClientDenied: async () => false } });
const { revokeUserOAuth } = await import('./service.js');
const user = '65f0c0ffee0000000000abcd';

test('deleting an account also ends admins\' connections to that channel', async () => {
    calls.length = 0;
    await revokeUserOAuth(user, '533538623');
    const filter = { $or: [{ user_id: user }, { channel_id: '533538623' }] };
    assert.deepEqual(calls.filter(call => call.model !== 'refresh').map(call => call.filter), Array(5).fill(filter));
    assert.deepEqual(calls.find(call => call.model === 'refresh')?.filter, { session_id: { $in: ['s1', 's2'] } });
});

test('without a valid channel id only the user\'s own connections end; nothing runs without either', async () => {
    calls.length = 0;
    await revokeUserOAuth(user, 'not-a-channel');
    assert.ok(calls.filter(call => call.model !== 'refresh').every(call => JSON.stringify(call.filter) === JSON.stringify({ $or: [{ user_id: user }] })));
    calls.length = 0;
    await revokeUserOAuth('bad-id');
    assert.equal(calls.length, 0);
    await revokeUserOAuth('bad-id', '533538623');
    assert.ok(calls.length > 0 && calls.filter(call => call.model !== 'refresh').every(call => JSON.stringify(call.filter) === JSON.stringify({ $or: [{ channel_id: '533538623' }] })));
});
