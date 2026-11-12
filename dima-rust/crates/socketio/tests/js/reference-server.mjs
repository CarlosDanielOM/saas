// The reference side of the differential test: the installed socket.io 4.8.3 (dimabot's
// node_modules, not modified), configured like dimabot/src/server/websocket.ts, with the test
// namespaces that tests/support/namespaces.rs declares on the Rust side.
//
//   node tests/js/reference-server.mjs [<dimabot node_modules dir>]
//
// Prints one JSON line {"reference": <port>, "short": <port>} once both servers listen on
// 127.0.0.1: "reference" has the reference's own timings, "short" a 1 s connect timeout and a
// 1.5 s recovery window for the expiry cases, a 1 s upgrade timeout and a 400 ms ping interval
// (1.5 s ping timeout). Runs until stdin closes.
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modules = resolve(process.argv[2] ?? join(here, '../../../../../dimabot/node_modules'));
const require = createRequire(join(modules, 'noop.js'));
const { Server } = require('socket.io');
const { Adapter, SessionAwareAdapter } = require('socket.io-adapter');
const { WebSocketServer } = require('ws');
const version = require('socket.io/package.json').version;
if (version !== '4.8.3') throw new Error(`expected socket.io 4.8.3, found ${version}`);

// The adapter factory of pets/socket_adapter.ts: plain adapters for the namespaces that must
// never recover, the session-aware one for everything else.
const NO_RECOVERY = new Set(['/norec', '/control']);
function adapter(namespace) {
  return NO_RECOVERY.has(namespace.name) ? new Adapter(namespace) : new SessionAwareAdapter(namespace);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// The Express app stand-in: one route, the default 404 otherwise, and its own WebSocket
// endpoint on another path (like /v1/desktop/ws next to /socket.io/).
function app(req, res) {
  if (req.url === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('hello from the app');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`Cannot ${req.method} ${req.url}`);
}

function start(options) {
  const server = http.createServer(app);
  const io = new Server(server, { connectionStateRecovery: {}, adapter, destroyUpgrade: false, ...options });
  const raw = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/raw-ws') return; // left to other listeners, as destroyUpgrade: false does
    raw.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(`app:${data}`)));
  });

  // Offsets only, no sessions (the overlay families).
  const noPersist = /^\/nopersist\/\w+$/;
  io.on('new_namespace', (child) => {
    if (noPersist.test(child.name)) child.adapter.persistSession = () => {};
  });

  // The last socket per auth.tag in /basic and /fam/*, kept after it disconnects (server code holding a
  // socket object, as the reference's handlers do).
  const tagged = new Map();

  function events(socket) {
    const nsp = socket.nsp;
    socket.on('echo', (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      if (ack) ack(...args);
      else socket.emit('echo', ...args);
    });
    socket.on('1', (...args) => socket.emit('one', ...args));
    socket.on('ack-multi', (ack) => ack(1, 'two', { three: [3] }, null));
    socket.on('ack-empty', (ack) => ack());
    socket.on('ack-twice', (ack) => {
      ack('first');
      ack('second');
    });
    socket.on('no-ack', () => {});
    socket.on('ask', async (payload) => {
      try {
        const reply = await socket.timeout(2000).emitWithAck('question', payload);
        socket.emit('answer', { ok: true, reply });
      } catch (error) {
        socket.emit('answer', { ok: false, error: error.message });
      }
    });
    socket.on('ask-silent', async () => {
      try {
        await socket.timeout(300).emitWithAck('question-silent');
        socket.emit('answer', { ok: true });
      } catch (error) {
        socket.emit('answer', { ok: false, error: error.message });
      }
    });
    socket.on('bye', () => socket.disconnect());
    socket.on('bye-all', () => socket.disconnect(true));
    socket.on('broadcast', (value) => nsp.emit('broadcast', value));
    socket.on('burst', (count) => {
      for (let i = 0; i < count; i++) socket.emit('seq', i);
    });
    socket.on('texts', () =>
      socket.emit('texts', {
        emoji: '😀👍🏽',
        combining: 'é',
        rtl: 'שלום עולם',
        zwj: '👨‍👩‍👧',
        separators: 'a b c',
        keys: { b: 1, 2: 2, a: 3, 1: 4 },
        numbers: [1e21, -0, 0.1 + 0.2, 9007199254740993, 1.5e-7, 123456789012],
      }),
    );
    socket.on('count', async (ack) => ack((await nsp.fetchSockets()).length));
  }

  function welcome(socket) {
    const { auth, query } = socket.handshake;
    socket.emit('welcome', {
      recovered: socket.recovered,
      nsp: socket.nsp.name,
      x: query.x ?? null,
      token: auth.token ?? null,
      tag: auth.tag ?? null,
    });
  }

  // /basic: full recovery, a connect check with every refusal shape.
  const basic = io.of('/basic');
  basic.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (token === 'bad') {
      const error = new Error('Invalid token');
      error.data = { code: 'bad_token', n: 1 };
      return next(error);
    }
    if (token === 'plain') return next(new Error('Plain refusal'));
    if (token === 'slow') await delay(200);
    next();
  });
  basic.on('connection', (socket) => {
    if (socket.handshake.auth.tag) tagged.set(socket.handshake.auth.tag, socket);
    welcome(socket);
    events(socket);
  });

  // /norec: the plain adapter (no offsets, no sessions), like /desktop.
  io.of('/norec').on('connection', (socket) => {
    welcome(socket);
    events(socket);
  });

  // A family with recovery; `_deny` names are refused, `quiet` ones send nothing on connect.
  io.of(/^\/fam\/\w+$/)
    .use((socket, next) => {
      if (socket.nsp.name.endsWith('_deny')) {
        const error = new Error('Denied');
        error.data = { nsp: socket.nsp.name };
        return next(error);
      }
      next();
    })
    .on('connection', (socket) => {
      if (socket.handshake.auth.tag) tagged.set(socket.handshake.auth.tag, socket);
      if (!socket.nsp.name.includes('quiet')) welcome(socket);
      events(socket);
    });
  // Two families where a name may match both: the first declared wins.
  io.of(/^\/pick\/[a-f0-9]{4}$/).on('connection', (socket) => socket.emit('which', 1));
  io.of(/^\/pick\/\w+$/).on('connection', (socket) => socket.emit('which', 2));
  io.of(/^\/digits\/[0-9]{1,3}$/).on('connection', (socket) => socket.emit('which', 3));
  // Offsets without sessions.
  io.of(noPersist).on('connection', (socket) => {
    welcome(socket);
    events(socket);
  });

  // The test's remote control: server-side emits while a client is away.
  io.of('/control').on('connection', (socket) => {
    socket.on('nsp-emit', (name, payload, ack) => {
      io.of(name).emit('pushed', payload);
      ack('done');
    });
    socket.on('direct-emit', (tag, payload, ack) => {
      const target = tagged.get(tag);
      if (target) target.emit('direct', payload);
      ack(target ? 'done' : 'unknown');
    });
    socket.on('direct-ask', async (tag, ack) => {
      const target = tagged.get(tag);
      try {
        await target.timeout(200).emitWithAck('question', 'while-away');
        ack('answered');
      } catch (error) {
        ack(error.message);
      }
    });
    socket.on('count', async (name, ack) => ack((await io.of(name).fetchSockets()).length));
  });

  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

const ports = {
  reference: await start({}),
  short: await start({
    connectTimeout: 1000,
    connectionStateRecovery: { maxDisconnectionDuration: 1500 },
    upgradeTimeout: 1000,
    pingInterval: 400,
    pingTimeout: 1500,
  }),
};
process.stdout.write(`${JSON.stringify(ports)}\n`);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
