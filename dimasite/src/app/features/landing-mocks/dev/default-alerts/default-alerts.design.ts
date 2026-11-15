import type { AlertDesign, AlertLayout, AlertMotion, AlertSound, OverlayWidget } from '../../../overlays/overlay.model';
import type { AlertKeyframes, MotionEasing, MotionPhase, MotionProperty, MotionTrack } from '../../../overlays/overlay-keyframes.model';

/**
 * The Dima default alerts every streamer gets: follow, Bits, sub, gifted subs (a sub look) and raid, on the 800×240
 * canvas of the old starter (the starter scene's alert box is 640×192, the same shape). Built only from objects the
 * Overlay Studio already plays (pictures, text, shapes, keyframes, sounds); pictures and sounds are items of Dima's
 * public overlay library (library.ts), so they use none of the streamer's storage.
 * COPY of dimabot src/overlays/default-alerts.ts (the source: new studios and the migration use it), with site imports.
 * This page plays it through the real renderer. Change the API file, then copy it here.
 * Art and sounds: marketing/alerts (build-art.mjs, build-sounds.mjs).
 */
export type DefaultAlertKind = 'follow' | 'bits' | 'sub' | 'gift' | 'raid';
export type DefaultAlertLanguage = 'en' | 'es';
export const DEFAULT_ALERT_KINDS: DefaultAlertKind[] = ['follow', 'bits', 'sub', 'gift', 'raid'];
export const DEFAULT_ALERT_CANVAS = { width: 800, height: 240 };

const ACCENT: Record<DefaultAlertKind, { light: string; tone: string }> = {
  follow: { light: '#c4b5fd', tone: '#8b5cf6' }, bits: { light: '#67e8f9', tone: '#06b6d4' }, sub: { light: '#fde68a', tone: '#f59e0b' },
  gift: { light: '#e9d5ff', tone: '#a855f7' }, raid: { light: '#fca5a5', tone: '#ef4444' }
};
export const DEFAULT_ALERT_DURATION: Record<DefaultAlertKind, number> = { follow: 6, bits: 6.5, sub: 7, gift: 7, raid: 8 };

/** What each alert says, with the usual alert text variables ($(gift.count) = subs in one gift). */
export const DEFAULT_ALERT_COPY: Record<DefaultAlertLanguage, Record<DefaultAlertKind, { kicker: string; name: string; stat?: string; unit?: string }>> = {
  en: {
    follow: { kicker: 'New follower', name: '$(user)' },
    bits: { kicker: 'Cheered', name: '$(user)', stat: '$(cheer.amount)', unit: 'bits' },
    sub: { kicker: 'New subscriber', name: '$(user)' },
    gift: { kicker: 'Gifted subs', name: '$(user)', stat: '$(gift.count)', unit: 'subs' },
    raid: { kicker: 'Raid incoming', name: '$(raid.channel)', stat: '$(raid.viewers)', unit: 'viewers' }
  },
  es: {
    follow: { kicker: 'Nuevo seguidor', name: '$(user)' },
    bits: { kicker: 'Mandó bits', name: '$(user)', stat: '$(cheer.amount)', unit: 'bits' },
    sub: { kicker: 'Nueva suscripción', name: '$(user)' },
    gift: { kicker: 'Regaló suscripciones', name: '$(user)', stat: '$(gift.count)', unit: 'subs' },
    raid: { kicker: '¡Llegó un raid!', name: '$(raid.channel)', stat: '$(raid.viewers)', unit: 'espectadores' }
  }
};

type Point = [offset: number, value: number, easing?: MotionEasing];
const track = (property: MotionProperty, points: Point[]): MotionTrack =>
  ({ property, points: points.map(([offset, value, easing]) => ({ offset, value, easing: easing ?? 'linear' })) });
const phase = (tracks: MotionTrack[]) => ({ tracks });
const motion = (delay: number, enter: number, exit: number, loop = 2, end?: number): AlertMotion =>
  ({ enter: 'none', exit: 'none', loop: 'none', delay, enterDuration: enter, exitDuration: exit || .5, loopDuration: loop, ...(end === undefined ? {} : { end: Math.round(end * 100) / 100 }) });
const part = (id: string, kind: OverlayWidget['kind'], x: number, y: number, width: number, height: number, extra: Partial<OverlayWidget> = {}): OverlayWidget =>
  ({ id, kind, x, y, width, height, visible: true, locked: false, ...extra });
const picture = (piece: string, kind: DefaultAlertKind) => ({ library: `dima-${kind}-${piece}` });
const keyframes = (k: Partial<Record<MotionPhase, MotionTrack[]>>): AlertKeyframes =>
  Object.fromEntries(Object.entries(k).map(([name, tracks]) => [name, phase(tracks!)])) as AlertKeyframes;
const clamp = (value: number) => Math.max(-400, Math.min(400, Math.round(value)));

/** Badge centre on the canvas: sparkles and confetti burst from here. */
const BADGE = { x: 130, y: 120 };

function sparkle(kind: DefaultAlertKind, id: string, cx: number, cy: number, size: number, delay: number, loop: number, end: number, burst = true): OverlayWidget {
  const dx = clamp((BADGE.x - cx) / size * 100), dy = clamp((BADGE.y - cy) / size * 100);
  return part(id, 'image', cx - size / 2, cy - size / 2, size, size, { name: 'Sparkle', ...picture('sparkle', kind), motion: motion(delay, .85, .3, loop, end), keyframes: keyframes({
    enter: [
      ...(burst ? [track('x', [[0, dx, 'ease-out'], [1, 0]]), track('y', [[0, dy, 'ease-out'], [1, 0]])] : []),
      track('scale', [[0, 0, 'ease-out'], [.55, 1.3, 'smooth'], [1, .9]]), track('opacity', [[0, 0], [.15, 1], [1, 1]]), track('rotation', [[0, -120, 'ease-out'], [1, 0]])
    ],
    loop: [track('scale', [[0, 1, 'smooth'], [.5, .55, 'smooth'], [1, 1]]), track('opacity', [[0, 1, 'smooth'], [.5, .45, 'smooth'], [1, 1]])],
    exit: [track('scale', [[0, 1, 'ease-in'], [1, 0]]), track('opacity', [[0, 1, 'ease-in'], [1, 0]])]
  }) });
}

const BADGE_LOOP: Record<DefaultAlertKind, { seconds: number; tracks: MotionTrack[] }> = {
  // A heartbeat.
  follow: { seconds: 1.8, tracks: [track('scale', [[0, 1, 'ease-out'], [.12, 1.07, 'smooth'], [.24, 1, 'ease-out'], [.36, 1.05, 'smooth'], [.5, 1], [1, 1]])] },
  // A gem rocking in the light.
  bits: { seconds: 2.6, tracks: [track('rotation', [[0, 0, 'smooth'], [.5, 7, 'smooth'], [1, 0]]), track('y', [[0, 0, 'smooth'], [.5, -3, 'smooth'], [1, 0]])] },
  sub: { seconds: 3, tracks: [track('rotation', [[0, 0, 'smooth'], [.5, -5, 'smooth'], [1, 0]]), track('y', [[0, 0, 'smooth'], [.5, -3, 'smooth'], [1, 0]])] },
  // A present being shaken.
  gift: { seconds: 2.4, tracks: [track('rotation', [[0, 0, 'smooth'], [.08, -7, 'smooth'], [.16, 6, 'smooth'], [.24, -4, 'smooth'], [.32, 2, 'smooth'], [.4, 0], [1, 0]]), track('scale', [[0, 1, 'smooth'], [.08, 1.04, 'smooth'], [.4, 1], [1, 1]])] },
  // Engines running.
  raid: { seconds: 1.4, tracks: [track('y', [[0, 0, 'smooth'], [.5, -3, 'smooth'], [1, 0]]), track('rotation', [[0, 0, 'smooth'], [.25, -2, 'smooth'], [.75, 2, 'smooth'], [1, 0]])] }
};

/** One alert layout. `text` maps each text template to what the overlay should print (the server does this in OBS). */
export function defaultAlertLayout(kind: DefaultAlertKind, language: DefaultAlertLanguage, text: (template: string) => string = t => t): AlertLayout {
  const D = DEFAULT_ALERT_DURATION[kind], copy = DEFAULT_ALERT_COPY[language][kind], accent = ACCENT[kind], stat = !!copy.stat;
  const fade = (y: number) => ({
    exit: [track('opacity', [[0, 1, 'ease-in'], [1, 0]]), track('y', [[0, 0, 'ease-in'], [1, y]])]
  });
  const widgets: OverlayWidget[] = [
    part('glow', 'image', 10, 0, 240, 240, { name: 'Glow', ...picture('glow', kind), opacity: .85, motion: motion(0, .8, .6, 2.4, D), keyframes: keyframes({
      enter: [track('scale', [[0, .3, 'ease-out'], [.6, 1.1, 'smooth'], [1, 1]]), track('opacity', [[0, 0, 'ease-out'], [.4, 1], [1, 1]])],
      loop: [track('scale', [[0, 1, 'smooth'], [.5, 1.08, 'smooth'], [1, 1]]), track('opacity', [[0, 1, 'smooth'], [.5, .7, 'smooth'], [1, 1]])],
      exit: [track('scale', [[0, 1, 'ease-in'], [1, .5]]), track('opacity', [[0, 1, 'ease-in'], [1, 0]])]
    }) }),
    part('ring', 'image', 30, 20, 200, 200, { name: 'Shockwave', ...picture('ring', kind), motion: motion(.06, kind === 'raid' ? 1 : .9, 0, 2, 1.1), keyframes: keyframes({
      enter: [track('scale', [[0, .6, 'ease-out'], [1, kind === 'raid' ? 1.4 : 1.3]]), track('opacity', [[0, 0], [.12, 1, 'sine-in'], [1, 0]])]
    }) }),
    part('card', 'image', 110, 49, 660, 150, { name: 'Card', ...picture('card', kind), motion: motion(.14, .7, .5, 2, D - .12), keyframes: keyframes({
      enter: [track('x', [[0, -9, 'ease-out'], [1, 0]]), track('scale', [[0, .94, 'ease-out'], [1, 1]]), track('opacity', [[0, 0, 'ease-out'], [.45, 1], [1, 1]])],
      exit: [track('x', [[0, 0, 'ease-in'], [1, -7]]), track('opacity', [[0, 1, 'ease-in'], [1, 0]])]
    }) })
  ];
  if (kind === 'raid') [[300, 32, 170, .16], [420, 84, 140, .24], [470, 142, 120, .3], [330, 188, 150, .36]].forEach(([x, y, width, delay], i) =>
    widgets.push(part(`wind-${i + 1}`, 'image', x, y, width, 20, { name: 'Speed line', ...picture('wind', kind), opacity: i % 2 ? .9 : .7, motion: motion(delay, .75, 0, 2, delay + .8), keyframes: keyframes({
      enter: [track('x', [[0, -120, 'ease-out'], [1, 150]]), track('opacity', [[0, 0], [.25, 1], [1, 0]])]
    }) })));
  const textStyle = { fontFamily: 'sans' as const, fontWeight: 700 as const, textAlign: 'left' as const };
  widgets.push(
    part('kicker', 'text', 236, 70, stat ? 362 : 510, 32, { name: 'Title', ...textStyle, text: text(copy.kicker), fontSize: 24, color: accent.light, motion: motion(.32, .55, .35, 2, D - .32), keyframes: keyframes({
      enter: [track('y', [[0, 55, 'ease-out'], [1, 0]]), track('opacity', [[0, 0, 'ease-out'], [.6, 1], [1, 1]])], ...fade(-30)
    }) }),
    part('name', 'text', 236, 101, stat ? 362 : 510, 58, { name: 'Name', ...textStyle, text: text(copy.name), fontSize: 48, color: '#f5f7fb', motion: motion(.4, .6, .35, 2, D - .28), keyframes: keyframes({
      enter: [track('y', [[0, 40, 'ease-out'], [1, 0]]), track('opacity', [[0, 0, 'ease-out'], [.6, 1], [1, 1]])], ...fade(-20)
    }) })
  );
  if (stat) widgets.push(
    part('amount', 'text', 608, 80, 138, 52, { name: 'Amount', ...textStyle, textAlign: 'center', text: text(copy.stat!), fontSize: 40, color: accent.light, motion: motion(.52, .65, .35, 2, D - .3), keyframes: keyframes({
      enter: [track('scale', [[0, .4, 'ease-out'], [.6, 1.12, 'smooth'], [1, 1]]), track('opacity', [[0, 0, 'ease-out'], [.35, 1], [1, 1]])],
      exit: [track('opacity', [[0, 1, 'ease-in'], [1, 0]]), track('scale', [[0, 1, 'ease-in'], [1, .8]])]
    }) }),
    part('unit', 'text', 608, 132, 138, 26, { name: 'Unit', ...textStyle, textAlign: 'center', text: text(copy.unit!), fontSize: 17, color: '#a7b0c2', motion: motion(.62, .5, .35, 2, D - .3), keyframes: keyframes({
      enter: [track('y', [[0, 50, 'ease-out'], [1, 0]]), track('opacity', [[0, 0, 'ease-out'], [.6, 1], [1, 1]])], ...fade(-20)
    }) })
  );
  // Sparkles burst out from behind the badge, then twinkle.
  ([[46, 46, 30, .1, 1.6], [226, 34, 24, .16, 2], [238, 206, 20, .2, 1.8], [28, 176, 26, .13, 2.2], [124, 16, 20, .24, 1.5], [196, 226, 20, .28, 1.9]] as const)
    .forEach(([x, y, size, delay, loop], i) => widgets.push(sparkle(kind, `sparkle-${i + 1}`, x, y, size, delay, loop, D - .18 - i * .03)));
  // Subs get a few more twinkles across the card; Bits a couple of gem glints.
  if (kind === 'sub') ([[700, 44, 22, .7], [560, 206, 20, .85], [392, 30, 20, 1]] as const).forEach(([x, y, size, delay], i) => widgets.push(sparkle(kind, `twinkle-${i + 1}`, x, y, size, delay, 1.7 + i * .2, D - .3, false)));
  if (kind === 'bits') ([[592, 40, 20, .75], [470, 208, 20, .9]] as const).forEach(([x, y, size, delay], i) => widgets.push(sparkle(kind, `glint-${i + 1}`, x, y, size, delay, 1.6 + i * .3, D - .3, false)));
  // Gifts: confetti thrown out of the box, swaying while it falls a little.
  if (kind === 'gift') ([[40, 30, 1, 200], [92, 14, 2, -160], [172, 14, 3, 140], [222, 58, 4, -220], [20, 110, 2, 180], [250, 168, 1, -140], [64, 222, 3, 120], [196, 224, 1, -200]] as const)
    .forEach(([cx, cy, color, spin], i) => widgets.push(part(`confetti-${i + 1}`, 'image', cx - 10, cy - 10, 20, 20, { name: 'Confetti', ...picture(`confetti${color}`, kind), motion: motion(.26 + i * .02, .9, .4, 2.2 + (i % 3) * .4, D - .2), keyframes: keyframes({
      enter: [track('x', [[0, clamp((BADGE.x - cx) / 20 * 100), 'ease-out'], [1, 0]]), track('y', [[0, clamp((BADGE.y - cy) / 20 * 100), 'ease-out'], [1, 0]]),
        track('rotation', [[0, 0, 'ease-out'], [1, spin]]), track('scale', [[0, .3, 'ease-out'], [1, 1]]), track('opacity', [[0, 0], [.1, 1], [1, 1]])],
      loop: [track('rotation', [[0, 0, 'smooth'], [.5, 22, 'smooth'], [1, 0]]), track('y', [[0, 0, 'smooth'], [.5, 40, 'smooth'], [1, 0]])],
      exit: [track('opacity', [[0, 1, 'ease-in'], [1, 0]]), track('y', [[0, 0, 'ease-in'], [1, 120]])]
    }) })));
  const loop = BADGE_LOOP[kind];
  widgets.push(part('badge', 'image', 30, 20, 200, 200, { name: 'Badge', ...picture('badge', kind), motion: motion(0, .8, .5, loop.seconds, D), keyframes: keyframes({
    enter: [track('scale', [[0, 0, 'ease-out'], [.55, 1.14, 'smooth'], [.8, .96, 'smooth'], [1, 1]]), track('rotation', [[0, -28, 'ease-out'], [.6, 6, 'smooth'], [1, 0]]), track('opacity', [[0, 0, 'ease-out'], [.2, 1], [1, 1]])],
    loop: loop.tracks,
    exit: [track('scale', [[0, 1, 'smooth'], [.3, 1.08, 'ease-in'], [1, 0]]), track('opacity', [[0, 1], [.6, 1, 'ease-in'], [1, 0]]), track('rotation', [[0, 0, 'ease-in'], [1, -20]])]
  }) }));
  // `sound` is the legacy mirror of sounds[0] that the save validator also writes (older OBS renderers read it).
  const sound: AlertSound = { library: `dima-${kind}-sound`, name: SOUND_NAME[language][kind], volume: .8, delay: 0, fadeIn: 0, fadeOut: 0 };
  return { duration: D, widgets, sounds: [{ id: 'sound', ...sound }], sound };
}

const SOUND_NAME: Record<DefaultAlertLanguage, Record<DefaultAlertKind, string>> = {
  en: { follow: 'Dima · Follow', bits: 'Dima · Bits', sub: 'Dima · Sub', gift: 'Dima · Gifted subs', raid: 'Dima · Raid' },
  es: { follow: 'Dima · Seguidor', bits: 'Dima · Bits', sub: 'Dima · Suscripción', gift: 'Dima · Suscripciones regaladas', raid: 'Dima · Raid' }
};

/** The whole default design: the four alert events, plus a "Gifted subs" sub look that every gift plays. */
export function makeDefaultDesign(id: string, name: string, language: DefaultAlertLanguage): AlertDesign {
  return { id, name, revision: 1, ...DEFAULT_ALERT_CANVAS,
    events: { follow: defaultAlertLayout('follow', language), bits: defaultAlertLayout('bits', language), sub: defaultAlertLayout('sub', language), raid: defaultAlertLayout('raid', language) },
    variants: { sub: [{ id: 'gifted-subs', name: language === 'es' ? 'Suscripciones regaladas' : 'Gifted subs', enabled: true, gift: true, layout: defaultAlertLayout('gift', language) }] } };
}
