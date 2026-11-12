//! `string.functions.ts`: `upper`, `lower`, `title`, `capitalize`, `trim`, `length`, `slice`,
//! `replace`. Lengths and positions count characters (an emoji is one), on purpose.
//!
//! Each function gets the budget for its result (`max`, in bytes) and computes the result's
//! size, with checked arithmetic, before it allocates it: a result over the budget is
//! [`TooLong`], and nothing of its size was allocated. The arguments themselves are within the
//! evaluator's budget for the arguments of one call.

use super::{Failure, TooLong};
use crate::value::Value;
use dima_text::{Radix, char_len, parse_int, slice_chars, to_lower, to_upper, trim};
use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

/// `String(arg ?? '')` of each argument from `from`, in order (the first that throws stops).
fn texts(args: &[Value], from: usize) -> Result<Vec<Cow<'_, str>>, Failure> {
    Ok(args
        .iter()
        .skip(from)
        .map(Value::to_text_or_empty)
        .collect::<Result<_, _>>()?)
}

/// `size` when it is within `max`.
fn within(size: Option<usize>, max: usize) -> Result<usize, Failure> {
    Ok(size.filter(|size| *size <= max).ok_or(TooLong)?)
}

/// The size of `parts` joined by spaces.
fn joined_size(parts: &[Cow<'_, str>], max: usize) -> Result<usize, Failure> {
    let mut total = Some(parts.len().saturating_sub(1));
    for part in parts {
        total = total.and_then(|total| total.checked_add(part.len()));
    }
    within(total, max)
}

/// `joinArgs(args, from)`: `String(arg ?? '')` of each argument from `from`, joined by spaces.
pub(crate) fn join_args(args: &[Value], from: usize, max: usize) -> Result<String, Failure> {
    let parts = texts(args, from)?;
    let mut out = String::with_capacity(joined_size(&parts, max)?);
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(part);
    }
    Ok(out)
}

/// The size of `text.toUpperCase()` (the full mapping has no context).
fn upper_size(text: &str) -> Option<usize> {
    text.chars().try_fold(0usize, |total, ch| {
        total.checked_add(ch.to_uppercase().map(char::len_utf8).sum())
    })
}

/// The size of `text.toLowerCase()` (a final sigma has the size of any sigma).
fn lower_size(text: &str) -> Option<usize> {
    text.chars().try_fold(0usize, |total, ch| {
        total.checked_add(ch.to_lowercase().map(char::len_utf8).sum())
    })
}

pub(crate) fn upper(args: &[Value], max: usize) -> Result<String, Failure> {
    let text = join_args(args, 0, max)?;
    within(upper_size(&text), max)?;
    Ok(to_upper(&text))
}

/// `text.toLowerCase()` within `max`.
fn lowered(text: &str, max: usize) -> Result<String, Failure> {
    within(lower_size(text), max)?;
    Ok(to_lower(text))
}

pub(crate) fn lower(args: &[Value], max: usize) -> Result<String, Failure> {
    lowered(&join_args(args, 0, max)?, max)
}

/// `/(?:^|\s)(\p{L})/gu` with JavaScript's `\s` (the `trim` set).
static TITLE_START: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        "(?:^|[\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])(\\p{L})",
    )
    .ok()
});

/// Lowercases, then uppercases each letter at the start or after whitespace.
pub(crate) fn title(args: &[Value], max: usize) -> Result<String, Failure> {
    let text = lowered(&join_args(args, 0, max)?, max)?;
    let Some(regex) = TITLE_START.as_ref() else {
        return Ok(text);
    };
    let mut size = Some(text.len());
    for captures in regex.captures_iter(&text) {
        if let Some(letter) = captures.get(1) {
            let grown = upper_size(letter.as_str()).map(|upper| upper.saturating_sub(letter.len()));
            size = size.and_then(|size| size.checked_add(grown?));
        }
    }
    within(size, max)?;
    Ok(regex
        .replace_all(&text, |captures: &regex::Captures<'_>| {
            let whole = captures.get(0).map_or("", |m| m.as_str());
            let letter = captures.get(1).map_or("", |m| m.as_str());
            match whole.strip_suffix(letter) {
                Some(prefix) => format!("{prefix}{}", to_upper(letter)),
                None => whole.to_owned(),
            }
        })
        .into_owned())
}

/// The first character uppercased. Intended difference: the reference uppercases the first
/// UTF-16 unit, so an astral first letter (Deseret `𐐨`, Adlam…) stayed lowercase there.
pub(crate) fn capitalize(args: &[Value], max: usize) -> Result<String, Failure> {
    let text = join_args(args, 0, max)?;
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return Ok(String::new());
    };
    let first = first.encode_utf8(&mut [0; 4]).to_owned();
    let rest = chars.as_str();
    within(
        upper_size(&first).and_then(|upper| upper.checked_add(rest.len())),
        max,
    )?;
    let mut out = to_upper(&first);
    out.push_str(rest);
    Ok(out)
}

pub(crate) fn trim_text(args: &[Value], max: usize) -> Result<String, Failure> {
    Ok(trim(&join_args(args, 0, max)?).to_owned())
}

/// Characters, not UTF-16 units (intended difference for text outside the BMP). Counted
/// without joining.
pub(crate) fn length(args: &[Value]) -> Result<String, Failure> {
    let parts = texts(args, 0)?;
    let spaces = parts.len().saturating_sub(1);
    let chars = parts
        .iter()
        .fold(spaces, |total, part| total.saturating_add(char_len(part)));
    Ok(chars.to_string())
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
pub(crate) fn slice(args: &[Value], max: usize) -> Result<String, Failure> {
    let token = |at: usize| -> Result<String, Failure> {
        Ok(match args.get(at) {
            Some(arg) => trim(&arg.to_text_or_empty()?).to_owned(),
            None => String::new(),
        })
    };
    let take_number = |at: usize| -> Result<(Option<String>, usize), Failure> {
        let current = token(at)?;
        if current == "-" {
            let next = token(at + 1)?;
            if is_integer_text(&next) {
                return Ok((Some(format!("-{next}")), at + 2));
            }
        }
        if is_integer_text(&current) {
            return Ok((Some(current), at + 1));
        }
        Ok((None, at))
    };
    let (Some(start), next) = take_number(0)? else {
        return Ok(String::new());
    };
    let (end, rest) = take_number(next)?;
    let text = join_args(args, rest, max)?;
    let length = char_len(&text);
    let start = slice_index(&start, length, 0);
    let end = end.map_or(length, |end| slice_index(&end, length, length));
    Ok(slice_chars(&text, start, end).to_owned())
}

/// `$(replace search replacement text…)`: literal, every occurrence (`split(search)` then
/// `join(replacement)`: non-overlapping matches, left to right). The result's size is
/// `text − n × search + n × replacement` for `n` matches, checked before it is built.
pub(crate) fn replace(args: &[Value], max: usize) -> Result<String, Failure> {
    let text_at = |at: usize| match args.get(at) {
        Some(arg) => arg.to_text_or_empty(),
        None => Ok(Cow::Borrowed("")),
    };
    let search = text_at(0)?;
    let replacement = text_at(1)?;
    let text = join_args(args, 2, max)?;
    if search.is_empty() || text.is_empty() {
        return Ok(text);
    }
    let matches = text.matches(search.as_ref()).count();
    let size = matches
        .checked_mul(search.len())
        .and_then(|removed| text.len().checked_sub(removed))
        .and_then(|kept| {
            matches
                .checked_mul(replacement.len())
                .and_then(|added| kept.checked_add(added))
        });
    let mut out = String::with_capacity(within(size, max)?);
    let mut last = 0;
    for (at, found) in text.match_indices(search.as_ref()) {
        out.push_str(text.get(last..at).unwrap_or_default());
        out.push_str(&replacement);
        last = at + found.len();
    }
    out.push_str(text.get(last..).unwrap_or_default());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: usize = 1 << 20;

    fn args(items: &[&str]) -> Vec<Value> {
        items.iter().map(|s| Value::text(*s)).collect()
    }

    #[test]
    fn string_functions() {
        assert_eq!(upper(&args(&["straße", "x"]), MAX).unwrap(), "STRASSE X");
        assert_eq!(
            title(&args(&["hello WORLD", "émile"]), MAX).unwrap(),
            "Hello World Émile"
        );
        assert_eq!(
            title(&args(&["a1 b\u{feff}c\u{85}d"]), MAX).unwrap(),
            "A1 B\u{feff}C\u{85}d"
        );
        assert_eq!(capitalize(&args(&["𐐨bc"]), MAX).unwrap(), "𐐀bc");
        assert_eq!(capitalize(&args(&[]), MAX).unwrap(), "");
        assert_eq!(length(&args(&["😀", "é"])).unwrap(), "3");
        assert_eq!(
            slice(&args(&["0", "5", "hello", "world"]), MAX).unwrap(),
            "hello"
        );
        assert_eq!(
            slice(&args(&["-", "5", "hello", "world"]), MAX).unwrap(),
            "world"
        );
        assert_eq!(slice(&args(&["1", "😀😃😄"]), MAX).unwrap(), "😃😄");
        assert_eq!(slice(&args(&["x", "abc"]), MAX).unwrap(), "");
        assert_eq!(slice(&args(&["3", "1", "abcdef"]), MAX).unwrap(), "");
        assert_eq!(
            replace(&args(&["a", "o", "banana"]), MAX).unwrap(),
            "bonono"
        );
        assert_eq!(replace(&args(&["", "o", "banana"]), MAX).unwrap(), "banana");
        assert_eq!(trim_text(&args(&["  x  "]), MAX).unwrap(), "x");
    }
}
