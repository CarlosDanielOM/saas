/** Portable, bounded animation data. Values are relative to the object's resting placement. */
export const MOTION_PHASES = ['enter', 'loop', 'exit'] as const;
export const MOTION_PROPERTIES = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export const MOTION_EASINGS = ['linear', 'smooth', 'ease-in', 'ease-out', 'soft', 'snappy', 'sine-in', 'sine-out', 'hold'] as const;
export type MotionPhase = typeof MOTION_PHASES[number];
export type MotionProperty = typeof MOTION_PROPERTIES[number];
export type MotionEasing = typeof MOTION_EASINGS[number];
export interface MotionPoint { offset: number; value: number; easing: MotionEasing }
export interface MotionTrack { property: MotionProperty; points: MotionPoint[] }
export interface MotionSequence { tracks: MotionTrack[] }
export type AlertKeyframes = Partial<Record<MotionPhase, MotionSequence>>;
export const MOTION_LIMITS: Record<MotionProperty, readonly [number, number]> = { x: [-400, 400], y: [-400, 400], scale: [0, 4], rotation: [-1440, 1440], opacity: [0, 1] };
export const neutralValue = (property: MotionProperty): number => property === 'opacity' || property === 'scale' ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** Also used for local draft recovery; arbitrary CSS and executable values are never accepted. */
export function validKeyframes(value: unknown): value is AlertKeyframes {
  if (!record(value) || Object.keys(value).some(key => !MOTION_PHASES.includes(key as MotionPhase))) return false;
  return Object.entries(value).every(([phase, sequence]) => {
    if (!record(sequence) || !Array.isArray(sequence['tracks']) || sequence['tracks'].length < 1 || sequence['tracks'].length > 5) return false;
    const seen = new Set<string>();
    return sequence['tracks'].every(track => {
      if (!record(track) || !MOTION_PROPERTIES.includes(track['property'] as MotionProperty) || seen.has(String(track['property']))) return false;
      seen.add(String(track['property']));
      const [min, max] = MOTION_LIMITS[track['property'] as MotionProperty], points = track['points'];
      if (!Array.isArray(points) || points.length < 2 || points.length > 24) return false;
      let previous = -1;
      for (const point of points) {
        if (!record(point) || !finite(point['offset']) || point['offset'] < 0 || point['offset'] > 1 || point['offset'] - previous < .000999
          || !finite(point['value']) || point['value'] < min || point['value'] > max || !MOTION_EASINGS.includes(point['easing'] as MotionEasing)) return false;
        previous = point['offset'];
      }
      return points[0].offset === 0 && points.at(-1).offset === 1 && (phase !== 'loop' || points[0].value === points.at(-1).value);
    });
  });
}
