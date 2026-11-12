//! Text folding for blacklist matching (reference `utils/moderation/normalize.ts`).

use unicode_normalization::UnicodeNormalization;

use super::unicode::is_mark;

/// `foldText`: `normalize('NFD')`, every `\p{M}` removed, then `toLowerCase()`. "Café" and
/// "cafe" fold to the same text. Classified as matching only (never stored or hashed).
pub fn fold_text(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    let stripped: String = text.nfd().filter(|&ch| !is_mark(ch)).collect();
    dima_text::to_lower(&stripped)
}

/// `escapeRegExp`: a backslash before each of `.*+?^${}()|[]\`. Its output is pattern source for
/// the reference's engines (RE2 through `dima_commands::patterns`, which reads JavaScript
/// escapes), never for `regex` directly.
pub fn escape_regexp(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if matches!(
            ch,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_accents_and_case() {
        assert_eq!(fold_text("Café"), "cafe");
        assert_eq!(fold_text("ÑOÑO"), "nono");
        assert_eq!(fold_text("İ"), "i");
        assert_eq!(fold_text("e\u{301}\u{301}x"), "ex");
        // Final sigma, as `toLowerCase` writes it.
        assert_eq!(fold_text("ΟΔΟΣ"), "\u{3bf}\u{3b4}\u{3bf}\u{3c2}");
        assert_eq!(fold_text("😀 Ǆ"), "😀 ǆ");
        assert_eq!(fold_text(""), "");
    }

    #[test]
    fn escapes_the_reference_set_only() {
        assert_eq!(escape_regexp("a.b*c-d/é"), r"a\.b\*c-d/é");
        assert_eq!(escape_regexp(r"$(x)[y]{z}|^\"), r"\$\(x\)\[y\]\{z\}\|\^\\");
    }
}
