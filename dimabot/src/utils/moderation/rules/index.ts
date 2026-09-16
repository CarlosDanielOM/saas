import type { IModerationRule } from '../../../schemas/channel_moderation_settings.schema.js';
import { evaluateCapsRule } from './caps.rule.js';
import { evaluateLinksRule } from './links.rule.js';
import { evaluateEmoteSpamRule } from './emote_spam.rule.js';
import { evaluateBlacklistRule } from './blacklist.rule.js';

export interface ModerationRuleInput {
    text: string;
    emoteCount: number;
    emoteTexts: string[];
}

export interface ModerationRuleResult {
    triggered: boolean;
    detail: string;
}

/**
 * Single entry point for rule evaluation. Adding a rule type means a new
 * evaluator file plus one case here — the handler and schema stay untouched.
 * Blacklist rules receive a pre-compiled pattern from the handler's cache.
 */
export function evaluateRule(
    rule: IModerationRule,
    input: ModerationRuleInput,
    blacklistPattern?: RegExp | null
): ModerationRuleResult {
    switch (rule.type) {
        case 'caps': {
            const result = evaluateCapsRule(rule, { text: input.text, emoteTexts: input.emoteTexts });
            return {
                triggered: result.triggered,
                detail: `caps=${result.capsCount}/${result.letterCount} (${result.capsPercentage.toFixed(0)}%)`
            };
        }
        case 'links': {
            const result = evaluateLinksRule(rule, { text: input.text });
            return {
                triggered: result.triggered,
                detail: result.blockedUrl ? `blocked url: ${result.blockedUrl}` : 'no blocked urls'
            };
        }
        case 'emote_spam': {
            const result = evaluateEmoteSpamRule(rule, { emoteCount: input.emoteCount });
            return {
                triggered: result.triggered,
                detail: `emotes=${result.emoteCount}/${rule.maxEmoteCount}`
            };
        }
        case 'blacklist': {
            const result = evaluateBlacklistRule(rule, { text: input.text }, blacklistPattern ?? null);
            return {
                triggered: result.triggered,
                detail: result.matchedText ? 'matched blacklisted term' : 'no match'
            };
        }
        default:
            return { triggered: false, detail: 'unknown rule type' };
    }
}
