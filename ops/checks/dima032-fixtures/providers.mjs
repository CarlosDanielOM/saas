// Materialize runtime-providers.mjs and its oauth-providers.mjs from existing fixtures.
import './startup.mjs';
import './runtime-providers.mjs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const { createClient } = createRequire('/app/package.json')('redis');
if (!/^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/.test(process.env.MONGO_URI || '') || process.env.PIPER_HTTP_URL !== 'http://pet-piper.test') throw new Error('DIMA032 fixtures require disposable Mongo/Redis and mock providers');
// Fixture-only command mailbox invokes the actual API singleton; no application test endpoint.
if ((process.argv[1] || '').endsWith('/dist/server/index.js')) {
    const cache = createClient({ url: 'redis://redis:6379' }); await cache.connect();
    // Delay responses of real disposable Mongo operations, never replace results.
    // These barriers exercise cancellation across CAS, retained upload and delivery persistence.
    const { PetRuntime, PetRequest } = await import('/app/dist/schemas/pet_runtime.schema.js');
    const controlReadFault = new AsyncLocalStorage();
    const findPrivateRequest = PetRequest.findById;
    PetRequest.findById = function (id, ...args) {
        const query = findPrivateRequest.call(this, id, ...args), fault = controlReadFault.getStore();
        if (fault?.requestId === String(id)) {
            const lean = query.lean;
            query.lean = async function (...options) {
                const result = await lean.apply(this, options);
                if (!fault.remaining) return result;
                fault.remaining--; fault.injected++;
                await barrier('release-read');
                throw new Error('DIMA032 fixture lost private request read reply');
            };
        }
        return query;
    };
    const terminalRequest = PetRequest.findOneAndUpdate;
    PetRequest.findOneAndUpdate = function (filter, update, ...args) {
        const query = terminalRequest.call(this, filter, update, ...args), fault = controlReadFault.getStore();
        if (fault && fault.requestId === filter?._id && fault.injected === 1 && update?.$set?.status === 'cancelled') {
            const exec = query.exec;
            query.exec = async function (...options) { await barrier('release-retry'); return exec.apply(this, options); };
        }
        return query;
    };
    async function observePrivateBoundary(boundary, request) {
        const raw = await cache.get('dima032:test:private-boundary');
        if (!raw || request?.operation !== 'tts' || request.origin?.kind !== 'tts-queue') return;
        const target = JSON.parse(raw);
        if (request.origin.id !== target.successorSpeechId) return;
        // Bypass the injected control-read wrapper, but execute the original real
        // Mongo read. Observing a bad boundary must not hold or stub creation.
        const prior = await findPrivateRequest.call(PetRequest, target.priorRequestId).lean();
        await cache.rPush('dima032:test:private-boundary-states', JSON.stringify({ boundary, requestId: String(request._id),
            speechId: request.origin.id, generation: request.generation, priorRequestId: target.priorRequestId,
            priorGeneration: prior?.generation ?? null, priorStatus: prior?.status ?? null }));
    }
    const createPrivateRequest = PetRequest.create;
    PetRequest.create = async function (request, ...args) {
        await observePrivateBoundary('create', request);
        return createPrivateRequest.call(this, request, ...args);
    };
    const originalClaim = PetRuntime.findOneAndUpdate;
    async function barrier(kind) {
        if (!await cache.get(`dima032:test:hold:${kind}`)) return;
        await cache.set(`dima032:test:entered:${kind}`, 'true', { EX: 60 });
        while (await cache.get(`dima032:test:hold:${kind}`)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    PetRuntime.findOneAndUpdate = function (filter, update, ...args) {
        const query = originalClaim.call(this, filter, update, ...args);
        if (update?.$set?.ttsReservation) {
            const lean = query.lean;
            query.lean = async function (...options) { const result = await lean.apply(this, options); await barrier('cas'); return result; };
        }
        return query;
    };
    const originalRequestUpdate = PetRequest.updateOne;
    PetRequest.updateOne = function (filter, update, ...args) {
        const query = originalRequestUpdate.call(this, filter, update, ...args);
        if (update?.$set?.deliveryAttempted) {
            const exec = query.exec;
            query.exec = async function (...options) {
                if (await cache.exists('dima032:test:private-boundary')) {
                    const request = await findPrivateRequest.call(PetRequest, filter._id).lean();
                    await observePrivateBoundary('delivery-attempt', request);
                }
                const result = await exec.apply(this, options); await barrier('private'); return result;
            };
        }
        return query;
    };
    const inheritedFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.hostname === 'pet-piper.test') {
            const priorId = await cache.get('dima032:test:terminal-before-provider');
            if (priorId) {
                const prior = await findPrivateRequest.call(PetRequest, priorId).lean();
                await cache.rPush('dima032:test:provider-prior-private-state', JSON.stringify({ requestId: priorId, status: prior?.status ?? null }));
            }
        }
        const response = await inheritedFetch(input, options);
        if (url.hostname !== 'pet-piper.test') return response;
        await barrier('synthesis');
        if (!await cache.get('dima032:test:long-audio')) return response;
        const bytes = 16000 * 2 * 300, wav = Buffer.alloc(44 + bytes);
        wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
        return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    };
    const mongoose = createRequire('/app/package.json')('mongoose');
    let configurationReads = 0;
    const settingsRead = mongoose.mongo.Collection.prototype.findOne;
    mongoose.mongo.Collection.prototype.findOne = function (...args) {
        if (this.collectionName === 'pet_settings') configurationReads++;
        return settingsRead.apply(this, args);
    };
    for (const method of ['insertOne', 'replaceOne']) {
        const original = mongoose.mongo.Collection.prototype[method];
        mongoose.mongo.Collection.prototype[method] = async function (...args) {
            const result = await original.apply(this, args);
            if (method === 'insertOne' && this.collectionName === 'overlay_media.files' && args[0]?.filename === 'overlay-playback') await barrier('retain');
            if (method === 'replaceOne' && this.collectionName === 'overlay_deliveries' && args[1]?.event?.tts) await barrier('persist');
            return result;
        };
    }
    let busy = false, wrappedQueueCache = false;
    const ownedCapacityClaims = new Set();
    setInterval(() => { if (busy) return; busy = true; void (async () => {
        const raw = await cache.lPop('dima032:test:commands'); if (!raw) return;
        const command = JSON.parse(raw); let result;
        try {
            const { ttsQueueHandler } = await import('/app/dist/handlers/tts_queue.handler.js');
            if (!wrappedQueueCache) {
                const actual = ttsQueueHandler.cache;
                if (actual) {
                    ttsQueueHandler.cache = new Proxy(actual, { get(target, property) {
                        if (property === 'eval') return async (...args) => {
                            const result = await actual.eval(...args);
                            if (String(args[0]).includes('DIMA032_POP') && result?.length === 3) await barrier('redis-pop');
                            return result;
                        };
                        if (property === 'set') return async (...args) => {
                            const result = await actual.set(...args);
                            if (String(args[0]).endsWith(':tts:processing') && args[1] !== 'pending') await barrier('processing-set');
                            return result;
                        };
                        if (property !== 'del') return Reflect.get(target, property);
                        return async (...args) => {
                            const result = await actual.del(...args);
                            if (String(args[0]).endsWith(':tts:processing')) await barrier('processing-del');
                            return result;
                        };
                    } });
                    wrappedQueueCache = true;
                }
            }
            if (command.kind === 'enqueue') result = await ttsQueueHandler.queueRequest({ channelID: command.channelId, source: 'chat-command', mode: 'speak', provider: 'piper', text: command.text, language: 'en', voice: 'en_US-ryan-medium' }, { queue: { maxItems: 20 }, voices: { en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', kokoroDefault: 'af_heart' } });
            else if (command.kind === 'invalidate') { const { invalidatePet } = await import('/app/dist/pets/state.js'); result = { ok: await invalidatePet(command.ownerId, 'settings_changed') }; }
            else if (command.kind === 'end') { await ttsQueueHandler.handleSpeechEnded(command.channelId, command.speechID, 'fixture-watchdog'); result = { ok: true }; }
            else if (command.kind === 'control') {
                if (command.failPrivateRead) {
                    const fault = { requestId: command.failPrivateRead, remaining: 1, injected: 0 };
                    let failure;
                    await controlReadFault.run(fault, async () => { try { await ttsQueueHandler.control(command.channelId, command.action); } catch (error) { failure = String(error); } });
                    result = { ok: !failure, injectedReadFailures: fault.injected, ...(failure ? { error: failure } : {}) };
                } else { await ttsQueueHandler.control(command.channelId, command.action); result = { ok: true }; }
            }
            else if (command.kind === 'capacity') {
                if (command.action === 'hold') {
                    if (ownedCapacityClaims.size || ttsQueueHandler.readHeads.size || ttsQueueHandler.headClaims.size) throw new Error('Fixture capacity must start empty');
                    const identity = randomUUID();
                    for (let index=0;index<128;index++) { const id=`dima032:capacity:${identity}:${index}`; ownedCapacityClaims.add(id); ttsQueueHandler.headClaims.add(id); }
                } else if (command.action === 'release') {
                    for (const id of ownedCapacityClaims) ttsQueueHandler.headClaims.delete(id);
                    ownedCapacityClaims.clear(); ttsQueueHandler.wakeCapacityWaiters();
                    // Let a capacity callback already queued by the real helper
                    // run before replying, even while the old DEL is still held.
                    await new Promise(resolve => setImmediate(resolve));
                } else throw new Error('Unknown fixture capacity action');
                result = { ownedClaims: ownedCapacityClaims.size, totalClaims: ttsQueueHandler.headClaims.size, heads: ttsQueueHandler.readHeads.size };
            }
            else if (command.kind === 'status') result = await ttsQueueHandler.getStatus(command.channelId);
            else if (command.kind === 'observe') { const { observeReadTtsRuntime } = await import('/app/dist/pets/tts_bridge.js'); const runtime = await PetRuntime.findById(command.ownerId).lean(); observeReadTtsRuntime(runtime); result = { ok: true }; }
            else if (command.kind === 'recover') { await ttsQueueHandler.reconcileReadTtsSessions(); result = { ok: true }; }
            else if (command.kind === 'head') {
                const head = ttsQueueHandler.readHeads.get(command.channelId), speech = command.speechID || head?.item.speechID;
                const file = speech && ttsQueueHandler.currentFiles.get(`${command.channelId}:${speech}`);
                const { readFile } = await import('node:fs/promises'), { createHash } = await import('node:crypto');
                const bytes = file ? await readFile(file).catch(() => null) : null;
                const { getEventListeners } = await import('node:events');
                result = { speechID: head?.item.speechID, phase: head?.phase, epoch: head?.epoch, running: head?.running,
                    fileHash: bytes ? createHash('sha256').update(bytes).digest('hex') : null, fileBytes: bytes?.length ?? 0,
                    processing: ttsQueueHandler.processingChannels.has(command.channelId), activePumps: ttsQueueHandler.activePumps,
                    watchdog: !!speech && ttsQueueHandler.currentTimeouts.has(`${command.channelId}:${speech}`),
                    pendingWait: !!head?.cancellation && getEventListeners(head.cancellation.signal, 'abort').length > 0,
                    electedOwner: ttsQueueHandler.readTtsOwners.get(command.channelId) ?? null,
                    position: speech ? ttsQueueHandler.playbackPositions.get(`${command.channelId}:${speech}`) : undefined,
                    cleanupPending: !!speech && ttsQueueHandler.fileCleanupTimeouts.has(`${command.channelId}:${speech}`), configurationReads };
            }
            else throw new Error('Unknown fixture command');
        } catch (error) { result = { fixtureError: String(error) }; }
        await cache.set(`dima032:test:reply:${command.id}`, JSON.stringify({ pid: process.pid, result }), { EX: 60 });
    })().catch(error => { console.error('DIMA032 fixture mailbox', String(error)); }).finally(() => { busy = false; }); }, 25).unref();
}
