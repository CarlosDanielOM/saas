import type { AlertDesign, AlertLayout, AlertSound, OverlayWidget } from './model.js';

/**
 * Dima's public overlay library: pictures and sounds that alert designs point to by id (`library` on an image object
 * or a sound). The files belong to us and are served by the site under /overlay-library/; they are never copied into
 * a streamer's asset library and use none of their storage. Versioned folders are immutable: a new look is a new id.
 * Mirrored in dimasite `features/overlays/overlay-library.ts` (same ids and files).
 */
export interface LibraryItem { kind: 'image' | 'audio'; file: string }
const EVENTS = ['follow', 'bits', 'sub', 'gift', 'raid'] as const;
const PICTURES = ['badge', 'card', 'glow', 'ring', 'sparkle'] as const;
const picture = (event: string, piece: string) => [`dima-${event}-${piece}`, { kind: 'image', file: `v1/${piece}-${event}.webp` }] as const;
export const OVERLAY_LIBRARY: Readonly<Record<string, LibraryItem>> = Object.freeze(Object.fromEntries([
  ...EVENTS.flatMap(event => [...PICTURES.map(piece => picture(event, piece)), [`dima-${event}-sound`, { kind: 'audio', file: `v1/sound-${event}.mp3` }] as const]),
  picture('raid', 'wind'), ...[1, 2, 3, 4].map(n => picture('gift', `confetti${n}`))
]));
export const isLibraryId = (value: unknown, kind: LibraryItem['kind']): value is string =>
  typeof value === 'string' && Object.hasOwn(OVERLAY_LIBRARY, value) && OVERLAY_LIBRARY[value].kind === kind;
/** Site-relative: every renderer (OBS page, Overlay Studio) runs on the site. */
export const libraryUrl = (id: string): string => Object.hasOwn(OVERLAY_LIBRARY, id) ? `/overlay-library/${OVERLAY_LIBRARY[id].file}` : '';

const widgetUrl = (w: OverlayWidget): OverlayWidget => w.library && Object.hasOwn(OVERLAY_LIBRARY, w.library) ? { ...w, mediaUrl: libraryUrl(w.library) } : w;
const soundUrl = (s: AlertSound): AlertSound => s.library && Object.hasOwn(OVERLAY_LIBRARY, s.library) ? { ...s, url: libraryUrl(s.library) } : s;
export function layoutWithLibraryUrls(layout: AlertLayout): AlertLayout {
  return { ...layout, widgets: layout.widgets.map(widgetUrl), ...(layout.sounds ? { sounds: layout.sounds.map(soundUrl) } : {}), ...(layout.sound ? { sound: soundUrl(layout.sound) } : {}) };
}
/**
 * Copies of the designs whose library objects also carry their file URL (`mediaUrl` / `url`). Served to OBS so pages
 * still running an older renderer, which only knows URLs and Studio assets, play them too. Never stored.
 */
export function designsWithLibraryUrls(designs: readonly AlertDesign[]): AlertDesign[] {
  return designs.map(design => ({ ...design, events: Object.fromEntries(Object.entries(design.events).map(([kind, layout]) => [kind, layoutWithLibraryUrls(layout)])) as AlertDesign['events'],
    ...(design.variants ? { variants: Object.fromEntries(Object.entries(design.variants).map(([kind, variants]) => [kind, variants?.map(v => ({ ...v, layout: layoutWithLibraryUrls(v.layout) }))])) } : {}) }));
}
