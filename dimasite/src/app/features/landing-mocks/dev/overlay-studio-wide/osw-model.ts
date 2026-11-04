/**
 * Data for the wide Overlay Studio mock (/mocks/dev/overlay-studio).
 * Everything is local: no API, no OBS, no saving to an account.
 */
import { CLIP_DESIGN_VARIANTS, type ClipDesignVariant } from '../../../clips/clips.model';

export type Kind = 'alert' | 'trigger' | 'tts' | 'clip' | 'poll' | 'prediction' | 'image' | 'video' | 'shape' | 'text';
export type AlertEvent = 'follow' | 'sub' | 'bits' | 'raid';
export type TestKind = AlertEvent | 'trigger' | 'tts' | 'clip' | 'poll' | 'prediction';
export type Motion = 'none' | 'fade' | 'slide-up' | 'slide-left' | 'zoom' | 'bounce';
export type Loop = 'none' | 'pulse' | 'float' | 'sway';
export type Handle = 'nw' | 'ne' | 'sw' | 'se';
export type Background = 'checker' | 'dark' | 'game';

export interface Layer {
  id: string; kind: Kind;
  /** Empty until the streamer renames it; the UI then shows `nameKey` copy or the kind label. */
  name: string; nameKey?: string;
  x: number; y: number; w: number; h: number;
  visible: boolean; locked: boolean;
  opacity: number; radius: number; borderWidth: number; borderColor: string; shadow: boolean;
  enter: Motion; loop: Loop; exit: Motion;
  designId?: string; events?: AlertEvent[];
  triggerMode?: 'all' | 'some'; triggerIds?: string[]; placement?: 'fixed' | 'random'; margin?: number;
  showText?: boolean;
  clipLook?: ClipDesignVariant;
  look?: 'card' | 'compact'; fixture?: string;
  media?: string; fit?: 'contain' | 'cover'; loopVideo?: boolean; sound?: boolean;
  shape?: 'rectangle' | 'ellipse'; fill?: string;
  /** `textKey` is starter copy that follows the UI language until the streamer types their own text. */
  text?: string; textKey?: string; fontSize?: number; color?: string; align?: 'left' | 'center' | 'right';
}

/** `name` is empty for the starter overlays, which use their copy key (`scenes.<id>`). */
export interface Scene { id: string; name: string; width: number; height: number; layers: Layer[]; waitFor: TestKind[] }
export interface Design { id: string; name: string; nameKey?: string; look: 'pop' | 'line' }

export const ALERT_EVENTS: AlertEvent[] = ['follow', 'sub', 'bits', 'raid'];
export const TEST_KINDS: TestKind[] = ['follow', 'sub', 'bits', 'raid', 'trigger', 'tts', 'clip', 'poll', 'prediction'];
export const MOTIONS: Motion[] = ['none', 'fade', 'slide-up', 'slide-left', 'zoom', 'bounce'];
export const LOOPS: Loop[] = ['none', 'pulse', 'float', 'sway'];
export const CLIP_LOOKS: readonly ClipDesignVariant[] = CLIP_DESIGN_VARIANTS;
/** Same rule as the Clips module: Classic and Lower third are free. */
export const FREE_CLIP_LOOKS: ClipDesignVariant[] = ['classic', 'third'];
export const TRIGGERS = ['airhorn', 'bonk', 'hydrate', 'jumpscare'] as const;
export const POLL_STAGES = ['begin', 'progress', 'result', 'tie', 'canceled'];
export const PREDICTION_STAGES = ['begin', 'progress', 'locked', 'result', 'canceled'];
export const LOGO = '/assets/brand/mark-on-dark.png';

/** Add palette, grouped by what the streamer wants to show. */
export const PALETTE: { group: 'events' | 'interact' | 'media'; kinds: Kind[] }[] = [
  { group: 'events', kinds: ['alert', 'trigger', 'tts', 'clip'] },
  { group: 'interact', kinds: ['poll', 'prediction'] },
  { group: 'media', kinds: ['image', 'video', 'shape', 'text'] }
];

/** Which layer kind answers each test event. */
export const PLAYS: Record<TestKind, Kind> = {
  follow: 'alert', sub: 'alert', bits: 'alert', raid: 'alert',
  trigger: 'trigger', tts: 'tts', clip: 'clip', poll: 'poll', prediction: 'prediction'
};

export const SIZES = [
  { id: '1080p', w: 1920, h: 1080 },
  { id: '720p', w: 1280, h: 720 },
  { id: '1440p', w: 2560, h: 1440 },
  { id: 'vertical', w: 1080, h: 1920 }
];

const DEFAULT_SIZE: Record<Kind, [number, number]> = {
  alert: [700, 210], trigger: [620, 360], tts: [700, 190], clip: [760, 430], poll: [560, 360], prediction: [560, 460],
  image: [240, 240], video: [640, 360], shape: [600, 140], text: [640, 110]
};

export function makeLayer(kind: Kind, id: string, at?: { x: number; y: number }, canvas = { w: 1920, h: 1080 }): Layer {
  const [w, h] = DEFAULT_SIZE[kind];
  const base: Layer = {
    id, kind, name: '', w, h,
    x: Math.round((at?.x ?? (canvas.w - w) / 2) / 10) * 10,
    y: Math.round((at?.y ?? (canvas.h - h) / 2) / 10) * 10,
    visible: true, locked: false, opacity: 100, radius: 0, borderWidth: 0, borderColor: '#a78bfa', shadow: false,
    enter: 'fade', loop: 'none', exit: 'fade'
  };
  switch (kind) {
    case 'alert': return { ...base, designId: 'pop', events: [...ALERT_EVENTS] };
    case 'trigger': return { ...base, triggerMode: 'all', triggerIds: [...TRIGGERS], placement: 'fixed', margin: 40 };
    case 'tts': return { ...base, showText: false };
    case 'clip': return { ...base, clipLook: 'classic' };
    case 'poll': return { ...base, look: 'card', fixture: 'progress' };
    case 'prediction': return { ...base, look: 'card', fixture: 'progress' };
    case 'image': return { ...base, media: LOGO, fit: 'contain' };
    case 'video': return { ...base, fit: 'cover', loopVideo: true, sound: false, radius: 16 };
    case 'shape': return { ...base, shape: 'rectangle', fill: '#7c3aed', opacity: 80, radius: 24 };
    case 'text': return { ...base, text: '', textKey: 'text.starter', fontSize: 64, color: '#ffffff', align: 'left', shadow: true };
  }
}

export function startingScenes(): Scene[] {
  const L = (kind: Kind, id: string, x: number, y: number, patch: Partial<Layer> = {}): Layer =>
    ({ ...makeLayer(kind, id), x, y, ...patch });
  return [
    {
      id: 'main', name: '', width: 1920, height: 1080, waitFor: ['tts', 'trigger', 'bits', 'follow'],
      layers: [
        L('poll', 'poll-1', 680, 300, { visible: false }),
        L('alert', 'alert-1', 60, 800),
        L('clip', 'clip-1', 1100, 500, { clipLook: 'third', h: 428 }),
        L('tts', 'tts-1', 1160, 80),
        L('trigger', 'trigger-1', 80, 80),
        L('image', 'logo-1', 1770, 950, { w: 110, h: 110, nameKey: 'media.logo' })
      ]
    },
    {
      id: 'chat', name: '', width: 1920, height: 1080, waitFor: ['tts'],
      layers: [
        L('shape', 'bar-1', 0, 960, { w: 1920, h: 120, radius: 0, fill: '#11131a', opacity: 85 }),
        L('text', 'goal-1', 60, 975, { w: 900, h: 90, textKey: 'text.goal', fontSize: 56 }),
        L('prediction', 'prediction-1', 1300, 80),
        L('poll', 'poll-2', 1300, 80, { visible: false }),
        L('alert', 'alert-2', 610, 60, { designId: 'line' }),
        L('tts', 'tts-2', 1160, 840, { showText: true, h: 100, w: 700 })
      ]
    },
    {
      id: 'brb', name: '', width: 1920, height: 1080, waitFor: [],
      layers: [
        L('shape', 'panel-1', 360, 300, { w: 1200, h: 480, radius: 48, fill: '#1d2230', opacity: 90, shadow: true }),
        L('text', 'brb-1', 460, 360, { w: 1000, h: 140, textKey: 'text.brb', fontSize: 104, align: 'center', loop: 'pulse' }),
        L('clip', 'clip-2', 580, 520, { w: 760, h: 214, clipLook: 'classic' })
      ]
    }
  ];
}
