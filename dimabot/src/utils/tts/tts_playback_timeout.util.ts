import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const mp3Duration = createRequire(import.meta.url)('mp3-duration') as (filePath: string) => Promise<number>;
const DEFAULT_TIMEOUT_MS = 60_000;

async function wavDurationSeconds(filePath: string): Promise<number> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(44);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < 44 || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WAVE'
      || header.toString('ascii', 36, 40) !== 'data') {
      return 0;
    }
    const bytesPerSecond = header.readUInt32LE(28);
    return bytesPerSecond > 0 ? header.readUInt32LE(40) / bytesPerSecond : 0;
  } finally {
    await file.close();
  }
}

export async function getTtsPlaybackTimeoutMs(filePath: string): Promise<number> {
  try {
    const extension = path.extname(filePath).toLowerCase();
    const duration = extension === '.mp3'
      ? await mp3Duration(filePath)
      : extension === '.wav'
        ? await wavDurationSeconds(filePath)
        : 0;
    if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_TIMEOUT_MS;
    // The overlay normally acknowledges playback. This is a recovery window
    // for missing acknowledgements, with time for the browser to fetch audio.
    return Math.max(60_000, Math.ceil(duration * 1000) + 30_000);
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}
