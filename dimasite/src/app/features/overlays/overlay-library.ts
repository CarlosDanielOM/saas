/**
 * Dima's public overlay library (mirror of dimabot `src/overlays/library.ts`: same ids and files). Alert designs point
 * to these pictures and sounds by id (`library`); the files are ours, served by this site, never copied into a
 * streamer's asset library and never counted against their storage.
 */
const EVENTS = ['follow', 'bits', 'sub', 'gift', 'raid'] as const;
const PICTURES = ['badge', 'card', 'glow', 'ring', 'sparkle'] as const;
const picture = (event: string, piece: string) => [`dima-${event}-${piece}`, `v1/${piece}-${event}.webp`] as const;
const FILES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...EVENTS.flatMap(event => [...PICTURES.map(piece => picture(event, piece)), [`dima-${event}-sound`, `v1/sound-${event}.mp3`] as const]),
  picture('raid', 'wind'), ...[1, 2, 3, 4].map(n => picture('gift', `confetti${n}`))
]));
/** Site-relative file URL of a library item, or '' for an unknown id. */
export function libraryUrl(id: string | undefined): string {
  return id && Object.hasOwn(FILES, id) ? `/overlay-library/${FILES[id]}` : '';
}
/** Every library file (preloading, checks). */
export const LIBRARY_URLS: readonly string[] = Object.values(FILES).map(file => `/overlay-library/${file}`);
