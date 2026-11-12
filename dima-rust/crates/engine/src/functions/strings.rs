//! `string.functions.ts`: `upper`, `lower`, `title`, `capitalize`, `trim`, `length`, `slice`,
//! `replace`. Lengths and positions count characters (an emoji is one), on purpose.

use crate::value::Value;
use dima_text::{Radix, char_len, parse_int, slice_chars, to_lower, to_upper, trim};
use regex::Regex;
use std::sync::LazyLock;

/// `joinArgs(args, from)`: `String(arg ?? '')` of each argument from `from`, joined by spaces.
pub(crate) fn join_args(args: &[Value], from: usize) -> String {
    let mut out = String::new();
    for (index, arg) in args.iter().skip(from).enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(&arg.to_text_or_empty());
    }
    out
}

pub(crate) fn upper(args: &[Value]) -> String {
    to_upper(&join_args(args, 0))
}

pub(crate) fn lower(args: &[Value]) -> String {
    to_lower(&join_args(args, 0))
}

/// `/(?:^|\s)(\p{L})/gu` with JavaScript's `\s` (the `trim` set).
static TITLE_START: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        "(?:^|[\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])(\\p{L})",
    )
    .ok()
});

/// Lowercases, then uppercases each letter at the start or after whitespace.
pub(crate) fn title(args: &[Value]) -> String {
    let text = to_lower(&join_args(args, 0));
    let Some(regex) = TITLE_START.as_ref() else {
        return text;
    };
    regex
        .replace_all(&text, |captures: &regex::Captures<'_>| {
            let whole = captures.get(0).map_or("", |m| m.as_str());
            let letter = captures.get(1).map_or("", |m| m.as_str());
            match whole.strip_suffix(letter) {
                Some(prefix) => format!("{prefix}{}", to_upper(letter)),
                None => whole.to_owned(),
            }
        })
        .into_owned()
}

/// The first character uppercased. Intended difference: the reference uppercases the first
/// UTF-16 unit, so an astral first letter (Deseret `𐐨`, Adlam…) stayed lowercase there.
pub(crate) fn capitalize(args: &[Value]) -> String {
    let text = join_args(args, 0);
    let mut chars = text.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut out = to_upper(first.encode_utf8(&mut [0; 4]));
            out.push_str(chars.as_str());
            out
        }
    }
}

pub(crate) fn trim_text(args: &[Value]) -> String {
    trim(&join_args(args, 0)).to_owned()
}

/// Characters, not UTF-16 units (intended difference for text outside the BMP).
pub(crate) fn length(args: &[Value]) -> String {
    char_len(&join_args(args, 0)).to_string()
}

/// `/^-?\d+$/` on the trimmed text.
fn is_integer_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `resolveSliceIndex`: negative counts from the end; clamped to the text.
fn slice_index(raw: &str, length: usize, fallback: usize) -> usize {
    let index = parse_int(raw, Radix::Decimal);
    if !index.is_finite() {
        return fallback;
    }
    let length_f = length as f64;
    let index = if index < 0.0 { length_f + index } else { index };
    index.clamp(0.0, length_f) as usize
}

/// `$(slice start [end] text…)`: numbers first (a separate `-` before a number is its sign),
/// then the text, cut by character.
pub(crate) fn slice(args: &[Value]) -> String {
    let token = |at: usize| -> String {
        args.get(at)
            .map(|arg| trim(&arg.to_text_or_empty()).to_owned())
            .unwrap_or_default()
    };
    let take_number = |at: usize| -> (Option<String>, usize) {
        let current = token(at);
        if current == "-" {
            let next = token(at + 1);
            if is_integer_text(&next) {
                return (Some(format!("-{next}")), at + 2);
            }
        }
        if is_integer_text(&current) {
            return (Some(current), at + 1);
        }
        (None, at)
    };
    let (Some(start), next) = take_number(0) else {
        return String::new();
    };
    let (end, rest) = take_number(next);
    let text = join_args(args, rest);
    let length = char_len(&text);
    let start = slice_index(&start, length, 0);
    let end = end.map_or(length, |end| slice_index(&end, length, length));
    slice_chars(&text, start, end).to_owned()
}

/// `$(replace search replacement text…)`: literal, every occurrence.
pub(crate) fn replace(args: &[Value]) -> String {
    let search = args
        .first()
        .map(|v| v.to_text_or_empty())
        .unwrap_or_default();
    let replacement = args
        .get(1)
        .map(|v| v.to_text_or_empty())
        .unwrap_or_default();
    let text = join_args(args, 2);
    if search.is_empty() || text.is_empty() {
        return text;
    }
    text.replace(search.as_ref(), &replacement)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<Value> {
        items.iter().map(|s| Value::text(*s)).collect()
    }

    #[test]
    fn string_functions() {
        assert_eq!(upper(&args(&["straße", "x"])), "STRASSE X");
        assert_eq!(title(&args(&["hello WORLD", "émile"])), "Hello World Émile");
        assert_eq!(
            title(&args(&["a1 b\u{feff}c\u{85}d"])),
            "A1 B\u{feff}C\u{85}d"
        );
        assert_eq!(capitalize(&args(&["𐐨bc"])), "𐐀bc");
        assert_eq!(capitalize(&args(&[])), "");
        assert_eq!(length(&args(&["😀", "é"])), "3");
        assert_eq!(slice(&args(&["0", "5", "hello", "world"])), "hello");
        assert_eq!(slice(&args(&["-", "5", "hello", "world"])), "world");
        assert_eq!(slice(&args(&["1", "😀😃😄"])), "😃😄");
        assert_eq!(slice(&args(&["x", "abc"])), "");
        assert_eq!(slice(&args(&["3", "1", "abcdef"])), "");
        assert_eq!(replace(&args(&["a", "o", "banana"])), "bonono");
        assert_eq!(replace(&args(&["", "o", "banana"])), "banana");
        assert_eq!(trim_text(&args(&["  x  "])), "x");
    }
}
