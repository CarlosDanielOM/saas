//! Pure caps evaluation for the declared TypeScript input contract.
use std::borrow::Cow;

use crate::utils::js_unicode_categories::{LETTER_RANGES, UPPERCASE_RANGES};
use crate::utils::js_string::JsString;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapsThresholdMode {
    Count,
    Percentage,
}

#[derive(Clone, Copy, Debug)]
pub struct CapsRule {
    pub caps_threshold_mode: CapsThresholdMode,
    pub min_caps_count: f64,
    pub max_caps_percentage: f64,
    pub min_message_length: f64,
}

pub struct CapsEvaluationInput<'a> {
    /// None represents the source's nullish `input.text` fallback.
    pub text: Option<&'a JsString>,
    pub emote_texts: Option<&'a [JsString]>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CapsEvaluationResult {
    pub triggered: bool,
    pub caps_count: usize,
    pub letter_count: usize,
    pub caps_percentage: f64,
}

/// Sequential JS `split(emote).join(' ')`, retaining ill-formed UTF-16.
pub fn strip_emote_texts<'a>(text: &'a JsString, emotes: Option<&[JsString]>) -> Cow<'a, JsString> {
    let mut result = Cow::Borrowed(text);
    for emote in emotes.unwrap_or_default() {
        if emote.is_empty() {
            continue;
        }
        if let (Some(value), Some(pattern)) = (result.as_str(), emote.as_str()) {
            if value.contains(pattern) {
                result = Cow::Owned(JsString::from(value.replace(pattern, " ")));
            }
            continue;
        }
        let value = result.units();
        let pattern = emote.units();
        // KMP: linear even for repeated prefixes; reset on each match for
        // split's non-overlap and never search a replacement in this pass.
        let mut prefix = vec![0; pattern.len()];
        let mut matched = 0;
        for i in 1..pattern.len() {
            while matched > 0 && pattern[i] != pattern[matched] {
                matched = prefix[matched - 1];
            }
            if pattern[i] == pattern[matched] {
                matched += 1;
            }
            prefix[i] = matched;
        }
        let mut output = Vec::with_capacity(value.len());
        let mut copied = 0;
        matched = 0;
        for (i, &unit) in value.iter().enumerate() {
            while matched > 0 && unit != pattern[matched] {
                matched = prefix[matched - 1];
            }
            if unit == pattern[matched] {
                matched += 1;
            }
            if matched == pattern.len() {
                output.extend_from_slice(&value[copied..i + 1 - pattern.len()]);
                output.push(b' ' as u16);
                copied = i + 1;
                matched = 0;
            }
        }
        if copied != 0 {
            output.extend_from_slice(&value[copied..]);
            result = Cow::Owned(JsString::from_units(output));
        }
    }
    result
}

fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    let i = ranges.partition_point(|&(start, _)| start <= cp);
    i != 0 && cp <= ranges[i - 1].1
}

pub fn evaluate_caps_rule(rule: CapsRule, input: CapsEvaluationInput<'_>) -> CapsEvaluationResult {
    let empty = JsString::from_static("");
    let text = strip_emote_texts(input.text.unwrap_or(&empty), input.emote_texts);
    let mut caps_count = 0usize;
    let mut letter_count = 0usize;
    let mut count = |cp: u32| {
        if cp < 128 {
            if (65..=90).contains(&cp) {
                caps_count += 1;
                letter_count += 1;
            } else if (97..=122).contains(&cp) {
                letter_count += 1;
            }
        } else if in_ranges(cp, LETTER_RANGES) {
            letter_count += 1;
            if in_ranges(cp, UPPERCASE_RANGES) {
                caps_count += 1;
            }
        }
    };
    if let Some(s) = text.as_str() {
        for ch in s.chars() {
            count(ch as u32);
        }
    } else {
        for ch in char::decode_utf16(text.code_units()).flatten() {
            count(ch as u32);
        }
    }
    let caps_percentage = if letter_count == 0 {
        0.0
    } else {
        (caps_count as f64 / letter_count as f64) * 100.0
    };
    let triggered = if (letter_count as f64) < rule.min_message_length {
        false
    } else {
        match rule.caps_threshold_mode {
            CapsThresholdMode::Percentage => caps_percentage >= rule.max_caps_percentage,
            CapsThresholdMode::Count => (caps_count as f64) >= rule.min_caps_count,
        }
    };
    CapsEvaluationResult {
        triggered,
        caps_count,
        letter_count,
        caps_percentage,
    }
}
