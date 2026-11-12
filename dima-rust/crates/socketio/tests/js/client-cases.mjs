// Drives the differential cases against one server and prints what the JavaScript clients
// observed, as JSON, on stdout.
//
//   node tests/js/client-cases.mjs <reference port> <short port> <output file> [case-name-substring]
//
// Client cases run with socket.io-client 4.8.3 and 4.7.5, each over polling only, WebSocket only
// and polling upgraded to WebSocket. HTTP cases (client files, Engine.IO errors, the app's own
// routes and upgrades) run once. Everything random (ids, offsets) is replaced by placeholders, and
// each socket's observations are kept apart, so the output depends only on the server's
// behaviour. Progress goes to stderr.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { io as io483, Manager as Manager483 } from 'client-4.8.3';
import { io as io475, Manager as Manager475 } from 'client-4.7.5';
import WebSocket from 'ws';

const [referencePort, shortPort, outputFile, only] = process.argv.slice(2);
if (!referencePort || !shortPort || !outputFile) {
  throw new Error('usage: client-cases.mjs <port> <short port> <output file> [filter]');
}
const BASE = `http://127.0.0.1:${referencePort}`;
const SHORT = `http://127.0.0.1:${shortPort}`;

const CLIENTS = {
  '4.8.3': { io: io483, Manager: Manager483 },
  '4.7.5': { io: io475, Manager: Manager475 },
};
const TRANSPORTS = {
  polling: ['polling'],
  websocket: ['websocket'],
  upgrade: ['polling', 'websocket'],
};
const OFFSET = /^[0-9A-Za-z_-]+(\.[0-9A-Za-z_-]+)?$/;
// Namespaces whose events carry a recovery offset as their last argument: all but the two with
// the plain adapter.
const offsets = (nsp) => nsp !== '/norec' && nsp !== '/control';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function normalize(value) {
  if (value === undefined) return '<undefined>';
  if (Number.isNaN(value)) return '<NaN>';
  if (Object.is(value, -0)) return '<-0>';
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    // Keys in the order the client sees them: that order is part of the payload.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

// One run of one case: a log per socket label, helpers to wait on it.
class Run {
  constructor(client, transport, base) {
    this.client = client;
    this.transport = transport;
    this.base = base;
    this.logs = {};
    this.sockets = [];
    this.managers = [];
  }

  log(label, ...entry) {
    (this.logs[label] ??= []).push(normalize(entry));
  }

  options(extra = {}) {
    return {
      forceNew: true,
      transports: TRANSPORTS[this.transport],
      reconnectionDelay: 100,
      reconnectionDelayMax: 100,
      randomizationFactor: 0,
      timeout: 5000,
      ...extra,
    };
  }

  watch(socket, label, nsp) {
    socket.on('connect', () => this.log(label, 'connect', { recovered: socket.recovered, id: typeof socket.id }));
    socket.on('connect_error', (error) => this.log(label, 'connect_error', error.message, error.data ?? null));
    socket.on('disconnect', (reason) => this.log(label, 'disconnect', reason));
    socket.onAny((event, ...args) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        this.log(label, 'event', event, ...args.slice(0, -1), '<ack requested>');
      } else if (offsets(nsp)) {
        const ok = typeof last === 'string' && OFFSET.test(last);
        this.log(label, 'event', event, ...args.slice(0, -1), ok ? '<offset>' : `<no offset: ${JSON.stringify(last)}>`);
      } else {
        this.log(label, 'event', event, ...args);
      }
    });
    return socket;
  }

  socket(nsp, label = nsp, extra = {}) {
    const socket = this.client.io(`${this.base}${nsp}`, this.options(extra));
    this.sockets.push(socket);
    return this.watch(socket, label, nsp.split('?')[0]);
  }

  manager(extra = {}) {
    const manager = new this.client.Manager(this.base, this.options(extra));
    this.managers.push(manager);
    return manager;
  }

  managed(manager, nsp, label = nsp, extra = {}) {
    const socket = manager.socket(nsp, extra);
    this.sockets.push(socket);
    this.watch(socket, label, nsp);
    socket.connect();
    return socket;
  }

  count(label, kind, name) {
    return (this.logs[label] ?? []).filter((e) => e[0] === kind && (name === undefined || e[1] === name)).length;
  }

  async until(label, kind, name, times = 1, timeout = 3000) {
    const start = Date.now();
    while (this.count(label, kind, name) < times) {
      if (Date.now() - start > timeout) {
        this.log(label, 'timeout waiting for', kind, name ?? null, times);
        return false;
      }
      await sleep(5);
    }
    return true;
  }

  // On the upgrade variant, the case starts once the WebSocket took over.
  async upgraded(socket) {
    if (this.transport !== 'upgrade') return;
    const start = Date.now();
    while (socket.io.engine?.transport?.name !== 'websocket' && Date.now() - start < 3000) await sleep(5);
  }

  async ack(label, socket, ...args) {
    try {
      this.log(label, 'ack', await socket.timeout(2000).emitWithAck(...args));
    } catch (error) {
      this.log(label, 'ack error', error.message);
    }
  }

  close() {
    for (const socket of this.sockets) socket.disconnect();
    for (const manager of this.managers) manager.engine?.close();
  }
}

// ----- client cases -------------------------------------------------------------------------

async function connected(run, socket, label) {
  await run.until(label, 'connect');
  await run.upgraded(socket);
}

// Leaves the transport without a goodbye (a network blip), then lets the client reconnect.
function blip(socket) {
  socket.io.engine.close();
}

const cases = {
  async 'connect root'(run) {
    const s = run.socket('/', 'root');
    await connected(run, s, 'root');
  },
  async 'connect check ok'(run) {
    const s = run.socket('/basic?x=1&x=2', 'a', { auth: { token: 'good' } });
    await run.until('a', 'event', 'welcome');
    run.log('a', 'nsp', s.nsp);
  },
  async 'connect check refusals'(run) {
    run.socket('/basic', 'bad', { auth: { token: 'bad' } });
    await run.until('bad', 'connect_error');
    run.socket('/basic', 'plain', { auth: { token: 'plain' } });
    await run.until('plain', 'connect_error');
    run.socket('/basic', 'slow', { auth: { token: 'slow' } });
    await run.until('slow', 'event', 'welcome');
  },
  async 'invalid namespace'(run) {
    run.socket('/nope', 'nope');
    await run.until('nope', 'connect_error');
  },
  async 'family names'(run) {
    for (const name of ['/fam/abc', '/fam/ABC_123', '/fam/', '/fam/ab-c', '/fam/abc/def', '/fam/x_deny', '/digits/123', '/digits/1234', '/pick/abcd', '/pick/zzzz', '/pick/abc', '/fam/é']) {
      const s = run.socket(name, name);
      const start = Date.now();
      while (!run.count(name, 'connect') && !run.count(name, 'connect_error') && Date.now() - start < 2000) await sleep(5);
      if (run.count(name, 'connect')) await run.until(name, 'event', undefined, 1, 500);
      s.disconnect();
    }
  },
  async 'events and acknowledgements'(run) {
    const s = run.socket('/basic', 'a');
    await connected(run, s, 'a');
    s.emit('echo', 'a', { b: [1] }, null, 1.5);
    await run.until('a', 'event', 'echo');
    await run.ack('a', s, 'echo', 'x', 2);
    await run.ack('a', s, 'ack-multi');
    try {
      run.log('a', 'ack-multi all', await new Promise((done) => s.emit('ack-multi', (...args) => done(args))));
      run.log('a', 'ack-empty all', await new Promise((done) => s.emit('ack-empty', (...args) => done(args))));
    } catch (error) {
      run.log('a', 'error', error.message);
    }
    await run.ack('a', s, 'ack-twice');
    try {
      run.log('a', 'ack', await s.timeout(300).emitWithAck('no-ack'));
    } catch (error) {
      run.log('a', 'ack error', error.message);
    }
    s.emit(1, 'num');
    await run.until('a', 'event', 'one');
  },
  async 'unicode payloads'(run) {
    const s = run.socket('/basic', 'a');
    await connected(run, s, 'a');
    s.emit('texts');
    await run.until('a', 'event', 'texts');
    await run.ack('a', s, 'echo', { text: 'é😀 שלום ́', lone: 'x' });
  },
  async 'server asks'(run) {
    const s = run.socket('/basic', 'a');
    s.on('question', (payload, ack) => ack({ got: payload }));
    await connected(run, s, 'a');
    s.emit('ask', { q: 1 });
    await run.until('a', 'event', 'answer');
    s.emit('ask-silent');
    await run.until('a', 'event', 'answer', 2);
  },
  async 'server disconnects'(run) {
    const s = run.socket('/basic', 'a');
    await connected(run, s, 'a');
    s.emit('bye');
    await run.until('a', 'disconnect');
    await sleep(400);
    run.log('a', 'connected after', s.connected);
  },
  async 'server closes the connection'(run) {
    const m = run.manager();
    const a = run.managed(m, '/basic', 'a');
    const b = run.managed(m, '/norec', 'b');
    await run.until('a', 'connect');
    await run.until('b', 'connect');
    await run.upgraded(a);
    a.emit('bye-all');
    await run.until('a', 'disconnect');
    await run.until('b', 'disconnect');
    await sleep(300);
    run.log('a', 'connected after', a.connected);
  },
  async 'client disconnects'(run) {
    const s = run.socket('/basic', 'a');
    await connected(run, s, 'a');
    s.disconnect();
    await run.until('a', 'disconnect');
  },
  async 'namespace broadcast'(run, tag) {
    const a = run.socket(`/fam/bc_${tag}`, 'a');
    const b = run.socket(`/fam/bc_${tag}`, 'b');
    await connected(run, a, 'a');
    await connected(run, b, 'b');
    a.emit('broadcast', 'hi');
    await run.until('a', 'event', 'broadcast');
    await run.until('b', 'event', 'broadcast');
    await run.ack('a', a, 'count');
  },
  async 'burst of events'(run) {
    const s = run.socket('/norec', 'a');
    const seen = [];
    s.on('seq', (i) => seen.push(i));
    await connected(run, s, 'a');
    s.emit('burst', 300);
    const start = Date.now();
    while (seen.length < 300 && Date.now() - start < 5000) await sleep(5);
    run.log('a', 'received', seen.length, seen.every((v, i) => v === i));
    run.logs.a = run.logs.a.filter((e) => e[1] !== 'seq');
  },
  async 'multiplexed namespaces'(run) {
    const m = run.manager();
    const a = run.managed(m, '/basic', 'a');
    const b = run.managed(m, '/fam/mx', 'b');
    const c = run.managed(m, '/norec', 'c');
    for (const label of ['a', 'b', 'c']) await run.until(label, 'connect');
    await run.upgraded(a);
    for (const [label, s] of [['a', a], ['b', b], ['c', c]]) await run.ack(label, s, 'echo', label);
    b.disconnect();
    await run.until('b', 'disconnect');
    await run.ack('a', a, 'echo', 'still');
    await run.ack('c', c, 'echo', 'still');
    run.log('a', 'one engine', a.io === c.io && m.engine === a.io.engine);
  },
  async 'upgrade with concurrent emits'(run) {
    const s = run.socket('/norec', 'a');
    const seen = [];
    s.on('echo', (i) => seen.push(i));
    await run.until('a', 'connect');
    for (let i = 0; i < 50; i++) s.emit('echo', i);
    const start = Date.now();
    while (seen.length < 50 && Date.now() - start < 5000) await sleep(5);
    await sleep(300);
    run.log('a', 'echoes', seen.length, seen.every((v, i) => v === i));
    run.log('a', 'transport', s.io.engine.transport.name);
    run.logs.a = run.logs.a.filter((e) => e[1] !== 'echo');
  },
  async 'large payloads'(run) {
    const s = run.socket('/norec', 'a');
    await connected(run, s, 'a');
    try {
      const reply = await s.timeout(5000).emitWithAck('echo', 'x'.repeat(900_000));
      run.log('a', 'large ack', reply.length);
    } catch (error) {
      run.log('a', 'large ack error', error.message);
    }
    s.emit('echo', 'y'.repeat(1_100_000));
    await run.until('a', 'disconnect', undefined, 1, 5000);
    await run.until('a', 'connect', undefined, 2, 5000);
  },
  async 'malformed packets close the connection'(run) {
    for (const packet of ['garbage', '2/basic,["connect"]', '0/basic,', '2/elsewhere,["x"]', '3/basic,']) {
      const label = packet;
      const s = run.socket('/basic', label);
      await connected(run, s, label);
      s.io.engine.send(packet);
      if (await run.until(label, 'disconnect', undefined, 1, 1500)) {
        await run.until(label, 'event', 'welcome', 2);
      }
      s.disconnect();
    }
  },

  // ----- recovery ------------------------------------------------------------------------
  async 'recovery: missed events are replayed'(run, tag) {
    const nsp = `/fam/rep_${tag}`;
    const control = run.socket('/control', 'control');
    await run.until('control', 'connect');
    const s = run.socket(nsp, 'a', { auth: { tag } });
    await connected(run, s, 'a');
    await run.until('a', 'event', 'welcome');
    const id = s.id;
    s.once('disconnect', async () => {
      run.log('control', 'ack', await control.emitWithAck('nsp-emit', nsp, 'away-1'));
      run.log('control', 'ack', await control.emitWithAck('direct-emit', tag, 'direct-1'));
      run.log('control', 'ack', await control.emitWithAck('nsp-emit', nsp, 'away-2'));
    });
    blip(s);
    await run.until('a', 'connect', undefined, 2);
    await run.until('a', 'event', 'welcome', 2);
    run.log('a', 'same id', s.id === id);
    await run.ack('a', s, 'echo', 'after');
  },
  async 'recovery: twice in a row'(run, tag) {
    const s = run.socket('/basic', 'a', { auth: { tag } });
    await connected(run, s, 'a');
    await run.until('a', 'event', 'welcome');
    blip(s);
    await run.until('a', 'event', 'welcome', 2);
    await run.upgraded(s);
    blip(s);
    await run.until('a', 'event', 'welcome', 3);
  },
  async 'recovery: only this socket and the namespace'(run, tag) {
    const control = run.socket('/control', 'control');
    const a = run.socket('/basic', 'a', { auth: { tag: `${tag}-a` } });
    const b = run.socket('/basic', 'b', { auth: { tag: `${tag}-b` } });
    await run.until('control', 'connect');
    await connected(run, a, 'a');
    await connected(run, b, 'b');
    await run.until('a', 'event', 'welcome');
    await run.until('b', 'event', 'welcome');
    a.once('disconnect', async () => {
      run.log('control', 'ack', await control.emitWithAck('direct-emit', `${tag}-b`, 'for-b'));
      run.log('control', 'ack', await control.emitWithAck('direct-emit', `${tag}-a`, 'for-a'));
      run.log('control', 'ack', await control.emitWithAck('direct-ask', `${tag}-a`));
    });
    blip(a);
    await run.until('a', 'event', 'welcome', 2);
    await run.until('b', 'event', 'direct');
    await sleep(200);
  },
  async 'recovery: multiplexed sockets'(run, tag) {
    const m = run.manager();
    const a = run.managed(m, '/basic', 'a', { auth: { tag } });
    const b = run.managed(m, `/fam/mr_${tag}`, 'b');
    await run.until('a', 'event', 'welcome');
    await run.until('b', 'event', 'welcome');
    await run.upgraded(a);
    m.engine.close();
    await run.until('a', 'event', 'welcome', 2);
    await run.until('b', 'event', 'welcome', 2);
  },
  async 'recovery: nothing received yet'(run, tag) {
    const s = run.socket(`/fam/quiet_${tag}`, 'a');
    await connected(run, s, 'a');
    blip(s);
    await run.until('a', 'connect', undefined, 2);
  },
  async 'recovery: not after a client disconnect'(run, tag) {
    const s = run.socket('/basic', 'a', { auth: { tag } });
    await run.until('a', 'event', 'welcome');
    s.disconnect();
    await run.until('a', 'disconnect');
    s.connect();
    await run.until('a', 'event', 'welcome', 2);
  },
  async 'recovery: not after a server disconnect'(run, tag) {
    const s = run.socket('/basic', 'a', { auth: { tag } });
    await run.until('a', 'event', 'welcome');
    s.emit('bye');
    await run.until('a', 'disconnect');
    s.connect();
    await run.until('a', 'event', 'welcome', 2);
  },
  async 'recovery: offsets without sessions'(run, tag) {
    const s = run.socket(`/nopersist/${tag}`, 'a');
    await run.until('a', 'event', 'welcome');
    await run.upgraded(s);
    blip(s);
    await run.until('a', 'event', 'welcome', 2);
  },
  async 'recovery: off'(run) {
    const s = run.socket('/norec', 'a');
    await run.until('a', 'event', 'welcome');
    await run.upgraded(s);
    blip(s);
    await run.until('a', 'event', 'welcome', 2);
  },
  async 'recovery: forged session'(run) {
    run.socket('/basic', 'a', { auth: { pid: 'forged-private-id', offset: 'forged-offset', tag: 'forged' } });
    await run.until('a', 'event', 'welcome');
  },
  async 'short: recovery window expired'(run, tag) {
    const s = run.socket('/basic', 'a', { auth: { tag }, reconnectionDelay: 2200, reconnectionDelayMax: 2200 });
    await run.until('a', 'event', 'welcome');
    await run.upgraded(s);
    blip(s);
    await run.until('a', 'event', 'welcome', 2, 6000);
  },
  async 'short: recovery within the window'(run, tag) {
    const s = run.socket('/basic', 'a', { auth: { tag }, reconnectionDelay: 600, reconnectionDelayMax: 600 });
    await run.until('a', 'event', 'welcome');
    await run.upgraded(s);
    blip(s);
    await run.until('a', 'event', 'welcome', 2, 6000);
  },
  async 'short: connect timeout'(run) {
    const m = run.manager({ reconnection: false });
    m.on('close', (reason) => run.log('manager', 'close', reason));
    m.on('open', () => run.log('manager', 'open'));
    await run.until('manager', 'open');
    await run.until('manager', 'close', undefined, 1, 4000);
  },
};

// ----- HTTP cases ---------------------------------------------------------------------------

function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done) => {
    const req = http.request(`${base}${path}`, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (error) => done({ error: error.code ?? error.message }));
      res.on('aborted', () => done({ error: 'aborted' }));
    });
    req.on('error', (error) => done({ error: error.code ?? error.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function decode(response) {
  const encoding = response.headers['content-encoding'];
  if (encoding === 'br') return brotliDecompressSync(response.body);
  if (encoding === 'gzip') return gunzipSync(response.body);
  if (encoding === 'deflate') return inflateSync(response.body);
  return response.body;
}

const HEADERS = ['content-type', 'cache-control', 'etag', 'content-encoding', 'x-xss-protection'];

function describe(response, { body = 'hash' } = {}) {
  if (response.error) return { error: response.error };
  const headers = Object.fromEntries(HEADERS.filter((h) => h in response.headers).map((h) => [h, response.headers[h]]));
  const out = { status: response.status, headers };
  const decoded = decode(response);
  if (body === 'hash') out.sha256 = createHash('sha256').update(decoded).digest('hex');
  if (body === 'text') out.body = decoded.toString('utf8');
  if (body === 'json') out.body = JSON.parse(decoded.toString('utf8'));
  return out;
}

async function handshake(base, headers = {}) {
  const response = await request(base, '/socket.io/?EIO=4&transport=polling', { headers });
  const text = decode(response).toString('utf8');
  const open = JSON.parse(text.slice(1));
  return { response, open, sid: open.sid };
}

const httpCases = {
  async 'client files'(base) {
    const out = {};
    const files = ['socket.io.js', 'socket.io.min.js', 'socket.io.js.map', 'socket.io.esm.min.js', 'socket.io.esm.min.js.map', 'socket.io.msgpack.min.js', 'socket.io.msgpack.min.js.map', 'socket.io.min.js.map'];
    for (const file of files) out[file] = describe(await request(base, `/socket.io/${file}`));
    for (const encoding of ['gzip', 'br', 'deflate', 'gzip, deflate, br, zstd', 'br;q=0.5, gzip', '*', 'identity', 'gzip;q=0']) {
      out[`socket.io.js ${encoding}`] = describe(await request(base, '/socket.io/socket.io.js', { headers: { 'accept-encoding': encoding } }));
    }
    for (const tag of ['"4.8.3"', 'W/"4.8.3"', '"4.8.2"', '*', '"4.8.3", "x"']) {
      out[`if-none-match ${tag}`] = describe(await request(base, '/socket.io/socket.io.js', { headers: { 'if-none-match': tag } }));
    }
    out['query string'] = describe(await request(base, '/socket.io/socket.io.js?v=1'));
    out.head = describe(await request(base, '/socket.io/socket.io.js', { method: 'HEAD' }));
    out.post = describe(await request(base, '/socket.io/socket.io.min.js', { method: 'POST', body: 'x' }));
    out['not shipped: esm'] = describe(await request(base, '/socket.io/socket.io.esm.js'));
    out['not shipped: msgpack map'] = describe(await request(base, '/socket.io/socket.io.msgpack.js.map'));
    out['other name'] = describe(await request(base, '/socket.io/socket.io.jsx'), { body: 'json' });
    return out;
  },
  async 'engine errors'(base) {
    const out = {};
    const get = async (label, path, options) => {
      out[label] = describe(await request(base, path, options), { body: 'text' });
    };
    await get('no query', '/socket.io/');
    await get('unknown path', '/socket.io/foo');
    await get('unknown transport', '/socket.io/?EIO=4&transport=carrier-pigeon');
    await get('protocol 3', '/socket.io/?EIO=3&transport=polling');
    await get('no protocol', '/socket.io/?transport=polling');
    await get('post handshake', '/socket.io/?EIO=4&transport=polling', { method: 'POST', body: '40' });
    await get('websocket without upgrade', '/socket.io/?EIO=4&transport=websocket');
    await get('unknown sid', '/socket.io/?EIO=4&transport=polling&sid=AAAAAAAAAAAAAAAAAAAA');
    await get('unknown sid on post', '/socket.io/?EIO=4&transport=polling&sid=AAAAAAAAAAAAAAAAAAAA', { method: 'POST', body: '40' });
    await get('last transport wins', '/socket.io/?EIO=4&transport=websocket&transport=nope');
    const { sid } = await handshake(base);
    await get('put on a session', `/socket.io/?EIO=4&transport=polling&sid=${sid}`, { method: 'PUT', body: '' });
    await get('websocket request on a polling session', `/socket.io/?EIO=4&transport=websocket&sid=${sid}`);
    return out;
  },
  async 'polling responses'(base) {
    const out = {};
    const { response, open } = await handshake(base, { 'accept-encoding': 'gzip', 'user-agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)' });
    out.handshake = describe(response, { body: 'none' });
    out.open = { ...open, sid: typeof open.sid };
    const path = `/socket.io/?EIO=4&transport=polling&sid=${open.sid}`;
    const text = { 'content-type': 'text/plain;charset=UTF-8' };
    const post = await request(base, path, { method: 'POST', body: '40/basic,{}', headers: text });
    out.post = describe(post, { body: 'text' });
    // An EVENT in the same payload as its CONNECT closes the session in the reference (the
    // socket joins on the next tick): send it once the CONNECT has been handled.
    await sleep(200);
    await request(base, path, { method: 'POST', body: '42/basic,["burst",60]', headers: text });
    await sleep(300);
    const poll = await request(base, path, { headers: { 'accept-encoding': 'gzip' } });
    const packets = decode(poll).toString('utf8').split('\x1e');
    out.poll = describe(poll, { body: 'none' });
    out['message packets'] = packets.filter((p) => p.startsWith('4')).length;
    out['first message'] = packets.find((p) => p.startsWith('4'))?.replace(/"sid":"[^"]+","pid":"[^"]+"/, '<ids>');
    const big = await request(base, path, { method: 'POST', body: 'x'.repeat(1_000_001), headers: text });
    out['oversized post'] = describe(big, { body: 'none' });
    return out;
  },
  async 'the app and other upgrades'(base) {
    const out = {};
    // The app is a stand-in on each side: only what reached it is compared.
    const hello = await request(base, '/hello');
    out.hello = { status: hello.status, body: hello.body.toString() };
    out['socket.io without slash'] = { status: (await request(base, '/socket.io')).status };
    out['socket.io prefix lookalike'] = { status: (await request(base, '/socket.iox/')).status };
    out['other path'] = { status: (await request(base, '/nope')).status };
    out['raw websocket'] = await new Promise((done) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/raw-ws`);
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (data) => {
        done({ message: data.toString() });
        ws.close();
      });
      ws.on('error', (error) => done({ error: error.message }));
    });
    out['bad upgrade'] = await new Promise((done) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/socket.io/?EIO=4&transport=carrier-pigeon`);
      ws.on('unexpected-response', (_req, res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      ws.on('open', () => done({ error: 'opened' }));
      ws.on('error', () => {});
    });
    return out;
  },
};

// ----- runner -------------------------------------------------------------------------------

const results = { client: {}, http: {} };
// The six combinations run side by side; within one, cases run one after another. Cases never
// share a namespace with another running case where an emit to the whole namespace is involved.
const combos = [];
for (const [version, client] of Object.entries(CLIENTS)) {
  for (const transport of Object.keys(TRANSPORTS)) combos.push([version, client, transport]);
}
await Promise.all(
  combos.map(async ([version, client, transport]) => {
    for (const [index, [name, run]] of Object.entries(cases).entries()) {
      if (only && !name.includes(only)) continue;
      const short = name.startsWith('short:');
      const r = new Run(client, transport, short ? SHORT : BASE);
      const tag = `t${version.replace(/\./g, '')}${transport}${index}`;
      process.stderr.write(`${new Date().toISOString()} ${version} ${transport} ${name}\n`);
      try {
        await run(r, tag);
      } catch (error) {
        r.log('case', 'threw', error.message);
      }
      r.close();
      await sleep(50);
      results.client[`${version} ${transport} ${name}`] = r.logs;
    }
  }),
);
// Stable order in the output.
results.client = Object.fromEntries(Object.entries(results.client).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
for (const [name, run] of Object.entries(httpCases)) {
  if (only && !name.includes(only)) continue;
  process.stderr.write(`http ${name}\n`);
  results.http[name] = await run(BASE);
}
writeFileSync(outputFile, `${JSON.stringify(results, null, 1)}\n`);
process.exit(0);
