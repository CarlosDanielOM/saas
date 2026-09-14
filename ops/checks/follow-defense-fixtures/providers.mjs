// Provider boundary for saas-ops' private Mongo/Redis test network only.
import fs from 'node:fs';
const directory = '/tmp/saas-fixtures';
const originalFetch = globalThis.fetch;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const log = value => fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify(value) + '\n');
const originalLog = console.log;
console.log = (...args) => {
    if (args[0] === 'Follow defense action worker ready') log({ ready: process.pid });
    originalLog(...args);
};
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/moderation/bans') {
            const body = JSON.parse(options.body);
            const user = body.data.user_id;
            log({ user, channel: url.searchParams.get('broadcaster_id'), moderator: url.searchParams.get('moderator_id'), at: Date.now() });
            if (user === 'slow-first') await new Promise(resolve => setTimeout(resolve, 4000));
            return json({ data: [{ user_id: user }] }, 200, { 'Ratelimit-Remaining': '800', 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 60) });
        }
        if (url.pathname === '/helix/chat/messages') { const body = JSON.parse(options.body); log({ chat: true, channel: body.broadcaster_id, message: body.message, at: Date.now() }); return json({ data: [{ is_sent: true, message_id: 'test' }] }); }
        return json({ data: [], total: 0, pagination: {} });
    }
    throw new Error(`External request blocked in follow defense test: ${url.origin}${url.pathname}`);
};
