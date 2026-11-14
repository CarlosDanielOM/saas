import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { OAuthError } from './catalog.js';

const DESKTOP_SCOPES = ['profile:read', 'credits:read', 'desktop:connect', 'pet:read', 'pet:receive', 'pet:control',
    'pet:playback:select', 'ai:interact', 'pet:interact'];
const docs = new Map<string, Record<string, any>>();
let writes = 0, inits = 0;
const init = async () => { inits++; };
/** Minimal Mongo upsert semantics; any other operator (a $set or $pull of scopes) fails the test. */
async function updateOne(filter: { client_id: string }, update: Record<string, any>, options: { upsert?: boolean } = {}) {
    writes++;
    assert.deepEqual(Object.keys(update).filter(op => !['$setOnInsert', '$addToSet'].includes(op)), []);
    const paths = Object.values(update).flatMap(value => Object.keys(value));
    assert.equal(new Set(paths).size, paths.length, 'Mongo rejects one path in two operators');
    const doc = docs.get(filter.client_id) ?? (options.upsert ? { ...filter, ...update.$setOnInsert } : undefined);
    if (!doc) return;
    docs.set(filter.client_id, doc);
    for (const [field, { $each }] of Object.entries(update.$addToSet ?? {}) as [string, { $each: string[] }][]) {
        const current: string[] = doc[field] ?? [];
        doc[field] = [...current, ...$each.filter(value => !current.includes(value))];
    }
}
const findOne = (filter: { client_id: string; enabled: boolean }) =>
    ({ lean: async () => docs.get(filter.client_id)?.enabled === filter.enabled ? docs.get(filter.client_id) : null });
mock.module('../../schemas/oauth_client.schema.js', { namedExports: { OAuthClient: { init, updateOne, findOne } } });
mock.module('../../schemas/oauth_grant.schema.js', { namedExports: { OAuthGrant: { init } } });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: { init } } });
mock.module('../../schemas/oauth_refresh_token.schema.js', { namedExports: { OAuthRefreshToken: { init } } });
mock.module('../../schemas/users.schema.js', { defaultExport: {} });
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => assert.fail('boot seeding never touches Redis')
} });
mock.module('../../schemas/admin.schema.js', { namedExports: { AdminSchema: {} } });
mock.module('../../site_agent/access.js', { namedExports: { resolveAccess: async () => null } });
const APP = 'https://app.example/client.json';
const denied = new Set<string>();
let fetches = 0;
mock.module('./cimd.js', { namedExports: { RECOGNIZED_CIMD_CLIENTS: [APP],
    isCimdClientId: (value: unknown) => typeof value === 'string' && value.startsWith('https://'),
    resolveCimdClient: async (clientID: string) => {
        fetches++;
        if (clientID !== APP || denied.has(clientID)) throw new OAuthError('invalid_client');
        return { client_id: APP, client_name: 'Example', redirect_uris: ['http://127.0.0.1/cb', 'http://localhost/cb'],
            document_host: 'app.example', recognized: true };
    },
    isCimdClientDenied: async (clientID: string) => denied.has(clientID) } });
const { initializeOAuth } = await import('./service.js');
const { assertClientRegistry, FIRST_PARTY_CLIENTS, resolveClient, resolveSessionClient } = await import('./clients.js');
const { DESKTOP_CLIENT_ID, OAUTH_SCOPES } = await import('./catalog.js');
const catalog = OAUTH_SCOPES as unknown as Record<string, { active: boolean; key: string }>;
const desktop = () => docs.get(DESKTOP_CLIENT_ID)!;

beforeEach(() => { docs.clear(); writes = 0; inits = 0; denied.clear(); fetches = 0; });

test('desktop registry entry keeps exactly the scopes the production app holds', () => {
    assert.deepEqual(FIRST_PARTY_CLIENTS.map(client => client.client_id), [DESKTOP_CLIENT_ID]);
    assert.deepEqual(FIRST_PARTY_CLIENTS[0].allowed_scopes, DESKTOP_SCOPES);
});

test('fresh database seeds each registry client with its own list', async () => {
    await initializeOAuth();
    assert.equal(docs.size, FIRST_PARTY_CLIENTS.length);
    assert.deepEqual(desktop(), { client_id: DESKTOP_CLIENT_ID, name: 'Dima Desktop Beta', type: 'public', enabled: true,
        redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'], allowed_scopes: DESKTOP_SCOPES });
    await initializeOAuth();
    assert.deepEqual(desktop().allowed_scopes, DESKTOP_SCOPES, 'restart is idempotent');
});

test('existing desktop client keeps DB edits and extra scopes, regains only listed ones', async () => {
    const edited = { client_id: DESKTOP_CLIENT_ID, name: 'Renamed', type: 'public', enabled: false,
        redirect_uris: ['http://127.0.0.1/custom'],
        allowed_scopes: [...DESKTOP_SCOPES.filter(scope => scope !== 'pet:read'), 'usage:read'] };
    docs.set(DESKTOP_CLIENT_ID, structuredClone(edited));
    await initializeOAuth();
    assert.deepEqual(desktop(), { ...edited, allowed_scopes: [...edited.allowed_scopes, 'pet:read'] });
});

test('newly activated catalog scopes are not granted to clients that do not list them', async () => {
    const saved = structuredClone(catalog);
    catalog['usage:read'].active = true;
    catalog['pet:write'].active = true;
    catalog['mcp:connect'] = { active: true, key: 'mcp' };
    try {
        await initializeOAuth();
        assert.deepEqual(desktop().allowed_scopes, DESKTOP_SCOPES, 'fresh install');
        docs.set(DESKTOP_CLIENT_ID, { ...desktop(), allowed_scopes: [...DESKTOP_SCOPES] });
        await initializeOAuth();
        assert.deepEqual(desktop().allowed_scopes, DESKTOP_SCOPES, 'existing install');
    } finally {
        delete catalog['mcp:connect'];
        Object.assign(catalog, saved);
    }
});

test('registry may list inactive scopes but not unknown or duplicate ones', () => {
    const client = { ...FIRST_PARTY_CLIENTS[0], client_id: 'fixture' };
    assert.doesNotThrow(() => assertClientRegistry());
    assert.doesNotThrow(() => assertClientRegistry([{ ...client, allowed_scopes: ['usage:read', 'pet:write'] }]));
    assert.throws(() => assertClientRegistry([{ ...client, allowed_scopes: ['profile:read', 'admin:all' as never] }]),
        /fixture lists unknown scopes: admin:all/);
    assert.throws(() => assertClientRegistry([client, client]), /Duplicate OAuth client fixture/);
});

test('startup fails before any write when a listed scope leaves the catalog', async () => {
    const saved = catalog['pet:interact'];
    delete catalog['pet:interact'];
    try {
        await assert.rejects(initializeOAuth(), /dima-desktop lists unknown scopes: pet:interact/);
        assert.equal(writes + inits, 0);
    } finally {
        catalog['pet:interact'] = saved;
    }
});

test('first-party record: the desktop app is native, desktop-only, on the account\'s own channel', async () => {
    await initializeOAuth();
    const desktopAudience = `${new URL(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').origin}/v1`;
    assert.deepEqual(await resolveClient(DESKTOP_CLIENT_ID), { client_id: DESKTOP_CLIENT_ID, name: 'Dima Desktop Beta', kind: 'first_party',
        application_type: 'native', redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
        allowed_scopes: DESKTOP_SCOPES, resources: [desktopAudience], default_resource: desktopAudience,
        channel_selection: false, recognized: true });
    assert.deepEqual(await resolveSessionClient(DESKTOP_CLIENT_ID), await resolveClient(DESKTOP_CLIENT_ID));
    desktop().enabled = false;
    for (const resolve of [resolveClient, resolveSessionClient]) {
        await assert.rejects(resolve(DESKTOP_CLIENT_ID), { code: 'invalid_client' });
        for (const bad of [undefined, 42, ['a'], 'unknown', 'x'.repeat(513)]) await assert.rejects(resolve(bad), { code: 'invalid_client' });
    }
});

test('CIMD record: resolver data, MCP scopes and audience, channel choice; sessions only check the denylist', async () => {
    const record = await resolveClient(APP);
    assert.deepEqual(record, { client_id: APP, name: 'Example', kind: 'cimd', application_type: 'native',
        redirect_uris: ['http://127.0.0.1/cb', 'http://localhost/cb'], allowed_scopes: ['channel:read', 'channel:write'],
        resources: ['https://mcp.domdimabot.com/mcp'], channel_selection: true, recognized: true, document_host: 'app.example' });
    assert.equal(fetches, 1);
    assert.deepEqual(await resolveSessionClient(APP), { client_id: APP, kind: 'cimd', allowed_scopes: ['channel:read', 'channel:write'],
        resources: ['https://mcp.domdimabot.com/mcp'], channel_selection: true });
    assert.equal(fetches, 1, 'live sessions never refetch the document');
    await assert.rejects(resolveClient('https://other.example/client.json'), { code: 'invalid_client' });
    denied.add(APP);
    await assert.rejects(resolveSessionClient(APP), { code: 'invalid_client' });
    await assert.rejects(resolveClient(APP), { code: 'invalid_client' });
    denied.clear();
    const saved = catalog['stream:act'].active;
    catalog['stream:act'].active = true;
    try { assert.deepEqual((await resolveClient(APP)).allowed_scopes, ['channel:read', 'channel:write', 'stream:act'], 'activating an MCP scope offers it'); }
    finally { catalog['stream:act'].active = saved; }
});
