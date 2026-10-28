"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPRESSIVE_TTS_TAGS = exports.EXPRESSIVE_TTS_TAG_GROUPS = void 0;
exports.normalizeExpressiveTtsTags = normalizeExpressiveTtsTags;
exports.reinforceFishTtsTags = reinforceFishTtsTags;
exports.filterExpressiveTtsTags = filterExpressiveTtsTags;
exports.EXPRESSIVE_TTS_TAG_GROUPS = {
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
};
exports.EXPRESSIVE_TTS_TAGS = Object.values(exports.EXPRESSIVE_TTS_TAG_GROUPS).flat();
function normalizeExpressiveTtsTags(input) {
    const values = input && typeof input === 'object' ? input : {};
    const legacyInline = values.inline;
    const legacyWrapping = values.wrapping;
    return Object.fromEntries(exports.EXPRESSIVE_TTS_TAGS.map(tag => {
        const legacyKey = tag === 'long-pause' ? 'longPause' : tag;
        const value = values[tag] ?? legacyInline?.[legacyKey] ?? legacyWrapping?.[legacyKey];
        return [tag, typeof value === 'boolean' ? value : true];
    }));
}
const ALIASES = {
    anger: 'angry', whispering: 'whisper', laughing: 'laugh', crying: 'cry',
    sighing: 'sigh', loud: 'shouting',
    chuckling: 'chuckle', gasping: 'gasp', 'soft tone': 'soft',
    'crying loudly': 'cry', 'in a hurry tone': 'fast',
    break: 'pause', 'long-break': 'long-pause', 'crowd laughing': 'audience laughing',
};
/** Expand already-filtered cues only at the Fish boundary, after message length limits. */
function reinforceFishTtsTags(text) {
    return text.replace(/\[([a-z -]+)\](?:\s*\[\1\])*/g, (match, tag) => {
        if (!exports.EXPRESSIVE_TTS_TAGS.includes(tag) || match !== `[${tag}]`) {
            return match;
        }
        return `[${tag}] [${tag}]`;
    });
}
function filterExpressiveTtsTags(rawText, options = { provider: 'piper' }) {
    return String(rawText || '')
        .replace(/<\s*(\/?)\s*([a-z][a-z -]*?)\s*>|\[([^\[\]]*)\]/gi, (_match, closing, angleTag, squareTag) => {
        const rawTag = angleTag ?? squareTag;
        const name = (angleTag !== undefined ? rawTag.replace(/\s*-\s*/g, '-') : rawTag).trim().toLowerCase();
        const tag = (Object.hasOwn(ALIASES, name) ? ALIASES[name] : name);
        if (options.provider === 'fish' && exports.EXPRESSIVE_TTS_TAGS.includes(tag)
            && options.enabledTags?.[tag] === true) {
            return angleTag !== undefined ? `<${closing}${tag}>` : `[${tag}]`;
        }
        return angleTag !== undefined ? '' : ' ';
    })
        .replace(/ {2,}/g, ' ')
        .trim();
}
