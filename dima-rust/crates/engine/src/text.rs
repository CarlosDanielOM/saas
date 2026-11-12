//! Checked byte-offset access to source text.
//!
//! Offsets come from the scanners in this crate and always sit on character boundaries; the
//! checked forms keep a bug from ever panicking on user text (an off-boundary range reads as
//! empty instead).

use std::ops::Range;

/// `text[range]`, or `""` when the range is out of bounds or off a character boundary.
pub(crate) fn sub(text: &str, range: Range<usize>) -> &str {
    text.get(range).unwrap_or_default()
}

/// `text[at..]`, or `""`.
pub(crate) fn rest(text: &str, at: usize) -> &str {
    text.get(at..).unwrap_or_default()
}

/// The byte at `at`, or 0 past the end (0 never matches any syntax byte).
pub(crate) fn byte(text: &str, at: usize) -> u8 {
    text.as_bytes().get(at).copied().unwrap_or(0)
}

/// The offset just after the character starting at `at` (`text.len()` at or past the end).
pub(crate) fn next_char(text: &str, at: usize) -> usize {
    rest(text, at)
        .chars()
        .next()
        .map_or(text.len(), |ch| at + ch.len_utf8())
}

/// The character starting at `at`.
pub(crate) fn char_at(text: &str, at: usize) -> Option<char> {
    rest(text, at).chars().next()
}

/// Whether the text at `at`, read no further than `end`, starts with `needle`.
pub(crate) fn starts_with_at(text: &str, at: usize, end: usize, needle: &str) -> bool {
    sub(text, at..end).starts_with(needle)
}
