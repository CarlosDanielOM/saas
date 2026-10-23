import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, mock, test } from 'node:test';
const channel = '123456', publicA = 'a'.repeat(48), publicB = 'b'.repeat(48);
const clientA = 'client-identity-0001', clientB = 'client-identity-0002';
const ended: any[] = [], playback: any[] = [], files = new Map(), saved = new Map();
const state = (publicId: string) => ({ publicId, channel, revision: 1, snapshot: { widgets: [{ visible: true, kind: 'tts' }], designs: [] }, controls: { revision: 1 } });
mock.module('./store.js', { namedExports: { publicState: async (id: string) => state(id), load: async () => {}, Studio: {}, OverlayError: Error } });
mock.module('./ast.js', { namedExports: { renderLayout: async () => ({}) } });
mock.module('./interactions.js', { namedExports: { resyncInteractions: async () => {} } });
mock.module('./widget-state-providers.js', { namedExports: { widgetStateRegistry: { snapshot: async () => ({ widgetStates: {}, serverTime: Date.now(), failedSources: [] }) }, legacyInteractions: () => ({}) } });
mock.module('./widget-contract.js', { namedExports: { getWidgetDefinition: () => ({}), validWidgetModuleConfig: () => true } });
mock.module('../schemas/domain_event.schema.js', { namedExports: { DomainEventSchema: {} } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({ set: async () => {} }) } });
mock.module('../handlers/clip_queue.handler.js', { namedExports: { clipQueueHandler: {} } });
mock.module('../handlers/tts_queue.handler.js', { namedExports: { ttsQueueHandler: { resumeIfIdle: async () => {},
    handleSpeechEnded: async (...args: any[]) => { ended.push(args); }, handleSpeechPlayback: (...args: any[]) => { playback.push(args); } } } });
const collection = (rows: Map<string, any>) => ({ find: () => ({ toArray: async () => [], sort: () => ({ toArray: async () => [] }) }),
    replaceOne: async (_filter: any, row: any) => { rows.set(row._id, row); }, updateOne: async (filter: any, update: any) => { Object.assign(rows.get(filter._id) ?? {}, update.$set); }, deleteOne: async (filter: any) => { rows.delete(filter._id); } });
mock.module('./delivery-store.js', { namedExports: { deliveries: async () => collection(saved), leases: async () => collection(new Map()),
    retainFile: async (file: string) => { files.set('retained', file); return { mediaId: 'retained', bytes: 8 }; }, releaseFile: async () => {}, sweepFiles: async () => {},
    DELIVERY_TTL_MS: 1800000, LEASE_MS: 120000, MAX_PENDING: 200, MAX_CHANNEL_BYTES: 10000000 } });
const { registerStudio, publishStudioReadTts, eventFor, fileFor, endStudioReadTts } = await import('./live.js');
class FakeSocket {
    connected = true; id: string; handshake: any; data: any; nsp: any; handlers = new Map<string, (...args: any[]) => any>(); events: any[] = [];
    conn = { close: () => this.disconnect() };
    constructor(publicId: string, clientId: string, socketId: string) { this.id = socketId; this.handshake = { auth: { clientId } }; this.nsp = { name: `/overlay-studio/${publicId}` }; this.data = { studioState: state(publicId) }; }
    emit(event: string, data: any) { this.events.push({ event, data }); }
    on(event: string, handler: (...args: any[]) => any) { this.handlers.set(event, handler); }
    disconnect() { this.connected = false; this.handlers.get('disconnect')?.(); }
    receive(event: string, data: any) { return this.handlers.get(event)?.(data); }
}
const io = new EventEmitter() as any, namespace = new EventEmitter() as any; namespace.use = () => {}; io.of = () => namespace;
registerStudio(io);
async function tick() { await new Promise(resolve => setTimeout(resolve, 5)); }
async function connect(publicId: string, clientId: string, socketId: string) {
    const socket = new FakeSocket(publicId, clientId, socketId); namespace.emit('connection', socket); await tick(); return socket;
}
after(() => io.emit('close'));
test('one elected Studio owns media; cross-scene reused clientId stays caption-only and cannot fetch owner media', async () => {
    const owner = await connect(publicA, clientA, 'socket-owner');
    const caption = await connect(publicA, clientB, 'socket-caption');
    const otherScene = await connect(publicB, clientA, 'socket-other-scene');
    await publishStudioReadTts(channel, { speechID: 'speech-a', durationMs: 0, text: 'preserve captions', legacy: false, file: '/normal/original-long.wav', mime: 'audio/wav' });
    const item = owner.events.find(event => event.event === 'overlay-event')!.data;
    assert.equal(item.tts.durationMs, 60000); assert.equal(item.tts.ownerClientId, clientA);
    const ownerEvent = await eventFor(publicA, item.id, clientA, owner.id); assert.ok(ownerEvent?.media?.url?.includes('socketId=socket-owner'));
    assert.ok(await fileFor(publicA, item.id, clientA, owner.id));
    assert.equal((await eventFor(publicB, item.id, clientA, otherScene.id))?.media, undefined);
    assert.equal((await eventFor(publicB, item.id, clientA, otherScene.id))?.tts?.ownerClientId, null);
    assert.equal(await fileFor(publicB, item.id, clientA, otherScene.id), null);
    assert.equal((await eventFor(publicA, item.id, clientB, caption.id))?.media, undefined);
    assert.equal(await eventFor(publicA, item.id), null);
    assert.equal(await fileFor(publicA, item.id, clientA, 'forged-socket'), null);
    assert.equal(files.get('retained'), '/normal/original-long.wav', 'long/unknown normal media is never truncated');
    caption.receive('overlay-speech-ended', { eventId: item.id, speechID: 'speech-a', reason: 'ended' }); await tick(); assert.equal(ended.length, 0);
    owner.receive('overlay-ended', item.id); await tick(); assert.ok(await eventFor(publicA, item.id, clientA, owner.id), 'generic ACK cannot destroy elected terminal correlation');
    owner.receive('overlay-speech-playback', { eventId: item.id, speechID: 'speech-a', phase: 'playing', position: 61 }); await tick();
    assert.equal(playback.at(-1)[1].position, 61, 'normal media can advance beyond caption hint');
    owner.receive('overlay-speech-ended', { eventId: item.id, speechID: 'speech-a', reason: 'ended' });
    owner.receive('overlay-speech-ended', { eventId: item.id, speechID: 'speech-a', reason: 'ended' }); await tick();
    assert.equal(ended.length, 1);
    await endStudioReadTts(channel, 'speech-a');
    owner.disconnect(); caption.disconnect(); otherScene.disconnect(); await tick();
});
test('disconnect/reconnect with same client never replays unseen pending audio nor reauthorizes old URLs', async () => {
    ended.length = 0;
    const first = await connect(publicA, clientA, 'epoch-one');
    await publishStudioReadTts(channel, { speechID: 'lost-delivery', durationMs: 500, text: 'once', legacy: false, file: '/normal/once.wav', mime: 'audio/wav' });
    const item = first.events.find(event => event.event === 'overlay-event')!.data;
    first.disconnect(); const second = await connect(publicA, clientA, 'epoch-two');
    assert.deepEqual(second.events.find(event => event.event === 'overlay-state')?.data.pendingIds, []);
    assert.equal(second.events.some(event => event.event === 'overlay-event'), false);
    assert.equal(await eventFor(publicA, item.id, clientA, 'epoch-one'), null);
    assert.equal(await eventFor(publicA, item.id, clientA, 'epoch-two'), null);
    assert.equal(await fileFor(publicA, item.id, clientA, 'epoch-one'), null);
    assert.equal(await fileFor(publicA, item.id, clientA, 'epoch-two'), null);
    assert.equal(ended.length, 1); second.disconnect(); await tick();
});
