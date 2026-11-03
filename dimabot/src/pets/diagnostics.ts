import { info as logInfo } from '../utils/logger.js';

export type PetDiagnosticEvent = 'ready' | 'play_delivery' | 'audio_fetch' | 'playback_report' | 'playback_rejected' | 'terminal' | 'invalidated' | 'reauth';
interface Fields {
    requestId?: unknown; generation?: unknown; operation?: unknown; peerKind?: unknown;
    phase?: unknown; reason?: unknown; status?: unknown; delivered?: unknown; accepted?: unknown; playbackStarted?: unknown;
    readyAt?: unknown; emittedAt?: unknown; emitDelayMs?: unknown; startRemainingMs?: unknown;
    durationMs?: unknown; positionMs?: unknown; queueDelayMs?: unknown; handlerMs?: unknown;
}
const reasons = new Set(['stale_playback', 'invalid_playback', 'invalid_message', 'rate_limited', 'temporarily_unavailable',
    'ok', 'player_unready', 'player_stopping', 'plan_required', 'access_denied',
    'settings_changed', 'personality_changed', 'overlay_rotated', 'api_restarted', 'request_missing',
    'invalid_ticket', 'stale_ticket', 'audio_unavailable', 'invalid_token', 'insufficient_scope', 'request_expired', 'provider_outcome_unknown', 'player_disconnected',
    'audio_output_unavailable', 'audio_download_failed', 'audio_media_failed', 'audio_authorization_expired', 'audio_output_failed', 'autoplay_blocked', 'lease_expired', 'vts_unavailable', 'player_unavailable', 'playback_error', 'cancelled', 'completed', 'failed', 'expired']);
const choices: Record<string, readonly string[]> = {
    operation: ['ask', 'talk', 'tts'], peerKind: ['desktop', 'browser'],
    phase: ['started', 'ended', 'stopped', 'error'], status: ['completed', 'cancelled', 'failed', 'expired']
};
/** Explicit allowlist: never spread request, packet, provider result, or exception objects into logs. */
export function petDiagnosticData(event: PetDiagnosticEvent, fields: Fields) {
    const result: Record<string, string | number | boolean> = { component: 'pet_playback', event, observedAt: Date.now() };
    if (typeof fields.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(fields.requestId)) result.requestId = fields.requestId;
    for (const key of ['generation', 'readyAt', 'emittedAt', 'emitDelayMs', 'startRemainingMs', 'durationMs', 'positionMs', 'queueDelayMs', 'handlerMs'] as const) {
        const value = fields[key]; if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    for (const key of ['delivered', 'accepted', 'playbackStarted'] as const) if (typeof fields[key] === 'boolean') result[key] = fields[key];
    for (const [key, values] of Object.entries(choices)) {
        const value = fields[key as keyof Fields]; if (typeof value === 'string' && values.includes(value)) result[key] = value;
    }
    if (fields.reason !== undefined) result.reason = typeof fields.reason === 'string' && reasons.has(fields.reason) ? fields.reason : 'other';
    return result;
}
export function createPetDiagnostics(write: (data: ReturnType<typeof petDiagnosticData>, channelId: string) => Promise<unknown>) {
    let pending = 0, globalWindow = 0, globalCount = 0;
    return (channelId: string, event: PetDiagnosticEvent, fields: Fields) => {
        // Bounded best effort, scheduled after the current callback. Diagnostics never delay play or ACK.
        if (pending >= 128 || channelId !== 'global' && !/^\d{1,30}$/.test(channelId)) return;
        if (channelId === 'global') {
            const now = Date.now();
            if (now - globalWindow >= 1000) { globalWindow = now; globalCount = 0; }
            if (globalCount >= 5) return;
            globalCount++;
        }
        const data = petDiagnosticData(event, fields); pending++;
        setImmediate(() => { Promise.resolve().then(() => write(data, channelId)).catch(() => {}).finally(() => { pending--; }); });
    };
}
export const petDiagnostic = createPetDiagnostics((data, channelId) => logInfo(data, { channelId, destination: 'both' }));
