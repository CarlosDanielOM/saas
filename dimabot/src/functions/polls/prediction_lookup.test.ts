import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const cacheAccess = mock.fn(async () => { throw new Error('Dragonfly unavailable'); });
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: cacheAccess } });
mock.module('../../utils/header.js', { namedExports: {
    getTwitchStreamerHeaderById: async () => ({ error: false, header: { Authorization: 'test' } })
} });
mock.module('../../utils/links.js', { namedExports: {
    getTwitchHelixUrl: (resource: string, params: string) => `https://twitch.test/${resource}?${params}`
} });

const { getPrediction } = await import('../predictions/get.prediction.js');
const { getPoll } = await import('./get.poll.js');
const { endPrediction } = await import('../predictions/end.prediction.js');
const { endPoll } = await import('./end.poll.js');

test('prediction lookup reaches Twitch without cache and selects an active ID', async () => {
    cacheAccess.mock.resetCalls();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({ status: 200, json: async () => ({ data: [
        { id: 'old', status: 'RESOLVED', title: 'Old', outcomes: [] },
        { id: 'current', status: 'ACTIVE', title: 'Current', outcomes: [{ id: 'winner', title: 'Yes' }] }
    ] }) })) as unknown as typeof fetch;
    try {
        const result = await getPrediction('channel-1');
        assert.equal(result.error, false);
        assert.equal(result.data?.id, 'current');
        assert.equal(cacheAccess.mock.callCount(), 0);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('poll lookup reaches Twitch without cache and selects an active ID', async () => {
    cacheAccess.mock.resetCalls();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({ status: 200, json: async () => ({ data: [
        { id: 'old', status: 'ARCHIVED', title: 'Old', choices: [] },
        { id: 'current', status: 'ACTIVE', title: 'Current', choices: [{ id: 'one', title: 'One' }] }
    ] }) })) as unknown as typeof fetch;
    try {
        const result = await getPoll('channel-1');
        assert.equal(result.error, false);
        assert.equal(result.data?.id, 'current');
        assert.equal(cacheAccess.mock.callCount(), 0);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('prediction resolution succeeds when cache cleanup is unavailable', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({ status: 200, json: async () => ({ data: [{
        id: 'prediction-1', status: 'RESOLVED', title: 'Current', outcomes: []
    }] }) })) as unknown as typeof fetch;
    try {
        const result = await endPrediction('channel-1', 'prediction-1', 'RESOLVED', 'winner');
        assert.equal(result.error, false);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('poll ending succeeds when cache cleanup is unavailable', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({ status: 200, json: async () => ({ data: [{
        id: 'poll-1', status: 'ARCHIVED', title: 'Current', choices: []
    }] }) })) as unknown as typeof fetch;
    try {
        const result = await endPoll('channel-1', 'poll-1', 'ARCHIVED');
        assert.equal(result.error, false);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
