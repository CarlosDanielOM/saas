/** dima-mouth-v1. Compute once per decoded clip; playback only indexes these bins. */
export const MAX_MOUTH_BINS = 1800;
export const MAX_MOUTH_DURATION_MS = 60_000;
export interface MouthCurves { sampleRate: number; binFrames: number; open: number[]; smile: number[] }

function percentile(sorted: readonly number[], p: number): number {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;
}
function bandpass(sampleRate: number, lo: number, hi: number) {
    const f0 = Math.sqrt(lo * hi), q = f0 / (hi - lo), w0 = 2 * Math.PI * f0 / sampleRate;
    const alpha = Math.sin(w0) / (2 * q), b0 = alpha / (1 + alpha), b2 = -alpha / (1 + alpha);
    const a1 = -2 * Math.cos(w0) / (1 + alpha), a2 = (1 - alpha) / (1 + alpha);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x: number) => {
        const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    };
}

/** Callback input permits interleaved decoder buffers without copying PCM. */
export function computeMouthCurvesFromSamples(frameCount: number, channelCount: number, sampleRate: number,
    sample: (frame: number, channel: number) => number): MouthCurves {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
        !Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > sampleRate * MAX_MOUTH_DURATION_MS / 1000 ||
        !Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > 32) throw new Error('invalid_pcm');
    const binFrames = Math.ceil(sampleRate / 30), bins = Math.ceil(frameCount / binFrames);
    if (bins > MAX_MOUTH_BINS) throw new Error('invalid_pcm');
    const lowFilter = bandpass(sampleRate, 250, 700), midFilter = bandpass(sampleRate, 700, 1300), highFilter = bandpass(sampleRate, 2000, 3500);
    const db: number[] = [], low: number[] = [], mid: number[] = [], high: number[] = [];
    for (let start = 0; start < frameCount; start += binFrames) {
        const count = Math.min(binFrames, frameCount - start);
        let energy = 0, lowEnergy = 0, midEnergy = 0, highEnergy = 0;
        for (let frame = start; frame < start + count; frame++) {
            let mono = 0;
            for (let channel = 0; channel < channelCount; channel++) {
                const value = sample(frame, channel);
                if (!Number.isFinite(value)) throw new Error('invalid_pcm');
                mono += value;
                // Loudness uses all channel samples; opposite-phase stereo stays audible.
                energy += value * value;
            }
            mono /= channelCount;
            const l = lowFilter(mono), m = midFilter(mono), h = highFilter(mono);
            lowEnergy += l * l; midEnergy += m * m; highEnergy += h * h;
        }
        db.push(20 * Math.log10(Math.sqrt(energy / (count * channelCount)) + 1e-9));
        low.push(lowEnergy / count); mid.push(midEnergy / count); high.push(highEnergy / count);
    }
    const ref = percentile(db.filter(value => value > -60).sort((a, b) => a - b), .95);
    const open = db.map(value => value < ref - 18 ? 0 : Math.min(1, (value - ref + 18) / 18) ** 2);
    const ratios = high.map((value, i) => 10 * Math.log10((value + 1e-12) / (mid[i] + 1e-12)));
    const voiced = db.map((value, i) => value > ref - 25 && low[i] + mid[i] > .05 * high[i]);
    const sorted = ratios.filter((_value, i) => voiced[i]).sort((a, b) => a - b);
    const center = percentile(sorted, .5), spread = Math.max(3, percentile(sorted, .9) - percentile(sorted, .1));
    let current = .5, quiet = 0;
    const smile = ratios.map((ratio, i) => {
        if (voiced[i]) { quiet = 0; current += (Math.max(0, Math.min(1, .5 + (ratio - center) / spread)) - current) * .5654; }
        else if (++quiet > 6) current += (.5 - current) * .1248;
        return current;
    });
    return { sampleRate, binFrames, open, smile };
}

export function computeMouthCurves(channels: readonly ArrayLike<number>[], sampleRate: number): MouthCurves {
    const frameCount = channels[0]?.length ?? 0;
    if (channels.some(channel => channel.length !== frameCount)) throw new Error('invalid_pcm');
    return computeMouthCurvesFromSamples(frameCount, channels.length, sampleRate, (frame, channel) => channels[channel][frame]);
}

export function sampleMouthCurves(curves: MouthCurves, positionMs: number): { value: number; smile: number } {
    if (!Number.isFinite(positionMs) || positionMs < 0) return { value: 0, smile: .5 };
    const index = Math.floor(positionMs * curves.sampleRate / (1000 * curves.binFrames));
    return { value: curves.open[index] ?? 0, smile: curves.smile[index] ?? .5 };
}
