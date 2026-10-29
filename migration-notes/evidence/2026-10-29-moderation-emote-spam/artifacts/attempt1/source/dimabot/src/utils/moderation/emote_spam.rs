//! Pure counterpart of `evaluateEmoteSpamRule`.

/// The required field selected by `Pick<IModerationRule, 'maxEmoteCount'>`.
#[derive(Debug, Clone, Copy)]
pub struct EmoteSpamRule {
    pub max_emote_count: f64,
}

/// `None` represents a nullish count (null or absent); typed callers pass `Some`.
#[derive(Debug, Clone, Copy)]
pub struct EmoteSpamInput {
    pub emote_count: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EmoteSpamEvaluationResult {
    pub triggered: bool,
    pub emote_count: f64,
}

pub fn evaluate_emote_spam_rule(
    rule: EmoteSpamRule,
    input: EmoteSpamInput,
) -> EmoteSpamEvaluationResult {
    let emote_count = input.emote_count.unwrap_or(0.0);
    EmoteSpamEvaluationResult {
        triggered: emote_count > rule.max_emote_count,
        emote_count,
    }
}
