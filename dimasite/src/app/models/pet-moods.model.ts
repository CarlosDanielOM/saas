import { warnPetMood } from './pet-mood-warning';
import { EXPRESSIVE_TTS_TAG_GROUPS } from './tts-settings.model';

export const PET_MOODS = ['happy', 'excited', 'sad', 'angry', 'surprised', 'scared', 'embarrassed', 'thinking'] as const;
export type PetMood8 = typeof PET_MOODS[number];
export type PetMood = 'neutral' | PetMood8;
export interface PetMoods {
  enabled: boolean;
  holdMs: number;
  emotions: Record<PetMood8, string[]>;
  images: Partial<Record<PetMood8, { idleAssetId?: string; talkingAssetId?: string }>>;
}
export type PetMoodConfiguration = { available: false; enabled: false } | {
  available: true; enabled: boolean; holdMs: number; emotions: Record<PetMood8, string[]>;
};
export type PetMoodAssets = Partial<Record<PetMood8, { idleUrl: string | null; talkingUrl: string | null }>>;
export function defaultPetMoods(): PetMoods {
  return { enabled: false, holdMs: 2000, images: {}, emotions: {
    happy: ['happy', 'delighted', 'satisfied', 'grateful', 'proud', 'confident', 'optimistic', 'hopeful', 'moved', 'empathetic', 'sympathetic', 'compassionate', 'laugh', 'chuckle', 'giggle'],
    excited: ['excited', 'hysterical', 'determined'],
    sad: ['sad', 'disappointed', 'depressed', 'unhappy', 'regretful', 'lonely', 'nostalgic', 'resigned', 'pessimistic', 'guilty', 'cry', 'sobbing'],
    angry: ['angry', 'frustrated', 'upset', 'disgusted', 'contemptuous', 'disdainful', 'jealous', 'envious', 'sarcastic'],
    surprised: ['surprised', 'gasp'], scared: ['scared', 'nervous', 'anxious', 'worried'],
    embarrassed: ['embarrassed', 'ashamed'], thinking: ['curious', 'confused', 'uncertain', 'doubtful']
  } };
}
export function normalizePetMood(value: unknown): PetMood {
  return typeof value === 'string' && (PET_MOODS as readonly string[]).includes(value) ? value as PetMood8 : 'neutral';
}


/** Legacy/corrupt decoration settings must never break the pet settings page. */
function parsePetMoodsSettings(input: unknown): PetMoods | null {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  try {
    if (!record(input) || typeof input['enabled'] !== 'boolean' || !Number.isSafeInteger(input['holdMs']) ||
      Number(input['holdMs']) < 0 || Number(input['holdMs']) > 10_000 || !record(input['emotions']) || !record(input['images'])) return null;
    const emotions = input['emotions'], images = input['images'];
    if (Object.keys(emotions).some(mood => !(PET_MOODS as readonly string[]).includes(mood)) ||
      Object.keys(images).some(mood => !(PET_MOODS as readonly string[]).includes(mood))) return null;
    const known = new Set<string>([...EXPRESSIVE_TTS_TAG_GROUPS.emotions, ...EXPRESSIVE_TTS_TAG_GROUPS.sounds]);
    const seen = new Set<string>(), result = defaultPetMoods();
    for (const mood of PET_MOODS) {
      const tags = emotions[mood];
      if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !known.has(tag))) return null;
      for (const tag of tags as string[]) {
        if (seen.has(tag)) return null;
        seen.add(tag);
      }
      result.emotions[mood] = [...tags] as string[];
      if (images[mood] !== undefined) {
        const image = images[mood];
        if (!record(image) || Object.keys(image).some(key => key !== 'idleAssetId' && key !== 'talkingAssetId')) return null;
        const fields: { idleAssetId?: string; talkingAssetId?: string } = {};
        for (const state of ['idleAssetId', 'talkingAssetId'] as const) {
          const id = image[state];
          if (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))) return null;
          if (typeof id === 'string') fields[state] = id;
        }
        result.images[mood] = fields;
      }
    }
    result.enabled = input['enabled']; result.holdMs = Number(input['holdMs']);
    return result;
  } catch { return null; }
}


export function normalizePetMoodsSettings(input: unknown): PetMoods {
  const result = parsePetMoodsSettings(input);
  if (result) return result;
  if (input !== undefined) warnPetMood('settings');
  return defaultPetMoods();
}

/** Isolate optional wire decorations from the required playback protocol. */
export function normalizePetMoodMetadata(config: unknown, assets: unknown): { moods?: PetMoodConfiguration; assets?: PetMoodAssets } {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const invalid = () => { warnPetMood('metadata'); return { moods: { available: false, enabled: false } as const }; };
  try {
    if (config === undefined && assets === undefined) return {};
    if (!record(config) || typeof config['available'] !== 'boolean' || typeof config['enabled'] !== 'boolean') return invalid();
    if (!config['available']) return { moods: { available: false, enabled: false } };
    const settings = parsePetMoodsSettings({ enabled: config['enabled'], holdMs: config['holdMs'], emotions: config['emotions'], images: {} });
    if (!settings) return invalid();
    const moods: PetMoodConfiguration = { available: true, enabled: settings.enabled, holdMs: settings.holdMs, emotions: settings.emotions };
    if (!settings.enabled || assets === undefined) return { moods };
    if (!record(assets)) return invalid();
    const images: PetMoodAssets = {};
    for (const mood of PET_MOODS) {
      const image = assets[mood];
      if (image === undefined) continue;
      if (!record(image)) { warnPetMood('metadata'); continue; }
      const idle = image['idleUrl'], talking = image['talkingUrl'];
      images[mood] = { idleUrl: typeof idle === 'string' ? idle : null, talkingUrl: typeof talking === 'string' ? talking : null };
      if (idle !== null && typeof idle !== 'string' || talking !== null && typeof talking !== 'string') warnPetMood('metadata');
    }
    return { moods, assets: images };
  } catch { return invalid(); }
}
