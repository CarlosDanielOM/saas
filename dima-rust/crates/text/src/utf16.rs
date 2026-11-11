//! UTF-16 *numbers*, computed on UTF-8 text.
//!
//! These exist only for the contract rows of `MIGRATION.md` section 4 (money counts, identity
//! cuts, limits that mirror an outside API, positions stored or sent to a client). Everything
//! else counts characters (see `char_len`).

/// Length in UTF-16 code units: JavaScript `.length`.
pub fn utf16_len(text: &str) -> usize {
    // One unit per character, plus one more for each four-byte (astral) character.
    text.bytes()
        .map(|byte| usize::from(byte & 0xc0 != 0x80) + usize::from(byte >= 0xf0))
        .sum()
}

/// The UTF-16 offset of byte offset `byte` in `text`.
///
/// A byte inside a character rounds down to that character's start; offsets past the end clamp
/// to the UTF-16 length.
pub fn utf16_offset(text: &str, byte: usize) -> usize {
    utf16_len(text.get(..text.floor_char_boundary(byte)).unwrap_or(text))
}

/// The byte offset of UTF-16 offset `unit` in `text`.
///
/// An offset inside a surrogate pair rounds down to the character's start; offsets past the end
/// clamp to `text.len()`.
pub fn utf16_to_byte(text: &str, unit: usize) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > unit {
            return byte;
        }
    }
    text.len()
}

/// The longest prefix of `text` that fits in `max_units` UTF-16 units.
///
/// It ends where JavaScript `text.slice(0, max_units)` ends, except that a character that does
/// not fit entirely is dropped: the cut never lands inside a surrogate pair.
pub fn truncate_utf16_budget(text: &str, max_units: usize) -> &str {
    text.get(..utf16_to_byte(text, max_units)).unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_count_astral_characters_twice() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("ñ"), 1);
        assert_eq!(utf16_len("中"), 1);
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(utf16_len("👍🏽"), 4);
        assert_eq!(utf16_len("e\u{301}"), 2);
    }

    #[test]
    fn offsets_round_down_inside_a_character() {
        let text = "a😀b";
        assert_eq!(utf16_offset(text, 0), 0);
        assert_eq!(utf16_offset(text, 1), 1);
        assert_eq!(utf16_offset(text, 2), 1);
        assert_eq!(utf16_offset(text, 4), 1);
        assert_eq!(utf16_offset(text, 5), 3);
        assert_eq!(utf16_offset(text, 6), 4);
        assert_eq!(utf16_offset(text, 60), 4);
        assert_eq!(utf16_to_byte(text, 0), 0);
        assert_eq!(utf16_to_byte(text, 1), 1);
        assert_eq!(utf16_to_byte(text, 2), 1);
        assert_eq!(utf16_to_byte(text, 3), 5);
        assert_eq!(utf16_to_byte(text, 4), 6);
        assert_eq!(utf16_to_byte(text, 40), 6);
    }

    // Ported from `re2_compat::whole_word_guard_reports_the_inner_word_in_utf16`.
    #[test]
    fn a_match_after_an_emoji_reports_its_javascript_offset() {
        let text = "😀 no spam here";
        let start = text.find("spam").unwrap_or_default();
        assert_eq!(utf16_offset(text, start), 6);
        assert_eq!(utf16_offset(text, start + 4), 10);
    }

    // Restates the old `JsText::sliced` tests (dashboard insights and activity, AI usage
    // receipts): the 100/128-unit identity cuts no longer keep half of a surrogate pair.
    #[test]
    fn budgets_drop_a_character_that_does_not_fit() {
        let key = format!("{}😀", "x".repeat(99));
        assert_eq!(truncate_utf16_budget(&key, 100), "x".repeat(99));
        assert_eq!(truncate_utf16_budget(&key, 101), key);
        let receipt = "😀".repeat(65);
        assert_eq!(utf16_len(truncate_utf16_budget(&receipt, 128)), 128);
        let odd = format!("x{receipt}");
        assert_eq!(utf16_len(truncate_utf16_budget(&odd, 128)), 127);
        assert_eq!(truncate_utf16_budget("abc", 0), "");
        assert_eq!(truncate_utf16_budget("abc", 9), "abc");
    }
}
