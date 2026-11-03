import { afterEach, expect, it, vi } from 'vitest';
import { warnPetMood } from './pet-mood-warning';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('bounds diagnostics with fixed keys and no timers', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let index = 0; index < 100; index++) { warnPetMood('asset'); warnPetMood('metadata'); warnPetMood('settings'); }
  expect(warn).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(61_000); warnPetMood('asset'); expect(warn).toHaveBeenCalledTimes(4);
});
it('cannot turn a warning failure into a pet failure', () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console unavailable'); });
  expect(() => warnPetMood('asset')).not.toThrow();
});
