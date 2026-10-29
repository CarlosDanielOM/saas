import type { IModerationRule } from '../../../schemas/channel_moderation_settings.schema.js';

export interface EmoteSpamEvaluationResult {
    triggered: boolean;
    emoteCount: number;
}

/**
 * Emote spam = the emote analogue of the caps rule. The emote count comes
 * from Twitch's own message fragments (no regex needed): the caller counts
 * fragments with type === 'emote' and passes the number in.
 */
export function evaluateEmoteSpamRule(
    rule: Pick<IModerationRule, 'maxEmoteCount'>,
    input: { emoteCount: number }
): EmoteSpamEvaluationResult {
    const emoteCount = input.emoteCount ?? 0;
    return {
        triggered: emoteCount > rule.maxEmoteCount,
        emoteCount
    };
}
