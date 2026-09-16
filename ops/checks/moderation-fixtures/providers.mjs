// Provider boundary for saas-ops' private Mongo/Redis test network only.
import fs from 'node:fs';
const directory = '/tmp/saas-fixtures';
const originalFetch = globalThis.fetch;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const log = value => fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify(value) + '\n');
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'app-token', expires_in: 3600, token_type: 'bearer' });
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/moderation/warnings' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            log({ warn: body.data.user_id, reason: body.data.reason, channel: url.searchParams.get('broadcaster_id'), at: Date.now() });
            return json({ data: [{ user_id: body.data.user_id, reason: body.data.reason }] });
        }
        if (url.pathname === '/helix/moderation/chat' && options.method === 'DELETE') {
            log({ delete: url.searchParams.get('message_id'), channel: url.searchParams.get('broadcaster_id'), at: Date.now() });
            return new Response(null, { status: 204 });
        }
        if (url.pathname === '/helix/moderation/bans' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            log({ ban: body.data.user_id, duration: body.data.duration ?? null, reason: body.data.reason ?? null, channel: url.searchParams.get('broadcaster_id'), at: Date.now() });
            return json({ data: [{ user_id: body.data.user_id }] }, 200, { 'Ratelimit-Remaining': '800', 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 60) });
        }
        if (url.pathname === '/helix/chat/messages' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            log({ chat: true, channel: body.broadcaster_id, message: body.message, at: Date.now() });
            return json({ data: [{ is_sent: true, message_id: 'notice-msg' }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    throw new Error(`External request blocked in moderation test: ${url.origin}${url.pathname}`);
};
