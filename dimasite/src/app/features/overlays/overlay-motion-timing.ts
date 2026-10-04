import type { AlertMotion } from './overlay.model';
import type { AlertKeyframes } from './overlay-keyframes.model';
export interface MotionWindow { start: number; duration: number; span: number; iterations: number }
/** One clock for the renderer, overview timeline and detailed keyframe editor. All units are seconds. */
export function motionWindows(motion: AlertMotion, seconds: number, keyframes?: AlertKeyframes): Record<'enter' | 'loop' | 'exit', MotionWindow> {
  const total = Math.max(.001, seconds), delay = Math.min(motion.delay, Math.max(0, total - .001));
  const available = total - delay;
  const wantedIn = motion.enter === 'none' && !keyframes?.enter ? .001 : motion.enterDuration;
  const wantedOut = motion.exit === 'none' && !keyframes?.exit ? 0 : motion.exitDuration;
  const fit = Math.min(1, available / (wantedIn + wantedOut));
  const entrance = wantedIn * fit, exit = wantedOut * fit, idle = Math.max(0, available - entrance - exit);
  // Complete whole cycles so a float/breathe never snaps back midway through a cycle.
  const cycles = keyframes?.loop && idle > 0 ? Math.max(1, Math.round(idle / motion.loopDuration)) : idle / motion.loopDuration;
  return {
    enter: {start: delay, duration: entrance, span: entrance, iterations: 1},
    loop: {start: delay + entrance, duration: cycles > 0 ? idle / cycles : 0, span: idle, iterations: cycles},
    exit: {start: total - exit, duration: exit, span: exit, iterations: 1}
  };
}
