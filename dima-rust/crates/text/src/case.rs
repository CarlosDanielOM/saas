//! Case mapping and normalisation.

use std::borrow::Cow;
use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfc_quick};

/// `text.toLowerCase()`: the locale-independent full mapping (`İ` → `i̇`, final sigma `ς`).
pub fn to_lower(text: &str) -> String {
    text.to_lowercase()
}

/// `text.toUpperCase()`: the locale-independent full mapping (`ß` → `SS`, `ŉ` → `ʼN`).
pub fn to_upper(text: &str) -> String {
    text.to_uppercase()
}

/// `text.normalize('NFC')`; borrows when `text` is already in NFC.
pub fn nfc(text: &str) -> Cow<'_, str> {
    if is_nfc_quick(text.chars()) == IsNormalized::Yes {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.nfc().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_casing_matches_javascript() {
        assert_eq!(to_upper("straße"), "STRASSE");
        assert_eq!(to_lower("İ"), "i\u{307}");
        assert_eq!(to_lower("ΟΔΟΣ"), "οδος");
        assert_eq!(to_lower("ΟΔΟΣ ΑΣ"), "οδος ας");
        assert_eq!(to_lower("Σ"), "σ");
        assert_eq!(to_upper("ı"), "I");
    }

    #[test]
    fn nfc_composes_and_borrows_when_already_normal() {
        assert_eq!(nfc("e\u{301}"), "é");
        assert_eq!(nfc("\u{212b}"), "Å");
        assert!(matches!(nfc("ñandú"), Cow::Borrowed(_)));
    }
}
