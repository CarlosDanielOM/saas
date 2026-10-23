import { describe, expect, it } from 'vitest';
import { PetFollowClock } from './pet-follow-clock';
const packet = (extra = {}) => ({ v: 1, followId: 'speech-one', generation: 1, positionMs: 0, serverTime: 100,
  envelope: { stepMs: 40, values: Array.from({ length: 100 }, (_, i) => i % 2) }, ...extra });
describe('PNG follow clock', () => {
  it('samples locally, stalls without advancing reports, then resumes the same live identity', () => {
    let now = 0; const clock = new PetFollowClock(() => now);
    expect(clock.accept(packet(), 1)).toBe(true);
    expect(clock.sample().talking).toBe(false);
    now = 40; expect(clock.sample().talking).toBe(true);
    now = 500; expect(clock.accept(packet({ serverTime: 200 }), 1)).toBe(false);
    now = 1001; expect(clock.sample()).toEqual({ talking: false, ticking: false });
    expect(clock.live).toBe(true);
    expect(clock.accept(packet({ envelope: undefined, serverTime: 300, positionMs: 120 }), 1)).toBe(true);
    expect(clock.sample().talking).toBe(true);
    expect(clock.accept(packet({ envelope: undefined, serverTime: 400, positionMs: 80 }), 1)).toBe(false);
    expect(clock.accept(packet({ envelope: undefined, serverTime: 300, positionMs: 160 }), 1)).toBe(true);
    expect(clock.accept(packet({ envelope: undefined, serverTime: 500, positionMs: 160 }), 1)).toBe(false);
    expect(clock.accept(packet({ envelope: undefined, serverTime: 499, positionMs: 200 }), 1)).toBe(false);
  });
  it('requires a bounded initial envelope and rejects malformed packets', () => {
    for (const extra of [{ envelope: undefined }, { generation: 0 }, { positionMs: Infinity }, { serverTime: NaN },
      { envelope: { stepMs: 20.5, values: [1] } }, { envelope: { stepMs: 19, values: [1] } },
      { envelope: { stepMs: 101, values: [1] } }, { envelope: { stepMs: 40, values: [] } },
      { envelope: { stepMs: 40, values: Array(1501).fill(1) } }, { envelope: { stepMs: 100, values: Array(601).fill(1) } },
      ...[NaN, Infinity, -1, 1.01, '1'].map(n => ({ envelope: { stepMs: 40, values: [n] } }))]) {
      expect(new PetFollowClock().accept(packet(extra), 1)).toBe(false);
    }
  });
  it('requires generation on end and fences retired identities, generations and old reports', () => {
    const clock = new PetFollowClock(() => 0);
    expect(clock.accept(packet(), 1)).toBe(true);
    expect(clock.end({ v: 1, followId: 'speech-one' })).toBe(false);
    expect(clock.end({ v: 1, followId: 'speech-one', generation: 0 })).toBe(false);
    expect(clock.end({ v: 1, followId: 'speech-one', generation: 1 })).toBe(true);
    expect(clock.accept(packet({ serverTime: 101 }), 1)).toBe(false);
    expect(clock.accept(packet({ followId: 'two', serverTime: 99 }), 1)).toBe(false);
    expect(clock.accept(packet({ followId: 'two', serverTime: 101 }), 1)).toBe(true);
    expect(clock.end({ v: 1, followId: 'ended-before-follow', generation: 1 })).toBe(false);
    expect(clock.accept(packet({ followId: 'ended-before-follow', serverTime: 102 }), 1)).toBe(false);
    clock.reset(2);
    expect(clock.accept(packet({ positionMs: 40, serverTime: 102 }), 1)).toBe(false);
    expect(clock.sample()).toEqual({ talking: false, ticking: false });
  });
  it('retires on local cancellation and closes at the bounded duration with no ticking', () => {
    let now = 0; const clock = new PetFollowClock(() => now);
    clock.accept(packet(), 1); clock.retire();
    expect(clock.accept(packet({ serverTime: 101 }), 1)).toBe(false);
    clock.accept(packet({ followId: 'two', serverTime: 102, positionMs: 3980 }), 1);
    now = 30; expect(clock.sample()).toEqual({ talking: false, ticking: false });
    expect(clock.live).toBe(true);
    expect(clock.accept(packet({ followId: 'two', serverTime: 103, positionMs: 3990 }), 1)).toBe(true);
    clock.end({ v: 1, followId: 'two', generation: 1 });
    expect(clock.accept(packet({ followId: 'two', serverTime: 104, positionMs: 3995 }), 1)).toBe(false);
  });
});
