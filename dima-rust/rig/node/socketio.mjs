// JSON-lines RPC. stdout is protocol only. EOF owns and closes every client.
import readline from 'node:readline';
import { io as io483 } from 'client-4.8.3';
import { io as io475 } from 'client-4.7.5';
const clients = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CLIENTS = 64;
let queuedBytes = 0;
function push(c, item) {
  if (c.queue.length >= MAX || queuedBytes + Buffer.byteLength(JSON.stringify(item)) > MAX_BYTES) { c.overflow = true; c.socket.disconnect(); }
  else { queuedBytes += Buffer.byteLength(JSON.stringify(item)); c.queue.push(item); }
}
function take(c, count = c.queue.length) {
  const items = c.queue.splice(0, count);
  queuedBytes -= items.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), 0);
  return items;
}
async function until(c, test, ms, what) {
  const end = Date.now() + ms;
  while (!test()) {
    if (c.overflow) throw Error('Socket.IO observation queue exceeded 4096 entries or the global 32 MiB limit');
    if (Date.now() >= end) throw Error(`Socket.IO ${what} timed out after ${ms} ms; pending: ${JSON.stringify(c.queue)}`);
    await sleep(5);
  }
  if (c.overflow) throw Error('Socket.IO observation queue exceeded 4096 entries or the global 32 MiB limit');
}
async function command(x) {
  const ms = x.timeout_ms ?? 5000;
  if (x.action === 'open') {
    if (clients.size >= MAX_CLIENTS) throw Error('Socket.IO client limit exceeded (64)');
    if (clients.has(x.client)) throw Error(`duplicate client ${x.client}`);
    const io = x.version === '4.7.5' ? io475 : io483;
    const socket = io(x.url + x.namespace, { autoConnect: false, forceNew: true,
      reconnection: false, transports: x.transports, auth: x.auth, timeout: ms });
    const c = { socket, queue: [], overflow: false };
    clients.set(x.client, c);
    socket.on('connect', () => push(c, {type: 'connect', recovered: socket.recovered}));
    socket.on('connect_error', e => push(c, {type: 'connect_error', message: e.message, ...(e.data === undefined ? {} : {data: e.data})}));
    socket.on('disconnect', reason => push(c, {type: 'disconnect', reason}));
    socket.onAny((event, ...args) => push(c, {type: 'event', event, args}));
    socket.connect();
    await until(c, () => c.queue.some(e => ['connect', 'connect_error'].includes(e.type)), ms, 'connect');
    // Leave early application events for wait; the lifecycle result is first.
    return take(c, 1);
  }
  const c = clients.get(x.client);
  if (!c) throw Error(`unknown Socket.IO client ${x.client}`);
  if (c.overflow) throw Error('Socket.IO observation queue exceeded 4096 entries or the global 32 MiB limit');
  switch (x.action) {
    case 'emit': {
      if (!c.socket.connected) throw Error('cannot emit on a disconnected client');
      if (!x.ack) { c.socket.emit(x.event, ...x.args); return []; }
      return await new Promise(resolve => c.socket.timeout(ms).emit(x.event, ...x.args,
        (e, ...args) => resolve([{type: 'ack', event: x.event, timeout: !!e, args}])));
    }
    case 'wait':
      await until(c, () => c.queue.length >= x.count, ms, `wait for ${x.count} observations`);
      return take(c, x.count);
    case 'quiet':
      await sleep(ms);
      if (c.overflow || c.queue.length) throw Error(`unexpected Socket.IO observations for ${x.client}: ${JSON.stringify(c.queue)}`);
      return [];
    case 'disconnect':
      if (!c.socket.connected) throw Error('cannot disconnect a client that is not connected');
      if (x.transport) c.socket.io.engine.close(); else c.socket.disconnect();
      await until(c, () => c.queue.some(e => e.type === 'disconnect'), ms, 'disconnect');
      return take(c, c.queue.findIndex(e => e.type === 'disconnect') + 1);
    case 'reconnect':
      if (c.socket.connected) throw Error('cannot reconnect a connected client');
      c.socket.connect();
      await until(c, () => c.queue.some(e => ['connect', 'connect_error'].includes(e.type)), ms, 'reconnect');
      return take(c, c.queue.findIndex(e => ['connect', 'connect_error'].includes(e.type)) + 1);
    default: throw Error(`unknown action ${x.action}`);
  }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of input) {
    if (Buffer.byteLength(line) > 1024 * 1024) throw Error('command exceeds 1 MiB');
    try {
      const response = JSON.stringify({ok: await command(JSON.parse(line))});
      if (Buffer.byteLength(response) > MAX_BYTES) throw Error('Socket.IO result exceeds 32 MiB');
      process.stdout.write(response + '\n');
    }
    catch (e) { process.stdout.write(JSON.stringify({error: e.message}) + '\n'); }
  }
} finally {
  for (const c of clients.values()) c.socket.disconnect();
}
