//! JavaScript whitespace, as `String.prototype.trim` removes it.

/// ECMAScript WhiteSpace or LineTerminator.
///
/// Includes U+FEFF and every space separator; excludes U+0085 (NEL, which Rust's
/// `char::is_whitespace` includes) and U+180E.
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `text.trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from `js_compat::javascript_whitespace_differs_from_rust` and the dashboard
    // insights trim assertions.
    #[test]
    fn javascript_whitespace_differs_from_rust() {
        assert_eq!(trim("\u{feff}\u{2028}hello\u{a0}"), "hello");
        assert_eq!(trim("\u{85}hello\u{85}"), "\u{85}hello\u{85}");
        assert_eq!(trim("\u{feff} café \u{feff}"), "café");
        assert_eq!(trim_start("\u{3000} a "), "a ");
        assert_eq!(trim_end(" a \u{205f}"), " a");
        assert!(!is_js_whitespace('\u{180e}'));
        assert!(!is_js_whitespace('\u{200b}'));
    }
}
