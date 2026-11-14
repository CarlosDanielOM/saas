import type { TtsOutputsSummary } from '../../handlers/tts_outputs.js';

export interface TtsStatusData {
    connected: boolean;
    playing: boolean;
    preparing: boolean;
    queueLength: number;
    /** Open speech pages and what is wrong with them (absent from older API versions). */
    outputs?: TtsOutputsSummary;
}

export function isTtsStatusData(value: unknown): value is TtsStatusData {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<TtsStatusData>;
    return typeof data.connected === 'boolean' && typeof data.playing === 'boolean'
        && typeof data.preparing === 'boolean' && Number.isSafeInteger(data.queueLength) && data.queueLength! >= 0;
}

export function formatTtsStatus(data: TtsStatusData): string {
    const activity = data.playing ? 'playing' : data.preparing ? 'preparing' : data.queueLength ? 'waiting' : 'idle';
    return `TTS: ${data.connected ? 'connected' : 'disconnected'} · ${activity} · ${data.queueLength} queued`;
}
