/** Access rules for AI apps (MCP): own channel, or an explicit mcp:admin grant; never staff elevation or plain '*'. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const OWNER = '111', ADMIN = '222', STAFF = '333';
let row: { permissions: string[] } | null = null;
const lean = <T>(value: T) => ({ select: () => ({ lean: async () => value }) });
mock.module('../schemas/admin.schema.js', { namedExports: { AdminSchema: { findOne: () => lean(row) } } });
mock.module('../schemas/users.schema.js', { defaultExport: {
    findOne: (filter: { accounts: { $elemMatch: { id: string } } }) => lean({ language: 'en',
        accounts: [{ type: 'twitch', id: filter.accounts.$elemMatch.id, name: `Login_${filter.accounts.$elemMatch.id}` }] }) } });
mock.module('../middleware/admin.middleware.js', { namedExports: {
    hasGlobalChannelOwnerAccess: async (requester: string) => requester === STAFF } });
mock.module('../server/services/command_blocks.service.js', { namedExports: { channelPlanTier: async () => 'pro' } });
const { resolveAccess, permissionChecker } = await import('./access.js');

test('own channel: owner in both modes', async () => {
    row = null;
    assert.equal((await resolveAccess(OWNER, OWNER, 'site'))?.role, 'owner');
    assert.equal((await resolveAccess(OWNER, OWNER, 'mcp'))?.role, 'owner');
});

test('platform staff: owner on the website, nothing over MCP without a grant', async () => {
    row = null;
    assert.equal((await resolveAccess(STAFF, OWNER, 'site'))?.role, 'owner');
    assert.equal(await resolveAccess(STAFF, OWNER, 'mcp'), null);
    row = { permissions: ['*'] };
    assert.equal(await resolveAccess(STAFF, OWNER, 'mcp'), null, 'full access is not AI apps');
    row = { permissions: ['*', 'mcp:admin'] };
    assert.equal((await resolveAccess(STAFF, OWNER, 'mcp'))?.role, 'admin', 'with the grant: admin, never elevated to owner');
});

test('admins: full access works on the website; MCP needs the explicit mcp:admin grant', async () => {
    row = { permissions: ['*'] };
    assert.equal((await resolveAccess(ADMIN, OWNER, 'site'))?.role, 'admin');
    assert.equal(await resolveAccess(ADMIN, OWNER, 'mcp'), null);
    row = { permissions: ['dashboard:view', 'commands:view', 'commands:manage'] };
    assert.equal(await resolveAccess(ADMIN, OWNER, 'mcp'), null);
    row = { permissions: ['dashboard:view', 'commands:view', 'mcp:admin'] };
    const access = await resolveAccess(ADMIN, OWNER, 'mcp');
    assert.equal(access?.role, 'admin');
    assert.equal(access?.channelLogin, `login_${OWNER}`);
    const can = permissionChecker(ADMIN, OWNER, 30_000, 'mcp');
    assert.equal(await can(['commands:view']), true, 'MCP tools still need the admin\'s own permissions');
    assert.equal(await can(['commands:manage']), false);
    row = { permissions: ['dashboard:view', 'commands:view'] };
    assert.equal(await can(['commands:view'], true), false, 'taking mcp:admin away cuts MCP access on the next fresh check');
    assert.equal(await permissionChecker(ADMIN, OWNER)(['commands:view'], true), true, 'the website is unaffected');
});
