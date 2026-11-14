import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Which speech page plays a normal TTS message, and how a failed message moves to another page.
const data = new Map<string, string>();
const queues = new Map<string, string[]>();
const finishedActivities: string[] = [];
const retired = new Map<string, string>(), confirmed: string[] = [];
const synthesized: string[] = [];
/** Synthesis waits for these (by speech id) when present, so a test can act while a message is being made. */
const synthGates = new Map<string, Promise<void>>();
const cache = {
  eval: async (_script: string, options: { keys: string[] }): Promise<unknown> => {
    const next = queues.get(options.keys[0])?.shift();
    if (!next) return [];
    return [next, data.get(options.keys[2]) ?? '', data.get(options.keys[1]) ?? ''];
  },
  get: async (key: string) => data.get(key) ?? null,
  set: async (key: string, value: string) => { data.set(key, value); },
  del: async (key: string) => { data.delete(key); queues.delete(key); },
  zCard: async (key: string) => queues.get(key)?.length ?? 0,
  zRange: async (key: string) => [...queues.get(key) ?? []],
  zRem: async (key: string, id: string) => { queues.set(key, (queues.get(key) ?? []).filter(value => value !== id)); },
  zAdd: async (key: string, entry: { value: string }) => { queues.set(key, [...queues.get(key) ?? [], entry.value]); },
  keys: async () => [],
  multi: () => { const transaction = { zRem: () => transaction, del: () => transaction, exec: async () => {} }; return transaction; }
};

interface Sent { event: string; payload: any }
class Page {
  connected = true;
  sent: Sent[] = [];
  /** Reply to `speech-cancel`; undefined = no answer (an older page). */
  cancelReply: { stopped: boolean; started: boolean } | undefined = { stopped: true, started: false };
  data: { ttsReady: boolean; ttsOutput: any };
  constructor(public id: string, state: 'old' | { visible: boolean; probe: string; obs?: boolean }, pageId = `page-${id}-id`) {
    const version = state === 'old' ? 1 : 2;
    this.data = { ttsReady: true, ttsOutput: { version, pageId: version === 2 ? pageId : undefined, played: false, probe: 'idle', failures: 0, connectedAt: 0,
      ...(state === 'old' ? {} : { visible: state.visible, obs: state.obs ?? true, probe: state.probe, played: state.probe === 'ok', probeSince: state.probe === 'pending' ? 0 : undefined }) } };
  }
  emit(event: string, payload?: any) { this.sent.push({ event, payload }); return true; }
  timeout(ms: number) {
    return { emitWithAck: async (event: string, payload: any) => {
      this.sent.push({ event, payload });
      if (!this.cancelReply) { await new Promise(resolve => setTimeout(resolve, ms)); throw new Error('operation has timed out'); }
      return this.cancelReply;
    } };
  }
  got(event: string, speechID?: string) { return this.sent.filter(entry => entry.event === event && (speechID === undefined || entry.payload?.speechID === speechID)).length; }
}
const pages = new Map<string, Map<string, Page>>();
const open = (channel: string, ...list: Page[]) => { pages.set(`/speech/${channel}`, new Map(list.map(page => [page.id, page]))); return list; };

mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../desktop_ai/activity.js', { namedExports: {
  prepareSpeechActivity: async (value: object) => ({ ...value, fence: 'test' }), startSpeechActivity: async () => true,
  finishSpeechActivity: async (activity: { playbackId: string }) => { finishedActivities.push(activity.playbackId); }, extendSpeechActivity: async () => true,
  retireMatchingSpeechActivity: async (channel: string, speech: string, _generation: number, _deadline: number, proof: { source: string }) => { retired.set(`${channel}:${speech}`, proof.source); return true; },
  confirmRetiredSpeechActivity: async (channel: string, proof: { source?: string }, speech: string) => {
    const key = `${channel}:${speech}`; if (retired.get(key) !== proof.source) return false;
    retired.delete(key); confirmed.push(key); return true;
  },
} });
mock.module('../server/websocket.js', { namedExports: { getIO: () => ({ of: (name: string) => ({
  sockets: pages.get(name) ?? new Map(),
  emit: (event: string, payload: any) => { for (const page of pages.get(name)?.values() ?? []) page.emit(event, payload); }
}) }) } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ plan_tier: 'free' }) } });
mock.module('../utils/billing.js', { namedExports: { isAiCreditsExhausted: async () => false, getAiCredits: async () => ({ status: 'available' }) } });
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async () => {} } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiOperation: () => {} } });
mock.module('../utils/tts/tts_playback_timeout.util.js', { namedExports: { getTtsPlaybackTimeoutMs: async () => 60000 } });
for (const provider of ['piper', 'fish', 'kokoro']) mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
  [`${provider}TtsService`]: { synthesize: async (input: any) => { synthesized.push(input.speechID); await synthGates.get(input.speechID); return { error: false, outputPath: `/tmp/${input.speechID}.wav`, publicPath: `/audio/${input.speechID}` }; } },
  ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-delivery' } : {})
} });
const { ttsQueueHandler: handler } = await import('./tts_queue.handler.js');
const { registerStudioBridge } = await import('../overlays/bridge.js');
registerStudioBridge({ hasSource: () => false, media: async () => {}, trigger: async () => {}, controlTts: async () => {} });
handler.outputTimings = { startAfterReadyMs: 40, startAfterSendMs: 120, cancelAckMs: 20 };

function seed(channel: string, speechID: string, extra: Record<string, unknown> = {}) {
  queues.set(`twitch:${channel}:tts:queue`, [...queues.get(`twitch:${channel}:tts:queue`) ?? [], speechID]);
  data.set(`twitch:${channel}:tts:queue:data:${speechID}`, JSON.stringify({ channelID: channel, speechID, provider: 'piper', mode: 'speak', language: 'en', voice: 'test', text: speechID, ...extra }));
}
async function until(condition: () => boolean, label = 'condition') {
  for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${label} timed out`);
}
const processing = (channel: string) => data.get(`twitch:${channel}:tts:processing`);
const playing = (channel: string, page: Page, speechID: string) => handler.handleSpeechPlayback(channel, { speechID, phase: 'playing', position: 0 }, `legacy:${page.id}`);
const ended = (channel: string, page: Page, speechID: string, reason = 'ended', report: Record<string, unknown> = {}) =>
  handler.handleOverlayEnded(channel, speechID, reason, `legacy:${page.id}`, true, report);

test('a message goes to the copy that can play, not the lowest socket id', async () => {
  const [hidden, visible] = open('pick', new Page('a-hidden', { visible: false, probe: 'pending' }), new Page('b-visible', { visible: true, probe: 'ok' }));
  seed('pick', 'pick-1');
  await handler.processNext('pick');
  await until(() => visible.got('speech', 'pick-1') === 1);
  assert.equal(hidden.got('speech'), 0);
  await ended('pick', visible, 'pick-1');
  assert.ok(finishedActivities.includes('pick-1'), 'a page that said it ended releases the speech slot');
});

test('play-error before anything was heard moves the same audio to the next copy, without new synthesis', async () => {
  const [first, second] = open('move', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  seed('move', 'move-1');
  await handler.processNext('move');
  await until(() => first.got('speech', 'move-1') === 1);
  const before = synthesized.filter(id => id === 'move-1').length;
  await ended('move', first, 'move-1', 'play-error');
  assert.equal(second.got('speech', 'move-1'), 1);
  assert.deepEqual(second.sent.find(entry => entry.event === 'speech')!.payload, first.sent.find(entry => entry.event === 'speech')!.payload, 'same speech id and audio url');
  assert.equal(synthesized.filter(id => id === 'move-1').length, before, 'never synthesized (or billed) again');
  assert.equal(processing('move'), 'move-1', 'the queue still waits for this message');
  assert.equal(first.data.ttsOutput.failures, 1, 'the failing copy ranks lower next time');
  // A late report from the copy it left must not finish it.
  await ended('move', first, 'move-1', 'ended');
  assert.equal(processing('move'), 'move-1');
  playing('move', second, 'move-1');
  await ended('move', second, 'move-1');
  assert.equal(processing('move'), undefined);
  assert.equal(second.data.ttsOutput.failures, 0);
  seed('move', 'move-2');
  await handler.processNext('move');
  await until(() => second.got('speech', 'move-2') === 1, 'next message goes to the copy that worked');
  await ended('move', second, 'move-2');
});

test('a failure after playback started is never replayed elsewhere', async () => {
  const [first, second] = open('heard', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  seed('heard', 'heard-1');
  await handler.processNext('heard');
  await until(() => first.got('speech', 'heard-1') === 1);
  playing('heard', first, 'heard-1');
  await ended('heard', first, 'heard-1', 'stalled', { position: 1.2 });
  assert.equal(second.got('speech'), 0);
  assert.equal(processing('heard'), undefined);
});

test('older pages: play-error moves on, but a page that reconnected under a new socket id is not trusted', async () => {
  const [oldA, reconnected, fresh] = open('old', new Page('a', 'old'), new Page('b', 'old'), new Page('c', { visible: true, probe: 'pending' }));
  pages.get('/speech/old')!.delete('b'); pages.get('/speech/old')!.delete('c');
  seed('old', 'old-1');
  await handler.processNext('old');
  await until(() => oldA.got('speech', 'old-1') === 1);
  // After it went out: an older page connects (could be page A again) and a current page with its own page id.
  pages.get('/speech/old')!.set('b', reconnected); pages.get('/speech/old')!.set('c', fresh);
  await ended('old', oldA, 'old-1', 'play-error');
  assert.equal(reconnected.got('speech'), 0, 'an older page that connected later may be the page that already saw it');
  assert.equal(fresh.got('speech', 'old-1'), 1);
  await ended('old', fresh, 'old-1');
});

test('a current page that reconnects keeps its page id and is not tried twice', async () => {
  const [a, b] = open('repage', new Page('a', { visible: true, probe: 'ok' }, 'page-same'), new Page('b', { visible: true, probe: 'ok' }, 'page-other'));
  seed('repage', 'repage-1');
  await handler.processNext('repage');
  await until(() => a.got('speech', 'repage-1') === 1);
  const again = new Page('a2', { visible: true, probe: 'ok' }, 'page-same');
  pages.get('/speech/repage')!.delete('b');
  pages.get('/speech/repage')!.set('a2', again);
  await ended('repage', a, 'repage-1', 'play-error');
  assert.equal(again.got('speech'), 0);
  assert.equal(processing('repage'), undefined, 'no other copy: the message ends');
  assert.equal(b.got('speech'), 0);
});

test('ready but never playing: the page is asked to stop, confirms, and the message moves', async () => {
  const [stuck, other] = open('stuck', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  seed('stuck', 'stuck-1');
  await handler.processNext('stuck');
  await until(() => stuck.got('speech', 'stuck-1') === 1);
  handler.handleSpeechPlayback('stuck', { speechID: 'stuck-1', phase: 'ready', position: 0 }, 'legacy:a');
  await until(() => other.got('speech', 'stuck-1') === 1, 'moved after the start deadline');
  assert.equal(stuck.got('speech-cancel', 'stuck-1'), 1);
  playing('stuck', other, 'stuck-1');
  await ended('stuck', other, 'stuck-1');
  assert.ok(finishedActivities.includes('stuck-1'), 'both copies are known to be silent');
});

test('a page that says it had started after all is stopped, not replayed', async () => {
  const [late, other] = open('late', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  late.cancelReply = { stopped: true, started: true };
  seed('late', 'late-1');
  await handler.processNext('late');
  await until(() => late.got('speech', 'late-1') === 1);
  handler.handleSpeechPlayback('late', { speechID: 'late-1', phase: 'ready', position: 0 }, 'legacy:a');
  await until(() => processing('late') === undefined, 'ended');
  assert.equal(other.got('speech'), 0);
});

test('with only one copy a slow start is left alone; its own checks end it', async () => {
  const [only] = open('alone', new Page('a', { visible: true, probe: 'ok' }));
  seed('alone', 'alone-1');
  await handler.processNext('alone');
  await until(() => only.got('speech', 'alone-1') === 1);
  handler.handleSpeechPlayback('alone', { speechID: 'alone-1', phase: 'ready', position: 0 }, 'legacy:a');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(only.got('speech-cancel'), 0);
  assert.equal(processing('alone'), 'alone-1');
  playing('alone', only, 'alone-1');
  await ended('alone', only, 'alone-1');
});

test('an older page that never reports is reset after its download budget and the message moves', async () => {
  const [silent, other] = open('quiet', new Page('a', 'old'), new Page('b', { visible: true, probe: 'ok' }));
  silent.data.ttsOutput.lastPlayedAt = Date.now(); // rank the older page first
  other.data.ttsOutput.failures = 1; other.data.ttsOutput.lastFailureAt = Date.now();
  seed('quiet', 'quiet-1');
  await handler.processNext('quiet');
  await until(() => silent.got('speech', 'quiet-1') === 1);
  await until(() => other.got('speech', 'quiet-1') === 1, 'moved after no report at all');
  assert.equal(silent.got('speech-reset'), 1, 'older pages understand a reset');
  await ended('quiet', other, 'quiet-1');
  assert.ok(finishedActivities.includes('quiet-1'), 'a page that never started is silent after the reset');
});

test('a copy that disconnects before playing hands the message over', async () => {
  const [leaving, staying] = open('gone', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  seed('gone', 'gone-1');
  await handler.processNext('gone');
  await until(() => leaving.got('speech', 'gone-1') === 1);
  leaving.connected = false; pages.get('/speech/gone')!.delete('a');
  await handler.handleOverlayDisconnected('gone', 'legacy:a');
  assert.equal(staying.got('speech', 'gone-1'), 1);
  await ended('gone', staying, 'gone-1');
});

test('at most three copies try one message', async () => {
  const list = open('cap', ...['a', 'b', 'c', 'd'].map(id => new Page(id, { visible: true, probe: 'ok' })));
  seed('cap', 'cap-1');
  await handler.processNext('cap');
  for (const page of list.slice(0, 3)) {
    await until(() => page.got('speech', 'cap-1') === 1);
    await ended('cap', page, 'cap-1', 'play-error');
  }
  assert.equal(list[3].got('speech'), 0);
  assert.equal(processing('cap'), undefined);
});

test('a skip while a message is moving to another copy never resurrects it', async () => {
  const [a, b] = open('skipmove', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  a.cancelReply = undefined; // no answer: the move waits for the ack timeout
  seed('skipmove', 'skipmove-1');
  await handler.processNext('skipmove');
  await until(() => a.got('speech', 'skipmove-1') === 1);
  handler.handleSpeechPlayback('skipmove', { speechID: 'skipmove-1', phase: 'ready', position: 0 }, 'legacy:a');
  await until(() => a.got('speech-cancel', 'skipmove-1') === 1);
  await handler.control('skipmove', 'skip');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(b.got('speech', 'skipmove-1'), 0);
  assert.equal(processing('skipmove'), undefined);
});

test('every copy mode: all open copies play; the queue waits for the ones that started and stops the rest', async () => {
  const [a, b, c] = open('every', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }), new Page('c', { visible: false, probe: 'pending' }));
  seed('every', 'every-1', { allOutputs: true });
  await handler.processNext('every');
  await until(() => a.got('speech', 'every-1') === 1 && b.got('speech', 'every-1') === 1 && c.got('speech', 'every-1') === 1);
  playing('every', a, 'every-1'); playing('every', b, 'every-1');
  await ended('every', a, 'every-1');
  assert.equal(processing('every'), 'every-1', 'b is still playing');
  const resetsBefore = c.got('speech-reset');
  await ended('every', b, 'every-1');
  assert.equal(processing('every'), undefined);
  assert.ok(c.got('speech-reset') > resetsBefore, 'the copy that never started is stopped');
  assert.ok(finishedActivities.includes('every-1'));
});

test('every copy mode: a skip waits for every copy that may be playing before releasing the speech slot', async () => {
  const [a, b] = open('everyskip', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  seed('everyskip', 'everyskip-1', { allOutputs: true });
  await handler.processNext('everyskip');
  await until(() => a.got('speech', 'everyskip-1') === 1 && b.got('speech', 'everyskip-1') === 1);
  playing('everyskip', a, 'everyskip-1'); playing('everyskip', b, 'everyskip-1');
  await handler.control('everyskip', 'skip');
  const key = 'everyskip:everyskip-1';
  assert.equal(retired.get(key), 'legacy:all');
  await ended('everyskip', a, 'everyskip-1', 'reset');
  assert.ok(!confirmed.includes(key), 'one copy is not enough');
  await ended('everyskip', b, 'everyskip-1', 'reset');
  assert.ok(confirmed.includes(key));
});

test('a reset confirmation from a current page releases a skipped message right away', async () => {
  const [a] = open('resetack', new Page('a', { visible: true, probe: 'ok' }));
  seed('resetack', 'resetack-1');
  await handler.processNext('resetack');
  await until(() => a.got('speech', 'resetack-1') === 1);
  playing('resetack', a, 'resetack-1');
  await handler.control('resetack', 'skip');
  assert.equal(retired.get('resetack:resetack-1'), 'legacy:a');
  await ended('resetack', a, 'resetack-1', 'reset');
  assert.ok(confirmed.includes('resetack:resetack-1'));
});

test('status lists the open copies and their problems', async () => {
  open('status', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: false, probe: 'pending' }), new Page('c', { visible: true, probe: 'blocked', obs: false }));
  const status = await handler.getStatus('status', { allOutputs: true });
  assert.deepEqual(status.outputs, { total: 3, playable: 1, hidden: 1, blocked: 1, failing: 0, unknown: 0, mode: 'all' });
});

test('a cancel that times out after a skip never resets the page that now plays the next message', async () => {
  const [a, b] = open('stale', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  a.cancelReply = undefined;
  const timings = handler.outputTimings;
  handler.outputTimings = { ...timings, cancelAckMs: 300 };
  try {
    seed('stale', 'stale-1'); seed('stale', 'stale-2');
    await handler.processNext('stale');
    await until(() => a.got('speech', 'stale-1') === 1);
    handler.handleSpeechPlayback('stale', { speechID: 'stale-1', phase: 'ready', position: 0 }, 'legacy:a');
    await until(() => a.got('speech-cancel', 'stale-1') === 1, 'waiting for the cancel answer');
    await handler.control('stale', 'skip');
    await until(() => a.got('speech', 'stale-2') === 1 || b.got('speech', 'stale-2') === 1, 'next message out');
    const page = a.got('speech', 'stale-2') ? a : b;
    const resets = page.got('speech-reset');
    await new Promise(resolve => setTimeout(resolve, 400)); // the old cancel answer times out now
    assert.equal(page.got('speech-reset'), resets, 'no reset reaches the page playing the next message');
    assert.equal(b.got('speech', 'stale-1'), 0, 'the skipped message was not moved');
    assert.equal(processing('stale'), 'stale-2');
    playing('stale', page, 'stale-2');
    await ended('stale', page, 'stale-2');
  } finally { handler.outputTimings = timings; }
});

test('a stop confirmed in the middle of a skip is remembered when cleanup retires the message again', async () => {
  const [a, b] = open('twice', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
  seed('twice', 'twice-1', { allOutputs: true });
  await handler.processNext('twice');
  await until(() => a.got('speech', 'twice-1') === 1 && b.got('speech', 'twice-1') === 1);
  playing('twice', a, 'twice-1'); playing('twice', b, 'twice-1');
  // Page A confirms while the skip is still running (between retirement and cleanup).
  registerStudioBridge({ hasSource: () => false, media: async () => {}, trigger: async () => {},
    controlTts: async () => { await ended('twice', a, 'twice-1', 'reset'); } });
  try { await handler.control('twice', 'skip'); }
  finally { registerStudioBridge({ hasSource: () => false, media: async () => {}, trigger: async () => {}, controlTts: async () => {} }); }
  const key = 'twice:twice-1';
  assert.ok(!confirmed.includes(key), 'B has not confirmed yet');
  await ended('twice', b, 'twice-1', 'reset');
  assert.ok(confirmed.includes(key), 'the slot is released once both confirmed');
});

test('a page that times out without starting is marked failing, even with no other page to move to', async () => {
  const [silent] = open('timeout', new Page('a', 'old'));
  seed('timeout', 'timeout-1');
  await handler.processNext('timeout');
  await until(() => silent.got('speech', 'timeout-1') === 1);
  await (handler as unknown as { playbackTimedOut(channel: string, speech: string): Promise<void> }).playbackTimedOut('timeout', 'timeout-1');
  assert.equal(processing('timeout'), undefined);
  assert.ok(silent.got('speech-reset') >= 1, 'the page is stopped');
  assert.ok(finishedActivities.includes('timeout-1'), 'a page that never started is known to be silent');
  const status = await handler.getStatus('timeout');
  assert.deepEqual([status.outputs?.failing, status.outputs?.playable], [1, 0]);
});

test('each message that was made leaves one playback row for the owner: played after a move, failed, skipped', async () => {
  const { setActivityLogSinkForTests, pendingActivityRowsForTests } = await import('../utils/activity_log.js');
  const written: Array<{ kind: string; name: string; ref: string; outcome: string; reason: string; actorLogin: string; data: Record<string, unknown> }> = [];
  setActivityLogSinkForTests(async rows => { written.push(...rows); });
  const rowsFor = (speechID: string) => [...written, ...pendingActivityRowsForTests()].filter(row => row.kind === 'voice' && row.name === 'playback' && row.ref === speechID);
  const viewer = { requestedBy: { userID: '7', userLogin: 'Viewer', userName: 'Viewer' } };
  try {
    // Moved off a page that could not start it, then played on the next one.
    const [first, second] = open('rows', new Page('a', { visible: true, probe: 'ok' }), new Page('b', { visible: true, probe: 'ok' }));
    seed('rows', 'rows-1', viewer);
    await handler.processNext('rows');
    await until(() => first.got('speech', 'rows-1') === 1);
    await ended('rows', first, 'rows-1', 'play-error');
    playing('rows', second, 'rows-1');
    await ended('rows', second, 'rows-1');
    await until(() => rowsFor('rows-1').length === 1, 'played row');
    const played = rowsFor('rows-1')[0];
    assert.deepEqual([played.outcome, played.reason, played.actorLogin], ['ok', '', 'viewer']);
    assert.deepEqual([played.data.movedBecause, played.data.pages, played.data.heard, played.data.provider], ['play-error', 2, true, 'piper']);

    // A mod skips it while it plays.
    seed('rows', 'rows-2', viewer);
    await handler.processNext('rows');
    await until(() => second.got('speech', 'rows-2') === 1);
    playing('rows', second, 'rows-2');
    await handler.control('rows', 'skip');
    await until(() => rowsFor('rows-2').length === 1, 'skipped row');
    assert.deepEqual([rowsFor('rows-2')[0].outcome, rowsFor('rows-2')[0].reason, rowsFor('rows-2')[0].data.heard], ['skipped', 'tts_skipped', true]);

    // The only page cannot start it: nowhere to move, so it did not play.
    const [only] = open('rows-one', new Page('a', { visible: true, probe: 'ok' }));
    seed('rows-one', 'rows-3', viewer);
    await handler.processNext('rows-one');
    await until(() => only.got('speech', 'rows-3') === 1);
    await ended('rows-one', only, 'rows-3', 'play-error');
    await until(() => rowsFor('rows-3').length === 1, 'failed row');
    const failed = rowsFor('rows-3')[0];
    assert.deepEqual([failed.outcome, failed.reason, failed.data.heard, failed.data.pages, failed.data.endReason], ['failed', 'play_error', false, 1, 'play-error']);

    // Late or repeated endings never add a second row.
    await ended('rows', second, 'rows-1');
    await handler.cleanupSpeech('rows-one', 'rows-3');
    assert.deepEqual(['rows-1', 'rows-2', 'rows-3'].map(id => rowsFor(id).length), [1, 1, 1]);

    // The only page closes while the message is being made: it was made, nobody got it, and no mod did anything.
    const [lonely] = open('rows-gone', new Page('a', { visible: true, probe: 'ok' }));
    let release!: () => void;
    synthGates.set('rows-4', new Promise<void>(resolve => { release = resolve; }));
    seed('rows-gone', 'rows-4', viewer);
    const run = handler.processNext('rows-gone');
    await until(() => synthesized.includes('rows-4'), 'synthesis started');
    lonely.connected = false;
    pages.delete('/speech/rows-gone');
    await handler.handleOverlayDisconnected('rows-gone', 'legacy:a');
    release();
    await run;
    await until(() => rowsFor('rows-4').length === 1, 'dropped row');
    assert.deepEqual([rowsFor('rows-4')[0].outcome, rowsFor('rows-4')[0].reason, rowsFor('rows-4')[0].data.pages], ['failed', 'page_closed', undefined]);
  } finally {
    setActivityLogSinkForTests(null);
  }
});
