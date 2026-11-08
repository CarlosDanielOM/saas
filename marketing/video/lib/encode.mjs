// MP4 output: PNG frames piped into x264, sound mixed from cues, poster and contact sheet.
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FFMPEG, audioMs, run, track} from './tools.mjs';

/** RGB → BT.709 limited range with matching tags, so colors don't shift on Twitter/TikTok players. */
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

export function startEncoder({file, fps}) {
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '17', '-g', String(fps * 2), '-keyint_min', String(fps * 2),
    '-sc_threshold', '0', '-r', String(fps), ...COLOR, '-threads', '4', '-movflags', '+faststart', file];
  const proc = track(spawn(FFMPEG, args, {stdio: ['pipe', 'ignore', 'pipe']}));
  let stderr = '', failure = null;
  proc.stderr.on('data', d => { stderr += d; });
  proc.stdin.on('error', error => { failure = error; });
  const done = new Promise((resolvePromise, reject) => proc.on('close', code => (code === 0 ? resolvePromise() : reject(new Error(`video encoder exited ${code}: ${stderr.slice(-1500)}`)))));
  done.catch(() => {});
  return {
    /** Waits when ffmpeg is behind, so frames never pile up in memory. */
    write(png) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolvePromise, reject) => {
        const ok = proc.stdin.write(png, error => (error ? reject(error) : null));
        if (ok) resolvePromise(); else proc.stdin.once('drain', resolvePromise);
      });
    },
    async end() { proc.stdin.end(); await done; },
    kill() { proc.kill('SIGKILL'); }
  };
}

/**
 * Mix cues into the video's soundtrack in one ffmpeg pass; returns how many cues it mixed (0 = nothing to add). Each cue: starts at `at` ms, plays from `skip` ms into the
 * clip (default 0), is cut at `end` (the alert's end), and fades like the overlay does:
 * gain × min(1, position/fadeIn, remaining/fadeOut). Cues are summed (no level normalization), limited, then
 * padded/trimmed to the video length.
 */
export async function muxAudio({video, cues, durationMs, out}) {
  const inputs = [], chains = [];
  for (const cue of cues) {
    const clip = (await audioMs(cue.file)) / 1000, skip = (cue.skip ?? 0) / 1000;
    // In clip time: the sound ends at the clip's end or the alert deadline (that is where it fades out);
    // the video may end earlier (a partial render), which only cuts it.
    const soundEnd = Math.min(clip, cue.end !== null && cue.end !== undefined ? (cue.end - cue.at) / 1000 + skip : clip);
    const cutEnd = Math.min(soundEnd, (durationMs - cue.at) / 1000 + skip);
    if (cutEnd - skip <= 0.001) continue;
    const fi = cue.fadeIn / 1000, fo = cue.fadeOut / 1000, p = skip > 0 ? `(t+${skip.toFixed(4)})` : 't';
    // Gain is evaluated every 240 samples (5 ms), so fades are smooth and click-free.
    const expr = `max(0,${cue.gain}*min(1,min(${fi > 0 ? `${p}/${fi}` : '1'},${fo > 0 ? `(${soundEnd.toFixed(4)}-${p})/${fo}` : '1'})))`;
    const index = inputs.length / 2 + 1;
    inputs.push('-i', cue.file);
    chains.push(`[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${skip.toFixed(4)}:end=${cutEnd.toFixed(4)},asetpts=PTS-STARTPTS,asetnsamples=n=240:p=0,volume='${expr}':eval=frame,adelay=${Math.max(0, Math.round(cue.at))}:all=1[c${chains.length}]`);
  }
  if (!chains.length) return 0;
  const seconds = (durationMs / 1000).toFixed(3);
  const graph = `${chains.join(';')};${chains.map((_, i) => `[c${i}]`).join('')}amix=inputs=${chains.length}:normalize=0:duration=longest:dropout_transition=0,alimiter=limit=0.95:level=disabled,apad=whole_dur=${seconds},atrim=0:${seconds}[aout]`;
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', video, ...inputs, '-filter_complex', graph, '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', seconds, '-movflags', '+faststart', out], {timeoutMs: 300000});
  return chains.length;
}

export async function writeJpeg(png, file) {
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'png_pipe', '-i', '-', '-q:v', '2', file], {input: png});
}

/** A grid of evenly spaced frames, for reviewing a whole video at a glance. */
export async function writeSheet(frames, file, columns = 4) {
  const dir = mkdtempSync(resolve(file, '..', '.sheet-'));
  try {
    frames.forEach((png, i) => writeFileSync(resolve(dir, `${String(i).padStart(3, '0')}.png`), png));
    const rows = Math.ceil(frames.length / columns);
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', resolve(dir, '%03d.png'),
      '-vf', `scale=iw/3:-1:flags=lanczos,pad=iw+8:ih+8:4:4:color=0x0d0b14,tile=${columns}x${rows}`, '-frames:v', '1', file]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
