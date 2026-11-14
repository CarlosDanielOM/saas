/**
 * OAuth Client ID Metadata Documents (CIMD): an https URL is the client_id; its JSON lists name and redirect URIs.
 * draft-ietf-oauth-client-id-metadata-document; MCP 2026-07-28 basic/authorization/client-registration.
 *
 * The fetch is the SSRF surface: we resolve DNS ourselves, refuse unless every address is public unicast, and pin the
 * TLS connection to a vetted address (SNI and certificate checks stay on the hostname). No redirects, 5 s, 32 KB,
 * identity encoding, JSON only. Every failure is OAuthError('invalid_client'); the internal reason is in `cause`
 * (never serialized by the OAuth error handler).
 */
import { createHash } from 'node:crypto';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { OAuthError } from './catalog.js';

export interface CimdClient {
    /** Exactly the document URL. */
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    /** Host of the document URL, shown on consent. */
    document_host: string;
    /** The client_id is on RECOGNIZED_CIMD_CLIENTS ("Recognized app", not "verified"). */
    recognized: boolean;
}
type StoredClient = Omit<CimdClient, 'recognized'>;
type Fetched = { status: number; headers: Record<string, string>; body: string };
type Fetcher = (url: string) => Promise<Fetched>;

/** Exact client_id URLs of known MCP apps. Each document was fetched and validated on 2026-11-14; source per entry.
 *  Not listed: Claude's `/confidential_client` (private_key_jwt only, refused here), ChatGPT/Codex per-callback ids
 *  (`chatgpt.com/oauth/<callback_id>/client.json`, opaque; sent to servers without RFC 9207 `iss`), Cursor (no CIMD). */
export const RECOGNIZED_CIMD_CLIENTS: readonly string[] = [
    // Claude (claude.ai, Desktop, mobile): the vendor-hosted document (client_name "Claude"); Anthropic's
    // claude.com/docs/connectors/building/enterprise-managed-auth.md pairs it with the /confidential_client variant.
    'https://claude.ai/oauth/mcp-oauth-client-metadata',
    // Claude Code: claude.com/docs/connectors/building/authentication.md ("its Client ID Metadata Document").
    'https://claude.ai/oauth/claude-code-client-metadata',
    // ChatGPT, stable id: developers.openai.com/plugins/build/auth.md.
    'https://chatgpt.com/oauth/client.json',
    // Codex CLI, stable id: learn.chatgpt.com/docs/extend/mcp.md.
    'https://chatgpt.com/oauth/codex/client.json',
    // VS Code (GitHub Copilot) stable and Insiders: the vendor-hosted documents (the product.json value is not public).
    'https://vscode.dev/oauth/client-metadata.json',
    'https://insiders.vscode.dev/oauth/client-metadata.json',
    // Zed: zed-industries/zed crates/context_server/src/oauth.rs `CIMD_URL`.
    'https://zed.dev/oauth/client-metadata.json',
    // goose: aaif-goose/goose crates/goose/src/oauth/mod.rs `CLIENT_METADATA_URL`.
    'https://goose-docs.ai/oauth/client-metadata.json'
];
/** Code-level kill switch, same member format as the `oauth:cimd:deny` set: an exact client_id or `host:<hostname>`. */
const DENIED_CIMD_CLIENTS: readonly string[] = [];

const MAX_ID_LENGTH = 512, MAX_BODY_BYTES = 32 * 1024, MAX_IN_FLIGHT = 8, FETCHES_PER_MINUTE = 60;
const DEFAULT_TTL = 300, MAX_TTL = 86_400, FAILURE_TTL = 60;
const DENY_KEY = 'oauth:cimd:deny';
const docKey = (id: string) => `oauth:cimd:doc:${hash(id)}`;
const failKey = (id: string) => `oauth:cimd:fail:${hash(id)}`;
// Same as service.ts `hash`; local so service.ts can import this module without a cycle.
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const USER_AGENT = 'DomDimaBot-OAuth/1 (client metadata fetch)';
// Never delegated or local-only; the address check below is the real guard, this only fails early.
const LOCAL_TLDS = new Set(['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'arpa', 'onion',
    'invalid', 'alt']);

/** Draft -03 §10: never accept a client_id on the authorization server's own domain (first parties are pre-registered). */
const isOwnHost = (host: string) => ['domdimabot.com', ...[process.env.PUBLIC_API_URL, process.env.DASHBOARD_URL]
    .flatMap(value => { try { return value ? [new URL(value).hostname] : []; } catch { return []; } })]
    .some(own => host === own || host.endsWith(`.${own}`));

const blocks = (ranges: string) => {
    const list = new BlockList();
    for (const range of ranges.split(/\s+/)) {
        const [address, prefix] = range.split('/');
        list.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
    }
    return list;
};
// IANA special-purpose registries (RFC 6890 and updates): nothing here hosts a public web server.
const BLOCKED_V4 = blocks('0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 ' +
    '192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4');
// 2001::/23 covers Teredo 2001::/32, benchmarking and ORCHID; 2002::/16 6to4; 64:ff9b::/96 and /48 NAT64;
// 3fff::/20 documentation (RFC 9637); 5f00::/16 SRv6 SIDs; fec0::/10 deprecated site-local.
const BLOCKED_V6 = blocks('::/128 ::1/128 fc00::/7 fe80::/10 fec0::/10 ff00::/8 100::/64 2001::/23 2001:db8::/32 ' +
    '2002::/16 64:ff9b::/96 64:ff9b:1::/48 3fff::/20 5f00::/16');
const GLOBAL_V6 = blocks('2000::/3');

/** Internal failure; `negative` false for our own limits and caller aborts, which say nothing about the document. */
class CimdFailure extends Error {
    constructor(reason: string, readonly negative = true) { super(reason); }
}
const invalidClient = (reason: string) => Object.assign(new OAuthError('invalid_client'), { cause: reason });

interface CimdNetwork {
    /** All A and AAAA records of the hostname. */
    resolve: (hostname: string, signal: AbortSignal) => Promise<string[]>;
    port: number;
    /** Test-only trust anchor; undefined keeps the system roots. */
    ca?: string;
    timeoutMs: number;
    dnsTimeoutMs: number;
    redisTimeoutMs: number;
    /** Tests only: the address actually dialed for a vetted one (a local server stands in for a public address). */
    dial: (address: string) => string;
}
const DEFAULT_NETWORK: CimdNetwork = { resolve: resolveDns, port: 443, timeoutMs: 5000, dnsTimeoutMs: 2000,
    redisTimeoutMs: 1000, dial: address => address };
let network = DEFAULT_NETWORK;
let fetcherOverride: Fetcher | null = null;
let inFlight = 0, windowStart = 0, windowFetches = 0;

/** Tests only: replaces the whole network fetch (DNS + TLS); limits, timeouts and validation still apply. */
export function __setCimdFetcherForTests(fetcher: Fetcher | null): void {
    fetcherOverride = fetcher;
    windowStart = windowFetches = 0;
}

/** Tests only: injected DNS, port, CA, dial target and timeouts for the real TLS path against a local server. */
export function __setCimdNetworkForTests(overrides: Partial<CimdNetwork> | null): void {
    network = overrides ? { ...DEFAULT_NETWORK, ...overrides } : DEFAULT_NETWORK;
    windowStart = windowFetches = 0;
}

/** True when the value has the shape of a CIMD client_id (https URL with a path). Does no I/O. */
export function isCimdClientId(value: unknown): value is string {
    if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) return false;
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    const labels = url.hostname.split('.'), tld = labels.at(-1) ?? '';
    // Canonical form only (href === value): one string per document, no dot segments, no explicit :443, no `?`/`#`.
    return url.protocol === 'https:' && url.href === value && !url.port && !url.username && !url.password &&
        !/[?#]/.test(value) && url.pathname !== '/' && isIP(url.hostname) === 0 && url.hostname.length <= 253 &&
        labels.length >= 2 && labels.every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) &&
        !/^\d+$/.test(tld) && !LOCAL_TLDS.has(tld);
}

/** Fetches (SSRF-guarded), validates and caches the document. Any failure or a denylisted client → OAuthError('invalid_client'). */
export async function resolveCimdClient(clientId: string, options: { signal?: AbortSignal } = {}): Promise<CimdClient> {
    if (!isCimdClientId(clientId)) throw invalidClient('shape');
    if (isOwnHost(new URL(clientId).hostname)) throw invalidClient('own host');
    if (options.signal?.aborted) throw invalidClient('aborted');
    if (await isCimdClientDenied(clientId)) throw invalidClient('denied');
    const recognized = (client: StoredClient): CimdClient =>
        ({ ...client, recognized: RECOGNIZED_CIMD_CLIENTS.includes(client.client_id) });
    const cache = await redis();
    if (cache) {
        try {
            const [stored, failed] = await timed(Promise.all([cache.get(docKey(clientId)), cache.get(failKey(clientId))]));
            if (stored) {
                // Re-validated so a corrupt or hand-written entry can never widen what the document allowed.
                try { return recognized(validateDocument(clientId, JSON.parse(stored))); } catch { /* refetch */ }
            } else if (failed) throw invalidClient('recent failure');
        } catch (error) {
            if (error instanceof OAuthError) throw error;
            // Redis outage: fetch without caching.
            return recognized((await fetchClient(clientId, options.signal, null)).client);
        }
    }
    return recognized((await fetchClient(clientId, options.signal, cache)).client);
}

/** Operator kill switch (client_id or host); checked on every authorize/token/refresh and for live CIMD sessions. */
export async function isCimdClientDenied(clientId: string): Promise<boolean> {
    if (typeof clientId !== 'string') return true;
    let host = '';
    try { host = new URL(clientId).hostname; } catch { /* exact id only */ }
    const members = host ? [clientId, `host:${host}`] : [clientId];
    if (members.some(member => DENIED_CIMD_CLIENTS.includes(member))) return true;
    try {
        const client = await timed(getDragonflyClient('OAuth'));
        const hits = await timed(Promise.all(members.map(member => client.sIsMember(DENY_KEY, member))));
        return hits.some(Boolean);
    } catch {
        return true; // fail closed: the kill switch must hold while Redis is unreachable
    }
}

type Cache = Awaited<ReturnType<typeof getDragonflyClient>>;
async function redis(): Promise<Cache | null> {
    try { return await timed(getDragonflyClient('OAuth')); } catch { return null; }
}

/** Commands queue while Redis reconnects; a bounded wait keeps an outage from hanging authorize. */
function timed<T>(promise: Promise<T>, ms = network.redisTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('redis timeout')), ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

async function fetchClient(clientId: string, signal: AbortSignal | undefined, cache: Cache | null) {
    try {
        const response = await fetchDocument(clientId, signal);
        const result = parseResponse(clientId, response);
        // Cache writes never delay or fail the answer.
        if (cache && result.ttl > 0) void timed(cache.set(docKey(clientId), JSON.stringify(result.client), { EX: result.ttl }))
            .catch(() => {});
        return result;
    } catch (error) {
        const failure = error instanceof CimdFailure ? error : new CimdFailure('unexpected');
        if (cache && failure.negative) void timed(cache.set(failKey(clientId), '1', { EX: FAILURE_TTL })).catch(() => {});
        throw invalidClient(failure.message);
    }
}

/** Takes a fetch slot (in-flight cap and per-minute budget), then fetches under one deadline and the caller's signal. */
async function fetchDocument(clientId: string, callerSignal: AbortSignal | undefined): Promise<Fetched> {
    if (inFlight >= MAX_IN_FLIGHT) throw new CimdFailure('busy', false);
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; windowFetches = 0; }
    if (windowFetches >= FETCHES_PER_MINUTE) throw new CimdFailure('fetch budget', false);
    windowFetches++; inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new CimdFailure('timeout')), network.timeoutMs);
    const onAbort = () => controller.abort(new CimdFailure('aborted', false));
    if (callerSignal?.aborted) onAbort(); else callerSignal?.addEventListener('abort', onAbort, { once: true });
    try {
        const override = fetcherOverride;
        const work = Promise.resolve().then(() => override ? override(clientId) :
            fetchOverNetwork(new URL(clientId), controller.signal));
        // The slot is held until the work itself settles, not just until we stop waiting for it.
        const release = () => { inFlight--; };
        work.then(release, release);
        return await abortable(work, controller.signal);
    } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onAbort);
    }
}

/** Settles with the promise, or rejects with the abort reason as soon as the signal fires. The promise is always
 *  observed, so its own later rejection is never unhandled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        if (signal.aborted) onAbort();
    });
}

async function fetchOverNetwork(url: URL, signal: AbortSignal): Promise<Fetched> {
    const dns = new AbortController();
    const timer = setTimeout(() => dns.abort(new CimdFailure('dns timeout')), network.dnsTimeoutMs);
    const dnsSignal = AbortSignal.any([signal, dns.signal]);
    let records: string[];
    try {
        records = await abortable(Promise.resolve().then(() => network.resolve(url.hostname, dnsSignal)), dnsSignal);
    } finally {
        clearTimeout(timer);
    }
    if (!records.length) throw new CimdFailure('dns empty');
    const addresses: string[] = [];
    for (const record of records) {
        const address = publicAddress(record);
        if (!address) throw new CimdFailure('non-public address');
        if (!addresses.includes(address)) addresses.push(address);
    }
    addresses.sort((a, b) => isIP(a) - isIP(b)); // IPv4 first: containers often have no IPv6 egress
    return httpsGet(url, addresses, signal);
}

/** c-ares, not getaddrinfo: no hosts file, cancellable, and never parks a libuv threadpool thread. */
async function resolveDns(hostname: string, signal: AbortSignal): Promise<string[]> {
    const resolver = new Resolver({ timeout: network.dnsTimeoutMs, tries: 1 });
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const records = (query: Promise<string[]>) => query.catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return [];
        throw new CimdFailure(`dns ${error.code ?? 'error'}`);
    });
    try {
        return (await Promise.all([records(resolver.resolve4(hostname)), records(resolver.resolve6(hostname))])).flat();
    } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
    }
}

/** The address to connect to when it is public unicast (IPv4-mapped IPv6 → its IPv4), else null. */
function publicAddress(ip: string): string | null {
    const family = isIP(ip);
    if (family === 4) return BLOCKED_V4.check(ip, 'ipv4') ? null : ip;
    if (family !== 6 || ip.includes('%')) return null;
    const groups = ipv6Groups(ip);
    if (!groups) return null;
    if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
        return publicAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
    }
    // IPv4-compatible ::/96 (deprecated, never routed; includes :: and ::1) and SIIT ::ffff:0:0/96.
    if (groups.slice(0, 6).every(group => group === 0) ||
        (groups.slice(0, 4).every(group => group === 0) && groups[4] === 0xffff && groups[5] === 0)) return null;
    return GLOBAL_V6.check(ip, 'ipv6') && !BLOCKED_V6.check(ip, 'ipv6') ? ip : null;
}

function ipv6Groups(ip: string): number[] | null {
    let text = ip.toLowerCase();
    const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (dotted) {
        const [a, b, c, d] = dotted.slice(1).map(Number);
        text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    if (fill < 0) return null;
    const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map(group => /^[0-9a-f]{1,4}$/.test(group) ?
        parseInt(group, 16) : NaN);
    return groups.length === 8 && groups.every(group => !Number.isNaN(group)) ? groups : null;
}

/** Connects only to the vetted addresses; TLS still verifies the certificate for the hostname (SNI = hostname). */
function httpsGet(url: URL, addresses: string[], signal: AbortSignal): Promise<Fetched> {
    const lookup = ((hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null,
        address: string | LookupAddress[], family?: number) => void) => {
        const entries = addresses.map(address => network.dial(address)).map(address => ({ address, family: isIP(address) }))
            .filter(entry => !options.family || options.family === entry.family);
        if (hostname !== url.hostname || !entries.length) {
            return callback(Object.assign(new Error('pinned lookup'), { code: 'ENOTFOUND' }), '', 0);
        }
        if (options.all) callback(null, entries);
        else callback(null, entries[0].address, entries[0].family);
    }) as LookupFunction;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, value?: Fetched) => {
            if (settled) return;
            settled = true;
            if (value) resolve(value);
            else reject(signal.aborted ? signal.reason : error instanceof CimdFailure ? error :
                new CimdFailure(`network ${(error as NodeJS.ErrnoException | null)?.code ?? 'error'}`));
        };
        const req = request({
            host: url.hostname, port: network.port, path: url.pathname, method: 'GET', servername: url.hostname,
            ca: network.ca, agent: false, lookup, signal, maxHeaderSize: 16 * 1024,
            headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': USER_AGENT }
        }, res => {
            res.on('error', finish);
            res.on('close', () => finish(new CimdFailure('truncated')));
            const headers = flatHeaders(res.headers);
            try { checkHeaders(res.statusCode ?? 0, headers); } catch (error) { finish(error); return req.destroy(); }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) { finish(new CimdFailure('too large')); req.destroy(); } else chunks.push(chunk);
            });
            res.on('end', () => {
                try { finish(null, { status: res.statusCode ?? 0, headers, body: utf8(Buffer.concat(chunks)) }); }
                catch (error) { finish(error); }
            });
        });
        req.on('error', finish);
        req.end();
    });
}

const flatHeaders = (headers: Record<string, string | string[] | number | undefined>) => Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined)
        .map(([name, value]): [string, string] => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]));

function utf8(bytes: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new CimdFailure('not utf-8'); }
}

/** Status, encoding, type and declared size; runs before the body is read and again on fetcher-hook results. */
function checkHeaders(status: number, headers: Record<string, string>): void {
    if (status >= 300 && status < 400) throw new CimdFailure('redirect');
    if (status !== 200) throw new CimdFailure(`status ${status}`);
    const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') throw new CimdFailure('encoding');
    if ((headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new CimdFailure('content type');
    }
    const length = headers['content-length'];
    if (length !== undefined && !(/^\d+$/.test(length.trim()) && Number(length) <= MAX_BODY_BYTES)) {
        throw new CimdFailure('too large');
    }
}

function parseResponse(clientId: string, response: Fetched): { client: StoredClient; ttl: number } {
    const headers = flatHeaders(response.headers);
    checkHeaders(response.status, headers);
    if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > MAX_BODY_BYTES) {
        throw new CimdFailure('too large');
    }
    let document: unknown;
    try { document = JSON.parse(response.body); } catch { throw new CimdFailure('json'); }
    return { client: validateDocument(clientId, document), ttl: cacheSeconds(headers['cache-control']) };
}

/** Seconds to cache: none for no-store/no-cache/private or an invalid max-age, max-age clamped to a day, else 300. */
function cacheSeconds(header: string | undefined): number {
    if (header === undefined) return DEFAULT_TTL;
    const directives = header.toLowerCase().split(',').map(directive => directive.trim());
    if (directives.some(directive => /^(no-store|no-cache|private)(\s*=|$)/.test(directive))) return 0;
    const maxAge = directives.find(directive => /^max-age(\s*=|$)/.test(directive));
    if (maxAge === undefined) return DEFAULT_TTL;
    const seconds = /^max-age\s*=\s*"?(\d+)"?$/.exec(maxAge);
    return seconds ? Math.min(Number(seconds[1]), MAX_TTL) : 0;
}

// Control, format (bidi marks/overrides/isolates, zero-width, BOM), surrogate, private-use and line/paragraph separators.
const UNSAFE_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function validateDocument(clientId: string, document: unknown): StoredClient {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new CimdFailure('not an object');
    const doc = document as Record<string, unknown>;
    if (doc.client_id !== clientId) throw new CimdFailure('client_id mismatch');
    const name = typeof doc.client_name === 'string' ? doc.client_name.trim() : '';
    if (!name || [...name].length > 80 || UNSAFE_NAME.test(name)) throw new CimdFailure('client_name');
    // The document is public: a shared secret in it is a broken client.
    if (Object.hasOwn(doc, 'client_secret') || Object.hasOwn(doc, 'client_secret_expires_at')) {
        throw new CimdFailure('client_secret');
    }
    // Draft -03 §5: the plural list wins when present (ChatGPT lists none + private_key_jwt and names private_key_jwt in
    // the singular), else the singular, else none. We only do `none`; a shared-secret method means a broken client.
    const single = doc.token_endpoint_auth_method;
    const methods = Object.hasOwn(doc, 'token_endpoint_auth_methods_supported') ? doc.token_endpoint_auth_methods_supported :
        Object.hasOwn(doc, 'token_endpoint_auth_method') ? [single] : ['none'];
    if ((Object.hasOwn(doc, 'token_endpoint_auth_method') && typeof single !== 'string') || !Array.isArray(methods) ||
        !methods.every(method => typeof method === 'string') || !methods.includes('none') ||
        [single, ...methods].some(method => typeof method === 'string' && method.startsWith('client_secret'))) {
        throw new CimdFailure('token_endpoint_auth_method');
    }
    const lists = (key: string, required: string) => {
        const value = doc[key];
        return !Object.hasOwn(doc, key) ||
            (Array.isArray(value) && value.every(item => typeof item === 'string') && value.includes(required));
    };
    if (!lists('grant_types', 'authorization_code')) throw new CimdFailure('grant_types');
    if (!lists('response_types', 'code')) throw new CimdFailure('response_types');
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new CimdFailure('redirect_uris');
    const redirects: string[] = [];
    for (const uri of uris) {
        if (!validRedirect(uri)) throw new CimdFailure('redirect_uri');
        if (!redirects.includes(uri)) redirects.push(uri);
    }
    return { client_id: clientId, client_name: name, redirect_uris: redirects, document_host: new URL(clientId).hostname };
}

/** https (no userinfo/fragment), or loopback http on 127.0.0.1, [::1] or localhost (no userinfo/query/fragment). Canonical. */
function validRedirect(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > MAX_ID_LENGTH) return false;
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    if (url.href !== value || url.username || url.password || value.includes('#')) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !value.includes('?');
}
