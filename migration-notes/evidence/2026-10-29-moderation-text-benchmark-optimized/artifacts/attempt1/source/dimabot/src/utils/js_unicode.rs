//! Node 24 / Unicode 17 default lowercase and moderation string folding.
//!
//! These operate on JavaScript UTF-16 strings, including lone surrogates. They
//! do not implement JavaScript value coercion. Generated properties and casing
//! are pinned to the Node runtime described in the migration handoff.
use std::borrow::Cow;

use unicode_normalization::UnicodeNormalization;

use super::js_string::JsString;
use super::js_unicode_data::{
    ASSIGNED_RANGES, CASE_IGNORABLE_RANGES, CASED_RANGES, LOWERCASE_MAPPINGS, MARK_RANGES,
};

fn contains(ranges: &[(u32, u32)], cp: u32) -> bool {
    let index = ranges.partition_point(|&(start, _)| start <= cp);
    index != 0 && cp <= ranges[index - 1].1
}

fn code_points(value: &JsString) -> Vec<u32> {
    char::decode_utf16(value.code_units())
        .map(|item| match item {
            Ok(c) => c as u32,
            Err(error) => u32::from(error.unpaired_surrogate()),
        })
        .collect()
}

fn push_point(out: &mut Vec<u16>, cp: u32) {
    if (0xd800..=0xdfff).contains(&cp) {
        out.push(cp as u16);
    } else {
        let mut buf = [0; 2];
        out.extend_from_slice(
            char::from_u32(cp)
                .expect("valid code point")
                .encode_utf16(&mut buf),
        );
    }
}

// Apply Final_Sigma using the nearest non-Case_Ignorable point on either
// side. Cased and Case_Ignorable overlap, so the ignorable test comes first.
// A reverse pass makes every sigma lookup constant-time even in long runs.
fn lower_points(points: &[u32]) -> Vec<u16> {
    let mut followed_by_cased = vec![false; points.len()];
    let mut cased = false;
    for (index, &cp) in points.iter().enumerate().rev() {
        followed_by_cased[index] = cased;
        if !contains(CASE_IGNORABLE_RANGES, cp) {
            cased = contains(CASED_RANGES, cp);
        }
    }
    let mut out = Vec::with_capacity(points.len());
    let mut preceded_by_cased = false;
    for (index, &cp) in points.iter().enumerate() {
        if cp == 0x03a3 && preceded_by_cased && !followed_by_cased[index] {
            push_point(&mut out, 0x03c2);
        } else if let Ok(index) = LOWERCASE_MAPPINGS.binary_search_by_key(&cp, |row| row.0) {
            for &mapped in LOWERCASE_MAPPINGS[index].1 {
                push_point(&mut out, mapped);
            }
        } else {
            push_point(&mut out, cp);
        }
        if !contains(CASE_IGNORABLE_RANGES, cp) {
            preceded_by_cased = contains(CASED_RANGES, cp);
        }
    }
    out
}

fn result<'a>(original: &'a JsString, units: Vec<u16>) -> Cow<'a, JsString> {
    if original.code_units().eq(units.iter().copied()) {
        Cow::Borrowed(original)
    } else {
        Cow::Owned(JsString::from_units(units))
    }
}

fn ascii_lower(value: &JsString) -> Option<Cow<'_, JsString>> {
    let text = value.as_str()?;
    if !text.is_ascii() {
        return None;
    }
    if !text.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Some(Cow::Borrowed(value))
    } else {
        Some(Cow::Owned(JsString::from(text.to_ascii_lowercase())))
    }
}

/// ECMAScript default `String.prototype.toLowerCase` with pinned Unicode 17 data.
pub fn lowercase(value: &JsString) -> Cow<'_, JsString> {
    if let Some(ascii) = ascii_lower(value) {
        return ascii;
    }
    result(value, lower_points(&code_points(value)))
}

/// `normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()` on a string.
/// JavaScript's `String(text ?? '')` coercion remains the caller's responsibility.
pub fn fold_text(value: &JsString) -> Cow<'_, JsString> {
    if let Some(ascii) = ascii_lower(value) {
        return ascii;
    }
    let mut normalized = Vec::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut Vec<u32>| {
        out.extend(
            run.nfd()
                .map(|c| c as u32)
                .filter(|&cp| !contains(MARK_RANGES, cp)),
        );
        run.clear();
    };
    for cp in code_points(value) {
        if let Some(c) = char::from_u32(cp).filter(|_| contains(ASSIGNED_RANGES, cp)) {
            run.push(c);
        } else {
            flush(&mut run, &mut normalized);
            normalized.push(cp);
        }
    }
    flush(&mut run, &mut normalized);
    // Removing a mark can bring two previously unpaired surrogates together.
    // JavaScript lowercases the resulting UTF-16 string, so decode it again.
    let mut units = Vec::new();
    for cp in normalized {
        push_point(&mut units, cp);
    }
    let stripped = JsString::from_units(units);
    result(value, lower_points(&code_points(&stripped)))
}
