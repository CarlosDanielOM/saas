// TTS clips for `tts` beats (a viewer message read on stream) and `voice` beats (voice-over). Engines:
//   clip  - the beat names an audio file (e.g. made on the fish.audio site) under marketing/video/sounds/
//   fish  - Fish Audio, the same request the product makes (POST /v1/tts with a `model` header and the voice's
//           reference_id; s2.1 models get the product's tag reinforcement). Never falls back to another model.
//   openrouter - OpenRouter's speech API (e.g. fish-audio/drama-3, which takes Fish voice ids and free-form
//           [bracket] directions), with the product's DomDimaBot app-attribution headers. Always paid.
// Clips are cached by engine + model + voice + text in sounds/tts/ (kept in git so a paid line is paid once).
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {TTS_CLIPS, VOICES} from './paths.mjs';
import {soundPath} from './sfx.mjs';
import {audioMs} from './tools.mjs';
import {resolveText} from '../../../dimasite/src/app/features/demo-video/demo-scene.ts';
import {reinforceFishTtsTags} from '../../../dimabot/src/utils/tts/expressive_tts_tags.util.ts';
import {OPENROUTER_APP_HEADERS} from '../../../dimabot/src/utils/ai/openrouter/app_attribution.util.ts';

const FISH_DEFAULT_BASE = 'https://api.fish.audio';
const FISH_FORMAT = 'mp3';
const OPENROUTER_DEFAULT_BASE = 'https://openrouter.ai/api/v1';

export function loadVoices(file = VOICES) {
  if (!existsSync(file)) return {defaults: {}, voices: {}};
  const voices = JSON.parse(readFileSync(file, 'utf8'));
  for (const [name, voice] of Object.entries(voices.voices ?? {})) {
    if (voice.engine === 'fish') {
      if (!/^[0-9a-f]{32}$/.test(voice.reference_id ?? '')) throw new Error(`voices.json: "${name}" needs the Fish voice id (32 hex characters) in "reference_id"`);
      if (!voice.model) throw new Error(`voices.json: "${name}" needs a "model" (e.g. s2.1-pro-free)`);
    } else if (voice.engine === 'openrouter') {
      if (!/^[\w.-]+\/[\w.:-]+$/.test(voice.model ?? '')) throw new Error(`voices.json: "${name}" needs an OpenRouter "model" (e.g. fish-audio/drama-3)`);
      if (typeof voice.voice !== 'string' || !voice.voice.trim()) throw new Error(`voices.json: "${name}" needs the provider's voice id in "voice"`);
    } else throw new Error(`voices.json: "${name}" has unknown engine "${voice.engine}" (fish or openrouter)`);
    if (!voice.license || !voice.source) throw new Error(`voices.json: "${name}" needs "license" and "source" (who owns the voice, can we use it in ads)`);
  }
  return {defaults: voices.defaults ?? {}, voices: voices.voices ?? {}};
}

/** Fish models that cost nothing, and until when. Any other model needs --allow-paid-tts. */
export const FREE_FISH_MODELS = {'s2.1-pro-free': '2026-11-30'};

/** Free only for a known free model inside its free period (a voice's own freeUntil can only shorten it). */
export function isFree(voice, today = new Date()) {
  if (voice.engine === 'openrouter') return false;
  const until = FREE_FISH_MODELS[voice.model];
  if (!until) return false;
  const day = today.toISOString().slice(0, 10);
  return day <= until && (!voice.freeUntil || day <= voice.freeUntil);
}

export function fishCacheKey(voice, text) {
  const spoken = voice.model.startsWith('s2.1-') ? reinforceFishTtsTags(text) : text;
  const key = createHash('sha256').update(JSON.stringify({engine: 'fish', backend: 'fish-api', model: voice.model, voice: voice.reference_id, format: FISH_FORMAT, text: spoken, v: 1})).digest('hex').slice(0, 24);
  return {key, spoken};
}

/** Cache key and the exact text sent, for any engine. */
export function cacheKey(voice, text) {
  if (voice.engine !== 'openrouter') return fishCacheKey(voice, text);
  const key = createHash('sha256').update(JSON.stringify({engine: 'openrouter', model: voice.model, voice: voice.voice, format: FISH_FORMAT, text, v: 1})).digest('hex').slice(0, 24);
  return {key, spoken: text};
}

async function openrouterSynthesize(voice, spoken, {fetchImpl = fetch, env = process.env} = {}) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OpenRouter TTS needs an API key: export OPENROUTER_API_KEY=... before rendering (never saved to disk)');
  const base = (env.OPENROUTER_API_BASE || OPENROUTER_DEFAULT_BASE).replace(/\/$/, '');
  const response = await fetchImpl(`${base}/audio/speech`, {
    method: 'POST',
    headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...OPENROUTER_APP_HEADERS},
    body: JSON.stringify({model: voice.model, input: spoken, voice: voice.voice, response_format: FISH_FORMAT}),
    signal: AbortSignal.timeout(90000)
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`OpenRouter TTS failed (${response.status}): ${body.toString('utf8').slice(0, 300)}`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('audio/mpeg')) {
    throw new Error(`OpenRouter TTS returned "${response.headers.get('content-type')}" instead of MP3: ${body.toString('utf8').slice(0, 200)}`);
  }
  return body;
}

async function fishSynthesize(voice, spoken, {fetchImpl = fetch, env = process.env} = {}) {
  const apiKey = env.FISH_AUDIO_API_KEY || env.FISH_API_KEY;
  if (!apiKey) throw new Error('Fish TTS needs an API key: export FISH_AUDIO_API_KEY=... before rendering (never saved to disk)');
  const base = (env.FISH_API_BASE || FISH_DEFAULT_BASE).replace(/\/$/, '');
  const response = await fetchImpl(`${base}/v1/tts`, {
    method: 'POST',
    headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', model: voice.model},
    body: JSON.stringify({text: spoken, reference_id: voice.reference_id, format: FISH_FORMAT}),
    signal: AbortSignal.timeout(90000)
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`Fish TTS failed (${response.status}): ${body.toString('utf8').slice(0, 300)}`);
  const type = response.headers.get('content-type') ?? '';
  if (!/audio\/(mpeg|mp3)/.test(type) && !(body[0] === 0x49 && body[1] === 0x44 && body[2] === 0x33) && !(body[0] === 0xff && (body[1] & 0xe0) === 0xe0)) {
    throw new Error(`Fish TTS returned "${type}" instead of MP3: ${body.toString('utf8').slice(0, 200)}`);
  }
  return body;
}

/**
 * Clips for every tts beat in one language.
 * Returns { media: { [beatId]: { src, durationMs, file } }, notes: string[] }.
 */
export async function prepareTts(raw, lang, {allowPaid = false, voices = loadVoices(), fetchImpl, env, clipsDir = TTS_CLIPS, today} = {}) {
  const media = {}, notes = [];
  const beats = (raw.beats ?? []).map((beat, index) => ({beat, id: typeof beat.id === 'string' ? beat.id : `#${index + 1}`})).filter(({beat}) => beat.do === 'tts' || beat.do === 'voice');
  for (const {beat, id} of beats) {
    const text = resolveText(beat.text, lang);
    if (beat.clip !== undefined) {
      const clip = resolveText(beat.clip, lang);
      const file = soundPath(clip);
      media[id] = {src: `/__demo/media/${clip.replace(/^sounds\//, '')}`, durationMs: await audioMs(file), file};
      continue;
    }
    const name = beat.voice ?? voices.defaults[lang];
    if (!name) { notes.push(`${beat.do} ${id} (${lang}): no voice chosen yet, so it ${beat.do === 'tts' ? 'shows the text card' : 'stays silent'}`); continue; }
    const voice = voices.voices[name];
    if (!voice) throw new Error(`${beat.do} ${id}: voice "${name}" is not in voices.json`);
    const {key, spoken} = cacheKey(voice, text);
    const file = resolve(clipsDir, `${key}.mp3`);
    if (!existsSync(file)) {
      if (!isFree(voice, today) && !allowPaid) {
        const until = FREE_FISH_MODELS[voice.model];
        throw new Error(`tts ${id}: model ${voice.model} costs money${until ? ` (its free period ended ${until})` : ''}; add --allow-paid-tts to synthesize`);
      }
      const audio = await (voice.engine === 'openrouter' ? openrouterSynthesize : fishSynthesize)(voice, spoken, {fetchImpl, env});
      mkdirSync(clipsDir, {recursive: true});
      writeFileSync(file, audio);
      const indexFile = resolve(clipsDir, 'index.json');
      const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
      index[key] = {voice: name, engine: voice.engine, model: voice.model, reference_id: voice.reference_id ?? voice.voice, lang, text: spoken, created: new Date().toISOString()};
      writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
      notes.push(`${beat.do} ${id} (${lang}): synthesized with ${name} (${voice.model})`);
    }
    media[id] = {src: `/__demo/media/tts/${key}.mp3`, durationMs: await audioMs(file), file};
  }
  return {media, notes};
}
