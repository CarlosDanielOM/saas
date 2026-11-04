// Loaded only by saas-ops --test-env NODE_OPTIONS, inside the isolated API candidate.
// Mocks Qdrant, Polar and Twitch; loopback API traffic passes through untouched.
// Polar subscriptions live in /tmp/saas-fixtures/polar-state.json (written by the check); each
// revoke is logged to polar-calls.jsonl with the user/DimaFX rows that still existed at that moment.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const mongoose = createRequire('/app/package.json')('mongoose');

const STATE = '/tmp/saas-fixtures/polar-state.json';
const CALLS = '/tmp/saas-fixtures/polar-calls.jsonl';
const PAGE_SIZE = 2; // small pages exercise pagination
const originalFetch = globalThis.fetch;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { subscriptions: [] });
const writeState = state => fs.writeFileSync(STATE, JSON.stringify(state));

async function polar(url, options) {
  const state = readState();
  const method = (options.method || 'GET').toUpperCase();
  if (url.pathname === '/v1/subscriptions/' && method === 'GET') {
    const customer = url.searchParams.get('customer_id');
    const external = url.searchParams.get('external_customer_id');
    const matches = state.subscriptions.filter(s => (customer && s.customer_id === customer) || (external && s.external_customer_id === external));
    const page = Number(url.searchParams.get('page') || 1);
    const maxPage = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    return json({ items: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), pagination: { total_count: matches.length, max_page: maxPage } });
  }
  const match = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
  const subscription = match && state.subscriptions.find(s => s.id === decodeURIComponent(match[1]));
  if (match && !subscription) return json({ detail: 'Not found' }, 404);
  if (match && method === 'GET') return json(subscription);
  if (match && method === 'DELETE') {
    const db = mongoose.connection.db;
    fs.appendFileSync(CALLS, JSON.stringify({
      revoke: subscription.id,
      usersAtRevoke: await db.collection('users').countDocuments({ _id: new mongoose.Types.ObjectId(state.ownerUserId) }),
      dimafxItemsAtRevoke: await db.collection('channelextensionitems').countDocuments({ channelID: state.ownerChannelId })
    }) + '\n');
    if (state.failRevoke) return json({ detail: 'Polar unavailable' }, 503);
    subscription.status = 'canceled';
    writeState(state);
    // Simulates a concurrent cancel: Polar refuses, but the subscription has ended.
    if (subscription.conflictOnRevoke) return json({ error: 'AlreadyCanceledSubscription' }, 403);
    return json(subscription);
  }
  return json({ events: [], inserted: 1, duplicates: 0 });
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'qdrant.test') {
    return json(url.pathname === '/'
      ? { version: '1.18.0' }
      : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : url.pathname.endsWith('/delete') ? { operation_id: 1, status: 'completed' } : { collections: [] } });
  }
  if (url.hostname === 'api.polar.sh') return polar(url, options);
  if (url.hostname === 'id.twitch.tv' || url.hostname === 'api.twitch.tv') return json({}, 401);
  throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
