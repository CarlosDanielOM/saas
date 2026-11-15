/**
 * MCP v1, end to end on the exact API candidate (saas-ops verify, disposable Mongo/Redis, ops/checks/mcp-v1-fixtures):
 * CIMD sign-in with a channel choice by an admin, audience-bound tokens, protected resource metadata and challenges,
 * stateless MCP over the real Host boundary, live permissions, the safe-body guard, auto-apply + undo, and credits.
 */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { AdminSchema } = await import('/app/dist/schemas/admin.schema.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
assert.match(process.env.MONGO_URI, /saas_ops_mcp_v1_test$/, 'disposable database only');
const mongo = await getMongoDBConnection('mcp-v1-check');
const redis = await getDragonflyClient('mcp-v1-check');

const OWNER = '99004101', ADMIN = '99004102', STRANGER = '99004103';
const CIMD = 'https://client.example.com/oauth/mcp-client.json';
const CALLBACK = 'http://localhost:5555/callback';
const MCP = 'https://mcp.domdimabot.com/mcp';
const META = 'https://mcp.domdimabot.com/.well-known/oauth-protected-resource/mcp';
await mongo.connection.db.collection('users').insertMany([
  { name: 'MCP Owner', plan_tier: 'pro', polar_sh_customer_id: 'mcp-check-customer', language: 'en',
    accounts: [{ type: 'twitch', id: OWNER, name: 'mcp_owner' }] },
  { name: 'MCP Admin', plan_tier: 'free', language: 'en', accounts: [{ type: 'twitch', id: ADMIN, name: 'mcp_admin' }] },
  { name: 'MCP Stranger', plan_tier: 'free', accounts: [{ type: 'twitch', id: STRANGER, name: 'mcp_stranger' }] }
]);
await AdminSchema.create({ channelID: OWNER, channelName: 'mcp_owner', adminID: ADMIN, adminName: 'mcp_admin', actived: true,
  permissions: ['dashboard:view', 'commands:view', 'commands:manage'] });
const setBalance = balance => redis.set(`twitch:${OWNER}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
  used: 1000 - balance, limit: 1000, balance, available: true, status: balance > 0 ? 'available' : 'exhausted', updatedAt: new Date().toISOString() }));
await setBalance(500);

const rand = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
function http(method, path, { host = 'api.domdimabot.com', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port: 3000, method, path, headers: { Host: host,
      ...(payload ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const api = (method, path, body, token) => http(method, path, { body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
let rpcId = 0;
const mcp = (token, method, params, headers = {}) => http('POST', '/mcp', { host: 'mcp.domdimabot.com',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'MCP-Protocol-Version': '2025-11-25', ...headers },
  body: { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) } });
const tool = async (token, name, args = {}) => {
  const response = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(response.status, 200, `${name}: ${response.text.slice(0, 300)}`);
  const text = response.body.result.content[0].text;
  return { error: response.body.result.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

// Discovery: AS metadata advertises CIMD; the MCP host serves only MCP, with RFC 9728 metadata and challenges.
let result = await api('GET', '/.well-known/oauth-authorization-server');
assert.equal(result.body.client_id_metadata_document_supported, true);
assert.equal(result.body.authorization_response_iss_parameter_supported, true);
assert.deepEqual(result.body.token_endpoint_auth_methods_supported, ['none']);
result = await http('GET', '/.well-known/oauth-protected-resource/mcp', { host: 'mcp.domdimabot.com' });
assert.deepEqual(result.body, { resource: MCP, authorization_servers: ['https://api.domdimabot.com'],
  scopes_supported: ['channel:read', 'channel:write'], bearer_methods_supported: ['header'], resource_name: 'Dima' });
result = await mcp(null, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
assert.equal(result.status, 401);
assert.equal(result.headers['www-authenticate'], `Bearer realm="dima", scope="channel:read channel:write", resource_metadata="${META}"`);
assert.equal((await http('GET', '/users/me', { host: 'mcp.domdimabot.com' })).status, 404, 'the MCP host never reaches the API');
assert.notEqual((await http('POST', '/mcp', { body: {} })).headers['www-authenticate']?.includes('resource_metadata'), true,
  'the API host never serves MCP');

// The MCP host never reaches Socket.IO or the desktop WebSocket; the API host still does.
result = await http('GET', '/socket.io/?EIO=4&transport=polling', { host: 'mcp.domdimabot.com' });
assert.notEqual(result.status, 200, 'no Engine.IO polling on the MCP host');
assert.equal((await http('GET', '/socket.io/?EIO=4&transport=polling')).status, 200, 'Engine.IO still serves the API host');
const upgrade = (host, path = '/v1/desktop/ws') => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: 3000, path, headers: { Host: host, Connection: 'Upgrade',
    Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Protocol': 'dima.desktop.v1', Authorization: 'Bearer dima_at_' + 'x'.repeat(43) } });
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
  req.on('response', res => { res.resume(); resolve(res.statusCode); });
  req.on('error', error => error.code === 'ECONNRESET' ? resolve(0) : reject(error));
  req.end();
});
assert.equal(await upgrade('mcp.domdimabot.com'), 404, 'no desktop WebSocket on the MCP host');
assert.equal(await upgrade('api.domdimabot.com'), 401, 'the API host still checks desktop WebSocket tokens');
// An Engine.IO session opened through the API host cannot continue through the MCP host (polling or upgrade).
const handshake = await http('GET', '/socket.io/?EIO=4&transport=polling');
const sid = JSON.parse(handshake.text.slice(handshake.text.indexOf('{'))).sid;
assert.ok(sid, 'API-host handshake');
assert.equal((await http('GET', `/socket.io/?EIO=4&transport=polling&sid=${sid}`, { host: 'mcp.domdimabot.com' })).status, 400);
assert.notEqual(await upgrade('mcp.domdimabot.com', `/socket.io/?EIO=4&transport=websocket&sid=${sid}`), 101);

// CIMD authorization: resource is required for CIMD; the consent view shows publisher, callback host and channel choice.
async function begin(scope = 'channel:read channel:write', extra = {}) {
  const verifier = rand(), state = rand();
  const query = new URLSearchParams({ client_id: CIMD, response_type: 'code', redirect_uri: CALLBACK, scope, state,
    code_challenge: digest(verifier), code_challenge_method: 'S256', resource: MCP, ...extra });
  for (const [key, value] of Object.entries(extra)) if (value === undefined) query.delete(key);
  const response = await api('GET', `/oauth/authorize?${query}`);
  return { response, verifier, state, location: response.headers.location ? new URL(response.headers.location) : null };
}
let start = await begin(undefined, { resource: undefined });
assert.equal(start.response.status, 302);
assert.equal(start.location.origin + start.location.pathname, CALLBACK);
assert.equal(start.location.searchParams.get('error'), 'invalid_target', 'CIMD clients must send resource');
start = await begin('profile:read');
assert.equal(start.location.searchParams.get('error'), 'invalid_scope', 'desktop scopes are not issued for the MCP resource');
start = await begin();
assert.equal(start.response.status, 302);
assert.equal(start.location.origin, 'https://domdimabot.com');
const requestId = start.location.searchParams.get('request');
result = await api('GET', `/oauth/requests/${requestId}`);
assert.equal(result.body.client_kind, 'cimd');
assert.equal(result.body.client_name, 'Check MCP Client');
assert.equal(result.body.recognized, false);
assert.equal(result.body.document_host, 'client.example.com');
assert.equal(result.body.callback_host, 'localhost:5555');
assert.equal(result.body.channel_selection, true);
assert.equal(result.body.resource, MCP);
// An admin without the AI apps grant (mcp:admin) can't pick the channel, even though they manage it on the website.
result = await api('GET', '/oauth/browser-session', undefined, 'mcp-browser-admin');
assert.deepEqual(result.body.channels.map(channel => [channel.id, channel.role]), [[ADMIN, 'owner']]);
result = await api('POST', `/oauth/requests/${requestId}/decision`, { approve: true, channel_id: OWNER }, 'mcp-browser-admin');
assert.equal(result.status, 403);
assert.equal(result.body.error, 'channel_access_required');
// Full access alone is not enough either: AI apps is its own, explicit grant.
await AdminSchema.updateOne({ channelID: OWNER, adminID: ADMIN }, { $set: { permissions: ['*'] } });
result = await api('GET', '/oauth/browser-session', undefined, 'mcp-browser-admin');
assert.deepEqual(result.body.channels.map(channel => channel.id), [ADMIN]);
// Only the channel owner grants AI apps: platform staff (the creator account) can manage admins but not grant it.
const grant = (token, permissions) => http('PUT', `/admins/${OWNER}/${ADMIN}/permissions`, { body: { permissions },
  headers: { Authorization: `Bearer ${token}` } });
const withMcp = ['dashboard:view', 'commands:view', 'commands:manage', 'mcp:admin'];
result = await grant('mcp-browser-creator', withMcp);
assert.equal(result.status, 403, result.text);
assert.equal(result.body.type, 'mcp_owner_only');
result = await http('POST', `/admins/${OWNER}`, { body: { channelName: 'mcp_owner', adminName: 'mcp_stranger', permissions: ['*', 'mcp:admin'] },
  headers: { Authorization: 'Bearer mcp-browser-creator' } });
assert.equal(result.status, 403, 'staff cannot add a new admin with AI apps either');
result = await grant('mcp-browser-owner', withMcp);
assert.equal(result.status, 200, result.text);
assert.equal((await grant('mcp-browser-creator', withMcp)).status, 200, 'staff may keep an existing grant while editing');
result = await api('GET', '/oauth/browser-session', undefined, 'mcp-browser-admin');
assert.deepEqual(result.body.channels.map(channel => [channel.id, channel.role]), [[ADMIN, 'owner'], [OWNER, 'admin']]);
result = await api('POST', `/oauth/requests/${requestId}/decision`, { approve: true }, 'mcp-browser-admin');
assert.equal(result.status, 400, 'channel choice is required');
result = await api('POST', `/oauth/requests/${requestId}/decision`, { approve: true, channel_id: STRANGER }, 'mcp-browser-admin');
assert.equal(result.status, 403);
assert.equal(result.body.error, 'channel_access_required');
result = await api('POST', `/oauth/requests/${requestId}/decision`, { approve: true, channel_id: OWNER }, 'mcp-browser-admin');
assert.equal(result.status, 200);
let callback = new URL(result.body.redirect_uri);
assert.equal(callback.searchParams.get('state'), start.state);
assert.equal(callback.searchParams.get('iss'), 'https://api.domdimabot.com');
const exchange = (code, verifier, extra = {}) => api('POST', '/oauth/token', { grant_type: 'authorization_code', client_id: CIMD,
  code, redirect_uri: CALLBACK, code_verifier: verifier, ...extra });
result = await exchange(callback.searchParams.get('code'), start.verifier, { resource: 'https://api.domdimabot.com/v1' });
assert.equal(result.status, 400);
assert.equal(result.body.error, 'invalid_target');
result = await exchange(callback.searchParams.get('code'), start.verifier, { resource: MCP });
assert.equal(result.status, 200, JSON.stringify(result.body));
assert.equal(result.body.scope, 'channel:read channel:write');
const writer = result.body.access_token;
const writerRefresh = result.body.refresh_token;
assert.equal((await api('GET', '/v1/me', undefined, writer)).status, 401, 'MCP tokens never work on the desktop API');

// MCP session: stateless initialize, live tool list for an admin with commands rights only.
result = await mcp(writer, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
assert.equal(result.status, 200);
assert.equal(result.body.result.serverInfo.name, 'dima');
assert.equal(result.headers['mcp-session-id'], undefined);
result = await mcp(writer, 'tools/list');
const names = result.body.result.tools.map(item => item.name);
for (const name of ['list_commands', 'get_command', 'create_command', 'update_command', 'delete_command', 'undo_change', 'list_recent_changes', 'read_docs'])
  assert.ok(names.includes(name), `offered: ${name}`);
for (const name of ['create_poll', 'set_stream_info', 'send_test_alert', 'update_ai_personality', 'update_moderation_settings', 'show_ui', 'navigate', 'update_tts_settings'])
  assert.ok(!names.includes(name), `not offered: ${name}`);
assert.match(result.body.result.tools.find(item => item.name === 'list_commands').description, /1 AI credit/);
// v1.1: MCP-only descriptions (no website approval-card wording, only safe functions) and explicit hints.
for (const item of result.body.result.tools) {
  assert.doesNotMatch(item.description, /\bpropos|approv(e|es|al)\b|press Apply|sees a card|in your instructions/i, `${item.name}: website-only wording`);
  assert.doesNotMatch(item.description, /\$\((tts|ban|timeout)\b|#\(/, `${item.name}: teaches a refused function`);
}
const createListed = result.body.result.tools.find(item => item.name === 'create_command');
assert.match(createListed.description, /undo_change/);
assert.deepEqual(createListed.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
assert.doesNotMatch(result.body.result.tools.find(item => item.name === 'read_docs').description, /AI credit/);

// Reads cost 1 credit, charged once through Polar.
let call = await tool(writer, 'list_commands');
assert.equal(call.error, false, call.text);
assert.equal(call.json.charged, 1);
const billing = async () => (await redis.lRange('mcp:test:billing-events', 0, -1)).map(item => JSON.parse(item));
let events = await billing();
assert.equal(events.length, 1);
assert.equal(events[0].metadata.credits, 1);
assert.equal(events[0].metadata.reason, 'mcp_tool');
assert.equal(events[0].customer_id ?? events[0].customerId, 'mcp-check-customer');
assert.match(events[0].external_id ?? events[0].externalId, /^mcp_tool:/);

// Writes apply directly with a change id; the guard refuses commands that act on the stream; undo restores.
call = await tool(writer, 'create_command', { name: 'mcpcheck', body: 'Hello $(user), welcome!' });
assert.equal(call.error, false, call.text);
assert.equal(call.json.charged, 1);
assert.ok(call.json.changeId, 'change id returned');
assert.equal(call.json.undoable, true);
const changeId = call.json.changeId;
call = await tool(writer, 'get_command', { name: '!mcpcheck' });
assert.equal(call.error, false, call.text);
assert.match(call.text, /welcome/);
call = await tool(writer, 'create_command', { name: 'mcpban', body: 'bye $(ban $(user) 60)' });
assert.equal(call.error, true);
assert.match(call.text, /\(unsafe_content\)$/);
call = await tool(writer, 'create_command', { name: 'mcpnested', body: '$(if $(random 1 2) == 1 | ok | $(set.title hacked))' });
assert.equal(call.error, true, 'hidden effects in conditionals are refused too');
call = await tool(writer, 'list_recent_changes');
assert.equal(call.error, false, call.text);
assert.match(call.text, /mcpcheck/);
call = await tool(writer, 'undo_change', { changeId });
assert.equal(call.error, false, call.text);
call = await tool(writer, 'get_command', { name: '!mcpcheck' });
assert.equal(call.json.result.found, false, 'undo removed the command');
assert.equal(call.json.charged, 0, 'a not-found read is not billed');
const change = await mongo.connection.db.collection('site_agent_changes').findOne({ tool: 'create_command', undoOf: null });
assert.equal(change?.source?.surface, 'mcp', 'the website change log shows the MCP source');
assert.equal(change.source.clientName, 'Check MCP Client');
assert.ok(change.undoneAt, 'the change is marked undone');
events = await billing();
assert.equal(events.reduce((sum, event) => sum + event.metadata.credits, 0), events.length, 'one credit per billed call');

// v1.1 parallel tool calls: 16 at once on one connection all run (12 at a time, the rest wait their turn), each charged once.
const billedBeforeParallel = (await billing()).length;
const parallel = await Promise.all(Array.from({ length: 16 }, () => tool(writer, 'list_commands')));
assert.deepEqual(parallel.map(item => item.error), Array(16).fill(false), parallel.find(item => item.error)?.text);
assert.equal((await billing()).length, billedBeforeParallel + 16, 'every parallel call charged exactly once');
// Batches (old 2025-03-26 clients): every message counts against the limits; more than 20 is refused.
const batch = (token, messages, version = '2025-03-26') => http('POST', '/mcp', { host: 'mcp.domdimabot.com',
  headers: { Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': version },
  body: messages.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) })) });
result = await batch(writer, [['ping'], ['tools/list'], ['tools/call', { name: 'search_docs', arguments: { query: 'timers' } }]]);
assert.equal(result.status, 200, result.text.slice(0, 300));
assert.equal(Array.isArray(result.body) && result.body.length, 3, 'one answer per message');
result = await batch(writer, Array.from({ length: 21 }, () => ['ping']));
assert.equal(result.status, 400);
assert.equal(result.body.error.code, -32600);
// The call log: one row per tool call, refusals with their code and message, app and person, no arguments.
const logRows = await mongo.connection.db.collection('mcp_call_logs').find({ channelId: OWNER }).toArray();
assert.ok(logRows.length >= 24, `call log rows: ${logRows.length}`);
const refusedRow = logRows.find(row => row.code === 'unsafe_content');
assert.ok(refusedRow, 'the refused $(ban) write is logged');
assert.equal(refusedRow.outcome, 'blocked');
assert.equal(refusedRow.problem, true);
assert.match(refusedRow.reason, /Not applied/);
assert.equal(refusedRow.client.name, 'Check MCP Client');
assert.equal(refusedRow.user.id, ADMIN);
assert.equal(refusedRow.user.role, 'admin');
const writeRow = logRows.find(row => row.tool === 'create_command' && row.outcome === 'ok');
assert.ok(writeRow?.changeId, 'a logged write keeps its change id');
assert.equal(writeRow.charged, 1);
assert.ok(logRows.every(row => !('arguments' in row) && !JSON.stringify(row).includes('welcome!')), 'arguments are never stored');
assert.ok(logRows.every(row => row.expiresAt > new Date(Date.now() + 80 * 86_400_000)), 'kept 90 days');

// Step-up: a read-only token gets 403 insufficient_scope on a write, before anything runs.
start = await begin('channel:read');
result = await api('POST', `/oauth/requests/${start.location.searchParams.get('request')}/decision`, { approve: true, channel_id: OWNER }, 'mcp-browser-owner');
callback = new URL(result.body.redirect_uri);
const reader = (await exchange(callback.searchParams.get('code'), start.verifier)).body.access_token;
// The AI credit balance: free, for whoever may see the Credits page (the owner here; the admin lacks billing:view).
assert.ok(!names.includes('get_ai_credits'), 'hidden from an admin without billing:view');
result = await mcp(reader, 'tools/list');
const credits = result.body.result.tools.find(item => item.name === 'get_ai_credits');
assert.ok(credits, 'the owner sees the balance tool');
assert.doesNotMatch(credits.description, /Costs/);
const billedBeforeBalance = (await billing()).length;
call = await tool(reader, 'get_ai_credits');
assert.equal(call.error, false, call.text);
// The live balance: the 500 seeded minus every credit billed so far in this check (the local projection debits them).
assert.equal(call.json.result.balance, 500 - (await billing()).reduce((sum, event) => sum + event.metadata.credits, 0));
assert.equal(call.json.result.buyMoreAt, 'https://domdimabot.com/mcp_owner/credits');
assert.equal(call.json.charged, 0);
assert.equal((await billing()).length, billedBeforeBalance, 'reading the balance is never billed');
result = await mcp(reader, 'tools/call', { name: 'create_command', arguments: { name: 'nope', body: 'x' } });
assert.equal(result.status, 403);
assert.equal(result.headers['www-authenticate'], `Bearer realm="dima", error="insufficient_scope", scope="channel:read channel:write", resource_metadata="${META}"`);

// Credits: an empty balance refuses priced calls without charging; docs stay free.
const before = (await billing()).length;
await setBalance(0);
call = await tool(writer, 'list_commands');
assert.equal(call.error, true);
assert.match(call.text, /\(credits_exhausted\)$/);
assert.equal((await billing()).length, before, 'refused calls are never charged');
await setBalance(500);

// Live rights: taking only the AI apps grant away cuts tool access at once (the admin keeps the website).
await AdminSchema.updateOne({ channelID: OWNER, adminID: ADMIN }, { $set: { permissions: ['dashboard:view', 'commands:view', 'commands:manage'] } });
call = await tool(writer, 'list_commands');
assert.equal(call.error, true);
assert.match(call.text, /\(no_access\)$/);
await AdminSchema.updateOne({ channelID: OWNER, adminID: ADMIN }, { $set: { permissions: ['dashboard:view', 'commands:view', 'commands:manage', 'mcp:admin'] } });
assert.equal((await tool(writer, 'list_commands')).error, false, 'giving it back restores access');
// Removing the admin entirely also cuts access, and refresh is refused.
await AdminSchema.deleteMany({ channelID: OWNER, adminID: ADMIN });
call = await tool(writer, 'list_commands');
assert.equal(call.error, true);
assert.match(call.text, /\((no_access|permission_denied)\)$/);
result = await api('POST', '/oauth/token', { grant_type: 'refresh_token', client_id: CIMD, refresh_token: writerRefresh });
assert.equal(result.status, 400, 'refresh re-checks channel access');

// Denylisting the app ends its sessions.
await redis.sAdd('oauth:cimd:deny', CIMD);
result = await mcp(reader, 'tools/list');
assert.equal(result.status, 401);
await redis.sRem('oauth:cimd:deny', CIMD);

// CIMD fetch limits (last: they use up this process's shared fetch budget for a minute). Only real fetches count.
const RECOGNIZED = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const failKey = id => `oauth:cimd:fail:${digest(id)}`;
const authorizeFrom = (client, clientId) => http('GET', `/oauth/authorize?${new URLSearchParams({ client_id: clientId,
  response_type: 'code', redirect_uri: CALLBACK, scope: 'channel:read', code_challenge: digest(rand()), code_challenge_method: 'S256',
  resource: MCP })}`, { headers: { 'X-Real-IP': '162.158.10.1', 'CF-Connecting-IP': client } });
const junk = id => `https://junk-${id}.example.com/oauth/client.json`;
for (let i = 0; i < 10; i++) {
  result = await authorizeFrom('203.0.113.60', junk(`a${i}`));
  assert.deepEqual([result.status, result.body], [400, { error: 'invalid_client' }]);
  assert.equal(await redis.exists(failKey(junk(`a${i}`))), 1, 'a fetched 404 is negatively cached');
}
result = await authorizeFrom('203.0.113.60', junk('a10'));
assert.deepEqual([result.status, result.body], [400, { error: 'invalid_client' }], 'source over budget: same error shape');
assert.equal(await redis.exists(failKey(junk('a10'))), 0, 'a local limit is never negatively cached');
result = await authorizeFrom('203.0.113.60', junk('a0'));
assert.equal(result.status, 400, 'negative-cache hits need no budget');
result = await authorizeFrom('203.0.113.61', CIMD);
assert.equal(result.status, 302);
assert.equal(new URL(result.headers.location).origin, 'https://domdimabot.com', 'another source still connects');
// Use up the shared per-minute budget for unknown ids from fresh sources (10 each), until a fresh source is refused.
let exhausted = false;
for (let n = 0; n < 13 && !exhausted; n++) for (let i = 0; i < 10 && !exhausted; i++) {
  const id = junk(`s${n}-${i}`);
  result = await authorizeFrom(`198.51.100.${n + 10}`, id);
  assert.equal(result.status, 400);
  exhausted = await redis.exists(failKey(id)) === 0;
}
assert.ok(exhausted, 'the shared budget for unknown client ids ran out');
result = await authorizeFrom('198.51.100.200', CIMD);
assert.deepEqual([result.status, result.body], [400, { error: 'invalid_client' }], 'an unknown app now waits for the next minute');
result = await authorizeFrom('198.51.100.201', RECOGNIZED);
assert.equal(result.status, 302, 'a recognized app is not starved');
const recognizedRequest = new URL(result.headers.location).searchParams.get('request');
result = await api('GET', `/oauth/requests/${recognizedRequest}`);
assert.deepEqual([result.body.client_name, result.body.recognized], ['Claude', true]);

console.log('PASS MCP v1.1: parallel calls + batch limits + call log; CIMD sign-in + admin channel choice (explicit mcp:admin, not *, owner-only grant), audience, PRM/challenges/step-up, host boundary, tool list, '
  + 'reads/writes charged once, free credit balance, safe-body guard, undo, credits exhaustion, live rights, denylist, CIMD fetch budgets');
await mongo.disconnect();
await redis.quit();
process.exit(0);
