import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

process.env.SECRET_KEY ??= 'a'.repeat(32);
const PRIVATE = '1'.repeat(24), PUBLIC = '2'.repeat(24), SYSTEM = '3'.repeat(24), GONE = '4'.repeat(24), QUIET = '5'.repeat(24);
const assets: Record<string, Record<string, unknown>> = {
    [PRIVATE]: { _id: PRIVATE, scope: 'private', storageUrl: 'https://files.invalid/private.mp3' },
    [QUIET]: { _id: QUIET, scope: 'private', storageUrl: 'https://files.invalid/quiet.mp3' },
    [PUBLIC]: { _id: PUBLIC, scope: 'public', s3Key: 'library/audio/public.mp3' },
    [SYSTEM]: { _id: SYSTEM, scope: 'system', storageUrl: 'https://files.invalid/system.png' }
};
mock.module('../../schemas/media_asset.schema.js', { namedExports: { MediaAssetSchema: {
    findOne: (filter: { _id: string }) => ({ select: () => ({ lean: async () => assets[String(filter._id).toLowerCase()] ?? null }) })
} } });
mock.module('../../utils/s3.js', { namedExports: { getS3PublicObjectUrl: (key: string) => `https://s3.invalid/${key}` } });

const express = (await import('express')).default;
const { mediaRoute } = await import('./media.route.js');
const { mediaLinkSignature } = await import('../services/media_library.service.js');
const app = express();
app.use('/media', mediaRoute);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/media`;
test.after(() => { server.close(); });

const warnings: unknown[][] = [];
mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { redirect: 'manual', headers });
    return { status: response.status, location: response.headers.get('location') };
};

test('private assets: valid k is served, wrong k is 404, missing k is still served (grace)', async () => {
    assert.deepEqual(await get(`/${PRIVATE}?k=${mediaLinkSignature(PRIVATE)}`), { status: 307, location: 'https://files.invalid/private.mp3' });
    assert.equal((await get(`/${PRIVATE}?k=${mediaLinkSignature(PUBLIC)}`)).status, 404, 'another asset signature');
    assert.equal((await get(`/${PRIVATE}?k=nope`)).status, 404);
    assert.equal((await get(`/${PRIVATE}?k=`)).status, 404, 'an empty k is a wrong k');
    assert.equal((await get(`/${PRIVATE}?k=a&k=b`)).status, 404, 'a repeated k is a wrong k');
    assert.equal((await get(`/${PRIVATE}`)).status, 307);
    assert.equal((await get(`/${PRIVATE.toUpperCase()}?k=${mediaLinkSignature(PRIVATE)}`)).status, 307, 'signed over the stored id');
});

test('public and system assets are served with or without k; unknown, deleted and malformed ids are 404', async () => {
    for (const id of [PUBLIC, SYSTEM]) for (const query of ['', '?k=wrong', `?k=${mediaLinkSignature(id)}`]) assert.equal((await get(`/${id}${query}`)).status, 307, id + query);
    assert.equal((await get(`/${PUBLIC}`)).location, 'https://s3.invalid/library/audio/public.mp3');
    for (const id of [GONE, 'not-an-id', 'zz' + '1'.repeat(22)]) assert.equal((await get(`/${id}`)).status, 404, id);
});

test('unsigned private link warning: one line per asset per 10 minutes, no IPs or full URLs', async () => {
    warnings.length = 0;
    await get(`/${QUIET}`, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) OBS/30.1.0 Chrome/103', referer: 'https://dashboard.example.invalid/some/path?secret=1' });
    await get(`/${QUIET}`, { 'user-agent': 'curl/8.0' });
    await get(`/${QUIET}?k=${mediaLinkSignature(QUIET)}`);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], ['media: unsigned private link', QUIET, 'obs', 'dashboard.example.invalid']);
    assert(!JSON.stringify(warnings).includes('127.0.0.1') && !JSON.stringify(warnings).includes('secret'));
});
