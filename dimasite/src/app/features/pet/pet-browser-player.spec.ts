import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetBrowserPlayer, type BrowserPetPlaybackReport, type BrowserPetSpeech } from './pet-browser-player';
import { computeMouthCurves, sampleMouthCurves } from './mouth-curves';

class TestAudio extends EventTarget {
  src = ''; preload = ''; crossOrigin = ''; duration = 1; currentTime = 0;
  paused = true; ended = false;
  load = vi.fn();
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

describe('precomputed browser mouth playback', () => {
  let audio: TestAudio;
  let player: PetBrowserPlayer;
  let fetchAudio: ReturnType<typeof vi.fn>;
  let decode: ReturnType<typeof vi.fn>;
  let report: ReturnType<typeof vi.fn<(event: BrowserPetPlaybackReport) => void>>;
  let mouth: ReturnType<typeof vi.fn<(id: string, positionMs: number, value: number, smile: number) => void>>;
  let speaking: ReturnType<typeof vi.fn<(value: boolean) => void>>;
  let revoke: ReturnType<typeof vi.fn>;
  let createUrl: ReturnType<typeof vi.fn>;
  const rate = 8000;
  const pcm = Float32Array.from({ length: rate }, (_, index) => (index < 2000 ? .4 : .1) * Math.sin(2 * Math.PI * 900 * index / rate));
  const speech = (extra: Partial<BrowserPetSpeech> = {}): BrowserPetSpeech => ({
    id: 'speech-one', url: 'https://api.example.test/pets/playback/speech-one/audio?ticket=test',
    startBefore: Date.now() + 12_000, maxDurationMs: 1000, ...extra,
  });
  const response = (chunks = [new Uint8Array([1, 2, 3])], length = 3) => {
    let next = 0;
    return { ok: true, headers: { get: (name: string) => name === 'content-length' ? String(length) : 'audio/wav' },
      body: { getReader: () => ({ read: async () => next < chunks.length ? { done: false, value: chunks[next++] } : { done: true },
        cancel: vi.fn(async () => {}), releaseLock: vi.fn() }) } };
  };
  beforeEach(() => {
    vi.useFakeTimers();
    audio = new TestAudio();
    vi.stubGlobal('Audio', class { constructor() { return audio; } });
    decode = vi.fn(async () => ({ duration: 1, numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm }));
    vi.stubGlobal('AudioContext', class {
      state = 'running'; destination = {};
      createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
      decodeAudioData = decode;
      resume = vi.fn(async () => {}); suspend = vi.fn(async () => {}); close = vi.fn(async () => {});
    });
    fetchAudio = vi.fn(async () => response()); vi.stubGlobal('fetch', fetchAudio);
    createUrl = vi.fn(() => 'blob:owned-clip'); revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revoke });
    report = vi.fn(); mouth = vi.fn(); speaking = vi.fn();
    player = new PetBrowserPlayer(report, mouth, speaking);
  });
  afterEach(() => { player.destroy(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  const ready = async () => { await flush(); audio.dispatchEvent(new Event('canplay')); };

  it('fetches and decodes once, samples both native curves and releases its media', async () => {
    const clip = speech();
    expect(player.prepare(clip)).toBe(true);
    expect(player.prepare(clip)).toBe(false);
    await ready();
    expect(fetchAudio).toHaveBeenCalledTimes(1); expect(decode).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('blob:owned-clip');
    expect(report).toHaveBeenCalledWith({ id: clip.id, state: 'ready', positionMs: 0 });
    await player.start(clip.id);
    expect(audio.play).toHaveBeenCalledTimes(1);
    audio.currentTime = .1; vi.advanceTimersByTime(100);
    const expected = sampleMouthCurves(computeMouthCurves([pcm], rate), 100);
    expect(mouth).toHaveBeenLastCalledWith(clip.id, 100, Math.round(expected.value * 10_000) / 10_000, Math.round(expected.smile * 10_000) / 10_000);
    audio.currentTime = 1.1; vi.advanceTimersByTime(100);
    expect(mouth).toHaveBeenLastCalledWith(clip.id, 1100, 0, .5);
    expect(decode).toHaveBeenCalledTimes(1);
    const signal = fetchAudio.mock.calls[0][1].signal as AbortSignal;
    player.reset();
    expect(signal.aborted).toBe(true); expect(revoke).toHaveBeenCalledWith('blob:owned-clip');
    const count = mouth.mock.calls.length; vi.advanceTimersByTime(1000); expect(mouth).toHaveBeenCalledTimes(count);
  });

  it('keeps optional decode failure neutral without rejecting playable audio', async () => {
    decode.mockRejectedValueOnce(new Error('optional_decoder_error'));
    player.prepare(speech()); await ready(); await player.start('speech-one');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'started' }));
    vi.advanceTimersByTime(100); expect(mouth).toHaveBeenLastCalledWith('speech-one', 0, 0, .5);
    expect(report.mock.calls.some(([event]) => event.state === 'error')).toBe(false);
  });

  it('does not attach stale decoded data after reset or overwrite replacement media', async () => {
    let resolve!: (value: unknown) => void;
    decode.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    player.prepare(speech()); await flush(); expect(decode).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('blob:owned-clip');
    audio.dispatchEvent(new Event('canplay')); await player.start('speech-one');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'started' }));
    player.reset(); player.prepare(speech({ id: 'speech-two', animateMouth: false, url: 'https://api.example.test/two' }));
    resolve({ duration: 1, numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm }); await flush();
    expect(audio.src).toBe('https://api.example.test/two'); expect(createUrl).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:owned-clip');
  });

  it('PNG playback performs no clip analysis and retains speaking/progress callbacks', async () => {
    player.prepare(speech({ animateMouth: false })); await ready(); await player.start('speech-one');
    expect(fetchAudio).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    expect(speaking).toHaveBeenCalledWith(true);
    audio.currentTime = .4; vi.advanceTimersByTime(100);
    expect(mouth).toHaveBeenCalledWith('speech-one', 400, 0, .5);
    audio.dispatchEvent(new Event('waiting')); expect(speaking).toHaveBeenLastCalledWith(false);
    audio.dispatchEvent(new Event('playing')); expect(speaking).toHaveBeenLastCalledWith(true);
    audio.dispatchEvent(new Event('ended')); expect(report).toHaveBeenCalledWith({ id: 'speech-one', state: 'ended', positionMs: 400 });
  });

  it.each(['header', 'stream'])('rejects oversized %s data before decoding or playback', async mode => {
    fetchAudio.mockResolvedValueOnce(mode === 'header' ? response([], 8_000_001) : response([new Uint8Array(8_000_001)], 0));
    player.prepare(speech()); await flush();
    expect(decode).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'error', error: 'media_error' }));
    expect((fetchAudio.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  });

  it('expires and cancels a pending decode without loading or starting it later', async () => {
    let resolve!: (value: unknown) => void;
    decode.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    player.prepare(speech({ startBefore: Date.now() + 500 })); await flush();
    vi.advanceTimersByTime(500);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'error', error: 'expired' }));
    resolve({ duration: 1, numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm }); await flush();
    expect(createUrl).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledWith('blob:owned-clip');
    expect(audio.src).toBe(''); expect(audio.play).not.toHaveBeenCalled();
  });
});
