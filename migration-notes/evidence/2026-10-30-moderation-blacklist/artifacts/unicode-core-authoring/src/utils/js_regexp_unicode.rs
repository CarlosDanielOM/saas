//! Pinned Unicode 17.0 facts for ECMAScript Unicode regular expressions.
//!
//! Classification functions report raw general categories, without case folding.
//! For `/[\p{L}\p{N}]/iu`, classify `canonicalize(cp)`: U+0345, for example,
//! is a raw mark whose simple fold is a letter. This is deliberately separate
//! from JavaScript string lowercasing, full folding, and Turkic folding.

use super::js_regexp_unicode_data::{NUMBER_RANGES, SIMPLE_FOLD_MAPPINGS};
use super::js_unicode_categories::{LETTER_RANGES, UPPERCASE_RANGES};

/// ECMAScript `/iu` canonicalization using Unicode 17.0 simple case folding.
///
/// Only CaseFolding.txt statuses C and S participate. Lone surrogates and values
/// above U+10FFFF are preserved, as are all code points without a simple fold.
#[inline]
pub fn canonicalize(cp: u32) -> u32 {
    if cp <= 0x7F {
        return if (0x41..=0x5A).contains(&cp) {
            cp + 0x20
        } else {
            cp
        };
    }
    if !is_scalar(cp) {
        return cp;
    }
    SIMPLE_FOLD_MAPPINGS
        .binary_search_by_key(&cp, |&(source, _)| source)
        .map_or(cp, |index| SIMPLE_FOLD_MAPPINGS[index].1)
}

/// Raw Unicode general category L (Lu, Ll, Lt, Lm, or Lo).
#[inline]
pub fn is_letter(cp: u32) -> bool {
    if cp <= 0x7F {
        return (0x41..=0x5A).contains(&cp) || (0x61..=0x7A).contains(&cp);
    }
    is_scalar(cp) && in_ranges(cp, LETTER_RANGES)
}

/// Raw Unicode general category N (Nd, Nl, or No), not just decimal digits.
#[inline]
pub fn is_number(cp: u32) -> bool {
    if cp <= 0x7F {
        return (0x30..=0x39).contains(&cp);
    }
    is_scalar(cp) && in_ranges(cp, NUMBER_RANGES)
}

/// Raw Unicode general category Lu, not the broader binary Uppercase property.
#[inline]
pub fn is_uppercase(cp: u32) -> bool {
    if cp <= 0x7F {
        return (0x41..=0x5A).contains(&cp);
    }
    is_scalar(cp) && in_ranges(cp, UPPERCASE_RANGES)
}

/// Raw Unicode general category L or N; case folding is the caller's choice.
#[inline]
pub fn is_letter_or_number(cp: u32) -> bool {
    if cp <= 0x7F {
        return (0x30..=0x39).contains(&cp)
            || (0x41..=0x5A).contains(&cp)
            || (0x61..=0x7A).contains(&cp);
    }
    is_scalar(cp) && (in_ranges(cp, LETTER_RANGES) || in_ranges(cp, NUMBER_RANGES))
}

#[inline]
fn is_scalar(cp: u32) -> bool {
    cp <= 0x10FFFF && !(0xD800..=0xDFFF).contains(&cp)
}

#[inline]
fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    let index = ranges.partition_point(|&(_, end)| end < cp);
    ranges.get(index).is_some_and(|&(start, _)| start <= cp)
}
