// A small sound-effect kit made from scratch with ffmpeg's tone/noise generators: no third-party audio,
// so no license question. Generated on demand into .cache/sfx (bit-exact, same bytes every time).
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CACHE, SOUNDS} from './paths.mjs';
import {FFMPEG, run} from './tools.mjs';

const tone = (expr, seconds) => ['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${seconds}`];
export const KIT = {
  /** Soft bubble for a chat message. */
  pop: tone('0.5*sin(2*PI*(480+820*exp(-t*36))*t)*exp(-t*26)', 0.18),
  /** Bright short bell for a bot reply. */
  ding: tone('0.3*(sin(2*PI*1568*t)+0.45*sin(2*PI*3136*t))*exp(-t*7)', 0.75),
  /** Three-note rising chime for alerts. */
  chime: tone('0.26*(sin(2*PI*1046.5*t)+0.75*sin(2*PI*1318.5*t)*gte(t,0.09)+0.65*sin(2*PI*1568*t)*gte(t,0.18))*exp(-t*2.4)', 1.5),
  /** Low hit for a ban or a knockout. */
  thud: tone('0.85*sin(2*PI*(52+78*exp(-t*16))*t)*exp(-t*8.5)', 0.5),
  /** Airy sweep for transitions. */
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=d=0.8:c=pink:a=0.45:seed=7:r=48000', '-af', "highpass=f=350,lowpass=f=5200,afade=t=in:d=0.35:curve=qsin,afade=t=out:st=0.35:d=0.45:curve=qsin"]
  // No "sparkle": its wobbling 0.8-3.6 kHz tone was harsh on the duel result (owner, 2026-11-08). Keep new kit
  // sounds soft and short, like pop and ding.
};

/** Path to a sound: "kit:<name>" (generated) or a file under marketing/video/sounds/ that LICENSES.md lists. */
export async function soundFile(src) {
  if (src.startsWith('kit:')) {
    const name = src.slice(4);
    if (!KIT[name]) throw new Error(`unknown kit sound "${src}" (have: ${Object.keys(KIT).map(k => 'kit:' + k).join(', ')})`);
    const dir = resolve(CACHE, 'sfx'), file = resolve(dir, `${name}.wav`);
    if (!existsSync(file)) {
      mkdirSync(dir, {recursive: true});
      await run(FFMPEG, ['-y', '-loglevel', 'error', ...KIT[name], '-ac', '2', '-ar', '48000', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-c:a', 'pcm_s16le', file]);
    }
    return file;
  }
  return soundPath(src);
}

/** A file sound must exist under sounds/ and appear in sounds/LICENSES.md (where it came from, its license). */
export function soundPath(src) {
  const file = resolve(SOUNDS, src.replace(/^sounds\//, ''));
  if (!file.startsWith(SOUNDS + '/')) throw new Error(`sound "${src}" must be inside marketing/video/sounds/`);
  if (!existsSync(file)) throw new Error(`sound "${src}" not found in marketing/video/sounds/`);
  const licenses = existsSync(resolve(SOUNDS, 'LICENSES.md')) ? readFileSync(resolve(SOUNDS, 'LICENSES.md'), 'utf8') : '';
  const name = file.slice(SOUNDS.length + 1);
  if (!name.startsWith('tts/') && !licenses.includes(name)) throw new Error(`sound "${name}" is not listed in marketing/video/sounds/LICENSES.md (add its source and license first)`);
  return file;
}
