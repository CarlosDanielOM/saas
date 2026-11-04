import { Worker, isMarkedAsUntransferable } from 'node:worker_threads';
import type { MouthCurves } from './mouth_curves.js';

export const MAX_MOUTH_ANALYSES = 2;
export const MAX_QUEUED_MOUTH_ANALYSES = 8;
export const MAX_MOUTH_PCM_BYTES = 64 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 5000, QUEUE_TIMEOUT_MS = 20_000;
interface Job {
    work: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void;
    timer?: NodeJS.Timeout;
    signal?: AbortSignal; onAbort?: () => void;
}

/** Bound decoding as well as filtering. Waiting jobs retain only their file path. */
export class MouthAnalysisQueue {
    private active = 0;
    private readonly waiting: Job[] = [];
    constructor(private readonly queueTimeoutMs = QUEUE_TIMEOUT_MS) {}
    get status() { return { active: this.active, queued: this.waiting.length }; }
    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) { reject(new Error('mouth_analysis_cancelled')); return; }
            const job: Job = { work, resolve: value => resolve(value as T), reject, signal };
            if (this.active < MAX_MOUTH_ANALYSES) { this.start(job); return; }
            if (this.waiting.length >= MAX_QUEUED_MOUTH_ANALYSES) { reject(new Error('mouth_analysis_busy')); return; }
            this.waiting.push(job);
            job.timer = setTimeout(() => {
                const index = this.waiting.indexOf(job);
                if (index < 0) return;
                this.waiting.splice(index, 1); this.unlisten(job); reject(new Error('mouth_analysis_queue_timeout'));
            }, this.queueTimeoutMs);
            if (signal) {
                job.onAbort = () => {
                    const index = this.waiting.indexOf(job);
                    if (index < 0) return;
                    this.waiting.splice(index, 1); clearTimeout(job.timer); this.unlisten(job); reject(new Error('mouth_analysis_cancelled'));
                };
                signal.addEventListener('abort', job.onAbort, { once: true });
            }
        });
    }
    private unlisten(job: Job) { if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort); }
    private start(job: Job) {
        clearTimeout(job.timer); this.unlisten(job); this.active++;
        void (async () => {
            try { job.resolve(await job.work()); } catch (error) { job.reject(error); }
            finally {
                this.active--;
                const next = this.waiting.shift();
                if (next) this.start(next);
            }
        })();
    }
}
export const mouthAnalysisQueue = new MouthAnalysisQueue();

/** One short-lived worker per active clip. Never runs auth, database or provider code. */
export async function mouthCurvesInWorker(pcm: Buffer, sampleRate: number, channels: number,
    options: { workerUrl?: URL; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MouthCurves> {
    if (options.signal?.aborted) throw new Error('mouth_analysis_cancelled');
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 32 || !pcm.length || pcm.length % (4 * channels) || pcm.length > MAX_MOUTH_PCM_BYTES ||
        !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || pcm.length / (4 * channels) > sampleRate * 60) throw new Error('invalid_pcm');
    // execFile normally owns its complete ArrayBuffer. Small pooled/sliced Buffers
    // need one bounded copy because Node marks their shared backing store untransferable.
    const buffer = pcm.buffer instanceof ArrayBuffer && pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength && !isMarkedAsUntransferable(pcm.buffer)
        ? pcm.buffer : Uint8Array.from(pcm).buffer;
    const workerUrl = options.workerUrl ?? new URL(import.meta.url.endsWith('.ts') ? './mouth_curves.worker.ts' : './mouth_curves.worker.js', import.meta.url);
    const worker = new Worker(workerUrl, { workerData: { pcm: buffer, sampleRate, channels }, transferList: [buffer],
        env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
        return await new Promise<MouthCurves>((resolve, reject) => {
            worker.once('message', (message: { ok: boolean; curves?: MouthCurves; error?: string }) => {
                if (message?.ok && message.curves) resolve(message.curves);
                else reject(new Error(typeof message?.error === 'string' ? message.error.slice(0, 80) : 'mouth_analysis_failed'));
            });
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`mouth_analysis_exit_${code}`)));
            timer = setTimeout(() => reject(new Error('mouth_analysis_timeout')), options.timeoutMs ?? WORKER_TIMEOUT_MS);
            if (options.signal) {
                onAbort = () => reject(new Error('mouth_analysis_cancelled'));
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    } finally {
        clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener('abort', onAbort);
        // A released queue slot must never overlap its retired worker.
        await worker.terminate(); worker.removeAllListeners();
    }
}
