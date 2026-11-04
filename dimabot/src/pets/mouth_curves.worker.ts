import { parentPort, workerData } from 'node:worker_threads';

// Source tests use Node's native type stripping; production resolves compiled JS.
const { computeMouthCurvesFromSamples } = await import(new URL(import.meta.url.endsWith('.ts') ? './mouth_curves.ts' : './mouth_curves.js', import.meta.url).href);
try {
    const { pcm, sampleRate, channels } = workerData as { pcm: ArrayBuffer; sampleRate: number; channels: number };
    const bytes = Buffer.from(pcm);
    const curves = computeMouthCurvesFromSamples(bytes.length / (4 * channels), channels, sampleRate,
        (frame: number, channel: number) => bytes.readFloatLE((frame * channels + channel) * 4));
    parentPort!.postMessage({ ok: true, curves });
} catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message.slice(0, 80) : 'mouth_analysis_failed' });
} finally { parentPort!.close(); }
