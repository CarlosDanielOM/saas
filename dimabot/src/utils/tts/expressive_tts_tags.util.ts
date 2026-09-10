export const EXPRESSIVE_TTS_TAGS = [
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident',
  'surprised', 'scared', 'worried', 'disappointed', 'curious', 'sarcastic',
  'whisper', 'shouting', 'soft', 'singing', 'slow', 'fast', 'emphasis',
  'laugh', 'chuckle', 'giggle', 'cry', 'sigh', 'gasp', 'inhale', 'exhale',
  'pause', 'long-pause',
] as const;

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
};
const LEGACY_WRAPPERS = /<\/?(?:soft|whisper|loud|build-intensity|decrease-intensity|higher-pitch|lower-pitch|slow|fast|sing-song|singing|laugh-speak|emphasis)>/gi;

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
