/**
 * CIMD resolver: shape, SSRF guard (every blocked range, mapped IPv6, pinned TLS), response limits, document rules,
 * cache TTLs, negative cache, denylist, Redis failures, in-flight cap, fetch budgets (shared, per source, recognized
 * apps) and coalesced fetches. No request leaves 127.0.0.1:
 * DNS is injected and every vetted address is dialed as a local TLS server with a throwaway self-signed certificate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import type { TLSSocket } from 'node:tls';

const store = new Map<string, { value: string; ex?: number }>();
const deny = new Set<string>();
const faults = { down: false, cache: false, deny: false, hang: false };
const redisFake = {
    get: async (key: string) => {
        if (faults.hang) return new Promise<never>(() => {});
        if (faults.cache) throw new Error('cache down');
        return store.get(key)?.value ?? null;
    },
    set: async (key: string, value: string, options?: { EX?: number }) => {
        if (faults.cache) throw new Error('cache down');
        store.set(key, { value, ex: options?.EX });
        return 'OK';
    },
    sIsMember: async (key: string, member: string) => {
        if (faults.deny) throw new Error('deny down');
        return key === 'oauth:cimd:deny' && deny.has(member) ? 1 : 0;
    }
};
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => {
    if (faults.down) throw new Error('redis down');
    return redisFake;
} } });
const { OAuthError } = await import('./catalog.js');
const { RECOGNIZED_CIMD_CLIENTS, __setCimdFetcherForTests, __setCimdNetworkForTests, isCimdClientDenied,
    isCimdClientId, resolveCimdClient } = await import('./cimd.js');

const HOST = 'app.cimd.test';
const PUBLIC_V4 = '8.8.8.8';
const url = (path: string, host = HOST) => `https://${host}/${path}`;
const docKey = (id: string) => `oauth:cimd:doc:${sha(id)}`;
const failKey = (id: string) => `oauth:cimd:fail:${sha(id)}`;
/** service.ts `hash`: the documented key format. */
const sha = (value: string) => createHash('sha256').update(value).digest('base64url');
const document = (clientId: string, extra: Record<string, unknown> = {}) => ({ client_id: clientId,
    client_name: 'Fixture App', redirect_uris: ['https://app.cimd.test/callback'], ...extra });

type Route = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Route>();
const hits: { path: string; headers: IncomingHttpHeaders; servername: unknown }[] = [];
const dns = new Map<string, string[]>();
const dialed: string[] = [];
const resolved: string[] = [];
const json = (body: unknown, headers: Record<string, string> = {}): Route => (_req, res) => {
    const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
    res.end(text);
};
/** Any `/c/...` path serves a valid document for itself. */
const echo: Route = (req, res) => json(document(`https://${String(req.headers.host).split(':')[0]}${req.url}`))(req, res);

let certDir = '', cert = '', port = 0;
let server: ReturnType<typeof createServer>;
before(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'cimd-test-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '2', '-subj', `/CN=${HOST}`,
        '-addext', `subjectAltName=DNS:${HOST},DNS:*.cimd.test`], { stdio: 'ignore' });
    cert = readFileSync(join(certDir, 'cert.pem'), 'utf8');
    server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert }, (req, res) => {
        hits.push({ path: req.url ?? '', headers: req.headers, servername: (req.socket as TLSSocket).servername });
        const route = routes.get(req.url ?? '') ?? (req.url?.startsWith('/c/') ? echo : undefined);
        if (route) route(req, res); else res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
});
after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(certDir, { recursive: true, force: true });
    __setCimdFetcherForTests(null);
    __setCimdNetworkForTests(null);
});

function useNetwork(overrides: NonNullable<Parameters<typeof __setCimdNetworkForTests>[0]> = {}) {
    __setCimdNetworkForTests({
        resolve: async hostname => { resolved.push(hostname); return dns.get(hostname) ?? []; },
        // Never dial what DNS said: every vetted address goes to the local server.
        dial: address => { dialed.push(address); return '127.0.0.1'; },
        port, ca: cert, timeoutMs: 1500, dnsTimeoutMs: 300, redisTimeoutMs: 150, ...overrides
    });
}
beforeEach(() => {
    store.clear(); deny.clear(); routes.clear(); dns.clear();
    hits.length = dialed.length = resolved.length = 0;
    Object.assign(faults, { down: false, cache: false, deny: false, hang: false });
    dns.set(HOST, [PUBLIC_V4]);
    __setCimdFetcherForTests(null);
    useNetwork();
});

async function refused(id: string, cause?: string | RegExp, signal?: AbortSignal, source?: string[]): Promise<void> {
    const error = await resolveCimdClient(id, { signal, source }).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof OAuthError, `${id}: expected OAuthError, got ${String(error)}`);
    assert.equal(error.code, 'invalid_client', id);
    if (cause !== undefined) {
        const reason = String((error as Error).cause);
        if (typeof cause === 'string') assert.equal(reason, cause, id); else assert.match(reason, cause, id);
    }
}
type Fetched = { status: number; headers: Record<string, string>; body: string };
const hooked = (respond: (url: string) => Fetched | Promise<Fetched>) => {
    const calls: string[] = [];
    __setCimdFetcherForTests(async target => { calls.push(target); return respond(target); });
    return calls;
};
const ok = (body: unknown, headers: Record<string, string> = {}): Fetched => ({ status: 200,
    headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('isCimdClientId accepts canonical https URLs with a path on a DNS name', () => {
    for (const value of ['https://claude.ai/oauth/mcp-client.json', 'https://app.cimd.test/c', 'https://a.b.example/x/y.json',
        'https://xn--bcher-kva.example/client', 'https://sub-1.app.co.uk/client/', `https://example.com/${'a'.repeat(512 - 20)}`]) {
        assert.equal(isCimdClientId(value), true, value);
    }
});

test('isCimdClientId refuses everything else without I/O', () => {
    const bad: unknown[] = [undefined, null, 42, {}, '', 'dima-desktop', 'http://app.cimd.test/c', 'https://app.cimd.test',
        'https://app.cimd.test/', `https://example.com/${'a'.repeat(512 - 19)}`, 'https://app.cimd.test/c?x=1',
        'https://app.cimd.test/c?', 'https://app.cimd.test/c#f', 'https://app.cimd.test/c#', 'https://user@app.cimd.test/c',
        'https://user:pw@app.cimd.test/c', 'https://@app.cimd.test/c', 'https://app.cimd.test:8443/c',
        'https://app.cimd.test:443/c', 'https://127.0.0.1/c', 'https://[::1]/c', 'https://[2606:4700::1111]/c',
        'https://0x7f.1/c', 'https://2130706433/c', 'https://1.2.3/c', 'https://localhost/c', 'https://foo.localhost/c',
        'https://printer.local/c', 'https://svc.internal/c', 'https://1.0.0.127.in-addr.arpa/c', 'https://mongodb/c',
        'https://app.cimd.test./c', 'https://APP.cimd.test/c', 'https://app.cimd.test/a/../c', 'https://app.cimd.test/./c',
        'https://app.cimd.test/%2e%2e/c', 'https://app..cimd.test/c', 'https://-app.cimd.test/c', 'https://app_x.cimd.test/c',
        'https://bücher.example/c', 'https://app.cimd.test\\c', ' https://app.cimd.test/c', 'https://app.cimd.test/c ',
        'ftp://app.cimd.test/c', 'https://app.123/c'];
    for (const value of bad) assert.equal(isCimdClientId(value), false, String(value));
});

test('success over TLS: pinned to the vetted address, SNI kept, identity JSON requested, fields trimmed to the contract', async () => {
    const id = url('client.json');
    routes.set('/client.json', json(document(id, { client_name: '  Fixture App  ', logo_uri: 'https://evil.example/logo.png',
        client_uri: 'https://evil.example', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], redirect_uris: ['https://app.cimd.test/callback', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb',
            'http://localhost:3000/cb', 'https://app.cimd.test/callback', 'https://app.cimd.test/cb?mode=mcp'] })));
    const client = await resolveCimdClient(id);
    assert.deepEqual(client, { client_id: id, client_name: 'Fixture App', document_host: HOST, recognized: false,
        redirect_uris: ['https://app.cimd.test/callback', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb',
            'http://localhost:3000/cb', 'https://app.cimd.test/cb?mode=mcp'] });
    assert.deepEqual(resolved, [HOST]);
    assert.deepEqual(dialed, [PUBLIC_V4]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].servername, HOST);
    assert.equal(hits[0].headers.host, `${HOST}:${port}`);
    assert.equal(hits[0].headers.accept, 'application/json');
    assert.equal(hits[0].headers['accept-encoding'], 'identity');
    // Cached for the default 300 s, without `recognized`; the second call does no I/O.
    assert.deepEqual(store.get(docKey(id)), { value: JSON.stringify({ client_id: id, client_name: 'Fixture App',
        redirect_uris: client.redirect_uris, document_host: HOST }), ex: 300 });
    assert.deepEqual(await resolveCimdClient(id), client);
    assert.equal(hits.length, 1);
});

test('certificate checks stay on: wrong hostname and untrusted issuer are refused', async () => {
    dns.set('app.other.example', [PUBLIC_V4]);
    await refused(url('c/x', 'app.other.example'), 'network ERR_TLS_CERT_ALTNAME_INVALID');
    useNetwork({ ca: undefined });
    await refused(url('c/y'), /^network (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/);
    assert.equal(hits.length, 0);
});

test('every reserved range, mixed answers and empty DNS are refused before any connection', async () => {
    const blocked = ['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.254',
        '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1',
        '198.18.0.1', '198.19.255.254', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.250', '240.0.0.1',
        '255.255.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '100::1',
        '2001:db8::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:1ff::1', '2002:c000:204::1',
        '64:ff9b::808:808', '64:ff9b::8.8.8.8', '64:ff9b:1::1', '3fff::1', '5f00::1', '4000::1', '::ffff:127.0.0.1',
        '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::FFFF:192.168.0.1', '::127.0.0.1', '::8.8.8.8',
        '::ffff:0:8.8.8.8', 'fe80::1%eth0', 'not-an-ip'];
    let index = 0;
    for (const address of blocked) {
        const host = `b${index++}.cimd.test`;
        dns.set(host, [address]);
        await refused(url('c/1', host), 'non-public address');
    }
    dns.set('mixed.cimd.test', [PUBLIC_V4, '2606:4700:4700::1111', '10.0.0.1']);
    await refused(url('c/1', 'mixed.cimd.test'), 'non-public address');
    dns.set('empty.cimd.test', []);
    await refused(url('c/1', 'empty.cimd.test'), 'dns empty');
    assert.equal(hits.length, 0);
    assert.equal(dialed.length, 0);
});

test('public unicast next to the reserved ranges is allowed; mapped IPv6 dials its IPv4', async () => {
    const allowed = ['9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1',
        '192.0.1.1', '192.167.255.255', '198.17.255.255', '198.20.0.1', '223.255.255.254', '2606:4700:4700::1111',
        '2001:200::1', '2001:4860:4860::8888', '2003::1'];
    let index = 0;
    for (const address of allowed) {
        const host = `p${index++}.cimd.test`;
        dns.set(host, [address]);
        assert.equal((await resolveCimdClient(url('c/1', host))).document_host, host, address);
        assert.equal(dialed.at(-1), address);
    }
    dns.set('mapped.cimd.test', ['::ffff:8.8.4.4']);
    await resolveCimdClient(url('c/1', 'mapped.cimd.test'));
    assert.equal(dialed.at(-1), '8.8.4.4');
    // Both families vetted: the IPv4 address is offered first.
    dns.set('dual.cimd.test', ['2606:4700:4700::1111', '1.1.1.1']);
    await resolveCimdClient(url('c/1', 'dual.cimd.test'));
    assert.deepEqual(dialed.slice(-2), ['1.1.1.1', '2606:4700:4700::1111']);
});

test('DNS timeout, redirects, status, size, type and encoding are refused', async () => {
    useNetwork({ resolve: () => new Promise<string[]>(() => {}), dnsTimeoutMs: 100 });
    await refused(url('slow-dns'), 'dns timeout');
    useNetwork();
    routes.set('/moved', (_req, res) => res.writeHead(302, { location: '/c/target' }).end());
    await refused(url('moved'), 'redirect');
    assert.deepEqual(hits.map(hit => hit.path), ['/moved']);
    await refused(url('missing'), 'status 404');
    routes.set('/error', (_req, res) => res.writeHead(500, { 'content-type': 'application/json' }).end('{}'));
    await refused(url('error'), 'status 500');
    const exact = (target: string, size: number) => {
        const base = JSON.stringify(document(target));
        return base.slice(0, -1) + ' '.repeat(size - Buffer.byteLength(base)) + '}';
    };
    routes.set('/limit', json(exact(url('limit'), 32 * 1024)));
    assert.equal((await resolveCimdClient(url('limit'))).client_id, url('limit'));
    routes.set('/declared', json(exact(url('declared'), 32 * 1024 + 1)));
    await refused(url('declared'), 'too large');
    routes.set('/chunked', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        for (let i = 0; i < 10; i++) res.write(' '.repeat(4096));
        res.end('{}');
    });
    await refused(url('chunked'), 'too large');
    for (const [path, type] of [['html', 'text/html'], ['jsonp', 'application/jsonp'], ['text', 'text/plain; charset=utf-8'],
        ['ld', 'application/ld+json']]) {
        routes.set(`/${path}`, json(document(url(path)), { 'content-type': type }));
        await refused(url(path), 'content type');
    }
    routes.set('/notype', (_req, res) => res.writeHead(200).end(JSON.stringify(document(url('notype')))));
    await refused(url('notype'), 'content type');
    routes.set('/params', json(document(url('params')), { 'content-type': 'Application/JSON; charset=utf-8' }));
    assert.equal((await resolveCimdClient(url('params'))).client_id, url('params'));
    routes.set('/gzip', json(document(url('gzip')), { 'content-encoding': 'gzip' }));
    await refused(url('gzip'), 'encoding');
    routes.set('/identity', json(document(url('identity')), { 'content-encoding': 'identity' }));
    assert.equal((await resolveCimdClient(url('identity'))).client_id, url('identity'));
    routes.set('/latin1', json(Buffer.from([0x7b, 0xff, 0x7d])));
    await refused(url('latin1'), 'not utf-8');
});

test('total timeout and caller abort stop the fetch; only the timeout is negatively cached', async () => {
    routes.set('/slow', () => { /* never answers */ });
    useNetwork({ timeoutMs: 200 });
    let started = Date.now();
    await refused(url('slow'), 'timeout');
    assert.ok(Date.now() - started < 1000);
    assert.equal(store.get(failKey(url('slow')))?.ex, 60);
    useNetwork();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    started = Date.now();
    routes.set('/slow2', () => { /* never answers */ });
    await refused(url('slow2'), 'aborted', controller.signal);
    assert.ok(Date.now() - started < 1000);
    assert.equal(store.has(failKey(url('slow2'))), false);
    const calls = hooked(target => ok(document(target)));
    await refused(url('pre'), 'aborted', AbortSignal.abort());
    assert.deepEqual(calls, []);
    // A hook that ignores the signal is still cut off.
    __setCimdFetcherForTests(() => new Promise<Fetched>(resolve => setTimeout(() => resolve(ok(document(url('hang')))), 300)));
    const late = new AbortController();
    setTimeout(() => late.abort(), 20);
    await refused(url('hang'), 'aborted', late.signal);
    await new Promise(resolve => setTimeout(resolve, 320)); // let the slot go
    // Aborted while the denylist is read: DNS that rejects afterwards must not become an unhandled rejection.
    __setCimdFetcherForTests(null);
    useNetwork({ resolve: () => new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('late')), 20)) });
    const racing = new AbortController();
    const result = resolveCimdClient(url('c/race'), { signal: racing.signal }).then(() => null, (caught: unknown) => caught);
    racing.abort();
    assert.equal(String(((await result) as Error).cause), 'aborted');
    await new Promise(resolve => setTimeout(resolve, 50));
});

test('document rules', async () => {
    const id = url('doc');
    const cases: [string, unknown][] = [
        ['json', '{not json'], ['not an object', []], ['not an object', null], ['not an object', '"text"'],
        ['client_id mismatch', document(`${id}/`)], ['client_id mismatch', document(url('other'))],
        ['client_id mismatch', { ...document(id), client_id: undefined }],
        ['client_name', { ...document(id), client_name: undefined }], ['client_name', document(id, { client_name: '' })],
        ['client_name', document(id, { client_name: '   ' })], ['client_name', document(id, { client_name: 7 })],
        ['client_name', document(id, { client_name: 'x'.repeat(81) })],
        ['client_name', document(id, { client_name: 'App\nName' })], ['client_name', document(id, { client_name: 'App\u0007' })],
        ['client_name', document(id, { client_name: 'App\u0085' })],
        ...['‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩',
            '﻿', '​', ' ', '\ud800', ''].map(char =>
            ['client_name', document(id, { client_name: `Good${char}App` })] as [string, unknown]),
        ['client_secret', document(id, { client_secret: 's' })],
        ['client_secret', document(id, { client_secret_expires_at: 0 })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_method: 'client_secret_basic' })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_method: null })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_method: 'private_key_jwt' })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_method: 'none',
            token_endpoint_auth_methods_supported: ['private_key_jwt'] })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_methods_supported: 'none' })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_method: 'client_secret_post',
            token_endpoint_auth_methods_supported: ['none'] })],
        ['token_endpoint_auth_method', document(id, { token_endpoint_auth_method: 7, token_endpoint_auth_methods_supported: ['none'] })],
        ['grant_types', document(id, { grant_types: ['client_credentials'] })],
        ['grant_types', document(id, { grant_types: 'authorization_code' })],
        ['grant_types', document(id, { grant_types: ['authorization_code', 7] })],
        ['response_types', document(id, { response_types: ['token'] })],
        ['response_types', document(id, { response_types: null })],
        ['redirect_uris', { ...document(id), redirect_uris: undefined }], ['redirect_uris', document(id, { redirect_uris: [] })],
        ['redirect_uris', document(id, { redirect_uris: 'https://app.cimd.test/cb' })],
        ['redirect_uris', document(id, { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.cimd.test/${i}`) })],
        ...[7, '', 'http://app.cimd.test/cb', 'https://user@app.cimd.test/cb', 'https://app.cimd.test/cb#x',
            'https://app.cimd.test/cb#', 'http://127.0.0.1/cb?x=1', 'http://127.0.0.1/cb#x', 'http://user@127.0.0.1/cb',
            'http://127.1/cb', 'http://10.0.0.1/cb', 'http://localhost.evil.example/cb', 'cursor://anysphere/cb',
            'javascript:alert(1)', 'https://APP.cimd.test/cb', 'https://app.cimd.test', `https://app.cimd.test/${'a'.repeat(500)}`]
            .map(uri => ['redirect_uri', document(id, { redirect_uris: ['https://app.cimd.test/ok', uri] })] as [string, unknown])
    ];
    for (const [cause, body] of cases) {
        hooked(() => ok(body));
        store.clear();
        await refused(id, cause);
    }
    hooked(() => ok(document(id, { client_name: 'é'.repeat(80), redirect_uris: Array.from({ length: 10 },
        (_, i) => `https://app.cimd.test/${i}`) })));
    store.clear();
    const client = await resolveCimdClient(id);
    assert.equal(client.client_name, 'é'.repeat(80));
    assert.equal(client.redirect_uris.length, 10);
});

test('real vendor document shapes validate (ChatGPT plural auth methods, VS Code port and extra grant)', async () => {
    // Copied from https://chatgpt.com/oauth/client.json and https://vscode.dev/oauth/client-metadata.json (2026-11-14).
    const chatgpt = { client_id: 'https://chatgpt.com/oauth/client.json', client_uri: 'https://chatgpt.com/',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], grant_types: ['authorization_code', 'refresh_token',
            'urn:ietf:params:oauth:grant-type:jwt-bearer'], response_types: ['code'], client_name: 'ChatGPT',
        logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png', token_endpoint_auth_signing_alg: 'RS256',
        jwks_uri: 'https://chatgpt.com/oauth/jwks.json' };
    const vscode = { client_name: 'Visual Studio Code', logo_uri: 'https://code.visualstudio.com/assets/branding/code-stable.png',
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
        response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native',
        client_id: 'https://vscode.dev/oauth/client-metadata.json', client_uri: 'https://vscode.dev/product',
        redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'] };
    for (const body of [chatgpt, vscode]) {
        hooked(() => ok(body, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' }));
        assert.deepEqual(await resolveCimdClient(body.client_id), { client_id: body.client_id, client_name: body.client_name,
            redirect_uris: body.redirect_uris, document_host: new URL(body.client_id).hostname, recognized: true });
    }
});

test('client_ids on our own domain are refused before any I/O', async () => {
    const calls = hooked(target => ok(document(target)));
    process.env.PUBLIC_API_URL = 'https://api.dima-staging.example';
    for (const id of ['https://domdimabot.com/client.json', 'https://mcp.domdimabot.com/client.json',
        'https://api.domdimabot.com/v1/files/x.json', 'https://api.dima-staging.example/client.json']) {
        await refused(id, 'own host');
    }
    delete process.env.PUBLIC_API_URL;
    assert.deepEqual(calls, []);
    assert.equal((await resolveCimdClient('https://notdomdimabot.com/client.json')).document_host, 'notdomdimabot.com');
});

test('Cache-Control sets the TTL; failures are negatively cached for 60 s', async () => {
    const cases: [string | undefined, number | undefined][] = [[undefined, 300], ['max-age=120', 120], ['public, max-age=3600', 3600],
        ['max-age=999999999999', 86_400], ['max-age="60"', 60], ['public', 300], ['max-age=0', undefined],
        ['max-age=abc', undefined], ['no-store', undefined], ['no-cache', undefined], ['private', undefined],
        ['max-age=600, no-store', undefined], ['no-cache="set-cookie", max-age=600', undefined], ['Private, Max-Age=600', undefined]];
    let index = 0;
    for (const [header, ttl] of cases) {
        const id = url(`ttl/${index++}`);
        hooked(target => ok(document(target), header === undefined ? {} : { 'Cache-Control': header }));
        await resolveCimdClient(id);
        assert.equal(store.get(docKey(id))?.ex, ttl, String(header));
    }
    const id = url('flaky');
    const calls = hooked(() => ({ status: 500, headers: {}, body: '' }));
    await refused(id, 'status 500');
    assert.deepEqual(store.get(failKey(id)), { value: '1', ex: 60 });
    assert.equal(calls.length, 1);
    const retry = hooked(target => ok(document(target)));
    await refused(id, 'recent failure');
    assert.equal(retry.length, 0);
    store.delete(failKey(id));
    assert.equal((await resolveCimdClient(id)).client_id, id);
    assert.equal(retry.length, 1);
});

test('a corrupt or widened cache entry is refetched; a cached client wins over a stale failure marker', async () => {
    const id = url('cached');
    const calls = hooked(target => ok(document(target)));
    store.set(docKey(id), { value: '{broken' });
    assert.equal((await resolveCimdClient(id)).client_name, 'Fixture App');
    store.set(docKey(id), { value: JSON.stringify({ client_id: id, client_name: 'Evil‮', redirect_uris: ['https://x.example/'],
        document_host: HOST }) });
    assert.equal((await resolveCimdClient(id)).client_name, 'Fixture App');
    assert.equal(calls.length, 2);
    store.set(failKey(id), { value: '1' });
    assert.equal((await resolveCimdClient(id)).client_name, 'Fixture App');
    assert.equal(calls.length, 2);
});

test('denylist: exact client_id or host, Redis failure fails closed, resolve refuses before fetching', async () => {
    const id = url('c/listed');
    assert.equal(await isCimdClientDenied(id), false);
    deny.add(id);
    assert.equal(await isCimdClientDenied(id), true);
    assert.equal(await isCimdClientDenied(url('c/other')), false);
    deny.clear(); deny.add(`host:${HOST}`);
    assert.equal(await isCimdClientDenied(url('c/any')), true);
    assert.equal(await isCimdClientDenied(url('c/any', 'b.cimd.test')), false);
    assert.equal(await isCimdClientDenied('not a url'), false);
    await refused(url('c/any'), 'denied');
    assert.equal(hits.length, 0);
    deny.clear();
    faults.deny = true;
    assert.equal(await isCimdClientDenied(id), true);
    await refused(id, 'denied');
    faults.deny = false; faults.down = true;
    assert.equal(await isCimdClientDenied(id), true);
    await refused(id, 'denied');
    assert.equal(hits.length, 0);
    // A denied client is refused even when its document is cached.
    faults.down = false;
    await resolveCimdClient(id);
    deny.add(id);
    await refused(id, 'denied');
});

test('cache outage (errors or a hang) falls back to an uncached fetch', async () => {
    const id = url('c/outage');
    faults.cache = true;
    assert.equal((await resolveCimdClient(id)).client_id, id);
    assert.equal(store.size, 0);
    assert.equal(hits.length, 1);
    faults.cache = false; faults.hang = true;
    const started = Date.now();
    assert.equal((await resolveCimdClient(id)).client_id, id);
    assert.ok(Date.now() - started < 1000);
    assert.equal(store.size, 0);
    assert.equal(hits.length, 2);
    // A failing fetch during the outage is still refused, without a negative entry.
    faults.hang = false; faults.cache = true;
    await refused(url('missing'), 'status 404');
    faults.cache = false;
    assert.equal(store.size, 0);
});

/** Lets queued microtasks and immediates run until `condition` holds; fails instead of spinning forever. */
async function until(condition: () => boolean) {
    for (let i = 0; i < 1000 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(condition(), 'condition never became true');
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
/** A fetcher hook whose answers the test releases by hand. */
function held() {
    const calls: string[] = [], answers: ((value: Fetched) => void)[] = [];
    __setCimdFetcherForTests(target => { calls.push(target); return new Promise<Fetched>(resolve => answers.push(resolve)); });
    return { calls, answer: (index: number, value?: Fetched) => answers[index](value ?? ok(document(calls[index]))) };
}

test('in-flight cap: unknown client_ids get 6 slots, the 2 reserved ones stay free for recognized apps', async () => {
    const { calls, answer } = held();
    const running = Array.from({ length: 6 }, (_, i) => resolveCimdClient(url(`cap/${i}`)));
    await until(() => calls.length === 6);
    await refused(url('cap/6'), 'busy');
    assert.equal(store.has(failKey(url('cap/6'))), false, 'a local limit is never negatively cached');
    const [first, second, third] = RECOGNIZED_CIMD_CLIENTS;
    const known = [resolveCimdClient(first), resolveCimdClient(second)];
    await until(() => calls.length === 8);
    await refused(third, 'busy', undefined);
    assert.equal(calls.length, 8);
    calls.forEach((_target, i) => answer(i));
    assert.equal((await Promise.all(running)).length, 6);
    assert.deepEqual((await Promise.all(known)).map(client => client.recognized), [true, true]);
    __setCimdFetcherForTests(async target => ok(document(target)));
    assert.equal((await resolveCimdClient(url('cap/6'))).client_id, url('cap/6'));
});

test('per-source budget: 10 real fetches per source per minute; refusals cost nothing and are not negatively cached', async () => {
    const calls = hooked(target => ok(document(target), { 'cache-control': 'no-store' }));
    const attacker = ['203.0.113.7'];
    for (let i = 0; i < 10; i++) await resolveCimdClient(url(`junk/${i}`), { source: attacker });
    await refused(url('junk/10'), 'source budget', undefined, attacker);
    assert.equal(store.has(failKey(url('junk/10'))), false);
    for (let i = 11; i < 60; i++) await refused(url(`junk/${i}`), 'source budget', undefined, attacker);
    assert.equal(calls.length, 10, 'refused before any fetch');
    // Another source, and callers without a request, still fetch; refusals took none of the shared budget.
    for (let n = 1; n <= 5; n++) {
        for (let i = 0; i < 10; i++) await resolveCimdClient(url(`ok/${n}/${i}`), { source: [`198.51.100.${n}`] });
    }
    assert.equal(calls.length, 60);
    await refused(url('ok/6'), 'fetch budget', undefined, ['198.51.100.6']);
});

test('per-source budget: cached resolutions are free, and every key of a request is charged', async () => {
    const id = url('cached-app');
    const calls = hooked(target => ok(document(target), target === id ? {} : { 'cache-control': 'no-store' }));
    await resolveCimdClient(id, { source: ['198.51.100.1'] });
    const exhausted = ['203.0.113.7'];
    for (let i = 0; i < 10; i++) await resolveCimdClient(url(`x/${i}`), { source: exhausted });
    await refused(url('x/10'), 'source budget', undefined, exhausted);
    assert.equal((await resolveCimdClient(id, { source: exhausted })).client_id, id, 'a cache hit needs no budget');
    assert.equal(calls.filter(target => target === id).length, 1);
    // A pair is charged on both keys: each one alone then has 9 left.
    const pair = ['conflict:real:192.0.2.1', 'conflict:cf:192.0.2.2'];
    await resolveCimdClient(url('pair/0'), { source: pair });
    for (let i = 1; i < 10; i++) await resolveCimdClient(url(`pair/${i}`), { source: [pair[1]] });
    await refused(url('pair/10'), 'source budget', undefined, [pair[1]]);
    // Every key must have budget: rotating the forged half of a conflict pair keeps hitting the true one.
    await refused(url('pair/11'), 'source budget', undefined, ['conflict:real:192.0.2.9', pair[1]]);
    await resolveCimdClient(url('pair/12'), { source: [pair[0]] });
});

test('recognized apps have their own per-minute budget, so made-up client_ids cannot starve them', async () => {
    hooked(target => ok(document(target), { 'cache-control': 'no-store' }));
    for (let i = 0; i < 60; i++) await resolveCimdClient(url(`junk/${i}`));
    await refused(url('junk/60'), 'fetch budget');
    const known = RECOGNIZED_CIMD_CLIENTS[0];
    for (let i = 0; i < 30; i++) assert.equal((await resolveCimdClient(known)).recognized, true);
    await refused(known, 'recognized fetch budget');
    assert.equal(store.has(failKey(known)), false);
    await refused(url('junk/61'), 'fetch budget');
});

test('concurrent resolutions of one client_id share one fetch, and its source is charged once', async () => {
    const id = url('shared'), source = ['203.0.113.7'];
    const calls: string[] = [];
    let release: (value: Fetched) => void = () => assert.fail('not fetched yet');
    // Only `id` is held until the test answers it; anything else answers at once, uncacheable.
    __setCimdFetcherForTests(target => {
        calls.push(target);
        const answer = ok(document(target), { 'cache-control': 'no-store' });
        return target === id ? new Promise<Fetched>(resolve => { release = () => resolve(answer); }) : Promise.resolve(answer);
    });
    const shared = () => calls.filter(target => target === id).length;
    const waiters = Array.from({ length: 20 }, () => resolveCimdClient(id, { source }));
    await until(() => shared() === 1);
    await settle();
    // A source with no budget left may still join a fetch that is already running.
    const exhausted = ['198.51.100.9'];
    for (let i = 0; i < 10; i++) await resolveCimdClient(url(`spend/${i}`), { source: exhausted });
    await refused(url('spend/10'), 'source budget', undefined, exhausted);
    const joiner = resolveCimdClient(id, { source: exhausted });
    await settle();
    release(ok(document(id)));
    const results = await Promise.all([...waiters, joiner]);
    assert.ok(results.every(client => client.client_id === id));
    assert.equal(shared(), 1, 'one network fetch for 21 resolutions');
    // The 20 waiters cost their source one fetch: 9 more are allowed.
    for (let i = 0; i < 9; i++) await resolveCimdClient(url(`more/${i}`), { source });
    await refused(url('more/9'), 'source budget', undefined, source);
    // Once settled, a fetch is not reused: sequential resolutions of an uncacheable document each fetch.
    await resolveCimdClient(url('seq'));
    await resolveCimdClient(url('seq'));
    assert.equal(calls.filter(target => target === url('seq')).length, 2);
});

test('a shared fetch failure reaches every waiter once and is negatively cached once', async () => {
    const { calls, answer } = held();
    const id = url('shared-fail');
    const waiters = Array.from({ length: 5 }, () => refused(id, 'status 500'));
    await until(() => calls.length === 1);
    await settle();
    answer(0, { status: 500, headers: {}, body: '' });
    await Promise.all(waiters);
    assert.equal(calls.length, 1);
    assert.deepEqual(store.get(failKey(id)), { value: '1', ex: 60 });
});

test('one waiter aborting leaves the shared fetch running; when every waiter leaves it is aborted, not cached', async () => {
    routes.set('/late', (req, res) => { setTimeout(() => json(document(url('late')))(req, res), 150); });
    const early = new AbortController();
    setTimeout(() => early.abort(), 30);
    const [, stayed] = await Promise.all([refused(url('late'), 'aborted', early.signal), resolveCimdClient(url('late'))]);
    assert.equal(stayed.client_id, url('late'));
    assert.equal(hits.length, 1, 'both waited on one request');
    routes.set('/never', () => { /* never answers */ });
    useNetwork({ timeoutMs: 300 });
    const a = new AbortController(), b = new AbortController();
    const both = [refused(url('never'), 'aborted', a.signal), refused(url('never'), 'aborted', b.signal)];
    await until(() => hits.some(hit => hit.path === '/never'));
    a.abort();
    await settle();
    b.abort();
    await Promise.all(both);
    await new Promise(resolve => setTimeout(resolve, 400)); // past the fetch timeout
    assert.equal(store.has(failKey(url('never'))), false, 'aborted, so it never timed out into a negative entry');
    // The next resolution starts a fresh fetch instead of joining the aborted one.
    routes.set('/never', json(document(url('never'))));
    assert.equal((await resolveCimdClient(url('never'))).client_id, url('never'));
});

test('fetch budget: at most 60 document fetches per minute', async () => {
    const calls = hooked(target => ok(document(target), { 'cache-control': 'no-store' }));
    for (let i = 0; i < 60; i++) await resolveCimdClient(url('budget'));
    await refused(url('budget'), 'fetch budget');
    assert.equal(calls.length, 60);
    assert.equal(store.has(failKey(url('budget'))), false);
    hooked(target => ok(document(target)));
    assert.equal((await resolveCimdClient(url('budget'))).client_id, url('budget'));
});

test('fetcher hook gets the exact URL, its headers are case-insensitive and its result is fully validated', async () => {
    const id = url('hook/client.json');
    const calls = hooked(target => ({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(document(target)) }));
    assert.equal((await resolveCimdClient(id)).client_id, id);
    assert.deepEqual(calls, [id]);
    assert.equal(hits.length, 0);
    for (const status of [301, 302, 303, 307, 308]) {
        hooked(() => ({ status, headers: { location: url('c/x') }, body: '' }));
        store.clear();
        await refused(id, 'redirect');
    }
    hooked(() => ok(' '.repeat(32 * 1024 + 1)));
    store.clear();
    await refused(id, 'too large');
    __setCimdFetcherForTests(() => { throw new Error('boom'); });
    store.clear();
    await refused(id, 'unexpected');
});

test('recognized flag comes only from RECOGNIZED_CIMD_CLIENTS', async () => {
    for (const id of RECOGNIZED_CIMD_CLIENTS) assert.equal(isCimdClientId(id), true, id);
    assert.equal(new Set(RECOGNIZED_CIMD_CLIENTS).size, RECOGNIZED_CIMD_CLIENTS.length);
    hooked(target => ok(document(target)));
    assert.equal((await resolveCimdClient(url('unlisted'))).recognized, false);
    const listed = RECOGNIZED_CIMD_CLIENTS[0];
    if (listed) {
        const client = await resolveCimdClient(listed);
        assert.equal(client.recognized, true);
        // The cached copy never stores the flag; it is computed from the list each time.
        assert.equal(JSON.parse(store.get(docKey(listed))!.value).recognized, undefined);
    }
});
