import { warn } from '../utils/logger.js';

export type PetMoodWarning = 'settings_invalid' | 'stored_invalid' | 'image_limit' | 'invalid_image' |
    'extraction' | 'instruction' | 'image_selection' | 'cue_lookup' | 'cue_filter' | 'snapshot_config' | 'asset_urls';
const codes = new Set<PetMoodWarning>(['settings_invalid', 'stored_invalid', 'image_limit', 'invalid_image',
    'extraction', 'instruction', 'image_selection', 'cue_lookup', 'cue_filter', 'snapshot_config', 'asset_urls']);
const recent = new Map<string, number>();
let windowStart = 0, emitted = 0;

/** Bounded, best-effort diagnostics: no raw text, asset IDs or error details. */
export function warnPetMood(code: PetMoodWarning, channelId?: string): void {
    try {
        if (!codes.has(code)) return;
        const now = Date.now();
        if (now - windowStart >= 60_000 || now < windowStart) { windowStart = now; emitted = 0; }
        const channel = typeof channelId === 'string' && /^\d{1,30}$/.test(channelId) ? channelId : undefined;
        const key = `${code}:${channel ?? 'global'}`;
        const last = recent.get(key);
        if (emitted >= 10 || last !== undefined && now >= last && now - last < 60_000) return;
        recent.delete(key); recent.set(key, now);
        if (recent.size > 128) recent.delete(recent.keys().next().value!);
        emitted++;
        void Promise.resolve(warn({ message: 'Pet mood decoration unavailable', code }, { destination: 'console', ...(channel ? { channelId: channel } : {}) })).catch(() => {});
    } catch { /* Warnings are never part of speech delivery. */ }
}
