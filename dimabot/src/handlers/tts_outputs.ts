/**
 * Speech pages (`GET /speech/<channel>/`, Socket.IO `/speech/<channel>`) are the "outputs" that play
 * normal TTS audio. A channel can have several open at once: two OBS browser sources, a second PC,
 * a phone tab. This module keeps what each page told us about itself and ranks them, so a message
 * goes to a copy that can actually play it. Pure functions only; the queue handler owns delivery.
 *
 * Pages from before this protocol (still running in OBS until the source reloads) never send a
 * state. They rank as "unknown", just below a proven-good page, and are judged by their results.
 */

/** Outcome of the page's silent start-up probe (a ~50 ms silent clip played unmuted). */
export type SpeechProbe = 'idle' | 'pending' | 'ok' | 'blocked' | 'failed';

export interface SpeechOutputInfo {
    /** 1 = page from before this protocol (no state reports), 2 = current page. */
    version: 1 | 2;
    /** Random id the page made when it loaded; survives Socket.IO reconnects of the same page. */
    pageId?: string;
    /** `document.visibilityState === 'visible'` (OBS hides sources that are not on any view). */
    visible?: boolean;
    /** The page runs inside an OBS browser source. */
    obs?: boolean;
    /** OBS said the source is in the program output (only known after OBS reports a change). */
    obsActive?: boolean;
    /** This page has played audio at least once (probe or speech); hidden pages then still play. */
    played: boolean;
    probe: SpeechProbe;
    /** Server time when the probe was first reported pending. */
    probeSince?: number;
    /** Failed messages in a row since this page last played one. */
    failures: number;
    lastFailure?: string;
    lastFailureAt?: number;
    lastPlayedAt?: number;
    connectedAt: number;
}

/** A pending probe older than this means the browser is holding audio back (hidden OBS source). */
export const PROBE_DEFERRED_MS = 3_000;
/** Failures older than this stop counting against a page. */
const FAILURE_MEMORY_MS = 30 * 60_000;
const PAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function newOutputInfo(auth: unknown, now = Date.now()): SpeechOutputInfo {
    const record = auth && typeof auth === 'object' && !Array.isArray(auth) ? auth as Record<string, unknown> : {};
    const pageId = typeof record.pageId === 'string' && PAGE_ID.test(record.pageId) ? record.pageId : undefined;
    return { version: record.v === 2 && pageId ? 2 : 1, pageId: record.v === 2 ? pageId : undefined,
        played: false, probe: 'idle', failures: 0, connectedAt: now };
}

/**
 * Applies a `speech-state` report from a page. Unknown or malformed fields are ignored; a report
 * never changes the server-side failure history. Returns false when nothing usable was sent.
 */
export function applyOutputState(info: SpeechOutputInfo, raw: unknown, now = Date.now()): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const report = raw as Record<string, unknown>;
    if (report.v !== 2) return false;
    info.version = 2;
    if (!info.pageId && typeof report.pageId === 'string' && PAGE_ID.test(report.pageId)) info.pageId = report.pageId;
    if (typeof report.visible === 'boolean') info.visible = report.visible;
    if (typeof report.obs === 'boolean') info.obs = report.obs;
    if (typeof report.obsActive === 'boolean') info.obsActive = report.obsActive;
    if (report.played === true) info.played = true;
    if (report.probe === 'idle' || report.probe === 'pending' || report.probe === 'ok' || report.probe === 'blocked' || report.probe === 'failed') {
        if (report.probe === 'pending') { if (info.probe !== 'pending') info.probeSince = now; }
        else info.probeSince = undefined;
        info.probe = report.probe;
        if (report.probe === 'ok') info.played = true;
    }
    return true;
}

export function recordOutputSuccess(info: SpeechOutputInfo, now = Date.now()): void {
    info.failures = 0; info.lastFailure = undefined; info.lastFailureAt = undefined;
    info.played = true; info.lastPlayedAt = now;
}

export function recordOutputFailure(info: SpeechOutputInfo, reason: string, now = Date.now()): void {
    if (info.lastFailureAt && now - info.lastFailureAt > FAILURE_MEMORY_MS) info.failures = 0;
    info.failures++; info.lastFailure = reason; info.lastFailureAt = now;
}

function recentFailures(info: SpeechOutputInfo, now: number): number {
    return info.failures && info.lastFailureAt && now - info.lastFailureAt <= FAILURE_MEMORY_MS ? info.failures : 0;
}

/** The browser is holding audio back: the probe never got to play. */
function deferred(info: SpeechOutputInfo, now: number): boolean {
    return info.probe === 'pending' && !info.played && info.probeSince !== undefined && now - info.probeSince >= PROBE_DEFERRED_MS;
}

export type SpeechOutputProblem = 'hidden' | 'blocked' | 'failing' | null;

/** The one problem worth telling the streamer about for this page, if any. */
export function outputProblem(info: SpeechOutputInfo, now = Date.now()): SpeechOutputProblem {
    if (recentFailures(info, now)) return 'failing';
    if (info.probe === 'blocked' && !info.played) return 'blocked';
    if (info.visible === false && (!info.played || deferred(info, now))) return 'hidden';
    if (deferred(info, now)) return 'hidden';
    return null;
}

/**
 * Lower is better. Usable pages first; among those, a page OBS has in the program output, then
 * other OBS pages, then pages we know nothing about (old protocol), then other browsers, then
 * pages that are hidden but have played before. Pages that cannot play come last.
 */
export function outputScore(info: SpeechOutputInfo, now = Date.now()): number {
    let score = recentFailures(info, now) * 200;
    if (info.probe === 'blocked' && !info.played) score += 1000;
    if (deferred(info, now)) score += 500;
    if (info.version === 1) return score + 20;
    if (info.visible === false) score += 100;
    if (info.obs) score += info.obsActive === true ? 0 : info.obsActive === false ? 50 : 10;
    else score += 30;
    return score;
}

export interface RankableOutput { id: string; connected: boolean; data: { ttsReady?: boolean; ttsOutput?: SpeechOutputInfo } }

/** Ready sockets, best first. Ties: most recent success, then the page that connected first, then id. */
export function rankOutputs<T extends RankableOutput>(sockets: Iterable<T>, now = Date.now()): T[] {
    const ready = [...sockets].filter(socket => socket.connected && socket.data.ttsReady);
    const info = (socket: T) => socket.data.ttsOutput ?? newOutputInfo(undefined, 0);
    return ready.map(socket => ({ socket, score: outputScore(info(socket), now) }))
        .sort((a, b) => a.score - b.score
            || (info(b.socket).lastPlayedAt ?? 0) - (info(a.socket).lastPlayedAt ?? 0)
            || info(a.socket).connectedAt - info(b.socket).connectedAt
            || a.socket.id.localeCompare(b.socket.id))
        .map(entry => entry.socket);
}

/** Playback failures a page reports (or the server infers) before anything was heard. */
export const OUTPUT_FAILURES = new Set(['play-error', 'media-error', 'download-error', 'stalled', 'start-timeout', 'no-start', 'timeout']);

export interface TtsOutputsSummary {
    /** Open speech pages (not Overlay Studio or the pet). */
    total: number;
    /** Pages with no known problem. */
    playable: number;
    hidden: number;
    blocked: number;
    failing: number;
    /** Pages from before this version that cannot report problems yet (reload the OBS source). */
    unknown: number;
    /** 'one' = each message plays on one page; 'all' = on every open page. */
    mode: 'one' | 'all';
}

export function summarizeOutputs(sockets: Iterable<RankableOutput>, mode: 'one' | 'all', now = Date.now()): TtsOutputsSummary {
    const summary: TtsOutputsSummary = { total: 0, playable: 0, hidden: 0, blocked: 0, failing: 0, unknown: 0, mode };
    for (const socket of sockets) {
        if (!socket.connected || !socket.data.ttsReady) continue;
        summary.total++;
        const info = socket.data.ttsOutput;
        const problem = info ? outputProblem(info, now) : null;
        if (problem) summary[problem]++;
        else summary.playable++;
        if (!info || info.version === 1) summary.unknown++;
    }
    return summary;
}
