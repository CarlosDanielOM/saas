import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let queuedProvider = 'fish';
let creditStatus = 'exhausted';
let lookupFails = false;
let planTier = 'free';
let pending = true;
let rawText = '[happy] Hello';
let scriptedQueue: Array<{ value: string }> | null = null;
let itemExtras: Record<string, unknown> = {};
const synthesis: Array<{ provider: string; text: string; voice: string }> = [];
const synthesizeImpls: Record<string, (request: { text: string; voice: string }) => Promise<{ error: boolean; message: string }>> = {};
const emitted: Array<{ event: string; payload: { mode: string; audioUrl: string } }> = [];
let playbackAvailable = true;
const cache = {
  eval: async (_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> => {
    const next = await cache.zPopMin();
    if (!next) return [];
    return [next.value, await cache.get(options.keys[2]) ?? '', await cache.get(options.keys[1]) ?? ''];
  },
  zRange: async () => scriptedQueue ? scriptedQueue.slice(0, 1).map(item => item.value) : pending ? ['speech-test'] : [],
  zPopMin: async () => {
    if (scriptedQueue) {
      return scriptedQueue.shift() ?? null;
    }
    if (!pending) return null;
    pending = false;
    return { value: 'speech-test' };
  },
  get: async (key: string): Promise<string | null> => key.includes(':queue:data:')
    ? JSON.stringify({ channelID: 'test', speechID: 'speech-test', provider: queuedProvider,
      mode: 'clone', language: 'en', voice: 'fish-id', piperFallbackVoice: 'piper-en', text: rawText, ...itemExtras })
    : 'pending',
  set: async () => {},
  del: async (_key?: string | string[]) => {},
  keys: async (): Promise<string[]> => [],
  zCard: async () => 0,
};
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../desktop_ai/activity.js', { namedExports: {
  prepareSpeechActivity: async (value: object) => ({ ...value, fence: 'test' }), startSpeechActivity: async () => true,
  finishSpeechActivity: async () => {}, extendSpeechActivity: async () => true,
  retireMatchingSpeechActivity: async () => true, confirmRetiredSpeechActivity: async () => false,
} });
mock.module('../server/websocket.js', { namedExports: { getIO: () => playbackAvailable
  ? { of: () => ({ sockets: new Map([['test', { id: 'test', connected: true, data: { ttsReady: true }, emit: (event: string, payload: { mode: string; audioUrl: string }) => emitted.push({ event, payload }) }]]), emit: (event: string, payload: { mode: string; audioUrl: string }) => emitted.push({ event, payload }) }) }
  : null } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: {
  getTwitchAccountById: async () => {
    if (lookupFails) throw new Error('account unavailable');
    return { polar_sh_customer_id: 'customer', plan_tier: planTier };
  },
} });
mock.module('../utils/billing.js', { namedExports: {
  isAiCreditsExhausted: async () => creditStatus === 'exhausted',
  getAiCredits: async () => ({ status: creditStatus }),
} });
const usageCalls: Array<Record<string, any>> = [];
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async (options: Record<string, any>) => { usageCalls.push(options); } } });
for (const provider of ['fish', 'piper', 'kokoro']) {
  synthesizeImpls[provider] = async (request: { text: string; voice: string }) => {
    synthesis.push({ provider, text: request.text, voice: request.voice });
    return { error: true, message: 'test stops before playback' };
  };
  mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
    [`${provider}TtsService`]: {
      synthesize: (request: { text: string; voice: string }) => synthesizeImpls[provider](request),
    },
    ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-test' } : {}),
  } });
}
const operations: Array<Record<string, any>> = [];
mock.module('../utils/posthog_events.js', { namedExports: { trackAiOperation: (event: Record<string, any>) => { operations.push(event); } } });
const { ttsQueueHandler, ttsRequestSources } = await import('./tts_queue.handler.js');
const { setActivityLogSinkForTests, pendingActivityRowsForTests } = await import('../utils/activity_log.js');
const flushedRows: Array<Record<string, any>> = [];
setActivityLogSinkForTests(async rows => { flushedRows.push(...rows); });
// A timed flush moves rows from the buffer to the sink in order, so together they are every row so far.
const allActivityRows = (): Array<Record<string, any>> => [...flushedRows, ...pendingActivityRowsForTests()];

test('queued Fish requests recheck credits and use Piper when exhausted or unavailable', async () => {
  for (const status of ['exhausted', 'unavailable', 'available']) {
    pending = true;
    creditStatus = status;
    const before = synthesis.length;
    await ttsQueueHandler.processNext('test');
    assert.deepEqual(synthesis.slice(before), status === 'available'
      ? [
          { provider: 'fish', text: '[happy] Hello', voice: 'fish-id' },
          { provider: 'piper', text: 'Hello', voice: 'piper-en' },
        ]
      : [{ provider: 'piper', text: 'Hello', voice: 'piper-en' }]);
  }
  pending = true;
  lookupFails = true;
  await ttsQueueHandler.processNext('test');
  assert.equal(synthesis.at(-1)?.provider, 'piper');
  const count = synthesis.length;
  pending = true;
  rawText = '[happy]';
  await ttsQueueHandler.processNext('test');
  assert.equal(synthesis.length, count, 'empty fallback text is skipped');
});

test('a Fish synthesis that never finishes releases the channel and continues the queue', async () => {
  const originalFish = synthesizeImpls.fish;
  const originalTimeout = ttsQueueHandler.synthesisTimeoutMs;
  let started = 0;
  synthesizeImpls.fish = (request) => {
    started += 1;
    if (started === 1) {
      return new Promise(() => {});
    }
    synthesis.push({ provider: 'fish', text: request.text, voice: request.voice });
    return Promise.resolve({ error: true, message: 'second line' });
  };
  creditStatus = 'available';
  lookupFails = false;
  rawText = 'Hello again';
  scriptedQueue = [{ value: 'speech-a' }, { value: 'speech-b' }];
  ttsQueueHandler.synthesisTimeoutMs = 30;

  try {
    await ttsQueueHandler.processNext('hang-channel');
    for (let attempt = 0; attempt < 20 && started < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, 2);
    assert.equal(synthesis.at(-1)?.provider, 'piper');
    assert.equal(synthesis.at(-1)?.text, 'Hello again');
  } finally {
    synthesizeImpls.fish = originalFish;
    ttsQueueHandler.synthesisTimeoutMs = originalTimeout;
    scriptedQueue = null;
  }
});

test('a failed Fish request emits Piper audio for playback', async () => {
  const originalPiper = synthesizeImpls.piper;
  const originalGet = cache.get;
  const originalDel = cache.del;
  synthesizeImpls.piper = async (request) => {
    synthesis.push({ provider: 'piper', text: request.text, voice: request.voice });
    return { error: false, message: 'ok', outputPath: '/tmp/tts-test/audio.wav', publicPath: '/test/audio' };
  };
  creditStatus = 'available';
  lookupFails = false;
  rawText = '[happy] Hello';
  pending = true;
  playbackAvailable = true;
  const before = emitted.length;

  try {
    await ttsQueueHandler.processNext('playback-test');
    assert.deepEqual(emitted.slice(before), [{ event: 'speech', payload: {
      speechID: 'speech-test', audioUrl: '/test/audio', mimeType: 'audio/wav',
      mode: 'speak', text: 'Hello',
    } }]);
    const removed: string[] = [];
    cache.get = async (key: string) => key.endsWith(':tts:processing') ? null : originalGet(key);
    cache.del = async (key?: string | string[]) => {
      if (key) removed.push(...(Array.isArray(key) ? key : [key]));
    };
    await ttsQueueHandler.handleSpeechEnded('playback-test', 'speech-test');
    assert.ok(removed.includes('twitch:playback-test:tts:processing'), 'expired Redis key still releases active playback');
  } finally {
    cache.get = originalGet;
    cache.del = originalDel;
    await ttsQueueHandler.cleanupChannel('playback-test');
    playbackAvailable = false;
    synthesizeImpls.piper = originalPiper;
  }
});

test('a late overlay completion cannot release a newer speech', async () => {
  const originalGet = cache.get;
  const originalDel = cache.del;
  const removed: string[] = [];
  cache.get = async (key: string) => key.endsWith(':tts:processing') ? 'new-speech' : originalGet(key);
  cache.del = async (key?: string | string[]) => {
    if (key) removed.push(...(Array.isArray(key) ? key : [key]));
  };
  try {
    await ttsQueueHandler.handleSpeechEnded('late-channel', 'old-speech');
    assert.deepEqual(removed, []);
  } finally {
    cache.get = originalGet;
    cache.del = originalDel;
  }
});

test('startup drops processing locks left by a dead process', async () => {
  const removed: string[] = [];
  const originalKeys = cache.keys;
  const originalDel = cache.del;
  cache.keys = async () => ['twitch:stale:tts:processing'];
  cache.del = async (key?: string | string[]) => {
    if (key === undefined) return;
    removed.push(...(Array.isArray(key) ? key : [key]));
  };

  try {
    await ttsQueueHandler.releaseStaleProcessingLocks();
    assert.deepEqual(removed, ['twitch:stale:tts:processing']);
  } finally {
    cache.keys = originalKeys;
    cache.del = originalDel;
  }
});

test('overlay resume clears a processing key left by a dead process', async () => {
  let processing: string | null = 'old-speech';
  const originalGet = cache.get;
  const originalDel = cache.del;
  const originalZCard = cache.zCard;
  cache.get = async (key: string) => {
    if (key.endsWith(':tts:processing')) return processing;
    return originalGet(key);
  };
  cache.del = async (key?: string | string[]) => {
    const keys = key === undefined ? [] : Array.isArray(key) ? key : [key];
    if (keys.some((entry) => entry.endsWith(':tts:processing'))) {
      processing = null;
    }
  };
  cache.zCard = async () => 0;

  try {
    await ttsQueueHandler.resumeIfIdle('dead-channel');
    assert.equal(processing, null);
  } finally {
    cache.get = originalGet;
    cache.del = originalDel;
    cache.zCard = originalZCard;
  }
});

test('playback progress extends the deadline, stalled heartbeats do not, and duplicate finishes release only once', async (t) => {
  const originalPiper = synthesizeImpls.piper;
  const originalDel = cache.del;
  const removed: string[] = [];
  synthesizeImpls.piper = async () => ({ error: false, message: 'ok',
    outputPath: '/tmp/tts-test/audio.wav', publicPath: '/test/audio' });
  cache.del = async (key) => { if (typeof key === 'string') removed.push(key); };
  creditStatus = 'exhausted';
  playbackAvailable = true;
  scriptedQueue = [{ value: 'first' }, { value: 'second' }];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = emitted.filter(event => event.event === 'speech').length;
  try {
    await ttsQueueHandler.processNext('timing');
    ttsQueueHandler.handleSpeechPlayback('timing', { speechID: 'first', phase: 'loading', position: 0 }, 'legacy:test');
    t.mock.timers.tick(59_000);
    assert.equal(emitted.filter(event => event.event === 'speech').length, before + 1);
    ttsQueueHandler.handleSpeechPlayback('timing', { speechID: 'first', phase: 'progress', position: 1 }, 'legacy:test');
    t.mock.timers.tick(2_000);
    assert.equal(emitted.filter(event => event.event === 'speech').length, before + 1, 'playing past dispatch deadline does not advance queue');
    ttsQueueHandler.handleSpeechPlayback('timing', { speechID: 'first', phase: 'progress', position: 1 }, 'legacy:test');
    t.mock.timers.tick(58_000);
    for (let i = 0; i < 30 && emitted.filter(event => event.event === 'speech').length === before + 1; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(emitted.filter(event => event.event === 'speech').length, before + 2, 'stalled heartbeat cannot extend deadline');
    await Promise.all([
      ttsQueueHandler.handleSpeechEnded('timing', 'second'),
      ttsQueueHandler.handleSpeechEnded('timing', 'second'),
      ttsQueueHandler.handleSpeechEnded('timing'),
      ttsQueueHandler.handleSpeechEnded('timing', 'first'),
    ]);
    assert.equal(removed.filter(key => key.endsWith(':queue:data:second')).length, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await ttsQueueHandler.cleanupChannel('timing');
    t.mock.timers.reset();
    cache.del = originalDel;
    synthesizeImpls.piper = originalPiper;
    playbackAvailable = false;
    scriptedQueue = null;
  }
});

test('early completion cannot unlock synthesis; disconnect discards its result and preserves waiting work', async () => {
  const originalPiper = synthesizeImpls.piper;
  const originalZCard = cache.zCard;
  let finishSynthesis!: (value: { error: boolean; message: string; outputPath: string; publicPath: string }) => void;
  let started = 0;
  synthesizeImpls.piper = async () => {
    started++;
    if (started === 1) return new Promise(resolve => { finishSynthesis = resolve; });
    return {error:false,message:'ok',outputPath:'/tmp/tts-test/audio.wav',publicPath:'/test/audio'};
  };
  cache.zCard = async () => scriptedQueue?.length ?? 0;
  creditStatus = 'exhausted';
  playbackAvailable = true;
  scriptedQueue = [{value:'in-flight'},{value:'waiting'}];
  const before = emitted.length;
  const processing = ttsQueueHandler.processNext('disconnect-synthesis');
  try {
    while (!started) await new Promise<void>(resolve=>setImmediate(resolve));
    await ttsQueueHandler.handleSpeechEnded('disconnect-synthesis','in-flight');
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(started,1,'early completion must not start concurrent synthesis');
    playbackAvailable = false;
    await ttsQueueHandler.handleOverlayDisconnected('disconnect-synthesis');
    finishSynthesis({error:false,message:'ok',outputPath:'/tmp/tts-test/audio.wav',publicPath:'/test/audio'});
    await processing;
    assert.equal(emitted.length,before,'interrupted synthesis is not delivered');
    assert.equal(scriptedQueue.length,1,'waiting speech remains queued while disconnected');
    playbackAvailable = true;
    await ttsQueueHandler.resumeIfIdle('disconnect-synthesis');
    for(let i=0;i<100 && emitted.length===before;i++) await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(emitted.length,before+1);
    assert.equal(started,2);
    await ttsQueueHandler.handleSpeechEnded('disconnect-synthesis','waiting');
    await new Promise<void>(resolve=>setImmediate(resolve));
  } finally {
    finishSynthesis?.({error:true,message:'cleanup',outputPath:'',publicPath:''});
    await processing;
    await ttsQueueHandler.cleanupChannel('disconnect-synthesis');
    synthesizeImpls.piper = originalPiper;
    cache.zCard = originalZCard;
    playbackAvailable = false;
    scriptedQueue = null;
  }
});

test('dropping a failed item retains the producer lock through cleanup', async () => {
  const originalPiper = synthesizeImpls.piper;
  const originalCleanup = ttsQueueHandler.cleanupSpeech.bind(ttsQueueHandler);
  let started = 0;
  let afterCleanup = 0;
  creditStatus = 'exhausted';
  playbackAvailable = true;
  scriptedQueue = [{value:'failed'},{value:'next'}];
  synthesizeImpls.piper = async () => {
    started++;
    return started === 1 ? {error:true,message:'fixture failure'}
      : {error:false,message:'ok',outputPath:'/tmp/tts-test/audio.wav',publicPath:'/test/audio'};
  };
  ttsQueueHandler.cleanupSpeech = async (channel, id, keepProcessing) => {
    await originalCleanup(channel, id, keepProcessing);
    if (id === 'failed') {
      await ttsQueueHandler.processNext(channel);
      afterCleanup = started;
    }
  };
  try {
    await ttsQueueHandler.processNext('cleanup-lock');
    assert.equal(afterCleanup,1,'another queue request cannot acquire the producer during cleanup');
    assert.equal(started,2);
    await ttsQueueHandler.handleSpeechEnded('cleanup-lock','next');
    await new Promise<void>(resolve=>setImmediate(resolve));
  } finally {
    ttsQueueHandler.cleanupSpeech = originalCleanup;
    await ttsQueueHandler.cleanupChannel('cleanup-lock');
    synthesizeImpls.piper = originalPiper;
    playbackAvailable = false;
    scriptedQueue = null;
  }
});


test('queued Kokoro uses Piper without charging when credits are exhausted or synthesis fails', async () => {
  queuedProvider = 'kokoro';
  lookupFails = false;
  playbackAvailable = true;
  rawText = 'Hello';
  try {
    for (const status of ['exhausted', 'unavailable', 'available']) {
      pending = true;
      creditStatus = status;
      const before = synthesis.length;
      await ttsQueueHandler.processNext('kokoro-fallback');
      assert.deepEqual(synthesis.slice(before).map(item => item.provider), status === 'available'
        ? ['kokoro', 'piper'] : ['piper']);
    }
  } finally { queuedProvider = 'fish'; }
});

test('queued paid requests recheck the current tier and try Kokoro only after confirmed exhaustion', async () => {
  lookupFails = false;
  playbackAvailable = true;
  rawText = '[happy] Hello';
  try {
    for (const plan of ['premium', 'pro', 'free']) {
      planTier = plan;
      for (const provider of ['fish', 'kokoro', 'piper']) {
        queuedProvider = provider;
        for (const status of ['exhausted', 'unavailable', 'available']) {
          creditStatus = status;
          pending = true;
          const before = synthesis.length;
          await ttsQueueHandler.processNext('paid-exhaustion');
          const expected = provider === 'piper' ? ['piper']
            : status === 'available' ? [provider, 'piper']
            : status === 'exhausted' && plan !== 'free' ? ['kokoro', 'piper'] : ['piper'];
          assert.deepEqual(synthesis.slice(before).map(item => item.provider), expected, `${plan}/${provider}/${status}`);
          if (status === 'exhausted' && plan !== 'free' && provider !== 'piper') {
            assert.deepEqual(synthesis[before], { provider: 'kokoro', voice: 'af_heart', text: 'Hello' });
          }
        }
      }
    }
    planTier = 'pro';
    creditStatus = 'exhausted';
    queuedProvider = 'fish';
    lookupFails = true;
    pending = true;
    const before = synthesis.length;
    await ttsQueueHandler.processNext('missing-paid-account');
    assert.deepEqual(synthesis.slice(before).map(item => item.provider), ['piper']);
  } finally {
    planTier = 'free';
    queuedProvider = 'fish';
    lookupFails = false;
  }
});

test('voice requests that fall back or fail leave one activity row per provider that did not speak', async () => {
  const originalPiper = synthesizeImpls.piper;
  const requestedBy = { userID: '42', userLogin: 'Viewer', userName: 'Viewer', userLevel: 1 };
  // A reward's request: reported as 'ast' (as before), labeled 'redemption' on its receipt only.
  itemExtras = { requestedBy, ...ttsRequestSources('redemption'), timestamp: Date.now() - 50 };
  queuedProvider = 'fish';
  lookupFails = false;
  planTier = 'free';
  playbackAvailable = true;
  let activityRows: Array<Record<string, any>> = [];
  const run = async (channel: string) => {
    const start = allActivityRows().length;
    pending = true;
    await ttsQueueHandler.processNext(channel);
    activityRows = allActivityRows().slice(start);
    await ttsQueueHandler.cleanupChannel(channel);
    return activityRows.map(row => ({ name: row.name, outcome: row.outcome, reason: row.reason, fallback: row.data.fallback, requested: row.data.requested }));
  };
  try {
    // No credits: Fish is skipped, then Piper fails too.
    creditStatus = 'exhausted';
    rawText = 'Hello';
    assert.deepEqual(await run('activity-a'), [
      { name: 'fish', outcome: 'skipped', reason: 'no_credits', fallback: 'piper', requested: undefined },
      { name: 'piper', outcome: 'failed', reason: 'synthesis_failed', fallback: undefined, requested: 'fish' },
    ]);
    const [skipped] = activityRows;
    assert.equal(skipped.kind, 'voice');
    assert.equal(skipped.channelID, 'activity-a');
    assert.equal(skipped.ref, 'speech-test');
    assert.deepEqual([skipped.actorID, skipped.actorLogin, skipped.actorName], ['42', 'viewer', 'Viewer']);
    assert.equal(skipped.data.source, 'redemption');
    assert.equal(skipped.data.voice, 'fish-id');
    assert.equal(skipped.data.chars, 5);
    assert.ok(skipped.data.latencyMs >= 50);
    assert.equal(activityRows[1].data.voice, 'piper-en');
    assert.equal(activityRows[1].data.error, 'test stops before playback');

    // The credit check could not confirm a balance.
    creditStatus = 'unavailable';
    assert.equal((await run('activity-b'))[0].reason, 'credit_check_failed');

    // Fish fails, Piper speaks: only Fish gets a row; Piper's receipt names the requester and its voice.
    synthesizeImpls.piper = async (request) => {
      synthesis.push({ provider: 'piper', text: request.text, voice: request.voice });
      return { error: false, message: 'ok', outputPath: '/tmp/tts-test/audio.wav', publicPath: '/test/audio' } as any;
    };
    creditStatus = 'available';
    usageCalls.length = 0;
    operations.length = 0;
    assert.deepEqual(await run('activity-c'), [
      { name: 'fish', outcome: 'failed', reason: 'synthesis_failed', fallback: 'piper', requested: undefined },
    ]);
    assert.equal(usageCalls.length, 1);
    assert.equal(usageCalls[0].provider, 'piper');
    assert.equal(usageCalls[0].characters, 5);
    assert.equal(usageCalls[0].usage.source, 'ast');
    assert.deepEqual(usageCalls[0].usage.receipt, { actor: { id: '42', login: 'Viewer', name: 'Viewer' }, voice: 'piper-en', model: undefined, source: 'redemption' });
    assert.ok(operations.length > 0 && operations.every(event => event.source === 'ast'), 'PostHog keeps reporting a reward as ast');
    synthesizeImpls.piper = originalPiper;

    // Nothing is left to say once the Fish-only cue is removed.
    creditStatus = 'exhausted';
    rawText = '[happy]';
    assert.deepEqual(await run('activity-d'), [
      { name: 'fish', outcome: 'skipped', reason: 'no_credits', fallback: 'piper', requested: undefined },
      { name: 'piper', outcome: 'skipped', reason: 'empty_text_after_fallback', fallback: undefined, requested: 'fish' },
    ]);

    // An older queue entry without a requester still records the row, without an actor.
    itemExtras = {};
    rawText = 'Hello';
    await run('activity-e');
    assert.equal(activityRows[0].actorID, '');
  } finally {
    synthesizeImpls.piper = originalPiper;
    itemExtras = {};
    rawText = '[happy] Hello';
    playbackAvailable = false;
  }
});

test('a reward arrives as redemption and is reported as ast; unknown sources become chat commands', () => {
  assert.deepEqual(ttsRequestSources('redemption'), { source: 'ast', receiptSource: 'redemption' });
  assert.deepEqual(ttsRequestSources('ast'), { source: 'ast' });
  assert.deepEqual(ttsRequestSources('chat-command'), { source: 'chat-command' });
  assert.deepEqual(ttsRequestSources({ $ne: 1 }), { source: 'chat-command' });
  assert.deepEqual(ttsRequestSources(undefined), { source: 'chat-command' });
});
