import type { IModerationRule } from '../../../schemas/channel_moderation_settings.schema.js';
import { escapeRegExp, foldText } from '../normalize.js';

export interface BlacklistEvaluationResult {
    triggered: boolean;
    matchedText: string | null;
}

/**
 * Compiles a rule's terms into a single whole-word regex. Terms are
 * accent-folded at compile time; the message is folded at evaluation time,
 * so "café" in the list matches "Cafe" in chat and vice versa.
 * Whole-word boundaries use Unicode letter/number lookarounds so a listed
 * word never matches inside a longer word ("ass" does not flag "classic"),
 * while multi-word phrases still work.
 */
export function compileBlacklistPattern(terms: string[] | undefined): RegExp | null {
    const folded = (terms || [])
        .map(term => foldText(term).trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

    if (folded.length === 0) return null;

    const alternation = folded
        .map(term => escapeRegExp(term).replace(/\s+/g, '\\s+'))
        .join('|');

    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'iu');
}

export function evaluateBlacklistRule(
    _rule: Pick<IModerationRule, 'terms'>,
    input: { text: string },
    pattern: RegExp | null
): BlacklistEvaluationResult {
    if (!pattern) return { triggered: false, matchedText: null };

    const match = pattern.exec(foldText(input.text ?? ''));
    return {
        triggered: match !== null,
        matchedText: match ? match[0] : null
    };
}
