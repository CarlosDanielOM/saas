import type { ClipDesignVariant } from '../clips/clips.model';
import type { TestMedia } from './overlay-media.component';

/** Longest transition including the stagger on each original clip design. */
export const CLIP_MOTION: Record<ClipDesignVariant, { enter: number; exit: number }> = {
  classic: { enter: 1500, exit: 1500 }, third: { enter: 1320, exit: 1200 },
  tile: { enter: 1240, exit: 1100 }, cinema: { enter: 1260, exit: 1150 },
  orbit: { enter: 1280, exit: 1150 }, pill: { enter: 1280, exit: 1150 },
  hud: { enter: 1240, exit: 1150 }, slash: { enter: 1270, exit: 1200 }
};

/** The producer's limit wins over native duration; clips are capped at 30s. */
export function clipPlaybackLimit(media?: TestMedia, nativeDuration?: number): number {
  const seconds = [media?.duration, nativeDuration].find(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return Math.min(30, seconds ?? 30);
}
