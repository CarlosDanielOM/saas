// Isolated Twitch for the bot-chat-access check. No production credentials or outbound calls.
// Tokens look like `tok-<userId>-<login>`; OAuth codes like `code-<userId>-<login>`.
// A broadcaster whose id starts with `nobot` never granted `channel:bot`: Twitch answers 403.
// One starting with `botfail` granted it, but Twitch still refuses (bot-side approval missing).
// One starting with `scopefail` is refused and the authorization lookup itself fails (500).
import fs from 'node:fs';
const realFetch = globalThis.fetch;
const LOG = '/tmp/saas-fixtures/calls.jsonl';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const record = value => fs.appendFileSync(LOG, `${JSON.stringify(value)}\n`);
const header = (init, name) => {
    const headers = new Headers(init.headers || {});
    return headers.get(name) || '';
};
const userFromToken = token => {
    const match = /^tok-([^-]+(?:-[^-]+)*?)-([a-z0-9_]+)$/.exec(token || '');
    return match ? { id: match[1], login: match[2], display_name: match[2], profile_image_url: '' } : null;
};
let subscriptionSeq = 0;

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const rawBody = init.body == null ? '' : String(init.body);
    const bearer = header(init, 'authorization').replace(/^Bearer\s+/i, '');

    if (url.hostname === 'id.twitch.tv') {
        if (url.pathname === '/oauth2/validate') {
            const user = userFromToken(bearer);
            record({ provider: 'twitch-id', path: url.pathname, user: user?.id ?? null });
            return user ? json({ client_id: 'fixture', login: user.login, user_id: user.id, scopes: [], expires_in: 3600 }) : json({ status: 401, message: 'invalid access token' }, 401);
        }
        if (url.pathname === '/oauth2/token') {
            const form = new URLSearchParams(rawBody);
            record({ provider: 'twitch-id', path: url.pathname, grant_type: form.get('grant_type'), code: form.get('code'), redirect_uri: form.get('redirect_uri') });
            if (form.get('grant_type') === 'client_credentials') return json({ access_token: 'app-token-fixture', expires_in: 36000, token_type: 'bearer' });
            if (form.get('grant_type') === 'authorization_code') {
                const code = form.get('code') || '';
                return code.startsWith('code-')
                    ? json({ access_token: `tok-${code.slice(5)}`, refresh_token: `refresh-${code.slice(5)}`, expires_in: 14400, token_type: 'bearer' })
                    : json({ status: 400, message: 'Invalid authorization code', error: 'invalid_grant' }, 400);
            }
            return json({ status: 400, message: 'refresh refused in fixture', error: 'invalid_grant' }, 400);
        }
        throw new Error(`Unexpected id.twitch.tv call: ${url.pathname}`);
    }

    if (url.hostname === 'api.twitch.tv') {
        const path = url.pathname.replace(/^\/helix\//, '');
        const body = rawBody ? JSON.parse(rawBody) : null;
        record({ provider: 'twitch', path, method, bearer, query: url.search, body });
        if (path === 'users') {
            const user = userFromToken(bearer);
            if (user) return json({ data: [user] });
            const login = url.searchParams.get('login');
            const id = url.searchParams.get('id');
            return json({ data: login || id ? [{ id: id || `id-${login}`, login: login || `login-${id}`, display_name: login || id, profile_image_url: '' }] : [] });
        }
        if (path === 'eventsub/subscriptions' && method === 'POST') {
            const broadcaster = String(body?.condition?.broadcaster_user_id || '');
            if (bearer !== 'app-token-fixture') return json({ error: 'Unauthorized', status: 401, message: 'webhook subscriptions need an app token' }, 401);
            if (broadcaster.startsWith('nobot') || broadcaster.startsWith('botfail') || broadcaster.startsWith('scopefail')) return json({ error: 'Forbidden', status: 403, message: 'subscription missing proper authorization' }, 403);
            subscriptionSeq += 1;
            return json({ data: [{ id: `sub-${subscriptionSeq}`, status: 'enabled', type: body.type, version: body.version, condition: body.condition, created_at: new Date().toISOString(), transport: { method: 'webhook', callback: body.transport?.callback }, cost: 0 }], total: subscriptionSeq, total_cost: 0, max_total_cost: 10000 }, 202);
        }
        if (path === 'eventsub/subscriptions' && method === 'DELETE') return new Response(null, { status: 204 });
        if (path === 'authorization/users') {
            const id = url.searchParams.get('user_id') || '';
            if (id.startsWith('scopefail')) return json({ error: 'Internal Server Error', status: 500, message: 'fixture outage' }, 500);
            const scopes = id.startsWith('nobot') ? ['user:read:email'] : ['user:read:email', 'channel:bot'];
            return json({ data: [{ user_id: id, user_login: id, user_name: id, scopes, has_revoked: false }] });
        }
        if (path === 'moderation/moderators' && method === 'POST') return new Response(null, { status: 204 });
        if (method === 'PATCH' || method === 'DELETE') return new Response(null, { status: 204 });
        return json({ data: [] });
    }

    // Startup dependencies of the API process (same stubs as ai-chat-fixtures).
    if (url.hostname === 'qdrant.test') {
        if (url.pathname === '/') return json({ version: '1.18.0' });
        const result = url.pathname.endsWith('/exists') ? { exists: true }
            : url.pathname.endsWith('/query') ? { points: [] }
            : url.pathname.endsWith('/count') ? { count: 1000 }
            : url.pathname.endsWith('/search') ? [] : { collections: [] };
        return json({ status: 'ok', time: 0, result });
    }
    if (url.hostname === 'embeddings.test') {
        const body = rawBody ? JSON.parse(rawBody) : {};
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return json({ data: inputs.map((_, index) => ({ embedding: Array(1024).fill(0.01), index, object: 'embedding' })), model: 'fixture' });
    }
    if (url.hostname === 'us.i.posthog.com' || url.hostname.endsWith('posthog.com')) return json({ status: 1 });
    if (url.hostname === 'api.polar.sh' || url.hostname === 'sandbox-api.polar.sh') {
        record({ provider: 'polar', path: url.pathname, method });
        return json({ id: 'polar-fixture', items: [], pagination: { total_count: 0, max_page: 1 } });
    }
    if (url.hostname === 'api.resend.com') { record({ provider: 'resend', path: url.pathname }); return json({ id: 'email-fixture' }); }
    throw new Error(`External request blocked in bot-chat-access check: ${url.origin}${url.pathname}`);
};
