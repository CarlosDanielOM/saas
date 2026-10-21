// Fixed disposable Mongo upstream; copied/adapted from raid-sessions hard-watchdog fixture.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer, createConnection} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {ownedBulkWrite} from './lifecycle-assertions.mjs';
const {BSON}=createRequire('/app/package.json')('mongodb');
const dbPattern=/^dashboard_activity_fixture_[a-zA-Z0-9_]+$/;
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function waitFor(check,label){const end=Date.now()+15000;do{const result=await check();if(result)return result;await delay(30);}while(Date.now()<end);throw new Error(label);}
function assertWatchdogResetTiming(errors, exitedAt) {
    assert(Number.isFinite(exitedAt), 'confirmed native exit needs a monotonic timestamp');
    for (const error of errors) {
        assert.equal(error.kind, 'transport', 'watchdog cannot excuse parser/proxy failures');
        assert.equal(error.side, 'client', 'watchdog cannot excuse upstream failures');
        assert.equal(error.code, 'ECONNRESET', 'watchdog excuses only abrupt client resets');
        assert.equal(error.clientEof, false, 'FIN teardown follows the existing EOF/EPIPE rules');
        assert.equal(error.held, true); assert.equal(error.released, false);
        assert(Math.abs(error.at - exitedAt) <= 250, 'client reset must coincide within 250ms of confirmed hard exit');
    }
}
// Fixed alias upstream; parses actual uncompressed Mongo commands, holds exactly one.
export async function mongoHoldProxy(db, predicate) {
    assert.match(db.databaseName, dbPattern);
    const sockets = new Set();
    let failure, held, released = false, closing = false, pingSeen = false;
    const parsed = [], failures = [];
    const transport = { clientEofs: 0, upstreamEofs: 0, teardownEpipe: 0 };
    const fail = (error, detail = { kind: 'proxy' }) => {
        failures.push({ ...detail, at: performance.now(), held: Boolean(held), released });
        failure ||= error instanceof Error ? error : new Error(String(error));
        for (const socket of sockets) socket.destroy();
    };
    const server = createServer(downstream => {
        sockets.add(downstream);
        const upstream = createConnection({ host: 'mongo', port: 27017 });
        sockets.add(upstream);
        let pending = Buffer.alloc(0), blocked = false, clientEof = false;
        const queued = [];
        let queuedBytes = 0;
        const stopPair = () => {
            upstream.unpipe(downstream);
            upstream.destroy(); downstream.destroy();
        };
        // With allowHalfOpen=false, Node changes downstream.write to
        // writeAfterFIN at 'end'. Waiting for 'close' leaves a window in which
        // an in-flight Mongo response can be piped into an ended socket.
        downstream.on('end', () => { clientEof = true; transport.clientEofs++; stopPair(); });
        downstream.on('close', () => { sockets.delete(downstream); stopPair(); });
        upstream.on('end', () => {
            transport.upstreamEofs++;
            if (!closing && !clientEof) fail(new Error('Mongo fixture upstream EOF before client teardown'));
            stopPair();
        });
        upstream.on('close', () => { sockets.delete(upstream); stopPair(); });
        for (const [side, socket] of [['client', downstream], ['upstream', upstream]]) socket.on('error', error => {
            if (closing) return;
            // Only a write-after-FIN following an observed client EOF belongs
            // to normal child teardown. Pre-EOF EPIPE and all other errors
            // still fail the fixture; canceled Mongo requests are not released.
            if (clientEof && error.code === 'EPIPE') { transport.teardownEpipe++; return; }
            fail(new Error(`Mongo fixture ${side} transport failed (${error.code || 'unknown'}, clientEof=${clientEof})`, { cause: error }),
                { kind: 'transport', side, code: error.code, clientEof });
        });
        upstream.pipe(downstream);
        downstream.on('data', chunk => {
            try {
                pending = Buffer.concat([pending, chunk]);
                if (pending.length > 16 * 1024 * 1024) throw new Error('Mongo fixture proxy received oversized frame');
                while (pending.length >= 16) {
                    const length = pending.readInt32LE(0), opcode = pending.readInt32LE(12);
                    assert(length >= 21 && length <= 16 * 1024 * 1024, 'invalid Mongo fixture frame length');
                    if (pending.length < length) break;
                    const packet = Buffer.from(pending.subarray(0, length)); pending = pending.subarray(length);
                    let body, database;
                    if (opcode === 2013) { // OP_MSG: header, flags, kind-0 BSON command body.
                        const flags = packet.readUInt32LE(16);
                        assert.equal(flags & ~0x10003, 0, 'unsupported Mongo OP_MSG flags');
                        assert.equal(packet[20], 0, 'Mongo command must start with section kind 0');
                        const bodyLength = packet.readInt32LE(21), end = 21 + bodyLength;
                        assert(bodyLength >= 5 && end <= length - (flags & 1 ? 4 : 0), 'invalid Mongo command BSON boundary');
                        body = BSON.deserialize(packet.subarray(21, end)); database = body.$db;
                        let offset = end;
                        while (offset < length - (flags & 1 ? 4 : 0)) {
                            assert.equal(packet[offset++], 1, 'only BSON document sequences follow command body');
                            const sectionStart = offset, sectionSize = packet.readInt32LE(offset); offset += 4;
                            const identifierEnd = packet.indexOf(0, offset);
                            assert(identifierEnd > offset && identifierEnd < sectionStart + sectionSize);
                            const identifier = packet.toString('utf8', offset, identifierEnd); offset = identifierEnd + 1;
                            body[identifier] = [];
                            while (offset < sectionStart + sectionSize) {
                                const size = packet.readInt32LE(offset); assert(size >= 5 && offset + size <= sectionStart + sectionSize);
                                body[identifier].push(BSON.deserialize(packet.subarray(offset, offset + size))); offset += size;
                            }
                            assert.equal(offset, sectionStart + sectionSize);
                        }
                    } else if (opcode === 2004) { // A legacy initial hello is safe to forward after inspection.
                        const end = packet.indexOf(0, 20);
                        assert(end > 20 && end + 9 < length, 'invalid Mongo OP_QUERY handshake');
                        const namespace = packet.toString('utf8', 20, end);
                        assert.equal(namespace, 'admin.$cmd', 'OP_QUERY is allowed only for initial admin hello');
                        body = BSON.deserialize(packet.subarray(end + 9)); database = 'admin';
                        assert(['hello', 'isMaster', 'ismaster'].some(key => key in body), 'unsupported legacy Mongo command');
                    } else throw new Error(`Unsupported Mongo fixture opcode ${opcode}; compression must remain disabled`);
                    const name = Object.keys(body)[0];
                    assert(database === db.databaseName || database === 'admin', 'proxy command escaped owned fixture database');
                    const ownedBulk = name === 'bulkWrite' && ownedBulkWrite(body, db.databaseName);
                    if (database === 'admin') assert(ownedBulk || ['hello', 'isMaster', 'ismaster', 'ping', 'endSessions'].includes(name), 'unexpected/unowned Mongo admin command');
                    if (name === 'ping' && database === 'admin') pingSeen = true;
                    parsed.push({ name, database, body, at: performance.now() });
                    if (!released && !held && (database === db.databaseName || ownedBulk) && predicate(body)) {
                        assert.equal(opcode, 2013, 'held fixture operation must be uncompressed OP_MSG');
                        assert(pingSeen, 'Mongo utility must complete its initial admin ping before the held pass');
                        blocked = true;
                        held = { at: Date.now(), body, release: () => {
                            if (released) return;
                            assert(!clientEof && !upstream.destroyed && !upstream.writableEnded,
                                'cannot release held Mongo command after its client/upstream has ended');
                            released = true; blocked = false;
                            upstream.write(packet); for (const next of queued) upstream.write(next);
                            queued.length = 0; queuedBytes = 0;
                        } };
                    } else if (blocked) {
                        queuedBytes += packet.length;
                        assert(queuedBytes <= 16 * 1024 * 1024, 'Mongo fixture hold queue exceeded bound');
                        queued.push(packet);
                    } else upstream.write(packet);
                }
            } catch (error) { fail(error); }
        });
    });
    server.on('error', fail);
    const proxy = {
        check() { if (failure) throw failure; },
        checkConfirmedWatchdogExit(result, elapsed) {
            assert.equal(result.code, 1); assert.equal(result.signal, null);
            assert(elapsed >= 38000 && elapsed <= 47000, 'native exit must match the hard watchdog window');
            assert(!result.output.split('\n').some(line => line.startsWith('dashboard_activity:')), 'hard watchdog emits no completed batch');
            assert.match(result.output, /Dashboard activity active work exceeded 40-second watchdog; durable work retained for recovery/);
            assert(held && !released, 'hard exit must leave the actual selected command unforwarded');
            assertWatchdogResetTiming(failures, result.exitedAt);
        },
        snapshot: () => ({ ...transport, held: Boolean(held), released, activeSockets: sockets.size, failures: failures.map(row => ({ ...row })) }),
        async held() { return waitFor(() => { proxy.check(); return held; }, 'proxy holds selected actual Mongo command'); },
        release() { proxy.check(); assert(held, 'selected command must be held before release'); held.release(); },
        parsed,
        async close() {
            if (closing) return;
            closing = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), 3000, 'close owned Mongo proxy');

        },
    };

    await bounded(new Promise((resolve, reject) => {
        server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    }), 3000, 'listen on isolated loopback Mongo proxy');
    const address = server.address(); assert(address && typeof address === 'object' && address.address === '127.0.0.1');
    proxy.uri = `mongodb://127.0.0.1:${address.port}/${db.databaseName}?directConnection=true`;
    return proxy;
}
