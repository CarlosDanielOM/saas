//! String ordering: JavaScript's default order, and `localeCompare` behind the `collation` feature.

use std::cmp::Ordering;

/// JavaScript's default string order (`a < b`, and `Array.prototype.sort()` without a
/// comparator): UTF-16 code-unit order, computed on UTF-8 without building UTF-16.
///
/// It differs from `str::cmp` (code-point order) only where one string has U+E000–U+FFFF and the
/// other an astral character at the first difference: JavaScript sorts the astral one first.
pub fn cmp_utf16(left: &str, right: &str) -> Ordering {
    let Some(first_difference) = left.bytes().zip(right.bytes()).position(|(a, b)| a != b) else {
        return left.len().cmp(&right.len());
    };
    // Equal bytes before the difference mean equal characters, so both strings have a character
    // boundary at the same place.
    let start = left.floor_char_boundary(first_difference);
    let first_char = |text: &str| text.get(start..).and_then(|rest| rest.chars().next());
    match (first_char(left), first_char(right)) {
        (Some(a), Some(b)) => utf16_rank(a).cmp(&utf16_rank(b)),
        _ => left.cmp(right),
    }
}

/// A key whose order is the order of the characters' first UTF-16 units (then the second):
/// U+0000–U+D7FF, then astral characters (surrogates D800–DFFF), then U+E000–U+FFFF.
fn utf16_rank(ch: char) -> u32 {
    let code = u32::from(ch);
    if (0xe000..=0xffff).contains(&code) {
        code + 0x11_0000
    } else {
        code
    }
}

/// `a.localeCompare(b)` as Node computes it with its default locale (`en-US`): the CLDR root
/// collation at tertiary strength, punctuation not ignored.
#[cfg(feature = "collation")]
pub struct Collator(icu_collator::CollatorBorrowed<'static>);

/// The collation data compiled into the binary could not be loaded.
#[cfg(feature = "collation")]
#[derive(Debug, thiserror::Error)]
#[error("collation data unavailable: {0}")]
pub struct CollationError(String);

#[cfg(feature = "collation")]
impl Collator {
    /// A collator for Node's default locale.
    pub fn new() -> Result<Self, CollationError> {
        icu_collator::CollatorBorrowed::try_new(Default::default(), Default::default())
            .map(Self)
            .map_err(|error| CollationError(error.to_string()))
    }

    /// `left.localeCompare(right)` as an ordering.
    pub fn compare(&self, left: &str, right: &str) -> Ordering {
        self.0.compare(left, right)
    }
}

#[cfg(feature = "collation")]
impl std::fmt::Debug for Collator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Collator(root)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn astral_characters_sort_before_the_end_of_the_bmp() {
        assert_eq!(cmp_utf16("😀", "\u{ffff}"), Ordering::Less);
        assert_eq!("😀".cmp("\u{ffff}"), Ordering::Greater);
        assert_eq!(cmp_utf16("😀", "\u{d7ff}"), Ordering::Greater);
        assert_eq!(cmp_utf16("a😀", "a😁"), Ordering::Less);
        assert_eq!(cmp_utf16("ab", "a"), Ordering::Greater);
        assert_eq!(cmp_utf16("é", "ê"), Ordering::Less);
        assert_eq!(cmp_utf16("", ""), Ordering::Equal);
    }

    // Ported from `dashboard_insights` game ordering: case and accents are tertiary differences.
    #[cfg(feature = "collation")]
    #[test]
    fn locale_order_puts_lowercase_and_unaccented_first() -> Result<(), CollationError> {
        let collator = Collator::new()?;
        assert_eq!(collator.compare("a", "A"), Ordering::Less);
        assert_eq!(collator.compare("e", "é"), Ordering::Less);
        assert_eq!(collator.compare("é", "f"), Ordering::Less);
        assert_eq!(collator.compare("e\u{301}", "é"), Ordering::Equal);
        Ok(())
    }
}
