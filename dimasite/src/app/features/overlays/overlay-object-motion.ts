import type { AlertMotion, WidgetKind } from './overlay.model';

export const defaultMotion = (kind?: WidgetKind): AlertMotion => ({ enter: 'none', exit: 'none', loop: kind === 'animation' ? 'pulse' : 'none', delay: 0, enterDuration: .5, exitDuration: .5, loopDuration: 2 });

function transition(name: AlertMotion['enter']): Keyframe[] {
  const end: Keyframe = { opacity: 1, transform: 'none' };
  const starts: Record<string, string> = {
    'slide-left': 'translateX(-100%)', 'slide-right': 'translateX(100%)',
    'slide-up': 'translateY(-100%)', 'slide-down': 'translateY(100%)',
    zoom: 'scale(.25)', flip: 'perspective(600px) rotateY(90deg)', spin: 'rotate(-180deg) scale(.25)'
  };
  if (name === 'bounce') return [{ opacity: 0, transform: 'scale(.25)' }, { opacity: 1, transform: 'scale(1.12)', offset: .65 }, { opacity: 1, transform: 'scale(.95)', offset: .85 }, end];
  return [{ opacity: 0, transform: starts[name] ?? 'none' }, end];
}
function loopFrames(name: AlertMotion['loop']): Keyframe[] {
  if (name === 'spin') return [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }];
  const middle = name === 'pulse' ? 'scale(.85)' : name === 'float' ? 'translateY(-8%)' : 'rotate(8deg)';
  return [{ transform: 'none' }, { transform: middle }, { transform: 'none' }];
}
/** Separate wrappers keep entrance, idle and exit transforms independent of layout scaling. */
export function playObjectMotion(elements: { entrance: HTMLElement; exit: HTMLElement; loop: HTMLElement }, motion: AlertMotion, seconds: number, reduced: boolean): () => void {
  const total = Math.max(1, seconds * 1000);
  const delay = Math.min(motion.delay * 1000, total - 1);
  const available = total - delay;
  const wantedIn = motion.enter === 'none' ? 1 : motion.enterDuration * 1000;
  const wantedOut = motion.exit === 'none' ? 0 : motion.exitDuration * 1000;
  // The alert's overall duration owns its queue slot. Short layouts proportionally
  // shorten transitions rather than leaving motion running after playback ends.
  const fit = Math.min(1, available / (wantedIn + wantedOut));
  const enterTime = wantedIn * fit, exitTime = wantedOut * fit;
  const idleTime = Math.max(0, available - enterTime - exitTime);
  const animations: Animation[] = [];
  const animate = (node: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions, phase: string) => {
    const animation = node.animate(frames, options); animation.id = 'alert-object-' + phase; animations.push(animation);
  };
  const enter = motion.enter === 'none' || reduced ? [{ opacity: 0 }, { opacity: 1 }] : transition(motion.enter);
  animate(elements.entrance, enter, { duration: reduced ? 1 : enterTime, delay, fill: 'both', easing: motion.enter === 'none' || reduced ? 'steps(1, end)' : 'ease-out' }, 'enter');
  if (motion.exit !== 'none') animate(elements.exit, reduced ? [{ opacity: 1 }, { opacity: 0 }] : transition(motion.exit).reverse().map(frame => ({ ...frame, ...(frame.offset == null ? {} : { offset: 1 - frame.offset }) })), { duration: reduced ? 1 : exitTime, delay: total - (reduced ? 1 : exitTime), fill: 'both', easing: reduced ? 'steps(1, end)' : 'ease-in' }, 'exit');
  if (!reduced && motion.loop !== 'none' && idleTime > 0) animate(elements.loop, loopFrames(motion.loop), { duration: motion.loopDuration * 1000, delay: delay + enterTime, iterations: idleTime / (motion.loopDuration * 1000), fill: 'none', easing: motion.loop === 'spin' ? 'linear' : 'ease-in-out' }, 'loop');
  return () => animations.forEach(animation => animation.cancel());
}
