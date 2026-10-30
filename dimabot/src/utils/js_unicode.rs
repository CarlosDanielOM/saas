//! Node 24 / Unicode 17 default lowercase and moderation string folding.
//!
//! These operate on JavaScript UTF-16 strings, including lone surrogates. They
//! do not implement JavaScript value coercion. Generated properties and casing
//! are pinned to the Node runtime described in the migration handoff.
use std::borrow::Cow;

use unicode_normalization::{UnicodeNormalization, char::decompose_canonical, is_nfc, is_nfkd};

use super::js_string::JsString;
use super::js_unicode_data::{
    ASSIGNED_RANGES, CASE_IGNORABLE_RANGES, CASED_RANGES, LOWERCASE_MAPPINGS, MARK_RANGES,
};

fn contains(ranges: &[(u32, u32)], cp: u32) -> bool {
    let index = ranges.partition_point(|&(start, _)| start <= cp);
    index != 0 && cp <= ranges[index - 1].1
}

fn code_points(units: impl Iterator<Item = u16>) -> Vec<u32> {
    char::decode_utf16(units)
        .map(|item| match item {
            Ok(c) => c as u32,
            Err(error) => u32::from(error.unpaired_surrogate()),
        })
        .collect()
}

fn push_lower(out: &mut Vec<u16>, cp: u32) {
    if cp < 0x80 {
        let byte = cp as u8;
        out.push(u16::from(byte.to_ascii_lowercase()));
    } else if let Ok(index) = LOWERCASE_MAPPINGS.binary_search_by_key(&cp, |row| row.0) {
        for &mapped in LOWERCASE_MAPPINGS[index].1 {
            push_point(out, mapped);
        }
    } else {
        push_point(out, cp);
    }
}

// Without capital sigma, default case conversion has no contextual mapping.
fn lower_without_sigma(units: impl Iterator<Item = u16>) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.size_hint().0);
    for item in char::decode_utf16(units) {
        let cp = match item {
            Ok(c) => c as u32,
            Err(error) => u32::from(error.unpaired_surrogate()),
        };
        push_lower(&mut out, cp);
    }
    out
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
        } else {
            push_lower(&mut out, cp);
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

/// Project pinned ECMAScript default lowercase into ASCII, rejecting any
/// non-ASCII output or output longer than `max_len`. Valid UTF-8 input is
/// required; callers retain any separate unpaired-UTF-16 boundary.
/// Final sigma's contextual outputs are both non-ASCII, so either form is
/// rejected without needing the contextual scan used by `lowercase`.
pub fn lowercase_ascii_bounded(text: &str, max_len: usize) -> Option<String> {
    if text.is_ascii() {
        return (text.len() <= max_len).then(|| text.to_ascii_lowercase());
    }
    let mut out = String::with_capacity(text.len().min(max_len));
    for ch in text.chars() {
        if ch.is_ascii() {
            if out.len() == max_len {
                return None;
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            let index = LOWERCASE_MAPPINGS
                .binary_search_by_key(&(ch as u32), |row| row.0)
                .ok()?;
            let mapped = LOWERCASE_MAPPINGS[index].1;
            if mapped.len() > max_len.saturating_sub(out.len())
                || mapped.iter().any(|cp| *cp >= 128)
            {
                return None;
            }
            for &cp in mapped {
                out.push(char::from_u32(cp).expect("ASCII lowercase mapping"));
            }
        }
    }
    Some(out)
}

// The pinned normalization crate has newer tables than Node. Assigned Unicode
// 17 runs normalize together; unassigned points and lone surrogates are barriers.
fn flush_normalization_run(run: &mut String, out: &mut Vec<u16>, compatibility: bool) {
    let mut push = |c: char| {
        let mut units = [0; 2];
        out.extend_from_slice(c.encode_utf16(&mut units));
    };
    if compatibility {
        run.nfkd().for_each(&mut push);
    } else {
        run.nfc().for_each(&mut push);
    }
    run.clear();
}

/// ECMAScript `String.prototype.normalize("NFC")` for Unicode 17 and
/// arbitrary UTF-16, including lone surrogates. The dependency carries newer
/// tables, so unassigned Unicode 17 scalars and surrogates form barriers.
/// Unchanged input is borrowed. ASCII needs no normalization, and already
/// normalized UTF-8 containing only Unicode 17-assigned scalars needs no
/// output buffer.
pub fn normalize_nfc(value: &JsString) -> Cow<'_, JsString> {
    if let Some(text) = value.as_str() {
        if text.is_ascii() {
            return Cow::Borrowed(value);
        }
        // On an entirely assigned input the previous implementation applies
        // the crate's NFC to this same whole string. Its authoritative check
        // therefore decides whether that exact result equals the input. Never
        // use it across an unassigned scalar: the newer tables may give that
        // scalar a combining class even though Unicode 17 treats it as a barrier.
        let all_assigned = text
            .chars()
            .all(|c| c.is_ascii() || contains(ASSIGNED_RANGES, c as u32));
        if all_assigned {
            if is_nfc(text) {
                return Cow::Borrowed(value);
            }
            let mut out = String::with_capacity(text.len());
            out.extend(text.nfc());
            return Cow::Owned(JsString::from(out));
        }

        let mut out = String::with_capacity(text.len());
        let mut start = 0;
        for (index, c) in text.char_indices() {
            if !c.is_ascii() && !contains(ASSIGNED_RANGES, c as u32) {
                out.extend(text[start..index].nfc());
                out.push(c);
                start = index + c.len_utf8();
            }
        }
        out.extend(text[start..].nfc());
        return if out == text {
            Cow::Borrowed(value)
        } else {
            Cow::Owned(JsString::from(out))
        };
    }
    let mut out = Vec::with_capacity(value.len());
    let mut run = String::new();
    for point in char::decode_utf16(value.code_units()) {
        match point {
            Ok(c) if contains(ASSIGNED_RANGES, c as u32) => run.push(c),
            Ok(c) => {
                flush_normalization_run(&mut run, &mut out, false);
                push_point(&mut out, c as u32);
            }
            Err(e) => {
                flush_normalization_run(&mut run, &mut out, false);
                out.push(e.unpaired_surrogate());
            }
        }
    }
    flush_normalization_run(&mut run, &mut out, false);
    result(value, out)
}

/// ECMAScript NFKD using the same Unicode 17 assignment barriers as NFC.
/// Unchanged text, including ASCII and unpaired-surrogate inputs, is borrowed.
pub fn normalize_nfkd(value: &JsString) -> Cow<'_, JsString> {
    if let Some(text) = value.as_str() {
        if text.is_ascii() {
            return Cow::Borrowed(value);
        }
        let all_assigned = text
            .chars()
            .all(|c| c.is_ascii() || contains(ASSIGNED_RANGES, c as u32));
        if all_assigned {
            if is_nfkd(text) {
                return Cow::Borrowed(value);
            }
            let mut out = String::with_capacity(text.len());
            out.extend(text.nfkd());
            return Cow::Owned(JsString::from(out));
        }
        let mut out = String::with_capacity(text.len());
        let mut start = 0;
        for (index, c) in text.char_indices() {
            if !c.is_ascii() && !contains(ASSIGNED_RANGES, c as u32) {
                out.extend(text[start..index].nfkd());
                out.push(c);
                start = index + c.len_utf8();
            }
        }
        out.extend(text[start..].nfkd());
        return if out == text {
            Cow::Borrowed(value)
        } else {
            Cow::Owned(JsString::from(out))
        };
    }
    let mut out = Vec::with_capacity(value.len());
    let mut run = String::new();
    for point in char::decode_utf16(value.code_units()) {
        match point {
            Ok(c) if c.is_ascii() || contains(ASSIGNED_RANGES, c as u32) => run.push(c),
            Ok(c) => {
                flush_normalization_run(&mut run, &mut out, true);
                push_point(&mut out, c as u32);
            }
            Err(e) => {
                flush_normalization_run(&mut run, &mut out, true);
                out.push(e.unpaired_surrogate());
            }
        }
    }
    flush_normalization_run(&mut run, &mut out, true);
    result(value, out)
}

/// ECMAScript default `String.prototype.toLowerCase` with pinned Unicode 17 data.
pub fn lowercase(value: &JsString) -> Cow<'_, JsString> {
    if let Some(ascii) = ascii_lower(value) {
        return ascii;
    }
    if value.code_units().any(|unit| unit == 0x03a3) {
        result(value, lower_points(&code_points(value.code_units())))
    } else {
        result(value, lower_without_sigma(value.code_units()))
    }
}

/// `normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()` on a string.
/// JavaScript's `String(text ?? '')` coercion remains the caller's responsibility.
pub fn fold_text(value: &JsString) -> Cow<'_, JsString> {
    if let Some(ascii) = ascii_lower(value) {
        return ascii;
    }
    // The exhaustive property test checks that every nonzero combining-class
    // decomposition of a Unicode 17-assigned scalar is a Unicode 17 Mark.
    // Canonical ordering only permutes those nonstarters; all are removed, so
    // the retained class-zero characters have the same order without sorting.
    // Unicode 17-unassigned scalars and lone surrogates remain barriers.
    let mut units = Vec::with_capacity(value.len());
    for item in char::decode_utf16(value.code_units()) {
        match item {
            Ok(c) if c.is_ascii() => units.push(c as u16),
            Ok(c) if contains(ASSIGNED_RANGES, c as u32) => {
                decompose_canonical(c, |part| {
                    if part.is_ascii() || !contains(MARK_RANGES, part as u32) {
                        push_point(&mut units, part as u32);
                    }
                });
            }
            Ok(c) => push_point(&mut units, c as u32),
            Err(error) => units.push(error.unpaired_surrogate()),
        }
    }
    // Removing a mark can bring two previously unpaired surrogates together.
    // JavaScript lowercases the resulting UTF-16 string, so decode it again.
    if units.contains(&0x03a3) {
        result(value, lower_points(&code_points(units.iter().copied())))
    } else {
        result(value, lower_without_sigma(units.into_iter()))
    }
}
