import './cron-boot.mjs';
// Provider boundary for the isolated Polar entitlement check.
// The real compiled Polar SDK reaches this module through NODE_OPTIONS. Only
// the customer-state endpoint used for entitlement authority is served; every
// other external origin fails closed so a missing mock is visible.
import fs from 'node:fs';

const dir = process.env.SAAS_POLAR_FIXTURES || '/tmp/saas-fixtures';
const statePath = `${dir}/polar-state.json`;
const callsPath = `${dir}/polar-calls.jsonl`;
const realFetch = globalThis.fetch;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function record(entry) {
  try {
    fs.appendFileSync(callsPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // The behavior check also asserts through its own expectations.
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { customers: {} };
  }
}

globalThis.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = String(init.method || request?.method || 'GET').toUpperCase();

  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    return realFetch(input, init);
  }
  if (url.hostname === 'qdrant.test') {
    return json({ status: 'ok', time: 0, result: { collections: [] } });
  }
  if (['us.i.posthog.com', 'eu.i.posthog.com', 'app.posthog.com'].includes(url.hostname)) {
    return json({ status: 1 });
  }
  // Bot startup may hydrate Twitch/LLM clients. These are inert boundaries, not
  // live calls; anything not named here still fails closed.
  if (url.hostname === 'api.twitch.tv' || url.hostname === 'id.twitch.tv' || url.hostname.endsWith('.twitch.tv')) {
    record({ method, path: url.pathname, host: url.hostname, status: 'mocked' });
    if (url.pathname.includes('/oauth2/token')) {
      return json({ access_token: 'polar-fixture-twitch-token', expires_in: 3600, token_type: 'bearer' });
    }
    return json({ data: [] });
  }
  if (url.hostname === 'openrouter.ai') {
    record({ method, path: url.pathname, host: url.hostname, status: 'mocked' });
    return json({ choices: [{ message: { role: 'assistant', content: '' } }] });
  }
  if (url.hostname !== 'api.polar.sh' && url.hostname !== 'sandbox-api.polar.sh') {
    record({ method, path: url.pathname, host: url.hostname, status: 'blocked' });
    throw new Error(`External request blocked in polar entitlements check: ${url.origin}${url.pathname}`);
  }

  const match = url.pathname.match(/^\/v1\/customers\/([^/]+)\/state$/);
  if (method === 'GET' && match) {
    const customerId = decodeURIComponent(match[1]);
    const state = readState();
    const entry = state.customers?.[customerId] || state.default || { status: 200, state: { id: customerId } };
    const status = Number.isSafeInteger(entry.status) ? entry.status : 200;
    record({ method, path: url.pathname, customerId, status });
    return json(entry.body ?? entry.state, status);
  }

  record({ method, path: url.pathname, status: 'unexpected' });
  throw new Error(`Unexpected Polar request in polar entitlements check: ${method} ${url.pathname}`);
};
