// Scene scripts for promo demo videos.
// Shared by the player (/mocks/dev/demo) and the recorder (marketing/video, run by Node with type stripping), so
// this file must stay import-free and use only erasable TypeScript (no enums, namespaces or parameter properties).

export const DEMO_CONTRACT_VERSION = 1;

export type DemoLang = 'en' | 'es';
export type DemoFormat = 'vertical' | 'landscape';
export const DEMO_LANGS: readonly DemoLang[] = ['en', 'es'];
/** Art directions for the frame. Content and timing are identical; only the look changes. */
export type DemoLook = 'studio' | 'site' | 'paper' | 'signal' | 'broadcast' | 'night';
export const DEMO_LOOKS: readonly DemoLook[] = ['studio', 'site', 'paper', 'signal', 'broadcast', 'night'];
export const DEMO_FORMATS: Readonly<Record<DemoFormat, { width: number; height: number }>> = {
  vertical: { width: 540, height: 960 },
  landscape: { width: 960, height: 540 }
};
/** The stream canvas the overlay actors are laid out on (same as an OBS scene). */
export const STAGE = { width: 1920, height: 1080 };

export type DemoText = string | { en: string; es: string };
export interface DemoSound { src: string; gain: number; delay: number; fadeIn: number; fadeOut: number }
export interface DemoRef { file: string; quote: string; inText: boolean; lang: DemoLang | null }

type FieldType = 'text' | 'string' | 'number' | 'boolean' | 'id' | 'enum' | 'sound' | 'refs' | 'texts' | 'strings';
interface FieldSpec { type: FieldType; required?: boolean; values?: readonly string[]; min?: number; max?: number; doc: string }
interface ActorSpec { dur: number | 'auto'; doc: string; fields: Record<string, FieldSpec> }

const BADGES = ['broadcaster', 'mod', 'vip', 'sub', 'verified'] as const;
const ALERT_KINDS = ['follow', 'sub', 'bits', 'raid'] as const;
const FOCUS = ['full', 'stream', 'alert', 'tts', 'duel', 'roulette'] as const;

/** Every building block a scene can use. The JSON Schema for editors is generated from this table. */
export const DEMO_ACTORS: Readonly<Record<string, ActorSpec>> = {
  intro: { dur: 1800, doc: 'Full-screen brand card (logo, name, a short line).', fields: {
    title: { type: 'text', doc: 'Big line under the logo. Defaults to the brand tagline.' },
    sub: { type: 'text', doc: 'Smaller second line.' } } },
  outro: { dur: 2400, doc: 'Full-screen closing card with the domain.', fields: {
    title: { type: 'text', doc: 'Big closing line.' },
    cta: { type: 'text', doc: 'Call to action under it. Defaults to "Free to start".' } } },
  caption: { dur: 2600, doc: 'Big marketing caption. Wrap words in *stars* to color them. It stays on screen until the next caption in its place (at the same ms, the later one wins) or a full-screen card replaces it; dur only times the beats placed after it.', fields: {
    text: { type: 'text', required: true, doc: 'Caption text.' },
    place: { type: 'enum', values: ['top', 'bottom'], doc: 'Where it sits. Defaults: top on vertical (the band above the stream), bottom on landscape (the band under the stream).' } } },
  chat: { dur: 0, doc: 'A viewer chat message.', fields: {
    user: { type: 'string', required: true, doc: 'Twitch login (fictional).' },
    text: { type: 'text', required: true, doc: 'The message.' },
    first: { type: 'boolean', doc: 'First message ever in this channel (Twitch highlights it).' },
    badges: { type: 'strings', values: BADGES, doc: 'Chat badges.' },
    color: { type: 'string', doc: 'Name color (#rrggbb). Defaults to a color picked from the name.' } } },
  bot: { dur: 0, doc: 'A DomDimaBot chat message. Use refs so the wording stays what the bot really says.', fields: {
    text: { type: 'text', required: true, doc: 'The message. With "duel", {winner}, {loser} and {hp} come from that duel\'s result.' },
    duel: { type: 'id', doc: 'id of a duel beat whose result fills {winner}, {loser} and {hp}.' },
    refs: { type: 'refs', doc: 'Source quotes: [{ "file": "dimabot/...", "quote": "...", "inText": true, "lang": "en" }]. lang limits the text check to one language.' } } },
  event: { dur: 0, doc: 'A highlighted chat notice (follow, sub, cheer, raid, moderation).', fields: {
    text: { type: 'text', required: true, doc: 'Notice text.' },
    icon: { type: 'enum', values: ['follow', 'sub', 'bits', 'raid', 'shield', 'info'], doc: 'Icon. Defaults to info.' } } },
  delete: { dur: 0, doc: 'A moderator deletes one message.', fields: {
    target: { type: 'id', required: true, doc: 'id of the chat beat.' } } },
  ban: { dur: 0, doc: 'The user of a message is banned: all their messages disappear and chat shows a notice.', fields: {
    target: { type: 'id', required: true, doc: 'id of one of their chat beats.' },
    notice: { type: 'text', doc: 'Override the notice. Defaults to "<user> has been banned."' } } },
  alert: { dur: 5000, doc: 'An on-stream alert, rendered by the real Overlay Studio renderer.', fields: {
    event: { type: 'enum', required: true, values: ALERT_KINDS, doc: 'Which alert.' },
    user: { type: 'string', required: true, doc: 'Who followed/subbed/cheered/raided.' },
    amount: { type: 'number', min: 1, max: 1000000, doc: 'Bits, months or raid viewers.' },
    message: { type: 'text', doc: 'Line under the name. Defaults per event.' },
    sound: { type: 'sound', doc: 'Alert sound: "kit:chime" or { "src", "gain", "delay", "fadeIn", "fadeOut" } (ms).' } } },
  tts: { dur: 'auto', doc: 'A viewer message read aloud on stream (real TTS card). Length follows the voice clip.', fields: {
    user: { type: 'string', required: true, doc: 'Who sent it.' },
    text: { type: 'text', required: true, doc: 'What is read.' },
    voice: { type: 'string', doc: 'Voice name from marketing/video/voices.json. Defaults to the language default.' },
    clip: { type: 'text', doc: 'Use this audio file instead of synthesizing (path under marketing/video/sounds/).' },
    showText: { type: 'boolean', doc: 'Show the text card (default true).' } } },
  duel: { dur: 'auto', doc: 'A chat duel in the real duel overlay. Length comes from the seeded battle; dur can only make it longer (holds the winner screen).', fields: {
    left: { type: 'string', required: true, doc: 'Left fighter.' },
    right: { type: 'string', required: true, doc: 'Right fighter.' } } },
  roulette: { dur: 'auto', doc: 'A roulette spin in the real roulette overlay (0.6 s wait, spin, 2.4 s on the winner).', fields: {
    title: { type: 'text', doc: 'Roulette name.' },
    items: { type: 'texts', required: true, min: 2, max: 12, doc: 'Prizes.' },
    winner: { type: 'number', min: 0, max: 11, doc: 'Index of the winning prize. Defaults to a seeded pick.' },
    spin: { type: 'number', min: 2000, max: 12000, doc: 'Spin length in ms (default 5000).' } } },
  highlight: { dur: 1600, doc: 'A soft ring that points at something.', fields: {
    target: { type: 'string', required: true, doc: '"chat", "stream" or the id of a chat/bot beat.' },
    label: { type: 'text', doc: 'Small label next to the ring.' } } },
  camera: { dur: 700, doc: 'Zoom the stream view (mostly for vertical videos, where overlays are small).', fields: {
    focus: { type: 'enum', required: true, values: FOCUS, doc: 'What to frame. "full"/"stream" zooms back out.' },
    zoom: { type: 'number', min: 1, max: 3, doc: 'Maximum zoom (default 2.2).' } } },
  sfx: { dur: 0, doc: 'A sound effect.', fields: {
    src: { type: 'string', required: true, doc: '"kit:pop" (generated kit) or a file under marketing/video/sounds/.' },
    gain: { type: 'number', min: 0, max: 2, doc: 'Volume (default 1).' } } },
  music: { dur: 'auto', doc: 'Background music from this beat to the end (needs a licensed file).', fields: {
    src: { type: 'string', required: true, doc: 'File under marketing/video/sounds/.' },
    gain: { type: 'number', min: 0, max: 2, doc: 'Volume (default 0.35).' },
    fadeOut: { type: 'number', min: 0, max: 10000, doc: 'Fade at the end in ms (default 1500).' } } }
};
export const DEMO_ACTOR_NAMES = Object.keys(DEMO_ACTORS);

const COMMON_FIELDS: Record<string, FieldSpec> = {
  do: { type: 'enum', required: true, values: DEMO_ACTOR_NAMES, doc: 'Building block.' },
  id: { type: 'string', doc: 'Name this beat so others can target it or time from it.' },
  at: { type: 'string', doc: 'Start: absolute ms (number) or "+N" = N ms after the previous beat ends. Default "+0".' },
  after: { type: 'id', doc: 'Make "+N" count from the END of this beat instead of the previous one.' },
  with: { type: 'id', doc: 'Make "+N" count from the START of this beat (run alongside it).' },
  dur: { type: 'number', min: 0, max: 120000, doc: 'Length in ms (each block has a default).' },
  sfx: { type: 'sound', doc: 'Sound effect when this beat starts.' },
  $comment: { type: 'string', doc: 'Free note.' }
};

export interface RawScene {
  id: string; v: number; title?: DemoText; seed?: number; fps?: number; look?: DemoLook;
  formats?: DemoFormat[]; langs?: DemoLang[];
  channel?: { name?: string; title?: DemoText; game?: DemoText; viewers?: number };
  bot?: string; end?: number | 'auto'; tail?: number; poster?: number;
  beats: Record<string, unknown>[];
}

export interface DemoBeat {
  index: number; id: string; do: string;
  /** Absolute start and end in ms. */
  at: number; end: number;
  /** Fields with text resolved for the language. */
  props: Record<string, unknown>;
  sfx: DemoSound | null;
}
export interface DemoScene {
  id: string; lang: DemoLang; look: DemoLook; title: string; seed: number; fps: number; durationMs: number; posterMs: number;
  channel: { name: string; title: string; game: string; viewers: number };
  bot: string; beats: DemoBeat[];
}
export interface DemoCue { kind: 'sfx' | 'alert' | 'tts' | 'music'; beat: string; src: string; at: number; gain: number; fadeIn: number; fadeOut: number; end: number | null }

export interface DemoDurations {
  /** Clip lengths (ms) for tts beats, by beat id. Missing = estimate from the text. */
  tts?: Record<string, number>;
  /** Length of a duel beat in ms (the player simulates the seeded battle). */
  duel?: (beat: { index: number; seed: number }) => number;
}
export interface DemoNormalized { scene: DemoScene | null; errors: string[] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is DemoText =>
  typeof v === 'string' || (isObject(v) && typeof v['en'] === 'string' && typeof v['es'] === 'string');

export function resolveText(value: unknown, lang: DemoLang): string {
  if (typeof value === 'string') return value;
  if (isObject(value) && typeof value[lang] === 'string') return value[lang] as string;
  return '';
}

/** Reading time for a TTS line without a clip (text-only card). */
export function estimateSpeechMs(text: string): number {
  return Math.round(Math.min(20000, Math.max(1600, 900 + text.length * 62)));
}

export const ROULETTE_LEAD_MS = 600;
export const ROULETTE_HOLD_MS = 2400;
export const DEFAULT_ROULETTE_SPIN_MS = 5000;
export const DEFAULT_TAIL_MS = 500;
/** The duel's winner screen stays this long after the fight; the bot posts the result when the fight ends. */
export const DUEL_TAIL_MS = 1800;

export function parseSound(value: unknown): DemoSound | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return { src: value, gain: 1, delay: 0, fadeIn: 0, fadeOut: 0 };
  if (!isObject(value) || typeof value['src'] !== 'string') return null;
  const n = (k: string, d: number) => (typeof value[k] === 'number' && Number.isFinite(value[k]) ? (value[k] as number) : d);
  return { src: value['src'] as string, gain: n('gain', 1), delay: n('delay', 0), fadeIn: n('fadeIn', 0), fadeOut: n('fadeOut', 0) };
}

function checkField(where: string, name: string, spec: FieldSpec, value: unknown, errors: string[]): void {
  const bad = (msg: string) => errors.push(`${where}: "${name}" ${msg}`);
  switch (spec.type) {
    case 'text':
      if (!isText(value)) bad('must be a string or { "en": "...", "es": "..." }');
      else if (typeof value !== 'string' && (!value.en.trim() || !value.es.trim())) bad('needs both English and Spanish');
      return;
    case 'string':
    case 'id':
      if (typeof value !== 'string' || !value.trim()) bad('must be a non-empty string');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) bad('must be a number');
      else if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) bad(`must be between ${spec.min} and ${spec.max}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') bad('must be true or false');
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values!.includes(value)) bad(`must be one of: ${spec.values!.join(', ')}`);
      return;
    case 'sound':
      if (!parseSound(value)) bad('must be "kit:<name>", a file path, or { "src": ... }');
      return;
    case 'strings':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || (spec.values && !spec.values.includes(v)))) bad(`must be a list of: ${spec.values?.join(', ') ?? 'strings'}`);
      return;
    case 'texts':
      if (!Array.isArray(value) || value.some((v) => !isText(v))) bad('must be a list of texts');
      else if ((spec.min !== undefined && value.length < spec.min) || (spec.max !== undefined && value.length > spec.max)) bad(`needs ${spec.min} to ${spec.max} entries`);
      return;
    case 'refs':
      if (!Array.isArray(value) || value.some((r) => !isObject(r) || typeof r['file'] !== 'string' || typeof r['quote'] !== 'string' || !(r['quote'] as string).length)) bad('must be a list of { "file", "quote" }');
      return;
  }
}

export function refsOf(beat: Record<string, unknown>): DemoRef[] {
  const refs = Array.isArray(beat['refs']) ? beat['refs'] : [];
  return refs.filter(isObject).map((r) => ({ file: String(r['file']), quote: String(r['quote']), inText: r['inText'] !== false, lang: r['lang'] === 'en' || r['lang'] === 'es' ? r['lang'] : null }));
}

/** Small seeded generator (mulberry32) so every random choice is the same on every render. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const beatSeed = (sceneSeed: number, index: number) => (sceneSeed * 7919 + index * 104729 + 17) >>> 0;

/**
 * Check a scene and resolve it for one language: absolute times, text in that language, the total length.
 * `+N` counts from the end of the previous beat (or `after`'s end, or `with`'s start).
 */
export function normalizeScene(input: unknown, lang: DemoLang, durations: DemoDurations = {}): DemoNormalized {
  const errors: string[] = [];
  if (!isObject(input)) return { scene: null, errors: ['the scene must be a JSON object'] };
  const raw = input as unknown as RawScene;
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id)) errors.push('"id" must be lowercase letters, digits and dashes');
  if (raw.v !== DEMO_CONTRACT_VERSION) errors.push(`"v" must be ${DEMO_CONTRACT_VERSION}`);
  if (!Array.isArray(raw.beats) || !raw.beats.length) errors.push('"beats" must be a non-empty list');
  if (raw.formats !== undefined && (!Array.isArray(raw.formats) || !raw.formats.length || raw.formats.some((f) => !(f in DEMO_FORMATS)))) errors.push('"formats" must list vertical and/or landscape');
  if (raw.langs !== undefined && (!Array.isArray(raw.langs) || !raw.langs.length || raw.langs.some((l) => !DEMO_LANGS.includes(l)))) errors.push('"langs" must list en and/or es');
  if (raw.seed !== undefined && (!Number.isInteger(raw.seed) || raw.seed < 0)) errors.push('"seed" must be a whole number');
  if (raw.fps !== undefined && raw.fps !== 30 && raw.fps !== 60) errors.push('"fps" must be 30 or 60');
  if (raw.title !== undefined) checkField('scene', 'title', { type: 'text', doc: '' }, raw.title, errors);
  if (raw.look !== undefined && !DEMO_LOOKS.includes(raw.look)) errors.push(`"look" must be one of: ${DEMO_LOOKS.join(', ')}`);
  if (raw.end !== undefined && raw.end !== 'auto' && (typeof raw.end !== 'number' || raw.end < 500 || raw.end > 180000)) errors.push('"end" must be "auto" or 500..180000 ms');
  if (raw.channel !== undefined) {
    if (!isObject(raw.channel)) errors.push('"channel" must be an object');
    else {
      for (const key of ['title', 'game'] as const) if (raw.channel[key] !== undefined) checkField('channel', key, { type: 'text', doc: '' }, raw.channel[key], errors);
      if (raw.channel.name !== undefined && (typeof raw.channel.name !== 'string' || !raw.channel.name)) errors.push('channel: "name" must be a string');
      if (raw.channel.viewers !== undefined && (typeof raw.channel.viewers !== 'number' || raw.channel.viewers < 0)) errors.push('channel: "viewers" must be a number');
    }
  }
  if (errors.length) return { scene: null, errors };

  const seed = raw.seed ?? 1;
  const ids = new Map<string, number>();
  const beats: DemoBeat[] = [];
  /** When each duel's fight ends (its winner screen runs DUEL_TAIL_MS longer), by beat id. */
  const fightEnds = new Map<string, number>();
  let previousEnd = 0;
  raw.beats.forEach((entry, index) => {
    const where = `beat ${index + 1}`;
    if (!isObject(entry)) { errors.push(`${where}: must be an object`); return; }
    const kind = entry['do'];
    const spec = typeof kind === 'string' ? DEMO_ACTORS[kind] : undefined;
    if (!spec) { errors.push(`${where}: "do" must be one of: ${DEMO_ACTOR_NAMES.join(', ')}`); return; }
    const label = `${where} (${kind}${typeof entry['id'] === 'string' ? ' ' + entry['id'] : ''})`;
    for (const key of Object.keys(entry)) {
      if (!(key in COMMON_FIELDS) && !(key in spec.fields)) errors.push(`${label}: unknown field "${key}"`);
    }
    for (const [name, field] of Object.entries(spec.fields)) {
      if (entry[name] === undefined) { if (field.required) errors.push(`${label}: "${name}" is required`); continue; }
      checkField(label, name, field, entry[name], errors);
    }
    for (const name of ['id', 'after', 'with', 'dur', 'sfx'] as const) if (entry[name] !== undefined) checkField(label, name, COMMON_FIELDS[name], entry[name], errors);
    const id = typeof entry['id'] === 'string' ? entry['id'] : `#${index + 1}`;
    if (typeof entry['id'] === 'string') {
      if (ids.has(id)) errors.push(`${label}: id "${id}" is used twice`);
      ids.set(id, beats.length);
    }

    // Timing
    let at = previousEnd;
    const anchorId = (entry['after'] ?? entry['with']) as string | undefined;
    if (entry['after'] !== undefined && entry['with'] !== undefined) errors.push(`${label}: use "after" or "with", not both`);
    if (anchorId !== undefined) {
      const anchor = ids.has(anchorId) ? beats[ids.get(anchorId)!] : undefined;
      if (!anchor) errors.push(`${label}: "${entry['after'] !== undefined ? 'after' : 'with'}" points at "${anchorId}", which is not an earlier beat`);
      else at = entry['with'] !== undefined ? anchor.at : anchor.end;
    }
    const rawAt = entry['at'];
    // A bot line that reports a duel result, with no timing of its own, lands when that fight ends.
    const resultOf = kind === 'bot' && typeof entry['duel'] === 'string' && rawAt === undefined && anchorId === undefined && ids.has(entry['duel'] as string)
      ? beats[ids.get(entry['duel'] as string)!] : undefined;
    if (resultOf?.do === 'duel') at = fightEnds.get(resultOf.id) ?? resultOf.end - DUEL_TAIL_MS;
    if (typeof rawAt === 'number') {
      if (anchorId !== undefined) errors.push(`${label}: with "after"/"with", "at" must be "+N"`);
      if (!Number.isFinite(rawAt) || rawAt < 0) errors.push(`${label}: "at" must be 0 or more`);
      else at = rawAt;
    } else if (typeof rawAt === 'string') {
      const m = /^\+(\d{1,6})$/.exec(rawAt.trim());
      if (!m) errors.push(`${label}: "at" must be a number or "+N"`);
      else at += Number(m[1]);
    } else if (rawAt !== undefined) errors.push(`${label}: "at" must be a number or "+N"`);

    // Text in this language
    const props: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      const value = entry[name];
      if (value === undefined) continue;
      if (field.type === 'text') props[name] = resolveText(value, lang);
      else if (field.type === 'texts') props[name] = (value as unknown[]).map((v) => resolveText(v, lang));
      else if (field.type === 'sound') props[name] = parseSound(value);
      else props[name] = value;
    }

    // Length
    let dur = typeof entry['dur'] === 'number' ? entry['dur'] : spec.dur === 'auto' ? 0 : spec.dur;
    // A duel lasts as long as its seeded fight plus the winner screen; "dur" may only hold the end screen longer.
    const duelMs = kind === 'duel' ? (durations.duel ? durations.duel({ index, seed: beatSeed(seed, index) }) : 20000) : 0;
    if (kind === 'duel' && entry['dur'] !== undefined && dur < duelMs) errors.push(`${label}: "dur" can't be shorter than the fight (${duelMs} ms); leave it out`);
    if (entry['dur'] === undefined && spec.dur === 'auto') {
      if (kind === 'tts') dur = durations.tts?.[id] ?? estimateSpeechMs(String(props['text'] ?? ''));
      else if (kind === 'duel') dur = duelMs;
      else if (kind === 'roulette') dur = ROULETTE_LEAD_MS + (typeof props['spin'] === 'number' ? props['spin'] : DEFAULT_ROULETTE_SPIN_MS) + ROULETTE_HOLD_MS;
      else dur = 0; // music: until the end, resolved below
    }
    if (kind === 'roulette' && typeof props['winner'] === 'number' && Array.isArray(props['items']) && props['winner'] >= props['items'].length) errors.push(`${label}: "winner" must be below the number of items`);
    const beat: DemoBeat = { index, id, do: kind as string, at: Math.round(at), end: Math.round(at + dur), props, sfx: parseSound(entry['sfx']) };
    beats.push(beat);
    if (kind === 'duel') fightEnds.set(id, beat.at + duelMs - DUEL_TAIL_MS);
    previousEnd = beat.end;
  });

  // Targets must exist and point at the right kind of beat.
  for (const beat of beats) {
    const duel = beat.props['duel'];
    if (typeof duel === 'string') {
      const other = ids.has(duel) ? beats[ids.get(duel)!] : undefined;
      if (!other || other.do !== 'duel') errors.push(`${beat.do} ${beat.id}: "duel" must be the id of a duel beat`);
      else {
        const known = fightEnds.get(other.id) ?? other.end - DUEL_TAIL_MS;
        if (beat.at < known) errors.push(`${beat.do} ${beat.id}: the duel result is only known when the fight in ${duel} ends (${known} ms)`);
      }
    }
    const target = beat.props['target'];
    if (typeof target !== 'string') continue;
    if (beat.do === 'highlight' && (target === 'chat' || target === 'stream')) continue;
    if (beat.do === 'bot') continue;
    const other = ids.has(target) ? beats[ids.get(target)!] : undefined;
    const allowed = beat.do === 'highlight' ? ['chat', 'bot'] : ['chat'];
    if (!other) errors.push(`${beat.do} ${beat.id}: target "${target}" is not a beat id`);
    else if (!allowed.includes(other.do)) errors.push(`${beat.do} ${beat.id}: target "${target}" must be a ${allowed.join('/')} beat`);
    else if (other.at > beat.at) errors.push(`${beat.do} ${beat.id}: target "${target}" starts later`);
  }
  for (const beat of beats) {
    if (beat.do !== 'bot') continue;
    for (const ref of refsOf(raw.beats[beat.index] as Record<string, unknown>)) {
      if (ref.inText && (!ref.lang || ref.lang === lang) && !String(beat.props['text']).includes(ref.quote)) errors.push(`bot ${beat.id}: the text must contain the quoted source wording "${ref.quote}" (${lang})`);
    }
  }
  if (errors.length) return { scene: null, errors };

  const lastEnd = beats.reduce((max, b) => Math.max(max, b.end), 0);
  const durationMs = Math.round(typeof raw.end === 'number' ? raw.end : lastEnd + (raw.tail ?? DEFAULT_TAIL_MS));
  for (const beat of beats) if (beat.do === 'music' && raw.beats[beat.index]['dur'] === undefined) beat.end = durationMs;
  // The closing card covers everything, so nothing else may still be playing under it.
  for (const outro of beats.filter((b) => b.do === 'outro')) {
    const under = beats.find((b) => b !== outro && !['music', 'sfx', 'camera'].includes(b.do) && b.end > outro.at && b.at < outro.at);
    if (under) errors.push(`outro ${outro.id} starts at ${outro.at} ms while ${under.do} ${under.id} plays until ${under.end} ms; time it with "after": "${under.id}"`);
  }
  if (beats.some((b) => b.at >= durationMs)) errors.push(`a beat starts after the video ends (${durationMs} ms); raise "end" or remove it`);
  const channel = raw.channel ?? {};
  const scene: DemoScene = {
    id: raw.id, lang, look: raw.look ?? 'studio', title: resolveText(raw.title ?? '', lang), seed, fps: raw.fps ?? 30, durationMs,
    posterMs: Math.min(durationMs - 1, Math.max(0, raw.poster ?? Math.round(durationMs * 0.45))),
    channel: {
      name: channel.name ?? 'lunatica_v',
      title: resolveText(channel.title ?? { en: 'Chill ranked grind, come hang out', es: 'Rankeds tranquilas, ven a pasar el rato' }, lang),
      game: resolveText(channel.game ?? 'Just Chatting', lang),
      viewers: channel.viewers ?? 128
    },
    bot: raw.bot ?? 'DomDimaBot',
    beats
  };
  return { scene: errors.length ? null : scene, errors };
}

/** Every language/format the scene asks for, each validated. */
export function validateScene(input: unknown, durations: DemoDurations = {}): string[] {
  const langs = isObject(input) && Array.isArray(input['langs']) ? (input['langs'] as DemoLang[]) : DEMO_LANGS;
  const errors = new Set<string>();
  for (const lang of langs) for (const error of normalizeScene(input, lang, durations).errors) errors.add(error);
  return [...errors];
}

/** Sounds to mix, from a resolved scene. TTS clip paths come from the recorder (`ttsSrc`). */
export interface DemoCaptionSpan { beat: DemoBeat; place: 'top' | 'bottom'; end: number }

/**
 * When each caption is on screen. A caption holds until something replaces it, so slow readers get the whole gap:
 * the next caption in its place (at the same ms, the one written later wins), a full-screen card that starts at or
 * after it, or the end of the video (end = Infinity). Its `dur` only times the beats placed after it.
 */
export function captionSpans(scene: DemoScene, format: DemoFormat): DemoCaptionSpan[] {
  const fallback = format === 'vertical' ? 'top' : 'bottom';
  const captions = scene.beats.filter((b) => b.do === 'caption').map((beat) => ({ beat, place: (beat.props['place'] as 'top' | 'bottom' | undefined) ?? fallback }));
  const cards = scene.beats.filter((b) => b.do === 'intro' || b.do === 'outro');
  return captions.map((c) => {
    const replacements = [
      ...captions.filter((o) => o.place === c.place && (o.beat.at > c.beat.at || (o.beat.at === c.beat.at && o.beat.index > c.beat.index))).map((o) => o.beat.at),
      ...cards.filter((card) => card.at >= c.beat.at).map((card) => card.at)
    ];
    return { ...c, end: replacements.length ? Math.min(...replacements) : Infinity };
  });
}

export function sceneCues(scene: DemoScene, ttsSrc: Record<string, string> = {}): DemoCue[] {
  const cues: DemoCue[] = [];
  for (const beat of scene.beats) {
    if (beat.sfx) cues.push({ kind: 'sfx', beat: beat.id, src: beat.sfx.src, at: beat.at + beat.sfx.delay, gain: beat.sfx.gain, fadeIn: beat.sfx.fadeIn, fadeOut: beat.sfx.fadeOut, end: null });
    if (beat.do === 'sfx') cues.push({ kind: 'sfx', beat: beat.id, src: String(beat.props['src']), at: beat.at, gain: typeof beat.props['gain'] === 'number' ? beat.props['gain'] : 1, fadeIn: 0, fadeOut: 0, end: null });
    if (beat.do === 'alert' && beat.props['sound']) {
      // Same rules as the overlay: starts after its delay, fades by the smaller of fade-in/fade-out, cut when the alert ends.
      const s = beat.props['sound'] as DemoSound;
      cues.push({ kind: 'alert', beat: beat.id, src: s.src, at: beat.at + s.delay, gain: s.gain, fadeIn: s.fadeIn, fadeOut: s.fadeOut, end: beat.end });
    }
    if (beat.do === 'tts' && ttsSrc[beat.id]) cues.push({ kind: 'tts', beat: beat.id, src: ttsSrc[beat.id], at: beat.at, gain: 1, fadeIn: 0, fadeOut: 0, end: beat.end });
    if (beat.do === 'music') cues.push({ kind: 'music', beat: beat.id, src: String(beat.props['src']), at: beat.at, gain: typeof beat.props['gain'] === 'number' ? beat.props['gain'] : 0.35, fadeIn: 0, fadeOut: typeof beat.props['fadeOut'] === 'number' ? beat.props['fadeOut'] : 1500, end: beat.end });
  }
  return cues.sort((a, b) => a.at - b.at);
}

/** JSON Schema for editors (`"$schema": "../scene.schema.json"`), generated from DEMO_ACTORS. */
export function sceneJsonSchema(): Record<string, unknown> {
  const text = { oneOf: [{ type: 'string' }, { type: 'object', required: ['en', 'es'], additionalProperties: false, properties: { en: { type: 'string' }, es: { type: 'string' } } }] };
  const sound = { oneOf: [{ type: 'string' }, { type: 'object', required: ['src'], additionalProperties: false, properties: { src: { type: 'string' }, gain: { type: 'number' }, delay: { type: 'number' }, fadeIn: { type: 'number' }, fadeOut: { type: 'number' } } }] };
  const field = (f: FieldSpec): Record<string, unknown> => {
    const d = { description: f.doc };
    switch (f.type) {
      case 'text': return { ...text, ...d };
      case 'sound': return { ...sound, ...d };
      case 'string': case 'id': return { type: 'string', ...d };
      case 'boolean': return { type: 'boolean', ...d };
      case 'number': return { type: 'number', ...(f.min !== undefined ? { minimum: f.min } : {}), ...(f.max !== undefined ? { maximum: f.max } : {}), ...d };
      case 'enum': return { enum: f.values, ...d };
      case 'strings': return { type: 'array', items: f.values ? { enum: f.values } : { type: 'string' }, ...d };
      case 'texts': return { type: 'array', items: text, ...(f.min !== undefined ? { minItems: f.min } : {}), ...(f.max !== undefined ? { maxItems: f.max } : {}), ...d };
      case 'refs': return { type: 'array', items: { type: 'object', required: ['file', 'quote'], additionalProperties: false, properties: { file: { type: 'string' }, quote: { type: 'string' }, inText: { type: 'boolean' }, lang: { enum: DEMO_LANGS } } }, ...d };
    }
  };
  const common = {
    id: field(COMMON_FIELDS['id']), after: field(COMMON_FIELDS['after']), with: field(COMMON_FIELDS['with']),
    dur: field(COMMON_FIELDS['dur']), sfx: field(COMMON_FIELDS['sfx']), $comment: { type: 'string' },
    at: { oneOf: [{ type: 'number', minimum: 0 }, { type: 'string', pattern: '^\\+\\d{1,6}$' }], description: COMMON_FIELDS['at'].doc }
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'DomDimaBot demo video scene',
    type: 'object', required: ['id', 'v', 'beats'], additionalProperties: false,
    properties: {
      $schema: { type: 'string' }, $comment: { type: 'string' },
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }, v: { const: DEMO_CONTRACT_VERSION },
      title: { ...text, description: 'Short feature name for labels (e.g. "Chat protection").' }, seed: { type: 'integer', minimum: 0 }, fps: { enum: [30, 60] },
      look: { enum: DEMO_LOOKS, description: 'Art direction: studio, site (the website\'s Live First design), paper (print), signal (kinetic type), broadcast (cinematic UI), night (black, one accent, technical labels).' },
      formats: { type: 'array', items: { enum: Object.keys(DEMO_FORMATS) } }, langs: { type: 'array', items: { enum: DEMO_LANGS } },
      channel: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, title: text, game: text, viewers: { type: 'number', minimum: 0 } } },
      bot: { type: 'string' }, end: { oneOf: [{ const: 'auto' }, { type: 'number', minimum: 500, maximum: 180000 }] },
      tail: { type: 'number', minimum: 0 }, poster: { type: 'number', minimum: 0, description: 'Time (ms) of the poster image.' },
      beats: { type: 'array', minItems: 1, items: { oneOf: DEMO_ACTOR_NAMES.map((name) => ({
        type: 'object', description: DEMO_ACTORS[name].doc, additionalProperties: false,
        required: ['do', ...Object.entries(DEMO_ACTORS[name].fields).filter(([, f]) => f.required).map(([k]) => k)],
        properties: { do: { const: name }, ...common, ...Object.fromEntries(Object.entries(DEMO_ACTORS[name].fields).map(([k, f]) => [k, field(f)])) }
      })) } }
    }
  };
}
