import fs from 'node:fs';

const folder = '/tmp/saas-fixtures';
const statePath = `${folder}/events.json`;
const callsPath = `${folder}/calls.jsonl`;
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ events: [], failNative: false }));
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input);
    const method = init.method || request?.method || 'GET';
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    if (url.hostname === 'qdrant.test') return json({ result: { collections: [] }, status: 'ok', time: 0 });
    if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/benefit-grants' && method === 'GET') {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        fs.appendFileSync(callsPath, JSON.stringify({ method, path: url.pathname, query: url.searchParams.toString() }) + '\n');
        if (state.failSource) return json({ detail: 'Fixture source unavailable' }, 400);
        const items = (state.grants || []).filter(grant => grant.customer_id === url.searchParams.get('customer_id'));
        const page = Number(url.searchParams.get('page') || 1);
        return json({ items: items.slice((page - 1) * 2, page * 2), pagination: { max_page: Math.max(1, Math.ceil(items.length / 2)) } });
    }
    if (url.hostname === 'api.polar.sh' && /^\/v1\/orders\/[^/]+\/?$/.test(url.pathname) && method === 'GET') {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const id = url.pathname.split('/')[3];
        fs.appendFileSync(callsPath, JSON.stringify({ method, path: url.pathname }) + '\n');
        if (state.failSource) return json({ detail: 'Fixture source unavailable' }, 400);
        const item = state.orders?.find(item => item.id === id);
        return item ? json(item) : json({ detail: 'Fixture missing' }, 404);
    }
    if (url.hostname === 'api.polar.sh' && url.pathname.replace(/\/$/, '') === '/v1/events' && method === 'GET') {
        fs.appendFileSync(callsPath, JSON.stringify({ method, path: url.pathname, source: url.searchParams.get('source'), name: url.searchParams.get('name'), query: url.searchParams.toString() }) + '\n');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.failNative && url.searchParams.get('source') === 'system') return json({ detail: 'Fixture native history unavailable' }, 400);
        const start = Date.parse(url.searchParams.get('start_timestamp'));
        const end = Date.parse(url.searchParams.get('end_timestamp'));
        const items = state.events.filter(event => event.customer_id === url.searchParams.get('customer_id')
            && event.name === url.searchParams.get('name') && event.source === url.searchParams.get('source')
            && Date.parse(event.timestamp) >= start && Date.parse(event.timestamp) < end);
        const page = Number(url.searchParams.get('page') || 1);
        return json({ items: items.slice((page - 1) * 2, page * 2), pagination: { total_count: items.length, max_page: Math.max(1, Math.ceil(items.length / 2)) } });
    }
    if (url.hostname === 'api.polar.sh' && /^\/v1\/customers\/[^/]+\/state\/?$/.test(url.pathname) && method === 'GET') {
        return json({ id: url.pathname.split('/')[3], created_at: '2025-01-07T00:00:00Z', modified_at: null,
            metadata: {}, external_id: null, email: 'fixture@example.invalid', email_verified: true, type: 'individual', name: 'Fixture',
            billing_address: null, tax_id: null, organization_id: 'candidate', deleted_at: null,
            active_subscriptions: [], granted_benefits: [], active_meters: [], avatar_url: '' });
    }
    fs.appendFileSync(callsPath, JSON.stringify({ method, blocked: true, host: url.hostname, path: url.pathname }) + '\n');
    throw new Error(`External side effect blocked: ${method} ${url.hostname}${url.pathname}`);
};
