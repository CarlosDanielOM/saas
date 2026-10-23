import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
export const ENVELOPE_STEP_MS = 40;
export const MAX_ENVELOPE_VALUES = 1500;
const RATE = 8000, WINDOW = RATE * ENVELOPE_STEP_MS / 1000;
export function rmsEnvelope(pcm: Buffer) {
    if (!pcm.length || pcm.length % 4 || pcm.length > RATE * 60 * 4) throw new Error('invalid_pcm');
    const values: number[] = [];
    for (let start = 0; start < pcm.length / 4; start += WINDOW) {
        let sum = 0;
        const count = Math.min(WINDOW, pcm.length / 4 - start);
        for (let index = 0; index < count; index++) {
            const sample = pcm.readFloatLE((start + index) * 4);
            if (!Number.isFinite(sample)) throw new Error('invalid_pcm');
            sum += sample * sample;
        }
        values.push(Math.min(1, Math.sqrt(sum / count) * 4));
    }
    return { stepMs: ENVELOPE_STEP_MS, values };
}
export async function inspectTtsAudio(file: string) {
    if ((await stat(file)).size > 8_000_000) throw new Error('audio_too_large');
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration', '-of', 'json', file], { timeout: 5000, maxBuffer: 4096 });
    const durationMs = Math.ceil(Number(JSON.parse(stdout).format?.duration) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) throw new Error('audio_duration');
    return durationMs;
}
export async function ttsEnvelope(file: string) {
    await inspectTtsAudio(file);
    const { stdout } = await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-t', '60', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', timeout: 5000, maxBuffer: RATE * 60 * 4 + 4096 });
    return rmsEnvelope(stdout);
}
