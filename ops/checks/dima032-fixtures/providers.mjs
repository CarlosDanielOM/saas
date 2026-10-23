// Materialize runtime-providers.mjs and its oauth-providers.mjs from existing fixtures.
import './startup.mjs';
import './runtime-providers.mjs';
import { createRequire } from 'node:module';
const { createClient } = createRequire('/app/package.json')('redis');
if (!/^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/.test(process.env.MONGO_URI || '') || process.env.PIPER_HTTP_URL !== 'http://pet-piper.test') throw new Error('DIMA032 fixtures require disposable Mongo/Redis and mock providers');
// Fixture-only command mailbox invokes the actual API singleton; no application test endpoint.
if ((process.argv[1] || '').endsWith('/dist/server/index.js')) {
    const cache = createClient({ url: 'redis://redis:6379' }); await cache.connect();
    // Delay responses of real disposable Mongo operations, never replace results.
    // These barriers exercise cancellation across CAS, retained upload and delivery persistence.
    const { PetRuntime } = await import('/app/dist/schemas/pet_runtime.schema.js');
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
    const mongoose = createRequire('/app/package.json')('mongoose');
    for (const method of ['insertOne', 'replaceOne']) {
        const original = mongoose.mongo.Collection.prototype[method];
        mongoose.mongo.Collection.prototype[method] = async function (...args) {
            const result = await original.apply(this, args);
            if (method === 'insertOne' && this.collectionName === 'overlay_media.files' && args[0]?.filename === 'overlay-playback') await barrier('retain');
            if (method === 'replaceOne' && this.collectionName === 'overlay_deliveries' && args[1]?.event?.tts) await barrier('persist');
            return result;
        };
    }
    let busy = false;
    setInterval(() => { if (busy) return; busy = true; void (async () => {
        const raw = await cache.lPop('dima032:test:commands'); if (!raw) return;
        const command = JSON.parse(raw); let result;
        try {
            const { ttsQueueHandler } = await import('/app/dist/handlers/tts_queue.handler.js');
            if (command.kind === 'enqueue') result = await ttsQueueHandler.queueRequest({ channelID: command.channelId, source: 'chat-command', mode: 'speak', provider: 'piper', text: command.text, language: 'en', voice: 'en_US-ryan-medium' }, { queue: { maxItems: 20 }, voices: { en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', kokoroDefault: 'af_heart' } });
            else if (command.kind === 'end') { await ttsQueueHandler.handleSpeechEnded(command.channelId, command.speechID, 'fixture-watchdog'); result = { ok: true }; }
            else if (command.kind === 'control') { await ttsQueueHandler.control(command.channelId, command.action); result = { ok: true }; }
            else if (command.kind === 'status') result = await ttsQueueHandler.getStatus(command.channelId);
            else throw new Error('Unknown fixture command');
        } catch (error) { result = { fixtureError: String(error) }; }
        await cache.set(`dima032:test:reply:${command.id}`, JSON.stringify({ pid: process.pid, result }), { EX: 60 });
    })().catch(error => { console.error('DIMA032 fixture mailbox', String(error)); }).finally(() => { busy = false; }); }, 25).unref();
}
