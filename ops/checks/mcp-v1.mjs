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

// Step-up: a read-only token gets 403 insufficient_scope on a write, before anything runs.
start = await begin('channel:read');
result = await api('POST', `/oauth/requests/${start.location.searchParams.get('request')}/decision`, { approve: true, channel_id: OWNER }, 'mcp-browser-owner');
callback = new URL(result.body.redirect_uri);
const reader = (await exchange(callback.searchParams.get('code'), start.verifier)).body.access_token;
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

// Live rights: removing the admin cuts tool access at once, and refresh is refused.
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

console.log('PASS MCP v1: CIMD sign-in + admin channel choice, audience, PRM/challenges/step-up, host boundary, tool list, '
  + 'reads/writes charged once, safe-body guard, undo, credits exhaustion, live rights, denylist');
await mongo.disconnect();
await redis.quit();
process.exit(0);
