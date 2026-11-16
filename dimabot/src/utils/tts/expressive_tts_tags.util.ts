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

export function normalizeExpressiveTtsTag(name: string): string {
  const normalized = name.trim().toLowerCase();
  return Object.hasOwn(ALIASES, normalized) ? ALIASES[normalized] : normalized;
}

/** Expand already-filtered cues only at the Fish boundary, after message length limits. */
export function reinforceFishTtsTags(text: string): string {
  return text.replace(/\[([a-z -]+)\](?:\s*\[\1\])*/g, (match, tag: string) => {
    if (!EXPRESSIVE_TTS_TAGS.includes(tag as ExpressiveTtsTag) || match !== `[${tag}]`) {
      return match;
    }
    return `[${tag}] [${tag}]`;
  });
}

/**
 * Keeps the Fish cues a channel allows and removes the rest (every cue for Piper/Kokoro).
 * `freeformTags` (TTS setting "Allow any tag") also keeps square-bracket cues outside the list,
 * e.g. `[sad in a nervous voice]`, as written; listed tags still follow their own switch.
 */
export function filterExpressiveTtsTags(
  rawText: string,
  options: { provider: 'piper' | 'fish' | 'kokoro'; enabledTags?: ExpressiveTtsTagSettings; freeformTags?: boolean } = { provider: 'piper' },
): string {
  return String(rawText || '')
    .replace(/<\s*(\/?)\s*([a-z][a-z -]*?)\s*>|\[([^\[\]]*)\]/gi, (_match, closing: string | undefined, angleTag: string | undefined, squareTag: string | undefined) => {
      const rawTag = angleTag ?? squareTag!;
      // Collapse inner whitespace first so `[clear  throat]` is the listed tag, not a free cue that skips its switch.
      const name = (angleTag !== undefined ? rawTag.replace(/\s*-\s*/g, '-') : rawTag).replace(/\s+/g, ' ').trim().toLowerCase();
      const tag = normalizeExpressiveTtsTag(name) as ExpressiveTtsTag;
      if (options.provider === 'fish' && EXPRESSIVE_TTS_TAGS.includes(tag)) {
        if (options.enabledTags?.[tag] === true) return angleTag !== undefined ? `<${closing}${tag}>` : `[${tag}]`;
      } else if (options.provider === 'fish' && options.freeformTags === true && squareTag !== undefined) {
        const cue = squareTag.replace(/\s+/g, ' ').trim();
        if (cue) return `[${cue}]`;
      }
      return angleTag !== undefined ? '' : ' ';
    })
    .replace(/ {2,}/g, ' ')
    .trim();
}
