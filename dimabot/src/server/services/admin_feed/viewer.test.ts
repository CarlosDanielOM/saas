import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveViewerLogin, withViewerId } from './viewer.js';

const memoryCache = () => {
    const store = new Map<string, { value: string; ex: number }>();
    return { store, get: async (key: string) => store.get(key)?.value ?? null, set: async (key: string, value: string, options: { EX: number }) => { store.set(key, { value, ex: options.EX }); } };
};
const scope = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z') };

describe('viewer login → id', () => {
    it('resolves once and then answers from the cache', async () => {
        const cache = memoryCache();
        let calls = 0;
        const lookup = async (login: string) => { calls++; assert.equal(login, 'viewer'); return '820000001'; };
        assert.equal(await resolveViewerLogin('viewer', { lookup, cache }), '820000001');
        assert.equal(await resolveViewerLogin('viewer', { lookup, cache }), '820000001');
        assert.equal(calls, 1);
        assert.equal(cache.store.get('admin-feed:login:viewer')?.ex, 6 * 3600);
    });
    it('caches an unknown login briefly', async () => {
        const cache = memoryCache();
        let calls = 0;
        const lookup = async () => { calls++; return null; };
        assert.equal(await resolveViewerLogin('nobody', { lookup, cache }), null);
        assert.equal(await resolveViewerLogin('nobody', { lookup, cache }), null);
        assert.equal(calls, 1);
        assert.deepEqual(cache.store.get('admin-feed:login:nobody'), { value: '-', ex: 600 });
    });
    it('gives up quickly when Twitch is slow or down, and does not cache that', async () => {
        const cache = memoryCache();
        const started = Date.now();
        assert.equal(await resolveViewerLogin('slow', { lookup: () => new Promise(() => undefined), cache, timeoutMs: 50 }), null);
        assert.ok(Date.now() - started < 1000);
        assert.equal(await resolveViewerLogin('down', { lookup: async () => { throw new Error('503'); }, cache }), null);
        assert.equal(cache.store.size, 0);
        const broken = { get: async () => { throw new Error('cache down'); }, set: async () => { throw new Error('cache down'); } };
        assert.equal(await resolveViewerLogin('viewer', { lookup: async () => '5', cache: broken }), '5', 'works without the cache');
    });
    it('searches by id when the login resolves and keeps the login otherwise', async () => {
        const cache = null;
        assert.deepEqual(await withViewerId({ ...scope, actorLogin: 'viewer', channelID: '1' }, { lookup: async () => '820000001', cache }),
            { ...scope, channelID: '1', actorID: '820000001' });
        assert.deepEqual(await withViewerId({ ...scope, actorLogin: 'nobody' }, { lookup: async () => null, cache }), { ...scope, actorLogin: 'nobody' });
        let called = false;
        assert.deepEqual(await withViewerId({ ...scope, actorID: '7', actorLogin: 'x' }, { lookup: async () => { called = true; return '1'; }, cache }), { ...scope, actorID: '7', actorLogin: 'x' });
        assert.equal(called, false, 'an id given is never looked up');
    });
});
