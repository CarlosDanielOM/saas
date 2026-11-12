//! The reference's name rules (the regular expressions of `validate.ts`, `from_ast.ts` and
//! `to_source.ts`). Lengths count characters.

use regex::Regex;
use std::sync::LazyLock;

/// `/^[\p{L}\p{N}_]{1,64}$/u`.
static VAR_NAME: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_]{1,64}$").ok());

/// `/^[\p{L}\p{N}_@!&¡¿]+$/u`: text that needs no quotes inside an expression.
static BARE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_@!&¡¿]+$").ok());

fn matches(regex: &LazyLock<Option<Regex>>, text: &str) -> bool {
    // The patterns are constants; a pattern that failed to build matches nothing.
    regex.as_ref().is_some_and(|regex| regex.is_match(text))
}

/// A variable name: 1 to 64 letters, digits or `_`, in any script.
pub(crate) fn var_name(text: &str) -> bool {
    matches(&VAR_NAME, text)
}

/// Bare text inside an expression (before the reserved-word check).
pub(crate) fn bare_word(text: &str) -> bool {
    matches(&BARE, text)
}

fn identifier_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn identifier_rest(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn identifier(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes.next().is_some_and(identifier_start) && bytes.all(identifier_rest)
}

/// `/^[A-Za-z_][A-Za-z0-9_]{0,31}$/`.
pub(crate) fn loop_name(text: &str) -> bool {
    text.len() <= 32 && identifier(text)
}

/// `/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/`.
pub(crate) fn function_name(text: &str) -> bool {
    text.split('.').all(identifier)
}

/// `/^[^\s()"\\]{1,60}$/`: 1 to 60 characters, none of them JavaScript whitespace,
/// parentheses, a double quote or a backslash.
pub(crate) fn command_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 60 * 4
        && dima_text::char_len(text) <= 60
        && !text
            .chars()
            .any(|c| dima_text::is_js_whitespace(c) || matches!(c, '(' | ')' | '"' | '\\'))
}

/// `/^[\w-]{1,64}$/`: an editor id.
pub(crate) fn block_id(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `n.toString(36)`.
pub(crate) fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_reference_patterns() {
        assert!(var_name("deaths"));
        assert!(var_name("puntos_ñ"));
        assert!(var_name("𐐀"));
        assert!(var_name(&"𐐀".repeat(64)));
        assert!(!var_name(&"𐐀".repeat(65)));
        assert!(!var_name("bad name"));
        assert!(!var_name(""));
        assert!(!var_name("e\u{301}"), "a combining mark is \\p{{M}}, not \\p{{L}}");
        assert!(loop_name("i"));
        assert!(loop_name(&"a".repeat(32)));
        assert!(!loop_name(&"a".repeat(33)));
        assert!(!loop_name("1i"));
        assert!(function_name("raid.channel"));
        assert!(!function_name("raid..channel"));
        assert!(!function_name(""));
        assert!(!function_name(".x"));
        assert!(command_name("so"));
        assert!(command_name(&"😀".repeat(60)));
        assert!(!command_name(&"😀".repeat(61)));
        assert!(!command_name("a b"));
        assert!(!command_name("a\u{3000}b"));
        assert!(command_name("a\u{85}b"), "NEL is not JavaScript whitespace");
        assert!(block_id("s1"));
        assert!(!block_id("😀"));
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert!(bare_word("¡hola!"));
        assert!(!bare_word("two words"));
    }
}
