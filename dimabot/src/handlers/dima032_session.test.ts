import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

const data = new Map<string, string>();
const queues = new Map<string, string[]>();
const events: { channel: string; event: string; payload: any }[] = [];
let refreshes = 0;
let synthesize: (input: any) => Promise<any> = async () => ({ error: false, outputPath: file, publicPath: '/audio/test', mimeType: 'audio/wav' });
const synthesized: string[] = [];
let usage = 0;
let studioConnected = true, graceConnected = true, petReady = true, playbackTimeoutMs = 60000;
const turns = new Map<string, string>(), protections: number[] = [];
let afterRequeueWrite: (() => Promise<void>) | undefined, onReserve: (() => void) | undefined;
let publisher: ((input: any) => Promise<'emitted' | 'unavailable' | 'cancelled'>) | undefined;
let readRoute: 'pet' | 'overlay' | null = 'pet';
let lastInput: any;
const readDeliveries: any[] = [], released: string[] = [];
const legacySockets = new Map<string, any>();
for (const id of ['legacy-a', 'legacy-b']) legacySockets.set(id, { id, connected: true, data: { ttsReady: true }, conn: { close: () => {} }, emit: (event: string, payload: any) => events.push({ channel: id, event, payload }) });
let afterDel: ((key: string) => Promise<void>) | undefined;
const cache = {
  get: async (key: string) => data.get(key) ?? null,
  set: async (key: string, value: string) => { data.set(key, value); },
  del: async (key: string) => { data.delete(key); queues.delete(key); if (afterDel) await afterDel(key); },
  zPopMin: async (key: string) => { const value = queues.get(key)?.shift(); return value ? { value } : null; },
  zAdd: async (key: string, entry: any) => { const ids = queues.get(key) ?? []; if (!ids.includes(entry.value)) ids.push(entry.value); queues.set(key, ids); if (afterRequeueWrite) { const barrier = afterRequeueWrite; afterRequeueWrite = undefined; await barrier(); } },
  zRem: async (key: string, id: string) => { queues.set(key, (queues.get(key) ?? []).filter(item => item !== id)); },
  zCard: async (key: string) => queues.get(key)?.length ?? 0,
  zRange: async (key: string) => [...queues.get(key) ?? []],
  keys: async () => [],
  multi: () => {
    const commands: (() => void)[] = [];
    const transaction = {
      zRem(key: string, ids: string[]) { commands.push(() => queues.set(key, (queues.get(key) ?? []).filter(id => !ids.includes(id)))); return transaction; },
      del(key: string) { commands.push(() => { data.delete(key); }); return transaction; },
      async exec() { commands.forEach(command => command()); }
    };
    return transaction;
  }
};
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../server/websocket.js', { namedExports: { getIO: () => ({ of: (channel: string) => ({
  sockets: legacySockets,
  emit: (event: string, payload: any) => events.push({ channel, event, payload })
}) }) } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ plan_tier: 'free' }) } });
mock.module('../utils/billing.js', { namedExports: { isAiCreditsExhausted: async () => false, getAiCredits: async () => ({ status: 'available' }) } });
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async () => { usage++; } } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiOperation: () => {} } });
mock.module('../utils/tts/tts_playback_timeout.util.js', { namedExports: { getTtsPlaybackTimeoutMs: async () => playbackTimeoutMs } });
for (const provider of ['piper', 'fish', 'kokoro']) mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
  [`${provider}TtsService`]: { synthesize: (input: any) => { synthesized.push(input.speechID); return synthesize(input); } },
  ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-controls' } : {})
} });
import fs from 'node:fs/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerReadTtsBridge, releaseReadTts, readTtsTerminal, resumeReadTts, invalidateReadTts, observeReadTtsRuntime } from '../pets/tts_bridge.js';

let configurationReads = 0, renewalWrites = 0, advanceProbeTime = false, virtualNow = 0;
const owner = '012345678901234567890123', channel = '123456';
let runtime: any, config: any, rows: Map<string, any>, petEvents: any[], endings: string[];
let ticketFails = false, attemptedFails = false;
let afterPrivateCreate: (() => Promise<void>) | undefined, afterPrivateLink: (() => Promise<void>) | undefined, afterAttempted: (() => Promise<void>) | undefined;
let afterConfigurationRead: (() => Promise<void>) | undefined;
let afterClaim: (() => Promise<void>) | undefined;
const resumed: string[] = [];
const fileDir = await mkdtemp(path.join(tmpdir(), 'dima032-unit-'));
const file = path.join(fileDir, 'normal.wav'); await writeFile(file, 'normal TTS bytes');
const peer: any = { id: 'png-peer', ownerId: owner, channelId: channel, kind: 'browser', renderReady: true, audioReady: true,
    revalidate: async () => {}, socket: { connected: true, emit: (event: string, data: any) => petEvents.push({ event, data }) } };
const peers = new Map([[peer.id, peer]]);
const get = (row: any, key: string) => key.split('.').reduce((value, part) => value?.[part], row);
function matches(row: any, filter: any) {
    return Object.entries(filter).every(([key, value]: any) => {
        const current = get(row, key);
        if (value?.$not) return !current || current <= value.$not.$gt;
        if (value?.$gt) return current > value.$gt;
        if (value?.$lte) return current <= value.$lte;
        return current === value;
    });
}
function apply(row: any, update: any) { for (const [key, value] of Object.entries(update.$set ?? {})) {
    const parts = key.split('.'); let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = structuredClone(value);
} for (const [key, value] of Object.entries(update.$max ?? {})) { if (!get(row, key) || get(row, key) < (value as Date)) apply(row, { $set: { [key]: value } }); } }
const query = (read: () => any) => ({ lean: async () => structuredClone(await read()) });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => ({ select: () => query(() => ({ _id: owner })) }) } });
mock.module('../server/services/pet_settings.service.js', { namedExports: { getPetConfiguration: async () => { configurationReads++; if (advanceProbeTime) virtualNow += 50_001; const snapshot = structuredClone(config); const barrier = afterConfigurationRead; afterConfigurationRead = undefined; if (barrier) await barrier(); return snapshot; } } });
mock.module('../pets/peers.js', { namedExports: { petPeers: peers, selectedVtsController: async () => null } });
mock.module('../pets/tokens.js', { namedExports: { issueAudioTicket: async () => { if (ticketFails) throw new Error('ticket rejected before delivery'); return 'private-ticket'; } } });
mock.module('../pets/tts_envelope.js', { namedExports: { inspectTtsAudio: async () => 500, ttsEnvelope: async () => ({ stepMs: 40, values: [0, 0.7, 0.2] }) } });
mock.module('../schemas/pet_runtime.schema.js', { namedExports: {
    PetRuntime: {
        findById: () => query(() => runtime),
        find: () => ({ limit: () => query(() => runtime.ttsReservation?.token ? [runtime] : []) }),
        findOneAndUpdate: (filter: any, update: any) => query(async () => { if (!matches(runtime, filter)) return null; apply(runtime, update); const claimed = structuredClone(runtime); const barrier = afterClaim; afterClaim = undefined; if (barrier) await barrier(); return claimed; }),
        updateOne: async (filter: any, update: any) => { const match = matches(runtime, filter); if (match) apply(runtime, update); if (update.$max?.['ttsReservation.expiresAt']) renewalWrites++; const barrier = update.$set?.activeRequestId ? afterPrivateLink : undefined; if (barrier) { afterPrivateLink = undefined; await barrier(); } return { modifiedCount: +match, matchedCount: +match }; }
    },
    PetRequest: {
        create: async (value: any) => { if ([...rows.values()].some(row => row.ownerId === value.ownerId && row.origin.id === value.origin.id && row.actionKey === value.actionKey)) throw Object.assign(new Error('unique origin/action'), { code:11000 }); rows.set(value._id, structuredClone(value)); const barrier = afterPrivateCreate; afterPrivateCreate = undefined; if (barrier) await barrier(); return { ...value, toObject: () => structuredClone(value) }; },
        findById: (id: string) => query(() => rows.get(id) ?? null),
        updateOne: async (filter: any, update: any) => { const row = rows.get(filter._id); const match = row && matches(row, filter) && !attemptedFails; if (match) apply(row, update); const barrier = update.$set?.deliveryAttempted ? afterAttempted : undefined; if (barrier) { afterAttempted = undefined; await barrier(); } return { modifiedCount: +!!match, matchedCount: +!!match }; }
    }
} });
async function finish(id: string, status: string) {
    const row = rows.get(id); if (!row || ['completed', 'cancelled', 'failed', 'expired'].includes(row.status)) return;
    row.status = status; if (runtime.activeRequestId === id) runtime.activeRequestId = null;
    await readTtsTerminal(row); return row;
}
mock.module('../pets/state.js', { namedExports: { runtimeFor: async () => structuredClone(runtime), notifyPet: async () => {}, finishRequest: finish,
    invalidatePet: async (_owner: string, _reason: string, expected: any) => {
        assert.equal(expected.generation, runtime.generation); assert.equal(expected.requestId, runtime.activeRequestId);
        if (runtime.lease) { assert.equal(expected.leaseId, runtime.lease.leaseId); assert.deepEqual(expected.leaseExpiresAt, runtime.lease.expiresAt); }
        runtime.notBefore = new Date(Math.max(runtime.notBefore.getTime(), runtime.lease?.expiresAt.getTime() ?? 0));
        runtime.generation++; if (runtime.activeRequestId) await finish(runtime.activeRequestId, 'cancelled');
        runtime.lease = null; runtime.activeRequestId = null; return true;
    },
    requestView: (row: any) => ({ requestId: row._id, operation: row.operation, status: row.status, version: row.version, text: row.outputText }) } });
const { startReadTts, reconcileReadTtsStartup } = await import('../pets/read_tts.js');
let close = startReadTts();
async function reset() {
    await close(); close = startReadTts();
    runtime = { _id: owner, generation: 4, activeRequestId: null, ttsReservation: null, notBefore: new Date(0),
        lease: { leaseId: 'lease', holderPeerId: peer.id, expiresAt: new Date(Date.now() + 15000) } };
    config = { revision: 1, settings: { enabled: true, sources: { independent: false, readTts: true }, ttsAudio: 'pet',
        tts: { enabled: false }, personality: { source: 'profile', profileId: 'missing' }, appearance: { kind: 'png' }, playback: { target: 'browser' } }, runtime: { enabled: false, readTtsEnabled: true } };
    rows = new Map(); petEvents = []; endings = []; afterClaim = afterConfigurationRead = afterPrivateCreate = afterPrivateLink = afterAttempted = undefined; resumed.length = 0; ticketFails = attemptedFails = false; peer.socket.connected = peer.audioReady = peer.renderReady = true;
}
function input(speechId = 'speech') { return { channelId: channel, speechId, file, mime: 'audio/wav', text: 'Existing normal TTS', cancelled: () => false,
    ended: async (reason: string) => { endings.push(reason); await releaseReadTts(channel, speechId); } }; }
mock.module('../utils/logger.js', { namedExports: { error: async () => {}, info: async () => {} } });
mock.module('../classes/pubsub_manager.class.js', { namedExports: { pubSubManager: { publish: async (_topic: string, value: any) => { await handler.handleSessionEnded(value.channelID, value.session); } } } });
const { ttsQueueHandler: handler } = await import('./tts_queue.handler.js');
const { registerStudioBridge } = await import('../overlays/bridge.js');
let publishAttempts = 0;
registerStudioBridge({ hasSource: () => graceConnected, hasLiveSource: () => studioConnected, media: async () => {}, trigger: async () => {}, controlTts: async () => {}, readTts: async (_channel, input) => {
  publishAttempts++; if (!studioConnected) return 'unavailable'; return input.beforeEmit?.() === false ? 'cancelled' : 'emitted';
} });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => boolean) {
  for (let i=0; i<200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('reproduction barrier timed out');
}
function seed(id: string, ...later: string[]) {
  queues.set(`twitch:${channel}:tts:queue`, [id, ...later]);
  for (const speechID of later) data.set(`twitch:${channel}:tts:queue:data:${speechID}`, JSON.stringify({ channelID:channel, speechID, provider:'piper', mode:'speak', language:'en', voice:'test', text:speechID }));
  data.set(`twitch:${channel}:tts:queue:data:${id}`, JSON.stringify({ channelID:channel, speechID:id, provider:'piper', mode:'speak', language:'en', voice:'test', text:id }));
}
async function setup() {
  await handler.cleanupChannel(channel); await reset(); await writeFile(file, 'normal TTS bytes');
  data.clear(); queues.clear(); events.length=0; synthesized.length=0; usage=0; publishAttempts=0;
  configurationReads=renewalWrites=0; advanceProbeTime=false; afterDel=undefined;
  studioConnected=true; graceConnected=true; peer.audioReady=false;
  for (const socket of legacySockets.values()) socket.data.ttsReady=false;
}
async function stop(processing?: Promise<void>) {
  advanceProbeTime=false; afterDel=undefined; studioConnected=false; peer.audioReady=false;
  await handler.control(channel,'clear'); await processing; await handler.cleanupChannel(channel);
}
after(async () => { await close(); registerReadTtsBridge(); await rm(fileDir,{recursive:true,force:true}); });

test('session lifecycle regression 1: skip crossing final processing DEL removes captured requeued identity', async () => {
  await setup(); const entered=barrier(), resume=barrier();
  afterClaim=async () => { studioConnected=false; };
  afterDel=async key => { if(key===`twitch:${channel}:tts:processing`) { afterDel=undefined; entered.resolve(); await resume.promise; } };
  seed('late-skip'); const processing=handler.processNext(channel); await entered.promise;
  const skip=handler.control(channel,'skip'); assert.equal((handler as any).controls.has(channel),true);
  resume.resolve();
  try {
    await Promise.all([processing,skip]);
    console.log('R3-EVIDENCE-1', JSON.stringify({queue:queues.get(`twitch:${channel}:tts:queue`), active:(handler as any).activeSpeechIds.get(channel)??null, syntheses:synthesized.length, usage}));
    assert.deepEqual(queues.get(`twitch:${channel}:tts:queue`), [], 'skip must remove the exact unheard item even across final DEL');
  } finally { await stop(processing); }
});
test('session lifecycle regression 2: selected pet reconnect routes generated same file without another provider/debit', async () => {
  await setup(); const entered=barrier(), resume=barrier(); const original=synthesize;
  synthesize=async input => { entered.resolve(); await resume.promise; return original(input); };
  seed('pet-reconnect'); const processing=handler.processNext(channel); await entered.promise;
  studioConnected=false; resume.resolve();
  try {
    await processing; assert.equal((handler as any).readHeads.get(channel)?.phase, 'parked');
    peer.audioReady=true; await resumeReadTts(channel);
    await until(()=>petEvents.some(event=>event.event==='pet:play'));
    const plays=petEvents.filter(event=>event.event==='pet:play').length;
    console.log('R3-EVIDENCE-2', JSON.stringify({plays,studioAttempts:publishAttempts,syntheses:synthesized.length,usage,active:(handler as any).activeSpeechIds.get(channel)}));
    assert.equal(synthesized.length,1); assert.equal(usage,1);
    assert.equal(plays,1,'ready selected pet must receive generated unheard audio after reconnect');
  } finally { synthesize=original; await stop(processing); }
});
test('session lifecycle regression 3: no-output generated head parks rather than renewing/polling for ten virtual minutes', async () => {
  await setup(); const entered=barrier(), resume=barrier(); const original=synthesize, realNow=Date.now;
  synthesize=async input => { entered.resolve(); await resume.promise; return original(input); };
  seed('no-output'); const processing=handler.processNext(channel); await entered.promise;
  studioConnected=false; resume.resolve();
  try {
    await processing; assert.equal((handler as any).readHeads.get(channel)?.phase, 'parked');
    const reads = configurationReads, renewals = renewalWrites, base=realNow(); virtualNow=base+650013; Date.now=()=>virtualNow;
    await new Promise(resolve => setTimeout(resolve,250));
    console.log('R3-EVIDENCE-3', JSON.stringify({virtualWaitMs:virtualNow-base,configurationReads,renewalWrites,processing:(handler as any).processingChannels.has(channel),watchdog:(handler as any).currentTimeouts.has(`${channel}:no-output`),fileHeld:(handler as any).currentFiles.has(`${channel}:no-output`),reservation:!!runtime.ttsReservation,syntheses:synthesized.length,usage}));
    assert.equal(configurationReads, reads); assert.equal(renewalWrites,renewals);
    assert.equal(runtime.ttsReservation,null); assert.equal((handler as any).currentFiles.has(`${channel}:no-output`),true);
    assert.equal((handler as any).processingChannels.has(channel),false,'generated head must leave bounded active wait without discarding file');
  } finally { Date.now=realNow; advanceProbeTime=false; synthesize=original; await stop(processing); }
});

test('parked generated head preserves FIFO and count; next item cannot synthesize before its terminal', async () => {
  await setup(); const entered=barrier(), resume=barrier(), original=synthesize;
  synthesize=async input => { entered.resolve(); await resume.promise; return original(input); };
  seed('fifo-head','fifo-next'); const processing=handler.processNext(channel); await entered.promise;
  studioConnected=false; resume.resolve(); await processing;
  try {
    assert.equal((handler as any).readHeads.get(channel).item.speechID,'fifo-head');
    assert.deepEqual(queues.get(`twitch:${channel}:tts:queue`),['fifo-next']);
    await handler.processNext(channel); await new Promise<void>(done=>setImmediate(done));
    assert.equal(usage,1); assert.equal(synthesized.length,1);
    studioConnected=true; await handler.resumeIfIdle(channel); await until(()=>(handler as any).readHeads.get(channel)?.phase==='emitted');
    assert.equal(usage,1); await handler.handleOverlayEnded(channel,'fifo-head','ended','studio:fixture');
    await until(()=>synthesized.includes('fifo-next')); assert.equal(usage,2);
  } finally { synthesize=original; await stop(); }
});
for (const action of ['skip','clear'] as const) test(`parked ${action} cancels stable head without replay or early file cleanup`, async () => {
  await setup(); const entered=barrier(), resume=barrier(), original=synthesize;
  synthesize=async input => { entered.resolve(); await resume.promise; return original(input); };
  seed(`parked-${action}`,'waiting'); const processing=handler.processNext(channel); await entered.promise;
  studioConnected=false; resume.resolve(); await processing;
  try {
    assert.equal((handler as any).fileCleanupTimeouts.has(`${channel}:parked-${action}`),false);
    await handler.control(channel,action);
    assert.equal((handler as any).readHeads.has(channel),false); assert.equal(runtime.ttsReservation,null);
    assert.equal((handler as any).fileCleanupTimeouts.has(`${channel}:parked-${action}`),true);
    assert.deepEqual(queues.get(`twitch:${channel}:tts:queue`),action==='clear'?[]:['waiting']); assert.equal(usage,1);
  } finally { synthesize=original; await stop(); }
});
test('readiness crossing final parked DEL is latched and resumes once after release', async () => {
  await setup(); const entered=barrier(), resume=barrier(), synthEntered=barrier(), synthResume=barrier(), original=synthesize;
  synthesize=async input => { synthEntered.resolve(); await synthResume.promise; return original(input); };
  seed('lost-wake'); const processing=handler.processNext(channel); await synthEntered.promise;
  studioConnected=false;
  afterDel=async key=>{ if(key===`twitch:${channel}:tts:processing`) { afterDel=undefined; entered.resolve(); await resume.promise; } };
  synthResume.resolve(); await entered.promise; studioConnected=true; await handler.resumeIfIdle(channel); resume.resolve(); await processing;
  try { await until(()=>(handler as any).readHeads.get(channel)?.phase==='emitted'); assert.equal(publishAttempts,1); assert.equal(usage,1); assert.equal(synthesized.length,1); }
  finally { synthesize=original; await stop(); }
});
test('fresh safe private attempts preserve speech origin and use unique action identity; old terminal cannot end new play', async () => {
  await setup(); peer.audioReady=true; studioConnected=false; ticketFails=true;
  seed('private-retry'); await handler.processNext(channel);
  try {
    assert.equal((handler as any).readHeads.get(channel)?.phase,'parked'); assert.equal(rows.size,1); assert.equal(petEvents.filter(e=>e.event==='pet:play').length,0);
    const old=[...rows.values()][0]; ticketFails=false; await resumeReadTts(channel);
    await until(()=>petEvents.some(e=>e.event==='pet:play'));
    assert.equal(rows.size,2); const current=[...rows.values()].at(-1);
    assert.equal(current.origin.id,old.origin.id); assert.notEqual(current.actionKey,old.actionKey);
    assert.equal(synthesized.length,1); assert.equal(usage,1);
    await readTtsTerminal(old); assert.equal((handler as any).readHeads.get(channel)?.phase,'emitted');
    await resumeReadTts(channel); await new Promise<void>(done=>setImmediate(done)); assert.equal(petEvents.filter(e=>e.event==='pet:play').length,1);
  } finally { await stop(); }
});
test('actual stream-operations consumer clears the API parked head via cross-process boundary without a new provider', async () => {
  await setup(); const entered=barrier(), resume=barrier(), original=synthesize;
  synthesize=async input=>{ entered.resolve(); await resume.promise; return original(input); };
  seed('stream-head'); const processing=handler.processNext(channel); await entered.promise; studioConnected=false; resume.resolve(); await processing;
  const access=mock.method(fs,'access',async()=>{}), remove=mock.method(fs,'rm',async()=>{});
  try {
    const { clearSpeechFiles }=await import('../utils/speech.js');
    const { applyStreamOperationsDomainEvent }=await import('../domain_events/stream_operations_events.js');
    const noop=async()=>{};
    await applyStreamOperationsDomainEvent({type:'stream.ended',source:'twitch-eventsub',channelID:channel,payload:{event:{}}} as any, {
      hasNewerLifecycleEvent:async()=>false, unloadChannelTimersFromCache:noop,resetRedemptionCost:async()=>({}),resetSumimetro:noop,clearChannelCache:noop,clearSpeechFiles,clearHistory:noop,getChannelEditors:async()=>({}),loadChannelAdminsIntoCache:noop,
    } as any);
    assert.equal((handler as any).readHeads.has(channel),false); assert.equal(runtime.ttsReservation,null);
    assert.equal((handler as any).fileCleanupTimeouts.has(`${channel}:stream-head`),true);
    studioConnected=true; peer.audioReady=true; await resumeReadTts(channel); await new Promise<void>(done=>setImmediate(done));
    assert.equal(synthesized.length,1); assert.equal(usage,1); assert.equal(petEvents.some(e=>e.event==='pet:play'),false);
  } finally { access.mock.restore(); remove.mock.restore(); synthesize=original; await stop(); }
});
test('lost stream-end hint is repaired by bounded existing recovery and cannot resume stale generated work', async () => {
  await setup(); const entered=barrier(), resume=barrier(), original=synthesize;
  synthesize=async input=>{ entered.resolve(); await resume.promise; return original(input); };
  seed('lost-session-hint'); const processing=handler.processNext(channel); await entered.promise; studioConnected=false; resume.resolve(); await processing;
  try {
    data.set(`twitch:${channel}:tts:session`,'new-session'); await handler.reconcileReadTtsSessions();
    assert.equal((handler as any).readHeads.has(channel),false); studioConnected=true; await handler.resumeIfIdle(channel);
    await new Promise<void>(done=>setImmediate(done)); assert.equal(synthesized.length,1); assert.equal(usage,1);
  } finally { synthesize=original; await stop(); }
});

for (const setting of ['readTts','master'] as const) test(`parked normal audio survives ${setting} disable and elects one live overlay without pet animation`, async () => {
  await setup(); const entered=barrier(), resume=barrier(), original=synthesize;
  synthesize=async input=>{entered.resolve(); await resume.promise; return original(input);};
  seed(`disabled-${setting}`); const processing=handler.processNext(channel); await entered.promise; studioConnected=false; resume.resolve(); await processing;
  try {
    if(setting==='readTts') config.settings.sources.readTts=false; else config.settings.enabled=false;
    config.runtime.readTtsEnabled=false; config.revision++; runtime.generation++; peer.audioReady=true;
    await invalidateReadTts(owner,'settings_changed');
    await new Promise<void>(done=>setImmediate(done)); await until(()=>(handler as any).readHeads.get(channel)?.phase==='parked');
    assert.equal(petEvents.some(e=>e.event==='pet:play'),false); assert.equal(publishAttempts,0);
    for(const socket of legacySockets.values()) socket.data.ttsReady=true;
    studioConnected=true; await handler.resumeIfIdle(channel); await until(()=>(handler as any).readHeads.get(channel)?.phase==='emitted');
    assert.equal(synthesized.length,1); assert.equal(usage,1); assert.ok(runtime.ttsReservation);
    const audio=events.filter(e=>e.event==='speech'&&e.payload.speechID===`disabled-${setting}`); assert.equal(audio.length,1);
    handler.handleSpeechPlayback(channel,{speechID:`disabled-${setting}`,phase:'playing',position:0},'legacy:legacy-a');
    await new Promise<void>(done=>setImmediate(done)); assert.equal(petEvents.some(e=>e.event==='pet:follow'||e.event==='pet:play'),false);
  } finally { synthesize=original; await stop(); }
});

test('stream end crossing private preparation cancels old callbacks before final emission', async () => {
  await setup(); studioConnected=false; peer.audioReady=true; const entered=barrier(),resume=barrier();
  afterPrivateCreate=async()=>{entered.resolve(); await resume.promise;}; seed('ending-private'); const processing=handler.processNext(channel); await entered.promise;
  data.set(`twitch:${channel}:tts:session`,'ended-during-private'); const ending=handler.handleSessionEnded(channel,'ended-during-private'); resume.resolve();
  try {await Promise.all([processing,ending]); assert.equal((handler as any).readHeads.has(channel),false); assert.equal(petEvents.some(e=>e.event==='pet:play'),false); assert.equal(runtime.ttsReservation,null);}
  finally {await stop();}
});
test('stream end stops possibly active private audio and schedules original-file terminal cleanup', async () => {
  await setup(); studioConnected=false; peer.audioReady=true; seed('ending-audio'); await handler.processNext(channel);
  try {
    assert.equal(petEvents.filter(e=>e.event==='pet:play').length,1); data.set(`twitch:${channel}:tts:session`,'ended-active'); await handler.handleSessionEnded(channel,'ended-active');
    assert.equal((handler as any).readHeads.has(channel),false); assert.equal(runtime.ttsReservation,null); assert.ok(petEvents.some(e=>e.event==='pet:stop'));
    assert.equal((handler as any).fileCleanupTimeouts.has(`${channel}:ending-audio`),true);
    await resumeReadTts(channel); await new Promise<void>(done=>setImmediate(done)); assert.equal(petEvents.filter(e=>e.event==='pet:play').length,1);
  } finally {await stop();}
});
