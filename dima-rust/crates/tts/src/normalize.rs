//! Filtering order is emotes, URLs, controls, whitespace, then our scalar-value length limit.
//! Mentions and repeated characters are deliberately untouched, as in the reference.
use dima_text::{is_js_whitespace, trim, truncate_chars};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub skip_emotes: bool,
    pub strip_links: bool,
    pub normalize_whitespace: bool,
    pub max_length: usize,
    #[serde(default)]
    pub emote_names: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Normalized {
    pub error: bool,
    pub message: String,
    pub text: String,
    pub original_text: String,
}
pub fn normalize(raw: &str, options: &Options) -> Normalized {
    let mut text = String::new();
    // Keep whitespace tokens exactly, including JS whitespace absent from Rust's set.
    let mut token = String::new();
    for c in raw.chars().chain(std::iter::once(' ')) {
        if is_js_whitespace(c) {
            if !options.skip_emotes
                || !options
                    .emote_names
                    .iter()
                    .any(|e| trim(e) == token && !token.is_empty())
            {
                text.push_str(&token);
            }
            token.clear();
            text.push(c);
        } else {
            token.push(c);
        }
    }
    text.pop();
    if options.strip_links
        && let Ok(re) = Regex::new(
            r"(?i)((http|https)://)?(www\.)?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]{2,})+(:\d+)?(/[^\s\x{FEFF}]*)?(\?[^\s\x{FEFF}]+)?",
        )
    {
        text = re.replace_all(&text, "[link]").into_owned();
    }
    text = text
        .chars()
        .map(|c| {
            if matches!(c, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    if options.normalize_whitespace {
        text = text
            .split(is_js_whitespace)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
    }
    text = trim(&text).to_owned();
    if options.max_length > 0 {
        text = trim(truncate_chars(&text, options.max_length)).to_owned();
    }
    Normalized {
        error: text.is_empty(),
        message: if text.is_empty() {
            "No speakable text remained after filtering"
        } else {
            "TTS message normalized"
        }
        .into(),
        text,
        original_text: raw.into(),
    }
}
pub fn spoken_user_message(name: &str, message: &str, language: &str, source: &str) -> String {
    if source == "ast" || trim(name).is_empty() {
        return message.into();
    }
    format!(
        "{} {}: {}",
        trim(name),
        if language == "en" { "say" } else { "dice" },
        message
    )
}
pub const DEFAULT_SPEECH_TEMPLATE: &str = "$(tts $(user) dice: &t)";
pub fn migrate_legacy_template(message: Option<&str>) -> String {
    let raw = message.unwrap_or_default();
    let body = trim(raw);
    if body.is_empty() || body == "$(tts &t)" {
        return DEFAULT_SPEECH_TEMPLATE.into();
    }
    if Regex::new(r"\$\(tts(?:[.\s)]|\x{FEFF})").is_ok_and(|r| r.is_match(body)) {
        return raw.into();
    }
    format!("$(tts {raw})")
}
/// Twitch range ends are inclusive UTF-16 offsets. Never split a Unicode scalar.
pub fn extract_emote_names(message: &str, ranges: &[String]) -> Vec<String> {
    let mut names = Vec::new();
    for range in ranges {
        let mut parts = range.split('-');
        let start =
            dima_text::parse_int(parts.next().unwrap_or_default(), dima_text::Radix::Decimal);
        let end = dima_text::parse_int(parts.next().unwrap_or_default(), dima_text::Radix::Decimal);
        if !start.is_finite() || !end.is_finite() {
            continue;
        }
        let len = dima_text::utf16_len(message) as f64;
        let index = |v: f64| {
            if v < 0.0 {
                (len + v).max(0.0) as usize
            } else {
                v.min(len) as usize
            }
        };
        let a = dima_text::utf16_to_byte(message, index(start));
        let b = dima_text::utf16_to_byte(message, index(end + 1.0));
        let name = trim(message.get(a..b).unwrap_or_default()).to_owned();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}
/// Money/provider counts always retain JavaScript `.length`, including astral scalars costing 2.
pub fn billable_characters(text: &str) -> usize {
    dima_text::utf16_len(text)
}
