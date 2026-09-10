export const EXPRESSIVE_TTS_TAG_GROUPS = {
  emotions: [
    'happy', 'sad', 'angry', 'excited', 'calm', 'nervous',
    'confident', 'surprised', 'scared', 'worried', 'disappointed', 'curious',
    'sarcastic', 'satisfied', 'delighted', 'upset', 'frustrated', 'depressed',
    'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed',
    'grateful', 'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent',
    'uncertain', 'doubtful', 'confused', 'regretful', 'guilty', 'ashamed',
    'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic',
    'lonely', 'bored', 'contemptuous', 'sympathetic', 'compassionate', 'determined',
    'resigned',
  ],
  delivery: [
    'whisper', 'shouting', 'soft', 'singing', 'slow', 'fast',
    'emphasis', 'screaming',
  ],
  sounds: [
    'laugh', 'chuckle', 'giggle', 'cry', 'sigh', 'gasp',
    'inhale', 'exhale', 'sobbing', 'groaning', 'panting', 'yawning',
    'snoring', 'clear throat',
  ],
  effects: [
    'pause', 'long-pause', 'audience laughing', 'background laughter',
  ],
} as const;

export const EXPRESSIVE_TTS_TAGS = Object.values(EXPRESSIVE_TTS_TAG_GROUPS).flat();

export type ExpressiveTtsTag = typeof EXPRESSIVE_TTS_TAGS[number];
export type ExpressiveTtsTagSettings = Record<ExpressiveTtsTag, boolean>;

export function normalizeExpressiveTtsTags(input?: unknown): ExpressiveTtsTagSettings {
  const values = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const legacyInline = values.inline as Record<string, unknown> | undefined;
  const legacyWrapping = values.wrapping as Record<string, unknown> | undefined;
  return Object.fromEntries(EXPRESSIVE_TTS_TAGS.map(tag => {
    const legacyKey = tag === 'long-pause' ? 'longPause' : tag;
    const value = values[tag] ?? legacyInline?.[legacyKey] ?? legacyWrapping?.[legacyKey];
    return [tag, typeof value === 'boolean' ? value : true];
  })) as ExpressiveTtsTagSettings;
}

const ALIASES: Record<string, string> = {
  anger: 'angry', whispering: 'whisper', laughing: 'laugh', crying: 'cry',
  sighing: 'sigh', loud: 'shouting',
  chuckling: 'chuckle', gasping: 'gasp', 'soft tone': 'soft',
  'crying loudly': 'cry', 'in a hurry tone': 'fast',
  break: 'pause', 'long-break': 'long-pause', 'crowd laughing': 'audience laughing',
};
const LEGACY_WRAPPERS = /<\/?(?:soft|whisper|loud|build-intensity|decrease-intensity|higher-pitch|lower-pitch|slow|fast|sing-song|singing|laugh-speak|emphasis)>/gi;

/** Expand already-filtered cues only at the Fish boundary, after message length limits. */
export function reinforceFishTtsTags(text: string): string {
  return text.replace(/\[([a-z -]+)\](?:\s*\[\1\])*/g, (match, tag: string) => {
    if (!EXPRESSIVE_TTS_TAGS.includes(tag as ExpressiveTtsTag) || match !== `[${tag}]`) {
      return match;
    }
    return `[${tag}] [${tag}]`;
  });
}

export function filterExpressiveTtsTags(
  rawText: string,
  options: { provider: 'piper' | 'fish'; enabledTags?: ExpressiveTtsTagSettings } = { provider: 'piper' },
): string {
  return String(rawText || '')
    .replace(LEGACY_WRAPPERS, '')
    .replace(/\[([^\[\]]*)\]/g, (_match, rawTag: string) => {
      const name = rawTag.trim().toLowerCase();
      const tag = (Object.hasOwn(ALIASES, name) ? ALIASES[name] : name) as ExpressiveTtsTag;
      return options.provider === 'fish' && EXPRESSIVE_TTS_TAGS.includes(tag)
        && options.enabledTags?.[tag] === true ? `[${tag}]` : ' ';
    })
    .replace(/ {2,}/g, ' ')
    .trim();
}
