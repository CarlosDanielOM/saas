//! The emote-spam rule (reference `utils/moderation/rules/emote_spam.rule.ts`). The count is
//! the number of Twitch's `emote` fragments of the message, never parsed from its text.

/// `evaluateEmoteSpamRule`: more emotes than `max_emote_count`.
pub fn evaluate_emote_spam(max_emote_count: f64, emote_count: usize) -> bool {
    #[allow(clippy::cast_precision_loss)]
    let count = emote_count as f64;
    count > max_emote_count
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reference: rules/emote_spam_blacklist.rule.test.ts.
    #[test]
    fn triggers_only_above_the_max_count() {
        assert!(evaluate_emote_spam(10.0, 11));
        assert!(!evaluate_emote_spam(10.0, 10));
        assert!(!evaluate_emote_spam(10.0, 3));
        assert!(!evaluate_emote_spam(10.0, 0));
        assert!(!evaluate_emote_spam(f64::NAN, 1000));
    }
}
