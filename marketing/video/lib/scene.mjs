// Load a scene script and check it fully: the shared rules (same code the player runs) plus what only the
// recorder can check, i.e. that quoted bot wording really exists in the source and that sounds exist.
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {REPO, SCENES} from './paths.mjs';
import {KIT, soundPath} from './sfx.mjs';
import {DEMO_LANGS, normalizeScene, refsOf, validateScene} from '../../../dimasite/src/app/features/demo-video/demo-scene.ts';

export function findScene(arg) {
  if (!arg) throw new Error('name a scene, e.g. `npm run demo -- first-message-mod`');
  const candidates = [resolve(arg), resolve(SCENES, arg), resolve(SCENES, `${arg}.json`)];
  const file = candidates.find(f => existsSync(f) && f.endsWith('.json'));
  if (!file) throw new Error(`scene "${arg}" not found (looked in marketing/video/scenes/)`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new Error(`${file} is not valid JSON: ${error.message}`); }
  return {file, raw};
}

/** Duels get their real length in the browser; here a safe upper bound is enough for checking. */
const ESTIMATE = {duel: () => 20000};

export function checkScene(raw) {
  const errors = validateScene(raw, ESTIMATE);
  if (errors.length) return errors;
  const beats = Array.isArray(raw.beats) ? raw.beats : [];
  beats.forEach((beat, i) => {
    const label = `beat ${i + 1} (${beat.do}${beat.id ? ' ' + beat.id : ''})`;
    for (const ref of refsOf(beat)) {
      const file = resolve(REPO, ref.file);
      if (!file.startsWith(REPO + '/') || !existsSync(file)) errors.push(`${label}: source file ${ref.file} not found`);
      else if (!readFileSync(file, 'utf8').includes(ref.quote)) errors.push(`${label}: "${ref.quote}" no longer appears in ${ref.file}; update the scene to what the product says now`);
    }
    const sounds = [beat.sfx, beat.sound, beat.do === 'sfx' || beat.do === 'music' ? beat.src : undefined]
      .map(s => (typeof s === 'string' ? s : s?.src)).filter(Boolean);
    for (const src of sounds) {
      try { if (src.startsWith('kit:')) { if (!KIT[src.slice(4)]) throw new Error(`unknown kit sound "${src}"`); } else soundPath(src); }
      catch (error) { errors.push(`${label}: ${error.message}`); }
    }
    if ((beat.do === 'tts' || beat.do === 'voice') && beat.clip !== undefined) {
      for (const lang of DEMO_LANGS) {
        const clip = typeof beat.clip === 'string' ? beat.clip : beat.clip?.[lang];
        try { soundPath(clip); } catch (error) { errors.push(`${label}: clip (${lang}): ${error.message}`); }
      }
    }
  });
  return errors;
}

export const scenesFor = (raw, lang, durations) => normalizeScene(raw, lang, {...ESTIMATE, ...durations});
