// ffmpeg/ffprobe from npm (the host has no system ffmpeg; Playwright's own build only writes WebM).
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

const require = createRequire(import.meta.url);

/** Every running ffmpeg/ffprobe, so cancelling a render can stop them before the lock is released. */
const children = new Map();
export function track(proc) {
  // Wait for the process to exit, not for 'close': a killed encoder's stdin pipe never closes on its own.
  const exited = new Promise(resolve => { proc.once('exit', resolve); proc.once('error', resolve); });
  proc.once('exit', () => proc.stdin?.destroy());
  children.set(proc, exited);
  exited.then(() => children.delete(proc));
  return proc;
}
export async function stopChildren() {
  const waiting = [...children.entries()].map(([proc, closed]) => { proc.kill('SIGKILL'); return closed; });
  await Promise.all(waiting);
}
export const FFMPEG = require('ffmpeg-static');
export const FFPROBE = require('ffprobe-static').path;
export const chromium = () => require('playwright').chromium;
export const playwrightVersion = () => require('playwright/package.json').version;

/** Run a tool, collect stdout (Buffer) and stderr; reject on a non-zero exit. */
export function run(bin, args, {input, timeoutMs = 120000} = {}) {
  return new Promise((resolvePromise, reject) => {
    const proc = track(spawn(bin, args, {stdio: ['pipe', 'pipe', 'pipe']}));
    const out = [], err = [];
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${bin} timed out`)); }, timeoutMs);
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString();
      if (code === 0) resolvePromise({stdout: Buffer.concat(out), stderr});
      else reject(new Error(`${bin.split('/').pop()} exited ${code}: ${stderr.slice(-1500)}`));
    });
    if (input) proc.stdin.end(input); else proc.stdin.end();
  });
}

export async function probe(file) {
  const {stdout} = await run(FFPROBE, ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames,color_space,color_primaries,color_transfer,color_range,sample_rate,channels:format=duration',
    '-of', 'json', file]);
  return JSON.parse(stdout.toString());
}

/** Length of an audio file in ms. */
export async function audioMs(file) {
  const info = await probe(file);
  const seconds = Number(info.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`can't read the length of ${file}`);
  return Math.round(seconds * 1000);
}
