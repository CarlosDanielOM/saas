import type { MotionPhase, MotionProperty, MotionSequence, MotionEasing } from './overlay-keyframes.model';
import type { MotionWindow } from './overlay-motion-timing';
export const MOTION_CURVES: Record<MotionEasing, string> = {
  linear: 'linear', smooth: 'cubic-bezier(.45,0,.55,1)', 'ease-in': 'cubic-bezier(.64,0,.78,0)',
  'ease-out': 'cubic-bezier(.22,1,.36,1)', soft: 'cubic-bezier(.25,.1,.25,1)',
  snappy: 'cubic-bezier(.16,1,.3,1)', 'sine-in': 'cubic-bezier(.36,0,.66,.4)', 'sine-out': 'cubic-bezier(.34,.6,.64,1)', hold: 'steps(1,end)'
};
function frame(property: MotionProperty, value: number): Keyframe {
  switch (property) {
    case 'x': return {transform: `translateX(${value}%)`};
    case 'y': return {transform: `translateY(${value}%)`};
    case 'scale': return {transform: `scale(${value})`};
    case 'rotation': return {transform: `rotate(${value}deg)`};
    case 'opacity': return {opacity: value};
  }
}
/** Independent property wrappers compose transforms without WAAPI additive-composition differences. */
export function playKeyframeSequence(elements: Record<MotionProperty, HTMLElement>, sequence: MotionSequence, phase: MotionPhase, window: MotionWindow, total: number, reduced: boolean) {
  const animations: Animation[] = [];
  let clockStart = performance.now(), clockOffset = 0, clockPaused = false;
  if (window.span > 0) for (const track of sequence.tracks) {
    if (reduced && (track.property !== 'opacity' || phase === 'loop')) continue;
    const duration = reduced ? Math.min(.15, window.duration) : window.duration;
    const points = reduced ? [track.points[0], track.points.at(-1)!].map((p, i) => ({...p, offset: i, easing: 'smooth' as const})) : track.points;
    const animation = elements[track.property].animate(points.map(p => ({...frame(track.property, p.value), offset: p.offset, easing: MOTION_CURVES[p.easing]})), {
      duration: duration * 1000, delay: (phase === 'exit' && reduced ? total - duration : window.start) * 1000,
      iterations: phase === 'loop' ? window.iterations : 1, fill: phase === 'loop' ? 'none' : 'both', easing: 'linear'
    });
    animation.id = `alert-keyframe-${phase}-${track.property}`; animations.push(animation);
  }
  return {
    cancel: () => animations.forEach(a => a.cancel()),
    time: () => clockOffset + (clockPaused ? 0 : (performance.now() - clockStart) / 1000),
    seek: (seconds: number, paused = true) => { clockOffset = Math.max(0, Math.min(total, seconds)); clockStart = performance.now(); clockPaused = paused; animations.forEach(a => { if (paused) a.pause(); else a.play(); a.currentTime = clockOffset * 1000; }); }
  };
}

/** Sample the CSS curve for editor graphs and inserted points. No frame-by-frame JS in playback. */
export function easeProgress(easing: MotionEasing, progress: number): number {
  if (easing === 'linear') return progress;
  if (easing === 'hold') return progress >= 1 ? 1 : 0;
  const [x1,y1,x2,y2] = MOTION_CURVES[easing].slice(13,-1).split(',').map(Number);
  const cubic = (t:number,a:number,b:number) => 3*(1-t)*(1-t)*t*a + 3*(1-t)*t*t*b + t*t*t;
  let low=0,high=1;
  for(let i=0;i<20;i++) { const mid=(low+high)/2; if(cubic(mid,x1,x2)<progress) low=mid; else high=mid; }
  return cubic((low+high)/2,y1,y2);
}
