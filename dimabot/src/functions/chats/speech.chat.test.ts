import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('../../utils/logger.js', { namedExports: { error: async () => {} } });
const { requestTts } = await import('./speech.chat.js');

test('TTS reaches the API from production workers without legacy environment settings', async () => {
    const originalEnvironment = { ...process.env };
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ error: false, data: { speechID: 'fixture' } }));
    };
    try {
        process.env.NODE_ENV = 'production';
        delete process.env.ENVIRONMENT;
        delete process.env.INTERNAL_API_URL;
        assert.equal((await requestTts('fixture', { mode: 'speak', text: 'Hello from cheers' })).error, false);
        assert.equal(urls.at(-1), 'http://dima-server:3000/speech/fixture');

        process.env.ENVIRONMENT = 'production';
        await requestTts('fixture', { mode: 'speak', text: 'Hello' });
        assert.equal(urls.at(-1), 'http://dima-server:3000/speech/fixture');

        process.env.INTERNAL_API_URL = 'http://custom-api:3100';
        await requestTts('fixture', { mode: 'speak', text: 'Hello' });
        assert.equal(urls.at(-1), 'http://custom-api:3100/speech/fixture');

        process.env.NODE_ENV = 'development';
        delete process.env.ENVIRONMENT;
        delete process.env.INTERNAL_API_URL;
        await requestTts('fixture', { mode: 'speak', text: 'Hello' });
        assert.equal(urls.at(-1), 'http://localhost:3000/speech/fixture');
    } finally {
        process.env = originalEnvironment;
        globalThis.fetch = originalFetch;
    }
});
