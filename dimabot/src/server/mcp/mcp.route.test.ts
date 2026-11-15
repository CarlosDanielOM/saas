/** MCP endpoint: Host boundary, RFC 6750/9728 challenges, step-up 403, stateless SDK round trips, tool outcome mapping. */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, mock, test } from 'node:test';
import express from 'express';

class OAuthError extends Error { constructor(readonly code: string, readonly status = 400, readonly scope?: readonly string[]) { super(code); } }
const MCP = 'https://mcp.domdimabot.com/mcp';
const identity = { session_id: 'session-1', user_id: 'user-1', client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    requester_id: '111', channel_id: '222', resource: MCP, scopes: ['channel:read'] };
const calls: { name: string; args: unknown; principal: unknown }[] = [];
const buckets: string[] = [];
let limited = '';
mock.module('../oauth/catalog.js', { namedExports: {
    OAuthError, isMcpHost: (host: unknown) => typeof host === 'string' && host.split(':')[0] === 'mcp.domdimabot.com', OAUTH_RESOURCES: { desktop: 'https://api.domdimabot.com/v1', mcp: MCP },
    OAUTH_SCOPES: { 'channel:read': { active: true, resource: 'mcp' }, 'channel:write': { active: true, resource: 'mcp' },
        'stream:act': { active: false, resource: 'mcp' }, 'profile:read': { active: true, resource: 'desktop' } },
    bearerChallenge: (realm: string, error?: string, scope: readonly string[] = [], meta?: string) =>
        [`Bearer realm="${realm}"`, error && `error="${error}"`, scope.length && `scope="${scope.join(' ')}"`, meta && `resource_metadata="${meta}"`].filter(Boolean).join(', ')
} });
mock.module('../oauth/service.js', { namedExports: {
    hash: (value: string) => `h:${value}`, oauthIssuer: () => 'https://api.domdimabot.com',
    rateLimit: async (bucket: string, _limit: number, cost = 1) => { buckets.push(cost > 1 ? `${bucket}x${cost}` : bucket); if (bucket === limited) throw new OAuthError('slow_down', 429); },
    authenticateAccess: async (token: unknown, options?: { resource?: string }) => {
        assert.equal(options?.resource, MCP, 'only MCP-audience tokens');
        if (token === 'good') return identity;
        if (token === 'writer') return { ...identity, scopes: ['channel:read', 'channel:write'] };
        if (token === 'broken') throw new Error('db down');
        throw new OAuthError('invalid_token', 401);
    }
} });
mock.module('../../schemas/oauth_session.schema.js', { namedExports: { OAuthSession: {
    findById: () => ({ select: () => ({ lean: async () => ({ client_name: 'Claude' }) }) }) } } });
const tools: Record<string, { kind: string }> = { search_docs: { kind: 'knowledge' }, list_commands: { kind: 'read' }, create_command: { kind: 'write' } };
mock.module('../../site_agent/tools/execute.js', { namedExports: {
    mcpTool: (name: string) => tools[name],
    listMcpTools: async () => [{ name: 'list_commands', description: 'List commands. Costs 1 AI credit from the channel.',
        inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, credits: 1 }],
    executeMcpToolCall: async (principal: unknown, name: string, args: unknown, opts: { operationId: string; signal: AbortSignal }) => {
        assert.match(opts.operationId, /^[0-9a-f-]{36}$/);
        assert.ok(opts.signal instanceof AbortSignal);
        calls.push({ name, args, principal });
        if (name === 'list_commands') return { ok: true, result: { commands: ['!hi'] }, charged: 1 };
        return { ok: false, code: 'unknown_tool', message: 'There is no tool named "x".' };
    }
} });
mock.module('../../site_agent/tools/mcp.js', { namedExports: {
    requiredScope: (kind: string) => kind === 'knowledge' ? null : kind === 'read' ? 'channel:read' : kind === 'write' ? 'channel:write' : 'stream:act' } });
mock.module('../../site_agent/tools/registry.js', { namedExports: { toolResultText: (value: unknown) => JSON.stringify(value) } });
const { mcpHostBoundary } = await import('./mcp.route.js');

const app = express();
app.use(mcpHostBoundary);
app.use((_req, res) => { res.status(299).json({ api: true }); });
const listener = app.listen(0, '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const port = (listener.address() as AddressInfo).port;
after(() => listener.close());

function call(method: string, path: string, options: { host?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }>((resolve, reject) => {
        const payload = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: options.host ?? 'mcp.domdimabot.com',
            ...(payload ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {}), ...options.headers } }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => { let body: unknown = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body }); });
        });
        req.on('error', reject);
        req.end(payload);
    });
}
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
const META = 'https://mcp.domdimabot.com/.well-known/oauth-protected-resource/mcp';

test('other hosts never see the MCP router, and the MCP host never sees the API', async () => {
    assert.equal((await call('POST', '/mcp', { host: 'api.domdimabot.com', body: initialize })).status, 299);
    const other = await call('GET', '/users/me');
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, { error: 'not_found' });
});

test('protected resource metadata names the resource, the issuer and the active MCP scopes', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const response = await call('GET', path);
        assert.equal(response.status, 200);
        assert.equal(response.headers['access-control-allow-origin'], '*');
        assert.deepEqual(response.body, { resource: MCP, authorization_servers: ['https://api.domdimabot.com'],
            scopes_supported: ['channel:read', 'channel:write'], bearer_methods_supported: ['header'], resource_name: 'Dima' });
    }
});

test('401 challenges point at the resource metadata; bad tokens add invalid_token', async () => {
    const missing = await call('POST', '/mcp', { body: initialize });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers['www-authenticate'], `Bearer realm="dima", scope="channel:read channel:write", resource_metadata="${META}"`);
    const bad = await call('POST', '/mcp', { body: initialize, headers: { Authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['www-authenticate'], `Bearer realm="dima", error="invalid_token", scope="channel:read channel:write", resource_metadata="${META}"`);
    assert.equal((await call('POST', '/mcp?token=good', { body: initialize })).status, 401, 'never from the query string');
    assert.equal((await call('POST', '/mcp', { body: initialize, headers: { Authorization: 'Bearer broken' } })).status, 503);
});

test('stateless initialize and tools/list over plain JSON', async () => {
    const init = await call('POST', '/mcp', { body: initialize, headers: { Authorization: 'Bearer good' } });
    assert.equal(init.status, 200);
    assert.equal(init.headers['mcp-session-id'], undefined, 'stateless: no session id');
    assert.equal(init.body.result.serverInfo.name, 'dima');
    assert.ok(init.body.result.capabilities.tools);
    assert.match(init.body.result.instructions, /untrusted data/);
    const list = await call('POST', '/mcp', { body: rpc(2, 'tools/list'), headers: { Authorization: 'Bearer good', 'MCP-Protocol-Version': '2025-11-25' } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.result.tools.map((tool: { name: string }) => tool.name), ['list_commands']);
    assert.equal(list.body.result.tools[0].annotations.readOnlyHint, true);
});

test('tools/call maps outcomes and passes the principal; missing scope is a 403 step-up challenge', async () => {
    calls.length = 0;
    const ok = await call('POST', '/mcp', { body: rpc(3, 'tools/call', { name: 'list_commands', arguments: { limit: 5 } }), headers: { Authorization: 'Bearer good' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body.result.content[0].text), { result: { commands: ['!hi'] }, charged: 1 });
    assert.equal(ok.body.result.isError, undefined);
    const { stillAuthorized, ...principal } = calls[0].principal as Record<string, unknown>;
    assert.equal(typeof stillAuthorized, 'function', 'writes re-check the connection right before they apply');
    assert.equal(await (stillAuthorized as () => Promise<boolean>)(), true);
    assert.deepEqual({ ...calls[0], principal }, { name: 'list_commands', args: { limit: 5 }, principal: { requesterId: '111', channelId: '222',
        sessionId: 'session-1', clientId: identity.client_id, clientName: 'Claude', scopes: ['channel:read'] } });
    const unknown = await call('POST', '/mcp', { body: rpc(4, 'tools/call', { name: 'nope' }), headers: { Authorization: 'Bearer good' } });
    assert.equal(unknown.body.result.isError, true);
    assert.match(unknown.body.result.content[0].text, /\(unknown_tool\)$/);
    const step = await call('POST', '/mcp', { body: rpc(5, 'tools/call', { name: 'create_command', arguments: {} }), headers: { Authorization: 'Bearer good' } });
    assert.equal(step.status, 403);
    assert.equal(step.headers['www-authenticate'], `Bearer realm="dima", error="insufficient_scope", scope="channel:read channel:write", resource_metadata="${META}"`);
    assert.equal(calls.length, 2, 'the refused call never ran');
    assert.equal((await call('POST', '/mcp', { body: rpc(6, 'tools/call', { name: 'create_command', arguments: {} }), headers: { Authorization: 'Bearer writer' } })).status, 200);
});

test('only POST, bounded bodies, CORS preflight, rate limits per IP and per token', async () => {
    assert.equal((await call('GET', '/mcp', { headers: { Authorization: 'Bearer good' } })).status, 405);
    assert.equal((await call('DELETE', '/mcp')).status, 405);
    const preflight = await call('OPTIONS', '/mcp', { headers: { Origin: 'http://localhost:6274' } });
    assert.equal(preflight.status, 204);
    assert.match(String(preflight.headers['access-control-allow-headers']), /MCP-Protocol-Version/);
    assert.match(String(preflight.headers['access-control-expose-headers']), /WWW-Authenticate/);
    const big = await call('POST', '/mcp', { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300_000) } }), headers: { Authorization: 'Bearer good' } });
    assert.equal(big.status, 413);
    buckets.length = 0;
    await call('POST', '/mcp', { body: rpc(7, 'ping'), headers: { Authorization: 'Bearer good' } });
    assert.deepEqual(buckets, ['mcp:127.0.0.1', 'mcp-token:h:good']);
    limited = 'mcp-token:h:good';
    const slow = await call('POST', '/mcp', { body: rpc(8, 'ping'), headers: { Authorization: 'Bearer good' } });
    assert.equal(slow.status, 429);
    assert.equal(slow.headers['retry-after'], '60');
    limited = '';
});

test('batches: every message counts against the IP and token limits; oversized batches are refused; parallel calls all run', async () => {
    buckets.length = 0;
    const batch = await call('POST', '/mcp', { body: [1, 2, 3].map((id) => rpc(id, 'ping')), headers: { Authorization: 'Bearer good' } });
    assert.equal(batch.status, 200);
    assert.deepEqual(buckets, ['mcp:127.0.0.1', 'mcp:127.0.0.1x2', 'mcp-token:h:goodx3']);
    const huge = await call('POST', '/mcp', { body: Array.from({ length: 21 }, (_, id) => rpc(id + 1, 'ping')), headers: { Authorization: 'Bearer good' } });
    assert.equal(huge.status, 400);
    assert.equal(huge.body.error.code, -32600);
    calls.length = 0;
    const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        call('POST', '/mcp', { body: rpc(100 + i, 'tools/call', { name: 'list_commands', arguments: {} }), headers: { Authorization: 'Bearer good' } })));
    assert.deepEqual(parallel.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    assert.equal(calls.length, 6);
});
