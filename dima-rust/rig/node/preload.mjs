// dima-rig: confines a Node reference process to the rig's mock of the outside world.
//
// Loaded with NODE_OPTIONS=--import=/rig/preload.mjs; the application's source is not changed.
// Every outbound HTTP request (global fetch, http/https.request and .get) to a destination that
// is not on the side's loopback allow-list is rewritten to the side's mock as
//   http://<RIG_MOCK>/<host[:port]><path>?<query>
// so the mock, which knows every provider by its real host, records and answers it (an unknown
// host gets 501 and fails the scenario). Below that, every TCP connection the process opens
// (net.Socket#connect, which undici, the MongoDB driver, node-redis and ws all use) must go to a
// loopback address and an allowed port, and every DNS lookup of a name that is not loopback is
// answered locally with a TEST-NET-3 address (203.0.113.10, never routed), so nothing reaches a
// resolver either. Child programs get proxy variables that point at the mock, which refuses
// every CONNECT.
//
// Environment (set by the rig):
//   RIG_MOCK      host:port of the side's mock (always allowed)
//   RIG_DIRECT    comma-separated host:port pairs on loopback the process may reach directly
//                 (MongoDB, Dragonfly, the Qdrant proxy)
//   RIG_LISTEN    comma-separated port=port pairs: a server listening on the first port listens
//                 on the second instead; every server listens on 127.0.0.1 only
//   RIG_SIDE      reference or candidate (for log lines)
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const MOCK = process.env.RIG_MOCK || '';
if (!/^127\.0\.0\.1:\d+$/.test(MOCK)) {
    console.error('[dima-rig preload] RIG_MOCK is not set to 127.0.0.1:<port>; refusing to start');
    process.exit(97);
}
const MOCK_PORT = Number(MOCK.split(':')[1]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);
const DIRECT = new Set([MOCK]);
for (const pair of (process.env.RIG_DIRECT || '').split(',').map(s => s.trim()).filter(Boolean)) {
    DIRECT.add(pair);
}
const LISTEN = new Map();
for (const pair of (process.env.RIG_LISTEN || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [from, to] = pair.split('=').map(Number);
    if (Number.isInteger(from) && Number.isInteger(to)) LISTEN.set(from, to);
}
// A process may always reach the ports it listens on (an API calling itself).
for (const to of LISTEN.values()) DIRECT.add(`127.0.0.1:${to}`);
const FAKE_ADDRESS = '203.0.113.10';

const original = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    socketConnect: net.Socket.prototype.connect,
    serverListen: net.Server.prototype.listen,
    lookup: dns.lookup,
    promisesLookup: dns.promises.lookup,
};

function log(message) {
    try {
        process.stderr.write(`[dima-rig preload] ${message}\n`);
    } catch {
        // stderr closed: nothing to do.
    }
}

/** Report something the guard stopped to the mock (recorded as a refusal; fails the scenario). */
function refuse(kind, detail) {
    log(`refused ${kind}: ${detail}`);
    try {
        const body = JSON.stringify({ kind, detail, side: process.env.RIG_SIDE || '' });
        const req = original.httpRequest({
            host: '127.0.0.1', port: MOCK_PORT, method: 'POST', path: '/__rig/refused',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        });
        req.on('error', () => {});
        req.end(body);
    } catch {
        // The report is best effort; the refusal itself already happened.
    }
}

function isLoopbackHost(host) {
    if (!host) return true;
    const h = String(host).toLowerCase();
    return LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function defaultPort(protocol) {
    return protocol === 'https:' || protocol === 'wss:' ? 443 : 80;
}

/** The key a destination has at the mock: the host as written, with its port when not default. */
function hostKey(hostname, port, protocol) {
    const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
    const p = Number(port) || defaultPort(protocol);
    const shown = h.includes(':') ? `[${h}]` : h;
    return p === defaultPort(protocol) ? shown : `${shown}:${p}`;
}

/** Whether the process may reach this loopback destination directly. */
function direct(hostname, port, protocol) {
    if (!isLoopbackHost(hostname)) return false;
    const p = Number(port) || defaultPort(protocol);
    return DIRECT.has(`127.0.0.1:${p}`);
}

/** The mock URL for an outbound URL, or null when the destination is reached directly. */
function rewrite(url) {
    if (direct(url.hostname, url.port, url.protocol)) return null;
    const key = hostKey(url.hostname, url.port, url.protocol);
    return new URL(`http://${MOCK}/${key}${url.pathname}${url.search}`);
}

// --- global fetch -------------------------------------------------------------------------
if (typeof original.fetch === 'function') {
    globalThis.fetch = async function rigFetch(input, init) {
        let url;
        if (typeof input === 'string' || input instanceof URL) {
            url = new URL(String(input));
        } else if (input && typeof input.url === 'string') {
            url = new URL(input.url);
        } else {
            return original.fetch(input, init);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return original.fetch(input, init);
        }
        const target = rewrite(url);
        if (!target) return original.fetch(input, init);
        if (typeof input === 'string' || input instanceof URL) {
            return original.fetch(target, init);
        }
        // A Request: same method, headers, body and signal, new URL.
        return original.fetch(new Request(target, input), init);
    };
}

// --- http / https -------------------------------------------------------------------------
function requestArgs(protocol, args) {
    let url = null;
    let options = {};
    let cb;
    let i = 0;
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
        url = new URL(String(args[0]));
        i = 1;
    }
    if (args[i] && typeof args[i] === 'object') {
        options = args[i];
        i += 1;
    }
    if (typeof args[i] === 'function') cb = args[i];
    const merged = {};
    if (url) {
        merged.protocol = url.protocol;
        merged.hostname = url.hostname;
        merged.port = url.port;
        merged.path = `${url.pathname}${url.search}`;
        if (url.username || url.password) {
            merged.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        }
    }
    Object.assign(merged, options);
    if (!merged.protocol) merged.protocol = protocol;
    const hostname = merged.hostname || (merged.host ? String(merged.host).replace(/:\d+$/, '') : 'localhost');
    return { merged, hostname, port: merged.port, cb };
}

const TLS_OPTIONS = ['agent', 'createConnection', 'ca', 'cert', 'key', 'pfx', 'passphrase', 'servername',
    'rejectUnauthorized', 'checkServerIdentity', 'secureContext', 'ciphers', 'minVersion', 'maxVersion',
    'socketPath', 'lookup', 'family', 'localAddress', 'hints'];

function patchedRequest(protocol, originalRequest) {
    return function rigRequest(...args) {
        const { merged, hostname, port, cb } = requestArgs(protocol, args);
        if (merged.socketPath) {
            refuse('unix-socket', String(merged.socketPath));
            const opts = { host: '127.0.0.1', port: MOCK_PORT, method: 'GET',
                path: `/__rig/unknown/unix${String(merged.socketPath)}` };
            return cb ? original.httpRequest(opts, cb) : original.httpRequest(opts);
        }
        if (direct(hostname, port, merged.protocol)) {
            return originalRequest.apply(this, args);
        }
        const key = hostKey(hostname, port, merged.protocol);
        const opts = { ...merged };
        for (const k of TLS_OPTIONS) delete opts[k];
        delete opts.host;
        opts.protocol = 'http:';
        opts.hostname = '127.0.0.1';
        opts.port = MOCK_PORT;
        opts.path = `/${key}${merged.path || '/'}`;
        return cb ? original.httpRequest(opts, cb) : original.httpRequest(opts);
    };
}

http.request = patchedRequest('http:', original.httpRequest);
https.request = patchedRequest('https:', original.httpsRequest);
http.get = function rigGet(...args) {
    const req = http.request(...args);
    req.end();
    return req;
};
https.get = function rigGet(...args) {
    const req = https.request(...args);
    req.end();
    return req;
};

// --- sockets ------------------------------------------------------------------------------
function connectTarget(args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (first && typeof first === 'object') {
        return { path: first.path, host: first.host, port: first.port };
    }
    if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
    return { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}

net.Socket.prototype.connect = function rigConnect(...args) {
    const t = connectTarget(args);
    if (t.path) {
        refuse('unix-socket', String(t.path));
        process.nextTick(() => this.destroy(Object.assign(new Error(`dima-rig: unix socket ${t.path} refused`), { code: 'EACCES' })));
        return this;
    }
    const host = t.host || 'localhost';
    if (!isLoopbackHost(host) || !DIRECT.has(`127.0.0.1:${Number(t.port)}`)) {
        refuse('connect', `${host}:${t.port}`);
        process.nextTick(() => this.destroy(Object.assign(new Error(`dima-rig: connection to ${host}:${t.port} refused`), { code: 'ECONNREFUSED' })));
        return this;
    }
    return original.socketConnect.apply(this, args);
};

// --- DNS ----------------------------------------------------------------------------------
function fakeLookup(hostname, options) {
    const all = typeof options === 'object' && options !== null && options.all;
    const family = typeof options === 'number' ? options : options?.family;
    if (family === 6) {
        return all ? [{ address: '100::1', family: 6 }] : { address: '100::1', family: 6 };
    }
    return all ? [{ address: FAKE_ADDRESS, family: 4 }] : { address: FAKE_ADDRESS, family: 4 };
}

dns.lookup = function rigLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;
    if (isLoopbackHost(hostname)) return original.lookup.call(this, hostname, opts, cb);
    const answer = fakeLookup(hostname, opts);
    process.nextTick(() => (Array.isArray(answer) ? cb(null, answer) : cb(null, answer.address, answer.family)));
    return {};
};
dns.promises.lookup = async function rigPromisesLookup(hostname, options) {
    if (isLoopbackHost(hostname)) return original.promisesLookup.call(this, hostname, options);
    return fakeLookup(hostname, options);
};
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx',
    'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']) {
    if (typeof dns[name] === 'function') {
        dns[name] = function rigResolve(host, ...rest) {
            const cb = rest.find(x => typeof x === 'function');
            refuse('dns', `${name} ${host}`);
            const err = Object.assign(new Error(`dima-rig: DNS ${name} ${host} refused`), { code: 'ENOTFOUND' });
            if (cb) process.nextTick(() => cb(err));
        };
    }
    if (dns.promises && typeof dns.promises[name] === 'function') {
        dns.promises[name] = async function rigResolve(host) {
            refuse('dns', `${name} ${host}`);
            throw Object.assign(new Error(`dima-rig: DNS ${name} ${host} refused`), { code: 'ENOTFOUND' });
        };
    }
}

// --- servers ------------------------------------------------------------------------------
net.Server.prototype.listen = function rigListen(...args) {
    const first = args[0];
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
        const port = Number(first);
        const to = LISTEN.has(port) ? LISTEN.get(port) : port;
        const rest = args.slice(1);
        if (typeof rest[0] === 'string') rest.shift();
        return original.serverListen.call(this, to, '127.0.0.1', ...rest);
    }
    if (first && typeof first === 'object' && !first._handle && first.port !== undefined) {
        const port = Number(first.port);
        const to = LISTEN.has(port) ? LISTEN.get(port) : port;
        return original.serverListen.call(this, { ...first, port: to, host: '127.0.0.1' }, ...args.slice(1));
    }
    return original.serverListen.apply(this, args);
};

// --- child processes ----------------------------------------------------------------------
const PROXY = `http://${MOCK}`;
const PROXY_ENV = {
    HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, ALL_PROXY: PROXY,
    http_proxy: PROXY, https_proxy: PROXY, all_proxy: PROXY, NO_PROXY: '', no_proxy: '',
};
function withProxyEnv(options) {
    const env = { ...(options && options.env ? options.env : process.env), ...PROXY_ENV };
    return { ...(options || {}), env };
}
for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const fn = childProcess[name];
    childProcess[name] = function rigChild(...args) {
        const idx = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
        if (idx >= 0) args[idx] = withProxyEnv(args[idx]);
        else {
            const at = Array.isArray(args[1]) ? 2 : 1;
            args.splice(at, 0, withProxyEnv({}));
        }
        return fn.apply(this, args);
    };
}

syncBuiltinESMExports();
log(`${process.env.RIG_SIDE || 'side'}: outbound requests go to ${MOCK}; direct: ${[...DIRECT].join(', ')}; listen: ${[...LISTEN].map(([a, b]) => `${a}->${b}`).join(', ') || 'unchanged'}`);
