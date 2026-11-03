import { afterEach, describe, expect, it, vi } from 'vitest';
import { PetMoodDisplay } from './pet-mood-display';

describe('pet mood playback and hold', () => {
  afterEach(() => vi.useRealTimers());
  it('shows during playback, holds after end, then returns to normal', () => {
    vi.useFakeTimers(); const changed = vi.fn(), display = new PetMoodDisplay(changed);
    display.start('one', 'happy', 2000); expect(changed).toHaveBeenLastCalledWith('happy');
    vi.advanceTimersByTime(20_000); expect(changed).toHaveBeenCalledTimes(1);
    display.end('one'); vi.advanceTimersByTime(1999); expect(changed).toHaveBeenLastCalledWith('happy');
    vi.advanceTimersByTime(1); expect(changed).toHaveBeenLastCalledWith('neutral');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a new request replaces a held mood and cancels the old reset', () => {
    vi.useFakeTimers(); const changed = vi.fn(), display = new PetMoodDisplay(changed);
    display.start('one', 'happy', 2000); display.end('one'); vi.advanceTimersByTime(1000);
    display.start('two', 'sad', 3000); display.end('one'); vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenLastCalledWith('sad'); display.end('two'); vi.advanceTimersByTime(3000);
    expect(changed).toHaveBeenLastCalledWith('neutral');
  });
  it('handles neutral/unknown, zero hold, duplicate end and reset without idle timers', () => {
    vi.useFakeTimers(); const changed = vi.fn(), display = new PetMoodDisplay(changed);
    display.end('missing'); expect(vi.getTimerCount()).toBe(0);
    display.start('one', 'future-custom-mood', 0); expect(changed).toHaveBeenLastCalledWith('neutral');
    display.end('one'); display.end('one'); expect(vi.getTimerCount()).toBe(0);
    display.start('two', 'angry', 10000); display.end('two'); display.reset();
    expect(changed).toHaveBeenLastCalledWith('neutral'); expect(vi.getTimerCount()).toBe(0);
  });
});
