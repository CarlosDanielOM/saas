import { warnPetMood } from './mood_warnings.js';
import { EXPRESSIVE_TTS_TAG_GROUPS, normalizeExpressiveTtsTag } from '../utils/tts/expressive_tts_tags.util.js';

export const MOOD_NAMES = ['happy', 'excited', 'sad', 'angry', 'surprised', 'scared', 'embarrassed', 'thinking'] as const;
export type Mood8 = typeof MOOD_NAMES[number];
export type Mood = Mood8 | 'neutral';
export type PetMoods = { enabled: boolean; holdMs: number; emotions: Record<Mood8, string[]>; images: Partial<Record<Mood8, { idleAssetId?: string; talkingAssetId?: string }>> };
const defaults: Record<Mood8, string[]> = {
    happy: ['happy', 'delighted', 'satisfied', 'grateful', 'proud', 'confident', 'optimistic', 'hopeful', 'moved', 'empathetic', 'sympathetic', 'compassionate', 'laugh', 'chuckle', 'giggle'],
    excited: ['excited', 'hysterical', 'determined'],
    sad: ['sad', 'disappointed', 'depressed', 'unhappy', 'regretful', 'lonely', 'nostalgic', 'resigned', 'pessimistic', 'guilty', 'cry', 'sobbing'],
    angry: ['angry', 'frustrated', 'upset', 'disgusted', 'contemptuous', 'disdainful', 'jealous', 'envious', 'sarcastic'],
    surprised: ['surprised', 'gasp'], scared: ['scared', 'nervous', 'anxious', 'worried'],
    embarrassed: ['embarrassed', 'ashamed'], thinking: ['curious', 'confused', 'uncertain', 'doubtful']
};
const known = new Set<string>([...EXPRESSIVE_TTS_TAG_GROUPS.emotions, ...EXPRESSIVE_TTS_TAG_GROUPS.sounds]);
export function defaultPetMoods(): PetMoods { return { enabled: false, holdMs: 2000, emotions: structuredClone(defaults), images: {} }; }
/** Mongo minimizes empty objects, including the initially empty image mapping. */
export function savedPetMoods(value?: unknown): PetMoods {
    if (value === undefined) return defaultPetMoods();
    try {
        const stored = record(value, ['enabled', 'holdMs', 'emotions', 'images']);
        return validatePetMoods({ ...stored, ...(stored.images === undefined ? { images: {} } : {}) });
    } catch { warnPetMood('stored_invalid'); return defaultPetMoods(); }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalid_moods');
    return value as Record<string, unknown>;
}
export function validatePetMoods(input: unknown): PetMoods {
    const value = record(input, ['enabled', 'holdMs', 'emotions', 'images']);
    if (typeof value.enabled !== 'boolean' || typeof value.holdMs !== 'number' || !Number.isInteger(value.holdMs) || value.holdMs < 0 || value.holdMs > 10000) throw new Error('invalid_moods');
    const lists = record(value.emotions, MOOD_NAMES), images = record(value.images, MOOD_NAMES), seen = new Set<string>();
    const emotions = {} as Record<Mood8, string[]>;
    const resultImages: PetMoods['images'] = {};
    for (const mood of MOOD_NAMES) {
        if (!Array.isArray(lists[mood])) throw new Error('invalid_moods');
        emotions[mood] = (lists[mood] as unknown[]).map(raw => {
            if (typeof raw !== 'string') throw new Error('invalid_moods');
            const tag = normalizeExpressiveTtsTag(raw);
            if (!known.has(tag) || seen.has(tag)) throw new Error('invalid_moods');
            seen.add(tag); return tag;
        });
        if (images[mood] !== undefined) {
            const entry = record(images[mood], ['idleAssetId', 'talkingAssetId']);
            const out: { idleAssetId?: string; talkingAssetId?: string } = {};
            for (const key of ['idleAssetId', 'talkingAssetId'] as const) if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
                if (typeof entry[key] !== 'string' || !/^[a-f0-9]{24}$/i.test(entry[key] as string)) throw new Error('invalid_moods');
                out[key] = entry[key] as string;
            }
            if (Object.keys(out).length) resultImages[mood] = out;
        }
    }
    return { enabled: value.enabled, holdMs: value.holdMs, emotions, images: resultImages };
}
export function moodConfiguration(settings: PetMoods, planTier: string | undefined) {
    if (planTier !== 'premium' && planTier !== 'pro') return { available: false as const, enabled: false as const };
    return { available: true as const, enabled: settings.enabled, holdMs: settings.holdMs, emotions: settings.emotions };
}
export function resolvePetMood(rawText: string, moods: PetMoods): Mood {
    const pattern = /<\s*(\/?)\s*([a-z][a-z -]*?)\s*>|\[([^\[\]]*)\]/gi;
    for (const match of String(rawText || '').matchAll(pattern)) {
        if (match[1]) continue;
        const tag = normalizeExpressiveTtsTag(match[2] ?? match[3]);
        if (!known.has(tag)) continue;
        return MOOD_NAMES.find(mood => moods.emotions[mood].includes(tag)) ?? 'neutral';
    }
    return 'neutral';
}
export function moodInstruction(moods: PetMoods): string {
    const tags = MOOD_NAMES.flatMap(mood => moods.emotions[mood]);
    return tags.length ? `Begin your reply with exactly one emotion tag from this list, in square brackets: ${tags.join(', ')}.` : '';
}

/** Configured slots have a stable order across plan changes and editor rearrangements. */
export function moodImageSlots(moods: PetMoods): Array<{ mood: Mood8; key: 'idleAssetId' | 'talkingAssetId'; assetId: string }> {
    return MOOD_NAMES.flatMap(mood => (['idleAssetId', 'talkingAssetId'] as const).flatMap(key => {
        const assetId = moods.images?.[mood]?.[key];
        return assetId ? [{ mood, key, assetId }] : [];
    }));
}
export function moodImageLimit(planTier: string | undefined): number {
    return planTier === 'pro' ? 16 : planTier === 'premium' ? 8 : 0;
}
export function activeMoodImages(moods: PetMoods, planTier: string | undefined): PetMoods['images'] {
    const active: PetMoods['images'] = {};
    for (const { mood, key, assetId } of moodImageSlots(moods).slice(0, moodImageLimit(planTier))) {
        (active[mood] ??= {})[key] = assetId;
    }
    return active;
}
