import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOutputState, newOutputInfo, outputProblem, rankOutputs, recordOutputFailure, recordOutputSuccess, summarizeOutputs, PROBE_DEFERRED_MS, type SpeechOutputInfo } from './tts_outputs.js';

const NOW = 1_000_000;
const page = (id: string, state: Record<string, unknown> | null, extra: Partial<SpeechOutputInfo> = {}, connectedAt = 0) => {
  const info = newOutputInfo(state ? { v: 2, pageId: `page-${id}-0000` } : undefined, connectedAt);
  if (state) applyOutputState(info, { v: 2, ...state }, NOW - PROBE_DEFERRED_MS - 1);
  Object.assign(info, extra);
  return { id, connected: true, data: { ttsReady: true, ttsOutput: info } };
};
const order = (...sockets: ReturnType<typeof page>[]) => rankOutputs(sockets, NOW).map(socket => socket.id);

test('a visible OBS source beats a hidden one whose audio is held back (the spectralzero_ case)', () => {
  const hidden = page('hidden', { visible: false, obs: true, probe: 'pending' }, {}, 1);
  const visible = page('visible', { visible: true, obs: true, probe: 'ok' }, {}, 2);
  assert.deepEqual(order(hidden, visible), ['visible', 'hidden']);
  assert.equal(outputProblem(hidden.data.ttsOutput, NOW), 'hidden');
  assert.equal(outputProblem(visible.data.ttsOutput, NOW), null);
});

test('a browser tab that blocks sound ranks last; a page from before this version sits below known-good pages', () => {
  const blocked = page('phone', { visible: true, obs: false, probe: 'blocked' });
  const old = page('old', null);
  const good = page('good', { visible: true, obs: true, probe: 'ok' });
  assert.deepEqual(order(blocked, old, good), ['good', 'old', 'phone']);
  assert.equal(outputProblem(blocked.data.ttsOutput, NOW), 'blocked');
});

test('failures push a page down until it plays again; old failures are forgotten', () => {
  const a = page('a', { visible: true, obs: true, probe: 'ok' }, {}, 1);
  const b = page('b', { visible: true, obs: true, probe: 'ok' }, {}, 2);
  recordOutputFailure(a.data.ttsOutput, 'play-error', NOW);
  assert.deepEqual(order(a, b), ['b', 'a']);
  assert.equal(outputProblem(a.data.ttsOutput, NOW), 'failing');
  recordOutputSuccess(a.data.ttsOutput, NOW);
  assert.deepEqual(order(a, b), ['a', 'b'], 'the page that just played wins the tie');
  recordOutputFailure(b.data.ttsOutput, 'play-error', NOW - 31 * 60_000);
  assert.equal(outputProblem(b.data.ttsOutput, NOW), null);
});

test('OBS program output is preferred, and a hidden page that already played can still play', () => {
  const preview = page('preview', { visible: true, obs: true, obsActive: false, probe: 'ok' });
  const live = page('live', { visible: true, obs: true, obsActive: true, probe: 'ok' });
  const hiddenPlayed = page('hidden-played', { visible: false, obs: true, probe: 'ok' });
  assert.deepEqual(order(preview, hiddenPlayed, live), ['live', 'preview', 'hidden-played']);
  assert.equal(outputProblem(hiddenPlayed.data.ttsOutput, NOW), null);
});

test('state reports are validated, never touch the failure history and ignore other versions', () => {
  const info = newOutputInfo({ v: 2, pageId: 'bad id!' }, NOW);
  assert.equal(info.version, 1, 'a malformed page id is not trusted');
  recordOutputFailure(info, 'play-error', NOW);
  assert.equal(applyOutputState(info, { v: 1, visible: false }, NOW), false);
  assert.equal(applyOutputState(info, 'nope', NOW), false);
  assert.equal(applyOutputState(info, { v: 2, visible: 'no', probe: 'maybe', failures: 0, played: true }, NOW), true);
  assert.equal(info.visible, undefined);
  assert.equal(info.probe, 'idle');
  assert.equal(info.failures, 1);
  assert.equal(info.played, true);
});

test('a pending probe only counts as held back after a few seconds', () => {
  const info = newOutputInfo({ v: 2, pageId: 'page-pending-01' }, NOW);
  applyOutputState(info, { v: 2, visible: false, probe: 'pending' }, NOW);
  applyOutputState(info, { v: 2, probe: 'pending' }, NOW + 2_000); // a repeat keeps the first time
  assert.equal(info.probeSince, NOW);
  assert.equal(outputProblem(info, NOW + 1_000), 'hidden', 'hidden and never played');
  applyOutputState(info, { v: 2, visible: true }, NOW + 1_000);
  assert.equal(outputProblem(info, NOW + 1_000), null);
  assert.equal(outputProblem(info, NOW + PROBE_DEFERRED_MS), 'hidden');
});

test('summary counts speech pages only and says which mode is on', () => {
  const sockets = [page('a', { visible: true, obs: true, probe: 'ok' }), page('b', { visible: false, obs: true, probe: 'pending' }), page('c', null),
    { id: 'gone', connected: false, data: { ttsReady: true } }, { id: 'unready', connected: true, data: { ttsReady: false } }];
  assert.deepEqual(summarizeOutputs(sockets, 'all', NOW), { total: 3, playable: 2, hidden: 1, blocked: 0, failing: 0, unknown: 1, mode: 'all' });
});
