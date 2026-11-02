import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { Injector, runInInjectionContext, type DestroyableInjector } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import type { BrowserPetPlaybackReport } from './pet-browser-player';
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
});
