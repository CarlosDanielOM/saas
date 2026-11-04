import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { computeMouthCurvesFromSamples, sampleMouthCurves, type MouthCurves } from './mouth_curves.js';
import { mouthAnalysisQueue, mouthCurvesInWorker, MAX_MOUTH_PCM_BYTES } from './mouth_analysis.js';
export const ENVELOPE_STEP_MS = 40;
export const MAX_ENVELOPE_VALUES = 1500;
const MAX_DECODED_BYTES = MAX_MOUTH_PCM_BYTES;
export interface FollowEnvelope { stepMs: number; values: number[]; smile?: number[] }
export interface TtsEnvelopes { native: FollowEnvelope; readonly legacy: FollowEnvelope }
const rounded = (value: number) => Math.round(value * 10_000) / 10_000;

/** Native timing is capability-gated; old peers retain their exact 40ms shape. */
export function mouthEnvelopes(curves: MouthCurves, durationMs: number): TtsEnvelopes {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) throw new Error('audio_duration');
    const native = { stepMs: 1000 * curves.binFrames / curves.sampleRate, values: curves.open.map(rounded), smile: curves.smile.map(rounded) };
    let legacy: FollowEnvelope | undefined;
    return { native, get legacy() {
        // Derive at most once, and only if a legacy controller or PNG renderer needs it.
        return legacy ??= { stepMs: ENVELOPE_STEP_MS, values: Array.from({ length: Math.ceil(durationMs / ENVELOPE_STEP_MS) }, (_value, i) => rounded(sampleMouthCurves(curves, i * ENVELOPE_STEP_MS).value)) };
    } };
}

/** Native-rate interleaved f32le PCM, retaining all channels for loudness. */
export function pcmMouthCurves(pcm: Buffer, sampleRate: number, channels: number): MouthCurves {
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 32 || !pcm.length || pcm.length % (4 * channels) || pcm.length > MAX_DECODED_BYTES) throw new Error('invalid_pcm');
    return computeMouthCurvesFromSamples(pcm.length / (4 * channels), channels, sampleRate,
        (frame, channel) => pcm.readFloatLE((frame * channels + channel) * 4));
}

/** Decode once at the original rate; no resampling or per-frame FFT. */
async function decodeTtsAudio(file: string, signal?: AbortSignal) {
    const { sampleRate, channels } = await probeTtsAudio(file, signal);
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
        !Number.isSafeInteger(channels) || channels < 1 || channels > 32) throw new Error('invalid_pcm');
    const { stdout } = await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-map', '0:a:0', '-vn', '-t', '60', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', timeout: 5000, maxBuffer: Math.min(MAX_DECODED_BYTES, sampleRate * channels * 60 * 4) + 4096, signal });
    return { pcm: stdout, sampleRate, channels };
}
export async function ttsMouthCurves(file: string, signal?: AbortSignal): Promise<MouthCurves> {
    return (await analyzeTtsAudio(file, signal)).curves;
}
function analyzeTtsAudio(file: string, signal?: AbortSignal) {
    return mouthAnalysisQueue.run(async () => {
        const { pcm, sampleRate, channels } = await decodeTtsAudio(file, signal);
        const durationMs = pcm.length / (4 * channels * sampleRate) * 1000;
        const curves = await mouthCurvesInWorker(pcm, sampleRate, channels, { signal });
        return { curves, durationMs };
    }, signal);
}
async function probeTtsAudio(file: string, signal?: AbortSignal) {
    if ((await stat(file)).size > 8_000_000) throw new Error('audio_too_large');
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'a:0', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', file], { timeout: 5000, maxBuffer: 4096, signal });
    const metadata = JSON.parse(stdout);
    const durationMs = Math.ceil(Number(metadata.format?.duration) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) throw new Error('audio_duration');
    return { durationMs, sampleRate: Number(metadata.streams?.[0]?.sample_rate), channels: Number(metadata.streams?.[0]?.channels) };
}
export async function inspectTtsAudio(file: string) { return (await probeTtsAudio(file)).durationMs; }
export async function ttsEnvelope(file: string, signal?: AbortSignal): Promise<TtsEnvelopes> {
    const { curves, durationMs } = await analyzeTtsAudio(file, signal);
    return mouthEnvelopes(curves, durationMs);
}
