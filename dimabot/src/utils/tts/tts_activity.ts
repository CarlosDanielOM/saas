import type { ActivityOutcome } from '../../schemas/activity_log.schema.js';
import { recordActivity } from '../activity_log.js';

/**
 * Owner activity rows for TTS (kind `voice`), next to the synthesis problems `tts_queue.handler.ts` already
 * records under the provider's name:
 *
 * - `request`: a voice request that was never queued (TTS off, filtered text, no speech page open, queue full).
 * - `playback`: how each synthesized message ended on stream (played, page could not play it, moved to another
 *   page, skipped by a mod, page closed).
 *
 * Successful synthesis already has its usage receipt; these rows say what happened around it. Both builders are
 * pure (tested); the `record*` wrappers never throw.
 */

export interface VoiceRowOutcome { outcome: ActivityOutcome; reason: string }

/** Refusal codes the speech service sends (`POST /speech/:channelID`) and `queueDefaultTts` uses itself. */
export const TTS_REQUEST_CODES = [
    'empty_text', 'tts_disabled', 'text_rejected', 'no_voice', 'no_speech_page', 'queue_full', 'busy', 'streamer_not_found'
] as const;
export type TtsRequestCode = typeof TTS_REQUEST_CODES[number];

/** Settings doing their job (TTS off, the filters, the queue limit) are skipped; the rest kept a viewer from being heard. */
const SKIPPED_CODES: ReadonlySet<string> = new Set(['empty_text', 'tts_disabled', 'text_rejected', 'queue_full']);

export function ttsRequestOutcome(result: { status?: number | null; code?: string | null }): VoiceRowOutcome {
    const code = typeof result.code === 'string' && (TTS_REQUEST_CODES as readonly string[]).includes(result.code) ? result.code : null;
    if (code) return { outcome: SKIPPED_CODES.has(code) ? 'skipped' : 'failed', reason: code };
    // An API from before the codes: its statuses are specific enough.
    switch (result.status) {
        case 403: return { outcome: 'skipped', reason: 'tts_disabled' };
        case 400: return { outcome: 'skipped', reason: 'text_rejected' };
        case 409: return { outcome: 'failed', reason: 'no_speech_page' };
        case 429: return { outcome: 'skipped', reason: 'queue_full' };
        default: return { outcome: 'failed', reason: 'error' };
    }
}

export interface TtsRequestRefusal {
    channelID: string;
    actor?: { id?: string | null; login?: string | null; name?: string | null } | null;
    source?: string | null;
    /** What the viewer asked to be read (clipped and scrubbed by the writer). */
    text?: string | null;
    provider?: string | null;
    result: { message?: string | null; status?: number | null; code?: string | null };
}

export function ttsRequestActivity(refusal: TtsRequestRefusal) {
    const { outcome, reason } = ttsRequestOutcome(refusal.result);
    return {
        kind: 'voice' as const,
        name: 'request',
        channelID: refusal.channelID,
        outcome,
        reason,
        actor: refusal.actor ?? null,
        text: refusal.text ?? null,
        data: {
            source: refusal.source || undefined,
            provider: refusal.provider || undefined,
            error: refusal.result.message || undefined
        }
    };
}

export function recordTtsRequestRefused(refusal: TtsRequestRefusal): void {
    try { recordActivity(ttsRequestActivity(refusal)); } catch { /* a debug row must never change a TTS request */ }
}

/**
 * How a synthesized message ended, from the queue's end reason. `heard` = some page reported playing it.
 * Unknown reasons are failures under their own name, so a new ending is visible instead of hidden.
 */
export function ttsPlaybackOutcome(reason: string, heard: boolean): VoiceRowOutcome {
    switch (reason) {
        case 'ended':
        case 'pet:completed': return { outcome: 'ok', reason: '' };
        case 'skip': return { outcome: 'skipped', reason: 'tts_skipped' };
        case 'clear': return { outcome: 'skipped', reason: 'tts_cleared' };
        case 'refresh': return { outcome: 'skipped', reason: 'tts_refreshed' };
        case 'stream_ended': return { outcome: 'skipped', reason: 'stream_ended' };
        // Stopped by a control whose kind is not known any more (a skip, clear or reload).
        case 'interrupted': return { outcome: 'skipped', reason: 'tts_stopped' };
        // The desktop pet reading it privately: cancelled there, or the pet changed state.
        case 'pet:cancelled':
        case 'pet:state_changed': return { outcome: 'skipped', reason: 'pet_stopped' };
        case 'pet:failed': return { outcome: 'failed', reason: 'pet_failed' };
        case 'pet:expired': return { outcome: 'failed', reason: 'pet_expired' };
        // Played until the page went away: someone heard part of it.
        case 'disconnected': return { outcome: 'failed', reason: heard ? 'page_closed_while_playing' : 'page_closed' };
        case 'output_unavailable':
        case 'not_delivered': return { outcome: 'failed', reason: 'no_speech_page' };
        // The speech page's own reports, and the queue's checks on it.
        case 'play-error': return { outcome: 'failed', reason: 'play_error' };
        case 'media-error': return { outcome: 'failed', reason: 'media_error' };
        case 'download-error': return { outcome: 'failed', reason: 'download_error' };
        case 'stalled': return { outcome: 'failed', reason: 'stalled' };
        case 'start-timeout':
        case 'no-start': return { outcome: 'failed', reason: 'no_start' };
        case 'timeout': return { outcome: 'failed', reason: 'playback_timeout' };
        default: return { outcome: 'failed', reason: reason.replace(/[^a-z0-9_]+/gi, '_').toLowerCase().slice(0, 48) || 'error' };
    }
}

export interface TtsPlaybackEnd {
    channelID: string;
    speechID: string;
    reason: string;
    actor?: { id?: string | null; login?: string | null; name?: string | null } | null;
    provider?: string | null;
    voice?: string | null;
    source?: string | null;
    chars?: number | null;
    /** Some page reported playing it (or a position past the start). */
    heard: boolean;
    /** Speech pages it was sent to (a moved message has more than one); 0 for Overlay Studio or the pet. */
    pages: number;
    /** Why it left the first page, when it moved. */
    movedBecause?: string | null;
    everyPage?: boolean;
    /** From the request to the end. */
    totalMs?: number | null;
    /** An error that ended it (the queue itself failed). */
    error?: string | null;
}

export function ttsPlaybackActivity(end: TtsPlaybackEnd) {
    const { outcome, reason } = ttsPlaybackOutcome(end.reason, end.heard);
    return {
        kind: 'voice' as const,
        name: 'playback',
        channelID: end.channelID,
        outcome,
        reason,
        actor: end.actor ?? null,
        ref: end.speechID,
        durationMs: end.totalMs ?? null,
        // A recovered queue can end the same message twice: one row per message.
        dedupeKey: `${end.speechID}:playback`,
        data: {
            provider: end.provider || undefined,
            voice: end.voice || undefined,
            source: end.source || undefined,
            chars: typeof end.chars === 'number' ? end.chars : undefined,
            heard: end.heard,
            pages: end.pages || undefined,
            movedBecause: end.movedBecause || undefined,
            everyPage: end.everyPage ? true : undefined,
            // The raw end reason, for the reasons the sentence above summarises.
            endReason: outcome === 'ok' ? undefined : end.reason,
            error: end.error || undefined
        }
    };
}

export function recordTtsPlayback(end: TtsPlaybackEnd): void {
    try { recordActivity(ttsPlaybackActivity(end)); } catch { /* a debug row must never change playback */ }
}
