//! Small text primitives for JavaScript-compatible ports.
//!
//! These are shared by otherwise independent modules so an AI usage model or
//! chat default does not depend on the keyword matcher and its Unicode index.

/// ECMAScript WhiteSpace and LineTerminator characters. Rust's whitespace set
/// additionally includes NEL (U+0085), which JavaScript intentionally excludes.
pub fn is_whitespace(ch: char) -> bool {
    matches!(ch,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript `String.prototype.trim()` for valid Unicode strings.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

#[cfg(test)]
mod tests {
    #[test]
    fn javascript_whitespace_differs_from_rust() {
        assert_eq!(super::trim("\u{feff}\u{2028}hello\u{00a0}"), "hello");
        assert_eq!(
            super::trim("\u{0085}hello\u{0085}"),
            "\u{0085}hello\u{0085}"
        );
    }
}
