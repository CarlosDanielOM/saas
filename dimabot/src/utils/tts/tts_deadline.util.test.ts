import assert from 'node:assert/strict';
import test from 'node:test';

import { promiseWithTimeout, readAudioStream } from './tts_deadline.util.js';

test('promiseWithTimeout rejects when the work never settles', async () => {
  await assert.rejects(
    promiseWithTimeout(new Promise(() => {}), 20, 'TTS synthesis timed out'),
    /TTS synthesis timed out/,
  );
});

test('promiseWithTimeout returns the original result', async () => {
  assert.equal(await promiseWithTimeout(Promise.resolve('ok'), 50, 'late'), 'ok');
});

test('readAudioStream returns the bytes from a completed stream', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });

  const buffer = await readAudioStream(stream, AbortSignal.timeout(1000));
  assert.deepEqual([...buffer], [1, 2, 3]);
});

test('readAudioStream cancels a stream that never finishes', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const pending = readAudioStream(stream, controller.signal);
  controller.abort();

  await assert.rejects(pending, /Fish Audio TTS timed out/);
  assert.equal(cancelled, true);
});
