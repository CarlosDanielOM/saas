/**
 * Pins the HTTP surface of the overview and channel debugging routes: owner only, strict input, and the
 * parsed values that reach the services (which are faked here; their logic has its own tests).
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { fakeAuthMiddleware, startRouter } from './route_harness.test_util.js';

process.env.SECRET_KEY ??= 'route-test-secret';

const calls: unknown[][] = [];
const realDebug = await import('./admin_channel_debug.service.js');
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: fakeAuthMiddleware } });
mock.module('./admin_channel_debug.service.js', {
    namedExports: {
        ...realDebug,
        channelLogs: async (...args: unknown[]) => { calls.push(['logs', ...args]); return { entries: [], truncated: false, counts: {} }; },
        commandStats: async (...args: unknown[]) => { calls.push(['commands', ...args]); return { commands: [] }; },
        eventsubActivity: async (...args: unknown[]) => { calls.push(['eventsub', ...args]); return { types: [], revoked: [] }; }
    }
});
mock.module('./admin_overview.service.js', {
    namedExports: { adminOverview: { get: async () => { calls.push(['overview']); return { partial: [] }; } } }
});

const express = (await import('express')).default;
const { adminChannelDebugRouter } = await import('../routes/admin_site/channel_debug.route.js');
const { adminOverviewRouter } = await import('../routes/admin_site/overview.route.js');
const router = express.Router();
router.use(adminOverviewRouter);
router.use(adminChannelDebugRouter);
const harness = await startRouter('/admin-site', router);
after(() => harness.close());
beforeEach(() => { harness.user = { id: '533538623', login: 'cdom201', display_name: 'CDOM201' }; calls.length = 0; });

const paths = ['/overview', '/users/123/logs', '/users/123/command-stats', '/users/123/eventsub-activity'];

test('owner only', async () => {
    for (const path of paths) {
        harness.user = null;
        assert.equal((await harness.request('GET', path)).status, 401, path);
        harness.user = { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' };
        assert.equal((await harness.request('GET', path)).status, 403, path);
    }
    assert.deepEqual(calls, []);
});

test('defaults reach the services', async () => {
    for (const path of paths) assert.equal((await harness.request('GET', path)).status, 200, path);
    assert.deepEqual(calls.map(call => call.slice(0, 4).map(value => value instanceof Date ? 'date' : value)), [
        ['overview'], ['logs', '123', 'problems', 50], ['commands', '123', 7], ['eventsub', '123']
    ]);
});

test('parsed values reach the services', async () => {
    assert.equal((await harness.request('GET', '/users/9/logs?level=info&limit=200')).status, 200);
    assert.equal((await harness.request('GET', '/users/9/command-stats?days=30')).status, 200);
    assert.deepEqual(calls.map(call => call.slice(0, 4)), [['logs', '9', 'info', 200], ['commands', '9', 30]]);
});

test('refuses channel ids that are not digits and bad queries', async () => {
    for (const id of ['abc', '12a', '-1', '%24ne', 'logger%3A*', '123456789012345678901']) {
        for (const tail of ['logs', 'command-stats', 'eventsub-activity']) {
            const response = await harness.request('GET', `/users/${id}/${tail}`);
            assert.equal(response.status, 400, `${id} ${tail}`);
            assert.equal(response.body.message, 'Invalid channel');
        }
    }
    for (const query of ['level=trace', 'level=bogus', 'level[$ne]=x', 'level=warn&level=error', 'limit=0', 'limit=201', 'limit=abc', 'limit[$gt]=1']) {
        assert.equal((await harness.request('GET', `/users/1/logs?${query}`)).status, 400, query);
    }
    for (const query of ['days=0', 'days=31', 'days=abc', 'days[$ne]=1']) {
        assert.equal((await harness.request('GET', `/users/1/command-stats?${query}`)).status, 400, query);
    }
    assert.deepEqual(calls, []);
});
