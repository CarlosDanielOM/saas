//! Lengths and cuts in characters (Unicode scalar values), the default unit for user text.

use std::borrow::Cow;

/// Number of characters (Unicode scalar values) in `text`: the length rule for user text.
pub fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// Byte index where character `index` starts; `text.len()` when `index` is at or past the end.
pub fn char_to_byte(text: &str, index: usize) -> usize {
    text.char_indices()
        .nth(index)
        .map_or(text.len(), |(byte, _)| byte)
}

/// The first `max_chars` characters of `text`.
pub fn truncate_chars(text: &str, max_chars: usize) -> &str {
    prefix(text, char_to_byte(text, max_chars))
}

/// Characters `start..end` of `text`, each index clamped to the length; empty when `start >= end`.
pub fn slice_chars(text: &str, start: usize, end: usize) -> &str {
    if start >= end {
        return "";
    }
    let rest = text.get(char_to_byte(text, start)..).unwrap_or_default();
    truncate_chars(rest, end - start)
}

/// The longest prefix of `text` of at most `max_bytes` bytes that ends on a character boundary.
pub fn truncate_bytes(text: &str, max_bytes: usize) -> &str {
    prefix(text, text.floor_char_boundary(max_bytes))
}

/// `text.padStart(width, fill)` with `width` counted in characters (JavaScript counts UTF-16 units).
///
/// Borrows when no padding is needed or `fill` is empty.
pub fn pad_start<'a>(text: &'a str, width: usize, fill: &str) -> Cow<'a, str> {
    match padding(text, width, fill) {
        Some(pad) => Cow::Owned(pad + text),
        None => Cow::Borrowed(text),
    }
}

/// `text.padEnd(width, fill)` with `width` counted in characters (JavaScript counts UTF-16 units).
///
/// Borrows when no padding is needed or `fill` is empty.
pub fn pad_end<'a>(text: &'a str, width: usize, fill: &str) -> Cow<'a, str> {
    match padding(text, width, fill) {
        Some(pad) => Cow::Owned(String::from(text) + &pad),
        None => Cow::Borrowed(text),
    }
}

/// The `fill` repetitions (cut to whole characters) that bring `text` to `width` characters.
fn padding(text: &str, width: usize, fill: &str) -> Option<String> {
    let missing = width.saturating_sub(char_len(text));
    if missing == 0 || fill.is_empty() {
        return None;
    }
    Some(fill.chars().cycle().take(missing).collect())
}

/// `text[..end]` for an `end` known to be a character boundary.
fn prefix(text: &str, end: usize) -> &str {
    text.get(..end).unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_cuts_whole_characters() {
        let text = "a😀e\u{301}ש";
        assert_eq!(char_len(text), 5);
        assert_eq!(char_to_byte(text, 0), 0);
        assert_eq!(char_to_byte(text, 2), 5);
        assert_eq!(char_to_byte(text, 5), text.len());
        assert_eq!(char_to_byte(text, 99), text.len());
        assert_eq!(truncate_chars(text, 2), "a😀");
        assert_eq!(truncate_chars(text, 0), "");
        assert_eq!(truncate_chars(text, 99), text);
        assert_eq!(slice_chars(text, 1, 3), "😀e");
        assert_eq!(slice_chars(text, 3, 99), "\u{301}ש");
        assert_eq!(slice_chars(text, 4, 2), "");
        assert_eq!(slice_chars(text, 9, 12), "");
    }

    #[test]
    fn byte_budgets_never_split_a_character() {
        let text = "a😀b";
        assert_eq!(truncate_bytes(text, 0), "");
        assert_eq!(truncate_bytes(text, 1), "a");
        assert_eq!(truncate_bytes(text, 4), "a");
        assert_eq!(truncate_bytes(text, 5), "a😀");
        assert_eq!(truncate_bytes(text, 99), text);
    }

    #[test]
    fn padding_counts_characters_and_repeats_the_fill() {
        // `String(ms).padStart(13, '0')`: JavaScript pads in front of the minus sign.
        assert_eq!(pad_start("-1", 13, "0"), "00000000000-1");
        assert_eq!(pad_start("1700000000000", 13, "0"), "1700000000000");
        assert_eq!(pad_start("-1000000000000", 13, "0"), "-1000000000000");
        assert_eq!(pad_start("abc", 10, "123"), "1231231abc");
        assert_eq!(pad_end("abc", 6, "😀ab"), "abc😀ab");
        assert_eq!(pad_end("😀", 3, "-"), "😀--");
        assert!(matches!(pad_start("abc", 10, ""), Cow::Borrowed("abc")));
        assert!(matches!(pad_end("abc", 2, "x"), Cow::Borrowed("abc")));
    }
}
