import type { AlertMotion } from './overlay-model.generated';
import type { AlertKeyframes } from './overlay-keyframes.generated';
export interface MotionWindow { start: number; duration: number; span: number; iterations: number }
/**
 * When the object is gone, in seconds from the alert's start: `motion.end` clamped between just after its start
 * and the alert's end. Omitted (or not a number) = the alert's end, exactly as before `end` existed.
 */
export function motionStop(motion: AlertMotion, seconds: number): number {
  const total = Math.max(.001, seconds), delay = Math.min(motion.delay, Math.max(0, total - .001)), end = motion.end;
  return typeof end === 'number' && Number.isFinite(end) ? Math.min(total, Math.max(delay + .001, end)) : total;
}
/** One clock for the renderer, overview timeline and detailed keyframe editor. All units are seconds. */
export function motionWindows(motion: AlertMotion, seconds: number, keyframes?: AlertKeyframes): Record<'enter' | 'loop' | 'exit', MotionWindow> {
  const total = Math.max(.001, seconds), delay = Math.min(motion.delay, Math.max(0, total - .001));
  // The object's own window is [delay, stop]; without `end`, stop is the alert's end, so nothing changes.
  const stop = motionStop(motion, total);
  const available = stop - delay;
  const wantedIn = motion.enter === 'none' && !keyframes?.enter ? .001 : motion.enterDuration;
  const wantedOut = motion.exit === 'none' && !keyframes?.exit ? 0 : motion.exitDuration;
  const fit = Math.min(1, available / (wantedIn + wantedOut));
  const entrance = wantedIn * fit, exit = wantedOut * fit, idle = Math.max(0, available - entrance - exit);
  // Complete whole cycles so a float/breathe never snaps back midway through a cycle.
  const cycles = keyframes?.loop && idle > 0 ? Math.max(1, Math.round(idle / motion.loopDuration)) : idle / motion.loopDuration;
  return {
    enter: {start: delay, duration: entrance, span: entrance, iterations: 1},
    loop: {start: delay + entrance, duration: cycles > 0 ? idle / cycles : 0, span: idle, iterations: cycles},
    exit: {start: stop - exit, duration: exit, span: exit, iterations: 1}
  };
}
