import { MOTION_LIMITS, neutralValue, type MotionEasing, type MotionPhase, type MotionProperty, type MotionSequence, type MotionTrack } from './overlay-keyframes.model';
export type MotionMood = 'gentle' | 'playful' | 'bold';
export interface MotionPreset { id: string; phase: MotionPhase; mood: MotionMood; duration: number; sequence: MotionSequence }
const track = (property: MotionProperty, values: number[], offsets?: number[], easing: MotionEasing = 'smooth'): MotionTrack => ({property, points: values.map((value, i) => ({value, offset: offsets?.[i] ?? i / (values.length - 1), easing}))});
const fadeIn = () => track('opacity', [0, 1], undefined, 'soft');
const fadeOut = () => track('opacity', [1, 0], undefined, 'soft');
const preset = (id: string, phase: MotionPhase, mood: MotionMood, duration: number, ...tracks: MotionTrack[]): MotionPreset => ({id, phase, mood, duration, sequence: {tracks}});
const sine = (property: MotionProperty, values: number[], first: 'sine-in' | 'sine-out'): MotionTrack => {
  const result = track(property, values); result.points.forEach((p,i) => p.easing = i % 2 ? (first === 'sine-in' ? 'sine-out' : 'sine-in') : first); return result;
};
const arrivals: MotionPreset[] = [
  preset('dissolve', 'enter', 'gentle', .7, fadeIn()),
  preset('rise', 'enter', 'gentle', .85, track('y', [24, 0], undefined, 'ease-out'), fadeIn()),
  preset('settle', 'enter', 'gentle', .85, track('y', [-24, 0], undefined, 'ease-out'), fadeIn()),
  preset('glide-left', 'enter', 'gentle', .85, track('x', [-45, 0], undefined, 'ease-out'), fadeIn()),
  preset('glide-right', 'enter', 'gentle', .85, track('x', [45, 0], undefined, 'ease-out'), fadeIn()),
  preset('bloom', 'enter', 'gentle', .9, track('scale', [.78, 1], undefined, 'ease-out'), fadeIn()),
  preset('land', 'enter', 'gentle', .9, track('scale', [1.22, 1], undefined, 'ease-out'), fadeIn()),
  preset('spring', 'enter', 'playful', 1.05, track('scale', [.35, 1.10, .97, 1], [0, .56, .8, 1], 'soft'), track('opacity', [0, 1, 1], [0, .25, 1], 'soft')),
  preset('bounce-land', 'enter', 'playful', 1.15, track('y', [-70, 0, -12, 0, -3, 0], [0, .42, .61, .79, .9, 1], 'smooth'), fadeIn()),
  preset('swing-in', 'enter', 'playful', 1, track('rotation', [-18, 4, -1, 0], [0, .62, .83, 1], 'soft'), track('x', [-20, 0], undefined, 'ease-out'), fadeIn()),
  preset('arc-in', 'enter', 'playful', 1.1, track('x', [-60, -18, 0], [0, .5, 1], 'soft'), track('y', [35, -12, 0], [0, .55, 1], 'smooth'), fadeIn()),
  preset('whip-in', 'enter', 'bold', .7, track('x', [-160, 5, 0], [0, .74, 1], 'snappy'), fadeIn()),
  preset('twirl-in', 'enter', 'bold', 1.1, track('rotation', [-160, 0], undefined, 'ease-out'), track('scale', [.3, 1], undefined, 'ease-out'), fadeIn()),
  preset('hero-pop', 'enter', 'bold', .9, track('scale', [.05, 1.16, 1], [0, .68, 1], 'soft'), track('rotation', [-8, 2, 0], [0, .68, 1], 'soft'), fadeIn())
];
// Every loop returns exactly to its resting pose. Per-segment curves give soft reversals.
const idle: MotionPreset[] = [
  preset('float', 'loop', 'gentle', 3, track('y', [0, -7, 0])),
  preset('breathe', 'loop', 'gentle', 3.2, track('scale', [1, 1.045, 1])),
  preset('drift', 'loop', 'gentle', 4, track('x', [0, 5, 0, -5, 0])),
  preset('sway', 'loop', 'gentle', 3.5, track('rotation', [0, 3, 0, -3, 0])),
  preset('glimmer', 'loop', 'gentle', 3.5, track('opacity', [1, .7, 1])),
  preset('heartbeat', 'loop', 'playful', 2.2, track('scale', [1, 1.08, 1, 1.045, 1, 1], [0, .16, .3, .43, .6, 1])),
  preset('jelly', 'loop', 'playful', 2.8, track('scale', [1, 1.09, .97, 1, 1], [0, .25, .48, .7, 1]), track('rotation', [0, -4, 3, 0, 0], [0, .25, .48, .7, 1])),
  preset('hop', 'loop', 'playful', 2.5, track('y', [0, -16, 0, -4, 0, 0], [0, .25, .5, .65, .8, 1])),
  preset('figure-eight', 'loop', 'playful', 5, sine('x', [0, 8, 0, -8, 0], 'sine-out'), sine('y', [0, -5, 0, 5, 0, -5, 0, 5, 0], 'sine-out')),
  preset('rock', 'loop', 'bold', 2.4, track('rotation', [0, -7, 5, -3, 0, 0], [0, .2, .4, .6, .8, 1])),
  preset('pulse', 'loop', 'bold', 1.8, track('scale', [1, 1.12, 1])),
  preset('orbit', 'loop', 'gentle', 4.5,
    sine('x', [0, 6, 0, -6, 0], 'sine-out'), sine('y', [0, -6, -12, -6, 0], 'sine-in'))
];
const departures: MotionPreset[] = [
  preset('fade-away', 'exit', 'gentle', .65, fadeOut()),
  preset('sink', 'exit', 'gentle', .75, track('y', [0, 24], undefined, 'ease-in'), fadeOut()),
  preset('lift-away', 'exit', 'gentle', .75, track('y', [0, -24], undefined, 'ease-in'), fadeOut()),
  preset('drift-left', 'exit', 'gentle', .75, track('x', [0, -45], undefined, 'ease-in'), fadeOut()),
  preset('drift-right', 'exit', 'gentle', .75, track('x', [0, 45], undefined, 'ease-in'), fadeOut()),
  preset('shrink', 'exit', 'gentle', .8, track('scale', [1, .65], undefined, 'ease-in'), fadeOut()),
  preset('expand-away', 'exit', 'gentle', .8, track('scale', [1, 1.3], undefined, 'ease-in'), fadeOut()),
  preset('anticipate-out', 'exit', 'playful', .9, track('y', [0, -8, 80], [0, .3, 1], 'soft'), track('opacity', [1, 1, 0], [0, .3, 1], 'soft')),
  preset('swing-out', 'exit', 'playful', .85, track('rotation', [0, 22], undefined, 'ease-in'), track('x', [0, 25], undefined, 'ease-in'), fadeOut()),
  preset('pop-away', 'exit', 'playful', .85, track('scale', [1, 1.08, .1], [0, .3, 1], 'soft'), track('opacity', [1, 1, 0], [0, .3, 1], 'soft')),
  preset('whip-out', 'exit', 'bold', .6, track('x', [0, -5, 160], [0, .2, 1], 'soft'), fadeOut()),
  preset('twirl-out', 'exit', 'bold', 1, track('rotation', [0, 160], undefined, 'ease-in'), track('scale', [1, .2], undefined, 'ease-in'), fadeOut())
];
export const MOTION_PRESETS: readonly MotionPreset[] = [...arrivals, ...idle, ...departures];
export function presetSequence(preset: MotionPreset, strength = 1): MotionSequence {
  return {tracks: preset.sequence.tracks.map(track => ({property: track.property, points: track.points.map(point => {
    const neutral = neutralValue(track.property), [min, max] = MOTION_LIMITS[track.property];
    return {...point, value: track.property === 'opacity' ? point.value : +Math.max(min, Math.min(max, neutral + (point.value - neutral) * strength)).toFixed(4)};
  })}))};
}
/** Combine disjoint channels; when two presets animate a channel, the newest replaces that channel. */
export function combineSequences(current: MotionSequence | undefined, incoming: MotionSequence): MotionSequence {
  return {tracks: [...(current?.tracks ?? []).filter(track => !incoming.tracks.some(next => next.property === track.property)), ...incoming.tracks].map(track => structuredClone(track))};
}
