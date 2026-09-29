import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type Query = { channelID: string; scopeType: string; scopeName: string; userId?: string; userLogin?: string };
const db = new Map<string, Map<string, string>>();
const cache = new Map<string, string>();
const legacy: Array<{ query: Query; variables: Map<string, string>; updatedAt: number }> = [];
const keyFor = (query: Query) => [query.channelID, query.scopeType, query.scopeName,
    query.userLogin || query.userId || ''].join(':');

mock.module('../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async (id: string) => ({ id, name: id, plan_tier: 'pro' })
} });
mock.module('../schemas/ast_variables.schema.js', { namedExports: { AstVariablesSchema: {
    findOne: (query: Query & Record<string, unknown>) => {
        const result = () => {
            if (typeof query.scopeType === 'object') {
                const name = Object.keys(query).find((key) => key.startsWith('variables.'))?.slice('variables.'.length);
                const found = legacy.filter((row) => row.query.channelID === query.channelID
                    && (query.userLogin ? row.query.userLogin === query.userLogin : row.query.userId === query.userId)
                    && !!name && row.variables.has(name))
                    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
                return { variables: found?.variables };
            }
            return { variables: db.get(keyFor(query)) };
        };
        const chain = { select: () => ({ exec: async () => result() }), sort: () => chain };
        return chain;
    },
    findOneAndUpdate: (query: Query, update: { $set: Record<string, string>; $setOnInsert: Query }) => ({ exec: async () => {
        const vars = db.get(keyFor(query)) || new Map<string, string>();
        for (const [field, value] of Object.entries(update.$set)) vars.set(field.slice('variables.'.length), value);
        db.set(keyFor(query), vars);
        db.set(keyFor({ ...query, userId: undefined, userLogin: update.$setOnInsert.userLogin }), vars);
    } }),
    updateOne: (query: Query, update: { $unset: Record<string, string> }) => ({ exec: async () => {
        const vars = db.get(keyFor(query));
        for (const field of Object.keys(update.$unset)) vars?.delete(field.slice('variables.'.length));
    } })
} } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => ({
        get: async (key: string) => cache.get(key) ?? null,
        set: async (key: string, value: string) => { cache.set(key, value); },
        del: async (key: string) => { cache.delete(key); },
        exists: async (key: string) => Number(cache.has(key)),
        expire: async () => true
    })
} });
mock.module('../utils/ast_parser/functions/index.js', { namedExports: { registerAllFunctions: () => {} } });

const { parseSpecialCommands } = await import('./special_parser.handler.js');

function run(source: string, channelID: string, scopeType: string, scopeName: string, userId = 'viewer-id', userLogin = 'viewer') {
    return parseSpecialCommands(source, {
        channelID, scopeType, scopeName,
        eventData: { user_id: userId, user_login: userLogin },
        userPlan: 'pro'
    }).then((result) => result.parsedText);
}

test('all AST entry points share channel and user variables across trigger names', async () => {
    db.clear(); cache.clear(); legacy.length = 0;
    assert.equal(await run('%(*shield 5) %(**shield 2) %(#shield 9) %(##shield 3)', 'channel-a', 'redemption', 'Buy Shield'), '   ');
    for (const [scopeType, scopeName] of [['command', 'shields'], ['event', 'raid'], ['timer', 'daily']]) {
        assert.equal(await run('%(*shield) %(**shield) %(#shield) %(##shield)', 'channel-a', scopeType, scopeName), '5 2 9 3');
    }
    assert.equal(await run('%(*shield) %(**shield) %(#shield) %(##shield)', 'channel-b', 'command', 'shields'), '   ');
    assert.equal(await run('%(*shield) %(**shield) %(#shield) %(##shield)', 'channel-a', 'command', 'shields', 'other-id', 'other'), '5  9 ');
    assert.equal(await run('%(**shield 7) %(##shield 8)', 'channel-a', 'event', 'raid', 'other-id', 'other'), ' ');
    assert.equal(await run('%(**shield) %(##shield)', 'channel-a', 'command', 'shields'), '2 3');
    assert.equal(await run('%(**shield) %(##shield)', 'channel-a', 'command', 'shields', 'other-id', 'other'), '7 8');
});

test('newest trigger-local value is readable until migration, and deletion does not revive it', async () => {
    db.clear(); cache.clear(); legacy.length = 0;
    const identity = { channelID: 'old-channel', userId: 'viewer-id', userLogin: 'viewer' };
    legacy.push(
        { query: { ...identity, scopeType: 'redemption', scopeName: 'Buy Shield' }, variables: new Map([['shield', '2']]), updatedAt: 1 },
        { query: { ...identity, scopeType: 'command', scopeName: 'shields' }, variables: new Map([['shield', '5']]), updatedAt: 2 }
    );
    assert.equal(await run('%(**shield)', 'old-channel', 'event', 'raid'), '5');
    assert.equal(await run('%del(**shield)', 'old-channel', 'command', 'shields'), '');
    assert.equal(await run('%(**shield)', 'old-channel', 'redemption', 'Buy Shield'), '');
});
