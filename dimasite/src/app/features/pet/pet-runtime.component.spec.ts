import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { Injector, runInInjectionContext, type DestroyableInjector } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import type { BrowserPetPlaybackReport } from './pet-browser-player';
import { defaultPetMoods } from '../../models/pet-moods.model';
import { PetRuntimeComponent } from './pet-runtime.component';

const fake = vi.hoisted(() => {
  type Callback = (error: Error | null, ack?: unknown) => void;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const messages: { name: string; payload: Record<string, unknown>; callback: Callback }[] = [];
  const socket = {
    connected: true,
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => listeners.set(name, callback)),
    connect: vi.fn(), disconnect: vi.fn(), timeout: vi.fn(),
    emit: vi.fn((name: string, payload: Record<string, unknown>, callback: Callback) => messages.push({ name, payload, callback })),
    volatile: { emit: vi.fn() },
  };
  socket.timeout.mockReturnValue(socket);
  return { listeners, messages, socket, mouth: undefined as ((id: string, positionMs: number, value: number) => void) | undefined, report: undefined as ((report: BrowserPetPlaybackReport) => void) | undefined,
    prepare: vi.fn(() => true), start: vi.fn(), reset: vi.fn(), destroy: vi.fn(), unlock: vi.fn() };
});
vi.mock('socket.io-client', () => ({ io: () => fake.socket }));
vi.mock('./pet-browser-player', () => ({
  PetBrowserPlayer: class {
    prepare = fake.prepare; start = fake.start; reset = fake.reset; destroy = fake.destroy; unlock = fake.unlock;
    constructor(report: (report: BrowserPetPlaybackReport) => void, mouth: (id: string, positionMs: number, value: number) => void) { fake.report = report; fake.mouth = mouth; }
  },
}));

const serverTime = 1_000_000;
const snapshot = (overrides = {}) => ({ v: 1, generation: 1, settingsRevision: 1, peerId: 'browser-one', serverTime,
  appearance: { kind: 'vts' }, playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null },
  assets: { idleUrl: null, talkingUrl: null }, active: null, lease: null, ...overrides });
const lease = (overrides = {}) => ({ ok: true, data: { leaseId: 'lease-one', generation: 1,
  serverTime: serverTime + performance.now(), expiresAt: serverTime + performance.now() + 15_000, ttlMs: 15_000, ...overrides } });
const deliver = (name: string, value: unknown) => fake.listeners.get(name)?.(value);
const take = (name: string, action?: string) => {
  const index = fake.messages.findIndex(m => m.name === name && (!action || m.payload['action'] === action));
  expect(index, `${name} ${action ?? ''} emitted`).toBeGreaterThanOrEqual(0);
  return fake.messages.splice(index, 1)[0];
};
function prepareSpeech() {
  deliver('pet:play', { v: 1, generation: 1, requestId: 'speech-one', leaseId: 'lease-one', startBefore: serverTime + performance.now() + 12_000,
    audio: { url: 'https://api.example.test/pets/playback/speech-one/audio?ticket=fixture', mimeType: 'audio/wav', durationMs: 12_000 } });
  expect(fake.prepare).toHaveBeenCalledTimes(1);
}

describe('browser pet lease recovery', () => {
  let injector: DestroyableInjector;
  let component: PetRuntimeComponent;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fake.listeners.clear(); fake.messages.length = 0; vi.clearAllMocks();
    fake.socket.connected = true; fake.prepare.mockReturnValue(true); fake.socket.timeout.mockReturnValue(fake.socket);
    injector = Injector.create({ providers: [
      { provide: DOCUMENT, useValue: document },
      { provide: LanguageService, useValue: { translate: (key: string) => key } },
      { provide: LinksService, useValue: { getApiUrl: () => 'https://api.example.test' } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'a'.repeat(43) } } } },
    ] });
    component = runInInjectionContext(injector, () => new PetRuntimeComponent());
    deliver('connect', undefined); deliver('pet:snapshot', snapshot());
    take('pet:ready').callback(null, { ok: true, data: {} });
  });
  afterEach(() => { injector.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['transport close', 'io server disconnect'])('automatically reconnects after %s and reestablishes readiness', reason => {
    fake.socket.connected = false;
    deliver('disconnect', reason);
    const calls = fake.socket.connect.mock.calls.length;
    vi.advanceTimersByTime(999); expect(fake.socket.connect).toHaveBeenCalledTimes(calls);
    vi.advanceTimersByTime(1); expect(fake.socket.connect).toHaveBeenCalledTimes(calls + 1);
    fake.socket.connected = true; deliver('connect', undefined); deliver('pet:snapshot', snapshot({ peerId: 'browser-two' }));
    take('pet:ready').callback(null, { ok: true, data: {} });
    expect(component.status()).toBe('rendererReady');
    vi.advanceTimersByTime(30_000); expect(fake.socket.connect).toHaveBeenCalledTimes(calls + 1);
  });

  it('keeps retrying rejected handshakes with capped backoff and stops on destroy', () => {
    fake.socket.connected = false;
    const calls = fake.socket.connect.mock.calls.length;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]) {
      deliver('connect_error', new Error('unauthorized'));
      vi.advanceTimersByTime(delay - 1);
      const before = fake.socket.connect.mock.calls.length;
      vi.advanceTimersByTime(1); expect(fake.socket.connect).toHaveBeenCalledTimes(before + 1);
    }
    expect(fake.socket.connect).toHaveBeenCalledTimes(calls + 10);
    deliver('connect_error', new Error('unauthorized'));
    injector.destroy(); injector = Injector.create({ providers: [] }); vi.advanceTimersByTime(60_000);
    expect(fake.socket.connect).toHaveBeenCalledTimes(calls + 10);
  });

  it('retries an unconfirmed acquire without loading or replaying speech', () => {
    take('pet:lease', 'acquire').callback(new Error('ACK lost'));
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'acquire').callback(null, lease());
    prepareSpeech();
    expect(fake.prepare).toHaveBeenCalledTimes(1);
  });

  it('retries a temporarily unavailable acquisition without treating it as a new speech request', () => {
    take('pet:lease', 'acquire').callback(null, { ok: false, error: { code: 'temporarily_unavailable' } });
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'acquire').callback(null, lease());
    prepareSpeech();
  });

  it('retains a valid lease after temporary backend unavailability during renewal', () => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech(); const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'renew').callback(null, { ok: false, error: { code: 'temporarily_unavailable' } });
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    vi.advanceTimersByTime(1000);
    take('pet:lease', 'renew').callback(null, lease());
    expect(fake.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(['loading', 'playing'])('retains %s audio and the original deadline after a transient renewal timeout', phase => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    if (phase === 'playing') { fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 }); take('pet:playback').callback(null, { ok: true, data: {} }); }
    const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'renew').callback(new Error('ACK lost'));
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    vi.advanceTimersByTime(1000);
    take('pet:lease', 'renew').callback(null, lease());
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    expect(fake.prepare).toHaveBeenCalledTimes(1);
  });

  it('stops at the original deadline despite renewal timeouts, then safely reacquires', () => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    const pending = take('pet:lease', 'renew');
    vi.advanceTimersByTime(9499);
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    vi.advanceTimersByTime(1);
    expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
    vi.advanceTimersByTime(1000);
    take('pet:lease', 'acquire').callback(null, lease({ leaseId: 'lease-two' }));
    pending.callback(null, lease()); // Old callback cannot replace lease-two or replay speech.
    deliver('pet:play', { v: 1, generation: 1, requestId: 'speech-two', leaseId: 'lease-two', startBefore: serverTime + 30_000,
      audio: { url: 'https://api.example.test/pets/playback/speech-two/audio?ticket=fixture', mimeType: 'audio/wav', durationMs: 1000 } });
    expect(fake.prepare).toHaveBeenCalledTimes(2);
  });

  it('honors rate limiting without extending the lease and stops immediately on a definitive rejection', () => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech(); const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'renew').callback(null, { ok: false, error: { code: 'rate_limited', retryAfterMs: 2000 } });
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    vi.advanceTimersByTime(1999); expect(fake.messages.some(m => m.payload['action'] === 'renew')).toBe(false);
    vi.advanceTimersByTime(1);
    take('pet:lease', 'renew').callback(null, { ok: false, error: { code: 'stale_lease' } });
    expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
  });

  it('keeps a bounded rate-limit delay across local expiry before reacquisition', () => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech(); const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'renew').callback(null, { ok: false, error: { code: 'rate_limited', retryAfterMs: 20_000 } });
    vi.advanceTimersByTime(9500);
    expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
    vi.advanceTimersByTime(10_499); expect(fake.messages.some(m => m.payload['action'] === 'acquire')).toBe(false);
    vi.advanceTimersByTime(1); take('pet:lease', 'acquire');
  });

  it('refuses oversized finite acquire retry delays instead of overflowing the timer', () => {
    take('pet:lease', 'acquire').callback(null, { ok: false, error: { code: 'rate_limited', retryAfterMs: 1e100 } });
    vi.advanceTimersByTime(60_000); deliver('pet:snapshot', snapshot({ serverTime: serverTime + 60_000 }));
    expect(fake.messages.some(m => m.payload['action'] === 'acquire')).toBe(false);
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('still stops at expiry when an oversized renewal retry delay disables automatic retry', () => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech(); const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'renew').callback(null, { ok: false, error: { code: 'rate_limited', retryAfterMs: 1e100 } });
    vi.advanceTimersByTime(9500); expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
    vi.advanceTimersByTime(60_000); deliver('pet:snapshot', snapshot({ serverTime: serverTime + 74_500 }));
    expect(fake.messages.some(m => m.payload['action'] === 'acquire')).toBe(false);
  });

  it('honors an advertised acquisition retry delay before another same-peer attempt', () => {
    take('pet:lease', 'acquire').callback(null, { ok: false, error: { code: 'lease_unavailable', retryAfterMs: 12_000 } });
    vi.advanceTimersByTime(11_999); deliver('pet:snapshot', snapshot({ serverTime: serverTime + 11_999 }));
    expect(fake.messages.some(m => m.payload['action'] === 'acquire')).toBe(false);
    vi.advanceTimersByTime(1); take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
  });

  it.each(['disconnect', 'owner-switch'])('stops immediately on %s and ignores old renewal acknowledgements', change => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech(); const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000); const pending = take('pet:lease', 'renew');
    if (change === 'disconnect') { fake.socket.connected = false; deliver('disconnect', 'transport close'); }
    else deliver('pet:snapshot', snapshot({ playback: { target: 'desktop' } }));
    expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
    pending.callback(null, lease()); vi.advanceTimersByTime(30_000);
    expect(fake.prepare).toHaveBeenCalledTimes(1);
    expect(fake.messages.some(m => m.payload['action'] === 'acquire')).toBe(false);
  });

  it.each(['timeout', 'rate_limited', 'temporarily_unavailable'])('keeps playing after transient %s in progress telemetry', failure => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    take('pet:playback').callback(null, { ok: true, data: {} });
    vi.advanceTimersByTime(1000); fake.mouth?.('speech-one', 1000, 0.5);
    const progress = take('pet:playback'); expect(progress.payload['phase']).toBe('progress');
    const resets = fake.reset.mock.calls.length;
    if (failure === 'timeout') progress.callback(new Error('ACK lost'));
    else progress.callback(null, { ok: false, error: { code: failure } });
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    vi.advanceTimersByTime(1000); fake.mouth?.('speech-one', 2000, 0.5);
    expect(take('pet:playback').payload['phase']).toBe('progress');
    expect(fake.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(['renew', 'progress'])('stops safely on a malformed object error code in %s ACK', phase => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    if (phase === 'progress') {
      fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
      take('pet:playback').callback(null, { ok: true, data: {} });
      vi.advanceTimersByTime(1000); fake.mouth?.('speech-one', 1000, 0.5);
    } else vi.advanceTimersByTime(5000);
    const message = take(phase === 'renew' ? 'pet:lease' : 'pet:playback');
    const resets = fake.reset.mock.calls.length;
    expect(() => message.callback(null, { ok: false, error: { code: { toString: null } } })).not.toThrow();
    expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
  });

  it('rejects a renewal that changes the lease identity', () => {
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech(); const resets = fake.reset.mock.calls.length;
    vi.advanceTimersByTime(5000);
    take('pet:lease', 'renew').callback(null, lease({ leaseId: 'different-owner' }));
    expect(fake.reset).toHaveBeenCalledTimes(resets + 1);
  });

  const image = (name: string) => `https://api.example.test/pets/public/${'a'.repeat(43)}/assets/${name}`;
  function moodsSnapshot(active: Record<string, unknown> | null = null) {
    deliver('pet:snapshot', snapshot({ moods: { available: true, enabled: true, holdMs: 2000, emotions: defaultPetMoods().emotions },
      assets: { idleUrl: image('normal-idle'), talkingUrl: image('normal-talking'), moods: {
        happy: { idleUrl: image('happy-idle'), talkingUrl: null }, sad: { idleUrl: null, talkingUrl: image('sad-talking') }
      } }, active }));
  }
  const request = (id: string, status: string, version: number, mood: unknown = 'happy') =>
    deliver('pet:request', { v: 1, generation: 1, request: { requestId: id, operation: 'talk', status, version, mood } });

  it.each(['completed', 'cancelled', 'failed', 'expired'])('applies a request mood only on actual playback, with per-state fallbacks and a %s hold', terminal => {
    moodsSnapshot({ requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'happy' });
    expect(component.mood()).toBe('neutral'); expect(component.idleUrl()).toBe(image('normal-idle'));
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    expect(component.mood()).toBe('neutral');
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    take('pet:playback').callback(null, { ok: true, data: {} });
    expect(component.mood()).toBe('happy'); expect(component.idleUrl()).toBe(image('normal-idle'));
    component.moodImageLoaded(image('happy-idle'), component.moodAttempt());
    expect(component.idleUrl()).toBe(image('happy-idle'));
    expect(component.talkingUrl()).toBe(image('normal-talking'));
    request('speech-one', terminal, 2);
    vi.advanceTimersByTime(1999); expect(component.mood()).toBe('happy');
    vi.advanceTimersByTime(1); expect(component.mood()).toBe('neutral');
    expect(component.idleUrl()).toBe(image('normal-idle'));
  });

  it('switches immediately when a new playback starts during the previous hold', () => {
    moodsSnapshot({ requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'happy' });
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    take('pet:playback').callback(null, { ok: true, data: {} });
    fake.report?.({ id: 'speech-one', state: 'ended', positionMs: 100 });
    request('speech-one', 'completed', 2); vi.advanceTimersByTime(1000);
    request('speech-two', 'ready', 1, 'sad');
    deliver('pet:play', { v: 1, generation: 1, requestId: 'speech-two', leaseId: 'lease-one', startBefore: serverTime + performance.now() + 10_000,
      audio: { url: 'https://api.example.test/pets/playback/speech-two/audio?ticket=fixture', mimeType: 'audio/wav', durationMs: 1000 } });
    fake.report?.({ id: 'speech-two', state: 'started', positionMs: 0 });
    expect(component.mood()).toBe('sad'); expect(component.idleUrl()).toBe(image('normal-idle'));
    expect(component.talkingUrl()).toBe(image('normal-talking'));
    component.moodImageLoaded(image('sad-talking'), component.moodAttempt());
    expect(component.talkingUrl()).toBe(image('sad-talking'));
    vi.advanceTimersByTime(1000); expect(component.mood()).toBe('sad');
  });

  it('keeps the terminal hold when cancellation advances the runtime generation', () => {
    moodsSnapshot({ requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'happy' });
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    take('pet:playback').callback(null, { ok: true, data: {} });
    request('speech-one', 'cancelled', 2);
    deliver('pet:snapshot', { ...component.state()!, generation: 2, serverTime: serverTime + 1, active: null, lease: null });
    vi.advanceTimersByTime(1999); expect(component.mood()).toBe('happy');
    vi.advanceTimersByTime(1); expect(component.mood()).toBe('neutral');
  });

  it('treats unknown request moods as neutral and ignores disabled mood assets', () => {
    moodsSnapshot({ requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'future-custom' });
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    expect(component.mood()).toBe('neutral'); expect(component.idleUrl()).toBe(image('normal-idle'));
  });

  it('uses overlay-follow moods without restarting them on progress, then holds after follow-end', () => {
    moodsSnapshot();
    const png = snapshot({ appearance: { kind: 'png' }, moods: { available: true, enabled: true, holdMs: 2000, emotions: defaultPetMoods().emotions },
      assets: { idleUrl: image('normal-idle'), talkingUrl: image('normal-talking'), moods: { happy: { idleUrl: image('happy-idle'), talkingUrl: null } } } });
    deliver('pet:snapshot', png);
    const follow = { v: 1, followId: 'overlay-one', generation: 1, mood: 'happy', positionMs: 0, serverTime,
      envelope: { stepMs: 40, values: Array(100).fill(1) } };
    deliver('pet:follow', follow); expect(component.mood()).toBe('happy');
    deliver('pet:follow', { ...follow, positionMs: 40, serverTime: serverTime + 40, mood: 'sad', envelope: undefined });
    expect(component.mood()).toBe('happy');
    deliver('pet:follow-end', { v: 1, followId: 'overlay-one', generation: 1 });
    vi.advanceTimersByTime(1999); expect(component.mood()).toBe('happy');
    vi.advanceTimersByTime(1); expect(component.mood()).toBe('neutral');
  });


  it.each([{ available: false, enabled: false }, { available: true, enabled: false, holdMs: 2000, emotions: defaultPetMoods().emotions }])('ignores mood data when config is unavailable or disabled: %o', moods => {
    deliver('pet:snapshot', snapshot({ moods,
      active: { requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'happy' },
      assets: { idleUrl: image('normal-idle'), talkingUrl: image('normal-talking'), moods: { happy: { idleUrl: image('happy-idle'), talkingUrl: null } } }
    }));
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    expect(component.mood()).toBe('neutral'); expect(component.idleUrl()).toBe(image('normal-idle'));
  });


  it('keeps PNG readiness and its lease while optional mood images load one at a time', () => {
    take('pet:lease', 'acquire').callback(null, lease());
    const png = snapshot({ appearance: { kind: 'png' },
      moods: { available: true, enabled: true, holdMs: 2000, emotions: defaultPetMoods().emotions },
      assets: { idleUrl: image('normal-idle'), talkingUrl: image('normal-talking'),
        moods: { happy: { idleUrl: image('happy-idle'), talkingUrl: image('happy-talking') } } },
      active: { requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'happy' },
      lease: { leaseId: 'lease-one', holderPeerId: 'browser-one', expiresAt: serverTime + 15_000 }
    });
    deliver('pet:snapshot', png);
    const notLoaded = take('pet:ready'); expect(notLoaded.payload['renderReady']).toBe(false);
    notLoaded.callback(null, { ok: true, data: {} });
    component.imageLoaded('idle', image('normal-idle'));
    component.imageLoaded('talking', image('normal-talking'));
    const baseline = take('pet:ready'); expect(baseline.payload['renderReady']).toBe(true);
    baseline.callback(null, { ok: true, data: {} });
    prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    take('pet:playback').callback(null, { ok: true, data: {} });
    const resets = fake.reset.mock.calls.length;
    expect(component.idleUrl()).toBe(image('normal-idle'));
    expect(component.talkingUrl()).toBe(image('normal-talking'));
    component.moodImageLoaded(image('happy-idle'), component.moodAttempt());
    component.imageLoaded('idle', image('happy-idle'));
    expect(fake.messages.filter(message => message.name === 'pet:ready' && message.payload['renderReady'] === false)).toEqual([]);
    deliver('pet:snapshot', { ...png, serverTime: serverTime + 1, active: { requestId: 'speech-one', operation: 'talk', status: 'playing', version: 2, mood: 'happy' } });
    expect(fake.messages.filter(message => message.name === 'pet:ready' && message.payload['renderReady'] === false)).toEqual([]);
    component.moodImageLoaded(image('happy-talking'), component.moodAttempt());
    component.imageLoaded('talking', image('happy-talking'));
    component.imageFailed('idle', image('happy-idle'));
    expect(component.idleUrl()).toBe(image('normal-idle'));
    expect(component.talkingUrl()).toBe(image('happy-talking'));
    expect(component.status()).toBe('rendererReady');
    component.imageFailed('talking', image('happy-talking'));
    expect(component.talkingUrl()).toBe(image('normal-talking'));
    expect(component.status()).toBe('rendererReady');
    expect(fake.messages.filter(message => message.name === 'pet:ready' && message.payload['renderReady'] === false)).toEqual([]);
    expect(fake.reset).toHaveBeenCalledTimes(resets);
    vi.advanceTimersByTime(100); fake.mouth?.('speech-one', 1000, .5);
    expect(fake.socket.volatile.emit).toHaveBeenCalledWith('pet:mouth', expect.objectContaining({ requestId: 'speech-one', leaseId: 'lease-one' }));
    component.imageFailed('idle', image('normal-idle'));
    expect(take('pet:ready').payload['renderReady']).toBe(false);
  });


  it('retries a failed optional image only when a later actual request starts', () => {
    moodsSnapshot({ requestId: 'speech-one', operation: 'talk', status: 'ready', version: 1, mood: 'happy' });
    take('pet:lease', 'acquire').callback(null, lease()); prepareSpeech();
    fake.report?.({ id: 'speech-one', state: 'started', positionMs: 0 });
    take('pet:playback').callback(null, { ok: true, data: {} });
    const oldAttempt = component.moodAttempt();
    expect(component.idleUrl()).toBe(image('normal-idle'));
    component.moodImageFailed(image('happy-idle'), oldAttempt);
    expect(component.idleUrl()).toBe(image('normal-idle'));
    expect(component.moodPreloadIdleUrl()).toBe('');
    request('speech-one', 'playing', 2, 'happy');
    expect(component.moodAttempt()).toBe(oldAttempt);
    fake.report?.({ id: 'speech-one', state: 'ended', positionMs: 100 });
    request('speech-one', 'completed', 3, 'happy');
    request('speech-two', 'ready', 1, 'happy');
    deliver('pet:play', { v: 1, generation: 1, requestId: 'speech-two', leaseId: 'lease-one', startBefore: serverTime + 10_000,
      audio: { url: 'https://api.example.test/pets/playback/speech-two/audio?ticket=fixture', mimeType: 'audio/wav', durationMs: 1000 } });
    fake.report?.({ id: 'speech-two', state: 'started', positionMs: 0 });
    expect(component.moodAttempt()).toBe(oldAttempt + 1);
    expect(component.moodPreloadIdleUrl()).toBe(image('happy-idle'));
    expect(component.idleUrl()).toBe(image('normal-idle'));
    component.moodImageLoaded(image('happy-idle'), oldAttempt); // Stale callbacks cannot replace this attempt.
    expect(component.idleUrl()).toBe(image('normal-idle'));
    component.moodImageLoaded(image('happy-idle'), component.moodAttempt());
    expect(component.idleUrl()).toBe(image('happy-idle'));
  });

  it.each([null, false, [], 'bad', { available: true, enabled: true, holdMs: 'bad', emotions: {} }])('ignores malformed optional wire configuration without throwing: %o', moods => {
    expect(() => deliver('pet:snapshot', snapshot({ moods, assets: { idleUrl: null, talkingUrl: null, moods: 'bad' } }))).not.toThrow();
    expect(component.mood()).toBe('neutral');
    expect(component.state()?.moods).toEqual({ available: false, enabled: false });
  });

  it('isolates throwing optional metadata and request mood accessors', () => {
    const throwing = snapshot();
    Object.defineProperty(throwing, 'moods', { get: () => { throw new Error('legacy mood'); } });
    expect(() => deliver('pet:snapshot', throwing)).not.toThrow();
    const entry = { requestId: 'getter-request', operation: 'talk', status: 'ready', version: 1 };
    Object.defineProperty(entry, 'mood', { get: () => { throw new Error('bad request mood'); } });
    expect(() => deliver('pet:request', { v: 1, generation: 1, request: entry })).not.toThrow();
    expect(component.state()?.active?.mood).toBe('neutral');
  });

});
