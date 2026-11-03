import type { Mood } from './moods.js';
import { warnPetMood } from './mood_warnings.js';

/** Mood decoration is optional and must never interrupt a speech turn. */
export function safelyResolveMood(resolve: () => Mood, channelId?: string): Mood {
    try { return resolve(); } catch { warnPetMood('extraction', channelId); return 'neutral'; }
}
export function safelyBuildMoodInstruction(build: () => string, channelId?: string): string {
    try { return build(); } catch { warnPetMood('instruction', channelId); return ''; }
}

/** Start optional work without holding up generation or handling a rejected promise later. */
export function prefetchMoodCueSettings<T>(load: () => Promise<T>, channelId?: string): () => T | undefined {
    let value: T | undefined;
    try { void Promise.resolve(load()).then(result => { value = result; }, () => { warnPetMood('cue_lookup', channelId); }); } catch { warnPetMood('cue_lookup', channelId); }
    return () => value;
}

export function safelyFilterMoodCues(text: string, filter: () => string, channelId?: string): string {
    try { const filtered = filter(); if (filtered.trim()) return filtered; } catch { /* Preserve speech. */ }
    warnPetMood('cue_filter', channelId); return text;
}
