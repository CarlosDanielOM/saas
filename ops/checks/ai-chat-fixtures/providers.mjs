// Isolated provider responses. No production credentials or outbound actions.
import fs from 'node:fs';
const realFetch = globalThis.fetch;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const record = value => fs.appendFileSync('/tmp/saas-fixtures/calls.jsonl', `${JSON.stringify(value)}\n`);

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    const raw = init.body ?? (input instanceof Request ? await input.clone().text() : '{}');
    const body = JSON.parse(String(raw || '{}'));
    if (url.hostname === 'openrouter.ai') {
        record({ provider: 'openrouter', body });
        const last = body.messages.at(-1);
        let message = { role: 'assistant', content: '@Alice Fixture response.' };
        if (last.role === 'user' && last.content.includes('REQUEST_TITLE_ACTION')) {
            message = { role: 'assistant', content: null, tool_calls: [{
                id: 'test-title-action', type: 'function',
                function: { name: 'AST_PARSER', arguments: JSON.stringify({ command: 'set.title Fixture title', userlevel: 7 }) }
            }] };
        }
        return json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
    }
    if (url.hostname === 'embeddings.test') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return json({ data: inputs.map((_, index) => ({ embedding: Array(1024).fill(0.01), index, object: 'embedding' })), model: 'fixture' });
    }
    if (url.hostname === 'qdrant.test') {
        if (url.pathname === '/') return json({ version: '1.18.0' });
        const result = url.pathname.endsWith('/exists') ? { exists: true }
            : url.pathname.endsWith('/query') ? { points: [] }
            : url.pathname.endsWith('/count') ? { count: 1000 }
            : url.pathname.endsWith('/search') ? [] : { collections: [] };
        return json({ status: 'ok', time: 0, result });
    }
    if (url.hostname === 'api.twitch.tv') {
        record({ provider: 'twitch', path: url.pathname, method: init.method || 'GET', body });
        if (init.method === 'PATCH') return new Response(null, { status: 204 });
        return json({ data: [] });
    }
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'dummy-token', expires_in: 36000, token_type: 'bearer' });
    if (url.hostname === 'us.i.posthog.com') return json({ status: 1 });
    throw new Error(`External request blocked in AI chat test: ${url.origin}${url.pathname}`);
};
