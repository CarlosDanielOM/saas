import type { IModerationRule } from '../../../schemas/channel_moderation_settings.schema.js';

export interface CapsEvaluationInput {
    text: string;
    emoteTexts?: string[];
}

export interface CapsEvaluationResult {
    triggered: boolean;
    capsCount: number;
    letterCount: number;
    capsPercentage: number;
}

const UPPERCASE_LETTER = /\p{Lu}/u;
const LETTER = /\p{L}/u;

/**
 * Strips Twitch emote names from the raw message text. Emote codes like
 * "KAPPA" or "PogChamp" would otherwise inflate the caps count.
 */
export function stripEmoteTexts(text: string, emoteTexts: string[] | undefined): string {
    if (!emoteTexts || emoteTexts.length === 0) return text;

    let result = text;
    for (const emoteText of emoteTexts) {
        if (!emoteText) continue;
        result = result.split(emoteText).join(' ');
    }
    return result;
}

/**
 * Pure caps-rule evaluation. Unicode-aware: only letters (\p{L}) count toward
 * the message length, and only uppercase letters (\p{Lu}) count as caps.
 * Digits, symbols and emotes never affect the result, so "GG", "!!!" or pure
 * emote messages can't trigger the rule.
 */
export function evaluateCapsRule(
    rule: Pick<IModerationRule, 'capsThresholdMode' | 'minCapsCount' | 'maxCapsPercentage' | 'minMessageLength'>,
    input: CapsEvaluationInput
): CapsEvaluationResult {
    const text = stripEmoteTexts(input.text ?? '', input.emoteTexts);

    let capsCount = 0;
    let letterCount = 0;

    for (const char of text) {
        if (!LETTER.test(char)) continue;
        letterCount++;
        if (UPPERCASE_LETTER.test(char)) capsCount++;
    }

    const capsPercentage = letterCount === 0 ? 0 : (capsCount / letterCount) * 100;

    if (letterCount < rule.minMessageLength) {
        return { triggered: false, capsCount, letterCount, capsPercentage };
    }

    const triggered = rule.capsThresholdMode === 'percentage'
        ? capsPercentage >= rule.maxCapsPercentage
        : capsCount >= rule.minCapsCount;

    return { triggered, capsCount, letterCount, capsPercentage };
}
