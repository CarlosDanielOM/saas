// Disposable API runtime: no external provider traffic can leave this process.
import fs from 'node:fs';
const directory = '/tmp/saas-fixtures';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
    headers: { 'Content-Type': 'application/json' } });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    const controls = fs.existsSync(`${directory}/controls.json`)
        ? JSON.parse(fs.readFileSync(`${directory}/controls.json`, 'utf8')) : {};
    const text = typeof options.body === 'string' ? options.body
        : input instanceof Request ? await input.clone().text() : '';
    const body = text ? JSON.parse(text) : null;
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/'
        ? { version: '1.18.0' } : { status: 'ok', time: 0, result: { collections: [] } });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/chat/messages') {
            fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify({ chat: body }) + '\n');
            if (controls.chatThrow) throw new Error('Mock chat network failure');
            if (controls.chatFail) return json({ error: 'Unavailable' }, 503);
            return json({ data: [{ is_sent: !controls.chatHeld, message_id: 'mock-message' }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    if (url.hostname === 'api.polar.sh') {
        if (url.pathname.replace(/\/$/, '') === '/v1/events/ingest') {
            fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify({ grant: body }) + '\n');
            return json({ inserted: controls.grantFail ? 0 : 1, duplicates: 0 });
        }
        if (/\/v1\/customers\/[^/]+\/state\/?$/.test(url.pathname)) return json({
            id: '11111111-1111-4111-8111-111111111111', active_subscriptions: [],
            active_meters: [{ meter_id: '5103e79b-fd74-4ba8-a287-f95574f9addf', consumed_units: 0, balance: 0 }],
        });
    }
    throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
