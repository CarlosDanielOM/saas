import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { Server, type Namespace, type Socket } from 'socket.io';
import { Adapter, SessionAwareAdapter } from 'socket.io-adapter';
import { WebSocket } from 'ws';
import { petSocketAdapter } from './socket_adapter.js';

/** Real Engine.IO/Socket.IO wire, without a client parser that can discard extra arguments. */
test('pet namespaces emit two-argument events without recovery state; unrelated recovery is preserved', { timeout: 10_000 }, async context => {
    // The installed SessionAwareAdapter's close() does not clear its constructor's
    // private 60s interval. Observe construction and explicitly close test-owned
    // unrelated-namespace intervals; pet namespaces must never create any.
    const intervals = context.mock.method(globalThis, 'setInterval');
    const http = createServer();
    const io = new Server(http, { connectionStateRecovery: {}, adapter: petSocketAdapter });
    const clients = new Set<WebSocket>();
    context.after(async () => {
        for (const client of clients) client.terminate();
        try { await io.close(); }
        finally { for (const call of intervals.mock.calls) if (call.arguments[1] === 60_000 && call.result) clearInterval(call.result); }
    });
    const recoveryTimers = () => intervals.mock.calls.filter(call => call.arguments[1] === 60_000).length;
    const unrelated = io.of('/existing');
    assert.equal(recoveryTimers(), 2, 'only root and unrelated namespaces construct recovery adapters');
    for (const name of ['/desktop', '/pet']) {
        const namespace = io.of(name);
        assert.equal(namespace.adapter.constructor, Adapter);
        assert.equal(namespace.adapter instanceof SessionAwareAdapter, false);
        namespace.on('connection', socket => {
            if (name === '/desktop') socket.emit('desktop:hello', { v: 1, recovered: socket.recovered });
            socket.emit('pet:snapshot', { v: 1, recovered: socket.recovered });
        });
    }
    assert.equal(recoveryTimers(), 2, 'no replaced recovery adapters, stranded intervals or packet buffers for pets');
    assert.equal(unrelated.adapter.constructor, SessionAwareAdapter);
    unrelated.on('connection', socket => socket.emit('existing:hello', { recovered: socket.recovered }));
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    const url = `ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`;

    async function connect(namespace: Namespace, auth: Record<string, string> = {}) {
        const ws = new WebSocket(url); clients.add(ws);
        const changes = new EventEmitter();
        const events: unknown[][] = [];
        let hello: { sid: string; pid: string } | undefined;
        ws.on('message', raw => {
            const packet = raw.toString();
            if (packet === '2') return ws.send('3');
            if (packet.startsWith('0')) return ws.send(`40${namespace.name},${JSON.stringify(auth)}`);
            if (packet.startsWith(`40${namespace.name},`)) hello = JSON.parse(packet.slice(`40${namespace.name},`.length));
            if (packet.startsWith(`42${namespace.name},`)) events.push(JSON.parse(packet.slice(`42${namespace.name},`.length)));
            changes.emit('change');
        });
        ws.on('error', () => changes.emit('change'));
        async function wait<T>(read: () => T | undefined): Promise<T> {
            const signal = AbortSignal.timeout(2000);
            for (;;) {
                const result = read(); if (result !== undefined) return result;
                await once(changes, 'change', { signal });
            }
        }
        await wait(() => hello);
        return { ws, events, hello: hello!, event: (name: string) => wait(() => events.find(packet => packet[0] === name)) };
    }
    async function disconnect(client: Awaited<ReturnType<typeof connect>>, namespace: Namespace) {
        const socket = namespace.sockets.get(client.hello.sid); assert.ok(socket);
        const stopped = once(socket, 'disconnect'); client.ws.terminate(); await stopped;
        return socket;
    }
    for (const name of ['/desktop', '/pet']) {
        const namespace = io.of(name), first = await connect(namespace);
        await first.event('pet:snapshot');
        namespace.emit('pet:request', { v: 1 });
        const request = await first.event('pet:request');
        assert.equal(request.length, 2);
        for (const packet of first.events) {
            assert.equal(packet.length, 2, `${name} must never append a recovery offset`);
            assert.equal(typeof packet[0], 'string');
            assert.ok(packet[1] && typeof packet[1] === 'object' && !Array.isArray(packet[1]));
        }
        await disconnect(first, namespace);
        // Exercise the ordinary exported methods as well as real disconnect;
        // neither creates a session/packet retention structure.
        namespace.adapter.persistSession({ sid: first.hello.sid, pid: first.hello.pid, rooms: [first.hello.sid], data: {} });
        namespace.emit('pet:offline', { v: 1 });
        assert.equal(namespace.adapter.rooms.size, 0); assert.equal(namespace.adapter.sids.size, 0);
        assert.equal(await namespace.adapter.restoreSession(first.hello.pid, 'untrusted-offset'), null);
        assert.equal('sessions' in namespace.adapter, false);
        assert.equal('packets' in namespace.adapter, false);
        const next = await connect(namespace, { pid: first.hello.pid, offset: 'untrusted-offset' });
        const snapshot = await next.event('pet:snapshot');
        assert.equal(next.hello.sid === first.hello.sid, false);
        assert.equal((snapshot[1] as { recovered: boolean }).recovered, false);
        assert.ok(next.events.every(packet => packet.length === 2 && packet[0] !== 'pet:offline'), 'fresh connection has no replay');
        await disconnect(next, namespace);
    }
    const site = await connect(unrelated);
    const initial = await site.event('existing:hello');
    assert.equal(initial.length, 3, 'existing namespace retains its recovery offset');
    assert.equal(typeof initial[2], 'string');
    await disconnect(site, unrelated);
    unrelated.emit('existing:missed', { value: 1 });
    const restored = await connect(unrelated, { pid: site.hello.pid, offset: initial[2] as string });
    assert.equal(restored.hello.sid, site.hello.sid, 'existing namespace still restores its actual session');
    assert.deepEqual((await restored.event('existing:missed')).slice(0, 2), ['existing:missed', { value: 1 }]);
    const socket: Socket | undefined = unrelated.sockets.get(restored.hello.sid);
    assert.equal(socket?.recovered, true);
    assert.equal(recoveryTimers(), 2, 'connecting or recovering pet peers constructs no adapters/timers');
});
