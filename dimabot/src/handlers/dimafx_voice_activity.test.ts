import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Extension voice is free and has no usage receipt; the owner's activity log is its only trace.
process.env.SECRET_KEY ??= 'a'.repeat(32); // imported services read it at load; nothing is encrypted here
let synthesis: { error: boolean; message: string; outputPath?: string; publicPath?: string } = { error: false, message: 'ok' };
mock.module('../server/services/tts/piper_tts.service.js', { namedExports: {
  piperTtsService: { synthesize: async () => synthesis }, PIPER_PUBLIC_SPEECH_DIR: '/tmp/dimafx-test', buildPublicPath: (file: string) => file,
} });
const { DimafxQueueHandler } = await import('./dimafx_queue.handler.js');
const { setActivityLogSinkForTests, pendingActivityRowsForTests } = await import('../utils/activity_log.js');
setActivityLogSinkForTests(async () => {});

const handler = new DimafxQueueHandler() as unknown as {
  dispatch(channel: string, item: Record<string, unknown>): Promise<void>;
  isOverlayConnected(channel: string): Promise<boolean>;
  scheduleTtsFileCleanup(channel: string, trigger: string): void;
};
// The overlay "disconnects" right after synthesis, so dispatch stops before any socket work.
handler.isOverlayConnected = async () => false;
handler.scheduleTtsFileCleanup = () => {};
const item = (extra: Record<string, unknown> = {}) => ({ triggerID: 'trigger-1', channelID: '42', itemID: 'i1', name: 'Hello', category: 'tts',
  volume: 1, durationMs: 1, source: 'bits_purchase', enqueuedAt: 0, tts: { text: 'Hola 👋', voice: 'es_MX-voice', language: 'es' }, ...extra });

test('DimaFX speech leaves an ok row with the buyer and its length, and a failed row when Piper fails', async () => {
  synthesis = { error: false, message: 'ok', outputPath: '/tmp/dimafx-test/a.wav', publicPath: '/a.wav' };
  await assert.rejects(handler.dispatch('42', item({ widget: { bits: 100, credits: null, buyerId: '77', message: null } })), /disconnected/);
  const ok = pendingActivityRowsForTests().at(-1)!;
  assert.deepEqual({ kind: ok.kind, name: ok.name, outcome: ok.outcome, channelID: ok.channelID, actorID: ok.actorID, ref: ok.ref },
    { kind: 'voice', name: 'piper', outcome: 'ok', channelID: '42', actorID: '77', ref: 'trigger-1' });
  assert.deepEqual(ok.data, { source: 'dimafx', chars: 6, voice: 'es_MX-voice' });

  synthesis = { error: true, message: 'piper down' };
  await assert.rejects(handler.dispatch('42', item({ triggerID: 'trigger-2' })), /piper down/);
  const failed = pendingActivityRowsForTests().at(-1)!;
  assert.deepEqual({ outcome: failed.outcome, reason: failed.reason, actorID: failed.actorID, error: failed.data.error },
    { outcome: 'failed', reason: 'synthesis_failed', actorID: '', error: 'piper down' });
});

test('overlay test speech leaves an ok row and charges nothing', async () => {
  const { prepareTest } = await import('../overlays/test-playback.js');
  synthesis = { error: false, message: 'ok', outputPath: '/tmp/dimafx-test/b.wav' };
  const prepared = await prepareTest('42', 'tts', { language: 'en' });
  const row = pendingActivityRowsForTests().at(-1)!;
  assert.equal(row.name, 'piper');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.data.source, 'overlay_test');
  assert.equal(row.data.chars, prepared.text!.length);
  synthesis = { error: true, message: 'down' };
  await assert.rejects(prepareTest('42', 'tts', { language: 'es' }), /temporarily unavailable/);
  assert.equal(pendingActivityRowsForTests().at(-1)!.outcome, 'failed');
});
