//! The caps rule (reference `utils/moderation/rules/caps.rule.ts`).
//!
//! Counts are of characters (`for (const char of text)` iterates code points, as Rust's `chars`
//! does), so the ratio and both thresholds are the reference's exactly; nothing here counts
//! UTF-16 units.

use super::unicode::{is_letter, is_uppercase_letter};

/// How the threshold is read (`capsThresholdMode`): anything but `percentage` is a count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapsThresholdMode {
    /// `minCapsCount` capitals or more.
    Count,
    /// `maxCapsPercentage` percent of the letters or more.
    Percentage,
}

/// The rule's settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CapsSettings {
    /// `capsThresholdMode`.
    pub mode: CapsThresholdMode,
    /// `minCapsCount`.
    pub min_caps_count: f64,
    /// `maxCapsPercentage`.
    pub max_caps_percentage: f64,
    /// `minMessageLength`, in letters.
    pub min_message_length: f64,
}

/// `evaluateCapsRule`'s result.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CapsResult {
    /// The rule fired.
    pub triggered: bool,
    /// Uppercase letters (`\p{Lu}`).
    pub caps_count: usize,
    /// Letters (`\p{L}`).
    pub letter_count: usize,
    /// `caps / letters * 100`, 0 without letters.
    pub caps_percentage: f64,
}

/// `stripEmoteTexts`: every occurrence of each emote's text replaced with a space, in order.
pub fn strip_emote_texts<S: AsRef<str>>(text: &str, emote_texts: &[S]) -> String {
    let mut result = text.to_owned();
    for emote in emote_texts {
        let emote = emote.as_ref();
        if emote.is_empty() {
            continue;
        }
        // `split(emote).join(' ')`: non-overlapping, left to right, as `replace` does.
        if result.contains(emote) {
            result = result.replace(emote, " ");
        }
    }
    result
}

/// `evaluateCapsRule`.
pub fn evaluate_caps<S: AsRef<str>>(
    settings: &CapsSettings,
    text: &str,
    emote_texts: &[S],
) -> CapsResult {
    let text = strip_emote_texts(text, emote_texts);
    let mut caps_count = 0_usize;
    let mut letter_count = 0_usize;
    for ch in text.chars() {
        if !is_letter(ch) {
            continue;
        }
        letter_count += 1;
        if is_uppercase_letter(ch) {
            caps_count += 1;
        }
    }
    #[allow(clippy::cast_precision_loss)]
    let caps_percentage = if letter_count == 0 {
        0.0
    } else {
        (caps_count as f64 / letter_count as f64) * 100.0
    };
    #[allow(clippy::cast_precision_loss)]
    let letters = letter_count as f64;
    #[allow(clippy::cast_precision_loss)]
    let caps = caps_count as f64;
    let triggered = if letters < settings.min_message_length {
        false
    } else {
        match settings.mode {
            CapsThresholdMode::Percentage => caps_percentage >= settings.max_caps_percentage,
            CapsThresholdMode::Count => caps >= settings.min_caps_count,
        }
    };
    CapsResult {
        triggered,
        caps_count,
        letter_count,
        caps_percentage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: CapsSettings = CapsSettings {
        mode: CapsThresholdMode::Count,
        min_caps_count: 8.0,
        max_caps_percentage: 70.0,
        min_message_length: 10.0,
    };
    const PERCENT: CapsSettings = CapsSettings {
        mode: CapsThresholdMode::Percentage,
        ..BASE
    };
    const NONE: [&str; 0] = [];

    // Reference: rules/caps.rule.test.ts.
    #[test]
    fn count_mode_triggers_when_caps_count_reaches_the_threshold() {
        let result = evaluate_caps(&BASE, "THIS IS WAY TOO LOUD", &NONE);
        assert!(result.triggered);
        assert_eq!((result.caps_count, result.letter_count), (16, 16));
    }

    #[test]
    fn count_mode_does_not_trigger_below_the_threshold() {
        let result = evaluate_caps(&BASE, "HELLO how are you today friend", &NONE);
        assert!(!result.triggered);
        assert_eq!(result.caps_count, 5);
    }

    #[test]
    fn count_mode_ignores_digits_and_symbols() {
        let result = evaluate_caps(&BASE, "GG123!!!????", &NONE);
        assert!(!result.triggered);
        assert_eq!(result.letter_count, 2);
    }

    #[test]
    fn short_all_caps_messages_never_trigger() {
        assert!(!evaluate_caps(&BASE, "GG", &NONE).triggered);
        assert!(!evaluate_caps(&BASE, "LOL OMG", &NONE).triggered);
    }

    #[test]
    fn percentage_mode() {
        let result = evaluate_caps(&PERCENT, "THIS IS MOSTLY CAPS now ok", &NONE);
        assert!(result.triggered && result.caps_percentage >= 70.0);
        let quiet = "This is a totally normal sentence with A FEW caps words";
        assert!(!evaluate_caps(&PERCENT, quiet, &NONE).triggered);
        let short = evaluate_caps(&PERCENT, "LOL", &NONE);
        assert!(!short.triggered);
        assert!((short.caps_percentage - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn unicode_letters() {
        let result = evaluate_caps(&BASE, "ÁÉÍÓÚ ÜÑÇ ĤÊĽĻÕ", &NONE);
        assert!(result.triggered && result.caps_count == result.letter_count);
        let lower = evaluate_caps(&BASE, "áéíóú üñç ça va très bien", &NONE);
        assert!(!lower.triggered && lower.caps_count == 0);
        // Astral capitals count once each, as `for...of` counts them.
        let astral = evaluate_caps(&BASE, "𐐀𐐀𐐀𐐀𐐀𐐀𐐀𐐀𐐀𐐀", &NONE);
        assert_eq!((astral.caps_count, astral.letter_count), (10, 10));
        // Combining marks are not letters; title case `ǅ` is not uppercase.
        let marks = evaluate_caps(&BASE, "E\u{301}ǅ", &NONE);
        assert_eq!((marks.caps_count, marks.letter_count), (1, 2));
    }

    #[test]
    fn emotes_are_stripped_before_counting() {
        let result = evaluate_caps(
            &BASE,
            "KAPPA KAPPA KAPPA KAPPA hello there friend",
            &["KAPPA"],
        );
        assert!(!result.triggered);
        assert_eq!(result.caps_count, 0);
        assert_eq!(strip_emote_texts("HELLO WORLD", &NONE), "HELLO WORLD");
        assert_eq!(strip_emote_texts("KAPPA hello", &["KAPPA"]), "  hello");
        assert_eq!(strip_emote_texts("aaaa", &["aa", ""]), "  ");
    }

    #[test]
    fn empty_message_never_triggers() {
        let result = evaluate_caps(&BASE, "", &NONE);
        assert!(!result.triggered);
        assert_eq!(result.letter_count, 0);
    }
}
