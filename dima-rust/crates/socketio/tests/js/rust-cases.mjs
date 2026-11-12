// Cases for behaviour of the Rust server that the reference does not have (its bounds and the
// checks it adds), driven by the real JavaScript clients. Run by `../recovery_js.rs`, which
// starts the server (the test namespaces of `../support/mod.rs` with a 4 kB recovery store per
// namespace) and asserts on what the clients saw.
//
//   node tests/js/rust-cases.mjs <port> <output file>
//
// Output: `{ "<client> <transport> <case>": { "<label>": [entries…] } }`.
import { writeFileSync } from 'node:fs';
import { io as io483 } from 'client-4.8.3';
import { io as io475 } from 'client-4.7.5';

const [port, outputFile] = process.argv.slice(2);
if (!port || !outputFile) throw new Error('usage: rust-cases.mjs <port> <output file>');
const BASE = `http://127.0.0.1:${port}`;
const CLIENTS = { '4.8.3': io483, '4.7.5': io475 };
const TRANSPORTS = { polling: ['polling'], websocket: ['websocket'] };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Run {
  constructor(io, transports) {
    this.io = io;
    this.transports = transports;
    this.logs = {};
    this.sockets = [];
  }

  log(label, ...entry) {
    (this.logs[label] ??= []).push(entry);
  }

  socket(nsp, label, extra = {}) {
    const socket = this.io(`${BASE}${nsp}`, {
      forceNew: true,
      transports: this.transports,
      reconnectionDelay: 100,
      reconnectionDelayMax: 100,
      randomizationFactor: 0,
      ...extra,
    });
    this.sockets.push(socket);
    socket.on('connect', () => this.log(label, 'connect', { recovered: socket.recovered }));
    socket.on('connect_error', (error) => this.log(label, 'connect_error', error.message));
    socket.on('disconnect', (reason) => this.log(label, 'disconnect', reason));
    socket.onAny((event, ...args) => {
      const first = args[0];
      // Long payloads are logged by their length.
      this.log(label, 'event', event, typeof first === 'string' && first.length > 64 ? first.length : first ?? null);
    });
    return socket;
  }

  count(label, kind, name) {
    return (this.logs[label] ?? []).filter((e) => e[0] === kind && (name === undefined || e[1] === name)).length;
  }

  async until(label, kind, name, times = 1, timeout = 5000) {
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

  close() {
    for (const socket of this.sockets) socket.disconnect();
  }
}

const cases = {
  // The store keeps 4 kB per namespace: a small event missed while away is replayed.
  async 'a small missed event is replayed'(run, tag) {
    const nsp = `/fam/small_${tag}`;
    const control = run.socket('/control', 'control');
    await run.until('control', 'connect');
    const s = run.socket(nsp, 'a');
    await run.until('a', 'event', 'welcome');
    s.once('disconnect', async () => {
      run.log('control', 'ack', await control.emitWithAck('nsp-emit', nsp, 'small'));
    });
    s.io.engine.close();
    await run.until('a', 'connect', undefined, 2);
    await run.until('a', 'event', 'pushed');
    await sleep(100);
  },
  // Finding 8: an event too large to store is missed while away. The reference stores it and
  // replays it; here it cannot be stored, so the recovery fails and the client connects fresh
  // (never a "successful" recovery without it).
  async 'an event too large to store breaks recovery'(run, tag) {
    const nsp = `/fam/large_${tag}`;
    const control = run.socket('/control', 'control');
    await run.until('control', 'connect');
    const s = run.socket(nsp, 'a');
    await run.until('a', 'event', 'welcome');
    s.once('disconnect', async () => {
      run.log('control', 'ack', await control.emitWithAck('nsp-emit', nsp, 'x'.repeat(5000)));
      run.log('control', 'ack', await control.emitWithAck('nsp-emit', nsp, 'after'));
    });
    s.io.engine.close();
    await run.until('a', 'connect', undefined, 2);
    await run.until('a', 'event', 'welcome', 2);
    await sleep(200);
  },
  // Finding 8: the large event reaches a connected client live.
  async 'an event too large to store is still delivered live'(run, tag) {
    const nsp = `/fam/live_${tag}`;
    const control = run.socket('/control', 'control');
    await run.until('control', 'connect');
    run.socket(nsp, 'a');
    await run.until('a', 'event', 'welcome');
    run.log('control', 'ack', await control.emitWithAck('nsp-emit', nsp, 'y'.repeat(5000)));
    await run.until('a', 'event', 'pushed');
  },
};

const results = {};
for (const [version, io] of Object.entries(CLIENTS)) {
  for (const [transport, transports] of Object.entries(TRANSPORTS)) {
    for (const [index, [name, run]] of Object.entries(cases).entries()) {
      const r = new Run(io, transports);
      const tag = `r${version.replace(/\./g, '')}${transport}${index}`;
      process.stderr.write(`${version} ${transport} ${name}\n`);
      try {
        await run(r, tag);
      } catch (error) {
        r.log('case', 'threw', error.message);
      }
      r.close();
      await sleep(50);
      results[`${version} ${transport} ${name}`] = r.logs;
    }
  }
}
writeFileSync(outputFile, `${JSON.stringify(results, null, 1)}\n`);
process.exit(0);
