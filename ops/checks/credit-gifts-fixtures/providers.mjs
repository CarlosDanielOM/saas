// All external provider calls are intercepted. State persists across the real API/cron processes.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
const dir = '/tmp/saas-fixtures', statePath = `${dir}/polar.json`, callsPath = `${dir}/calls.jsonl`;
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ customers: {}, checkouts: {}, orders: {}, grants: [], controls: {} }));
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
// The check and the candidate's worker processes share this file: write a temp file and rename it, so a reader in
// another process never sees a half-written state (that surfaced as "Gift provider connection interrupted").
const save = state => { const tmp = `${statePath}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, statePath); };
const log = call => fs.appendFileSync(callsPath, JSON.stringify(call) + '\n');
const originalLog = console.log;
console.log = (...args) => {
    if (args[0] === 'Credit gift worker ready') log({ workerReady: process.pid });
    originalLog(...args);
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const page = items => ({ items, pagination: { total_count: items.length, max_page: 1 } });
const paidProduct = '6e0c530d-affc-44be-a51b-e11453ef1fa7', freeProduct = 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a';
const meter = '5103e79b-fd74-4ba8-a287-f95574f9addf', benefitId = 'a3f28ab5-ed53-4aae-a685-7dfaf89aa3df';
const benefit = { id: benefitId, type: 'meter_credit', properties: { meter_id: meter, rollover: true, units: 40000 } };
export const products = [
    { id: paidProduct, name: 'Sample Gift Credit Pack', is_recurring: false, visibility: 'private', prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 100, price_currency: 'usd' }], benefits: [] },
    { id: freeProduct, name: 'Paid Sample Gift Credit Pack', is_recurring: false, visibility: 'private', prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 0, price_currency: 'usd' }], benefits: [benefit] },
];
const extraPairs = [
    ['815d0efe-1d23-4fca-8762-ae3a9253b0bc', '019b6291-80a0-4b31-bb09-feaaa9afe5eb', '91cc7d43-192a-4167-8c69-26972ff4403c', 500, 250000, 'Starter'],
    ['7d0d5f0e-102a-4255-abf3-6f379e2da4ce', '3f6010b6-4108-4bf9-ab83-b035eeed6962', 'a70b4707-269e-4557-bd16-d5421b4f0550', 1000, 550000, 'Medium'],
];
for (const [paid, free, id, price, units, name] of extraPairs) {
    products.push(
        { id: paid, name: `${name} Gift Credits Pack`, is_recurring: false, visibility: 'private', prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: price, price_currency: 'usd' }], benefits: [] },
        { id: free, name: `Paid ${name} Gift Credits Pack`, is_recurring: false, visibility: 'private', prices: [{ type: 'one_time', amount_type: 'fixed', price_amount: 0, price_currency: 'usd' }], benefits: [{ id, type: 'meter_credit', properties: { meter_id: meter, rollover: true, units } }] },
    );
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' } : { status: 'ok', time: 0, result: { collections: [] } });
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    const method = options.method || 'GET', path = url.pathname.replace(/\/$/, '');
    if (url.hostname === 'api.twitch.tv') {
        if (path === '/helix/chat/messages') {
            const state = read();
            log({ chat: true, channel: body.broadcaster_id, message: body.message, at: Date.now() });
            if (state.controls.chatFail) return json({ error: 'Provider unavailable', message: 'Try again' }, 503);
            return json({ data: [{ is_sent: !state.controls.chatHeld, message_id: randomUUID() }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    if (url.hostname !== 'api.polar.sh' && url.hostname !== 'sandbox-api.polar.sh') throw new Error(`External request blocked: ${url.origin}${path}`);
    log({ host: url.hostname, method, path: path.includes('/client/') ? '/v1/checkouts/client/[redacted]/confirm' : path, query: url.search, body });
    const state = read();
    if (path.startsWith('/v1/products/')) {
        const product = structuredClone(products.find(p => p.id === path.split('/').at(-1)));
        if (state.controls.badFreePrice && product?.id === freeProduct) product.prices[0].price_amount = 100;
        if (state.controls.badRollover && product?.id === freeProduct) product.benefits[0].properties.rollover = false;
        return product ? json(product) : json({}, 404);
    }
    if (/^\/v1\/customers\/[^/]+\/state$/.test(path)) {
        const id = path.split('/')[3], customer = state.customers[id];
        const balance = state.grants.filter(g => g.customer_id === id && g.is_granted && !g.is_revoked).reduce((sum, g) => sum + g.properties.last_credited_units, 0);
        return json({ id, active_subscriptions: [], active_meters: [{ meter_id: meter, credited_units: balance, consumed_units: 0, balance }], ...customer });
    }
    if (/^\/v1\/customers\/[^/]+$/.test(path)) {
        const customer = state.customers[path.split('/')[3]];
        return customer ? json(customer) : json({}, 404);
    }
    if (path === '/v1/checkouts' && method === 'POST') {
        const product = products.find(p => p.id === body.products[0]);
        if (!product) return json({}, 404);
        const free = product.prices[0].price_amount === 0;
        const customer = state.customers[body.customer_id];
        if (!customer || customer.external_id !== body.external_customer_id) return json({}, 422);
        if (state.controls.rejectCreate) return json({}, 422);
        const id = randomUUID(), amount = product.prices[0].price_amount;
        const checkout = { id, url: `https://polar.sh/checkout/${id}`, client_secret: `polar_c_${id}`, status: 'open',
            product_id: body.products[0], customer_id: body.customer_id, customer_external_id: body.external_customer_id,
            amount, discount_amount: 0, total_amount: amount, currency: 'usd', metadata: body.metadata };
        state.checkouts[id] = checkout;
        const lose = free ? 'loseFulfillResponse' : 'losePurchaseResponse';
        const lost = state.controls[lose];
        delete state.controls[lose]; save(state);
        if (lost) throw new Error('Simulated response loss after checkout creation');
        return json(checkout, 201);
    }
    // Race hooks for checks: run inside the provider call, i.e. while the worker holds the gift between its read and its write.
    if (path === '/v1/checkouts' && method === 'GET' && globalThis.__giftCheckoutListHook) await globalThis.__giftCheckoutListHook();
    if (/^\/v1\/checkouts\/[^/]+$/.test(path) && method === 'GET' && globalThis.__giftCheckoutReadHook) await globalThis.__giftCheckoutReadHook(path.split('/')[3]);
    if (path === '/v1/checkouts' && method === 'GET') return json(page(Object.values(state.checkouts).filter(c => c.product_id === url.searchParams.get('product_id') && c.customer_external_id === url.searchParams.get('external_customer_id'))));
    if (path.endsWith('/confirm') && method === 'POST') {
        const secret = decodeURIComponent(path.split('/')[4]), checkout = Object.values(state.checkouts).find(c => c.client_secret === secret);
        if (!checkout) return json({}, 404);
        if (checkout.status !== 'open') return json({}, 403);
        if (checkout.total_amount !== 0) throw new Error('Test attempted a real paid confirmation');
        checkout.status = 'succeeded';
        const orderId = randomUUID();
        state.orders[orderId] = { id: orderId, paid: true, status: 'paid', product_id: checkout.product_id, checkout_id: checkout.id,
            customer_id: checkout.customer_id, customer: state.customers[checkout.customer_id], subscription_id: null,
            net_amount: 0, total_amount: 0, refunded_amount: 0, discount_amount: 0, currency: 'usd', metadata: checkout.metadata };
        const creditBenefit = products.find(p => p.id === checkout.product_id).benefits[0];
        state.grants.push({ id: randomUUID(), order_id: orderId, customer_id: checkout.customer_id, benefit_id: creditBenefit.id,
            granted_at: new Date().toISOString(), benefit: creditBenefit,
            is_granted: !state.controls.holdGrant, is_revoked: false, properties: {
                last_credited_meter_id: meter, last_credited_units: creditBenefit.properties.units, last_credited_at: new Date().toISOString(),
            } });
        const lost = state.controls.loseConfirmResponse;
        delete state.controls.loseConfirmResponse; save(state);
        if (lost) throw new Error('Simulated confirmation response loss');
        return json({ id: checkout.id, status: 'confirmed' });
    }
    if (/^\/v1\/checkouts\/[^/]+$/.test(path)) return state.checkouts[path.split('/')[3]] ? json(state.checkouts[path.split('/')[3]]) : json({}, 404);
    // `ordersDown` simulates a Polar outage on the order lookup (transient errors before payment).
    if (path === '/v1/orders' && state.controls.ordersDown) return json({ detail: 'unavailable' }, 503);
    if (path === '/v1/orders') return json(page(Object.values(state.orders).filter(o => o.checkout_id === url.searchParams.get('checkout_id'))));
    if (/^\/v1\/orders\/[^/]+$/.test(path)) return state.orders[path.split('/')[3]] ? json(state.orders[path.split('/')[3]]) : json({}, 404);
    if (path === '/v1/benefit-grants') return json(page(state.grants.filter(g => g.customer_id === url.searchParams.get('customer_id')).map(g => ({ ...g, properties: {} }))));
    throw new Error(`Unmocked Polar request blocked: ${method} ${path}`);
};

// Cron candidate (test-env-cron.json): the real supervisor starts only the gift worker and the domain-events
// worker with only its polar-gifts-v1 consumer. Every other worker is an inert child that never runs, so the
// candidate stays far below the test container's 3 GB limit (all 26 workers do not fit). Modules run unchanged.
if (process.env.GIFT_CHECK_ONLY_GIFT_WORKERS === 'true') {
    const inert = () => {
        const child = new EventEmitter();
        child.pid = 0;
        child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); return true; };
        return child;
    };
    globalThis.__giftCheckSpawn = (command, args, options) => {
        const entry = String(args?.[0] ?? '');
        if (!entry.endsWith('/credit_gifts.worker.js') && !entry.endsWith('/domain_events.worker.js')) return inert();
        return spawn(command, args, options);
    };
    globalThis.__giftCheckFork = (entry, args, options) => args?.includes('--consumer=polar-gifts-v1') ? fork(entry, args, options) : inert();
    const shim = name => `export const ${name} = (...args) => globalThis.__giftCheck${name[0].toUpperCase()}${name.slice(1)}(...args);`;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'node:child_process' && context.parentURL?.endsWith('/workers/cron.index.js')) {
                return { url: `data:text/javascript,${encodeURIComponent(shim('spawn'))}`, shortCircuit: true };
            }
            if (specifier === 'node:child_process' && context.parentURL?.endsWith('/utils/domain_event_execution.js')) {
                return { url: `data:text/javascript,${encodeURIComponent(shim('fork'))}`, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        }
    });
}
