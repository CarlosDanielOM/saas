//! Expressive cues, including the reference's alias spelling and Fish reinforcement.
pub use dima_model::channel_tts_settings::EXPRESSIVE_TAGS;
use dima_text::{to_lower, trim};
use regex::{Captures, Regex};
use std::collections::HashMap;
pub fn canonical(name: &str) -> String {
    let lower = to_lower(trim(name));
    match lower.as_str() {
        "anger" => "angry",
        "whispering" => "whisper",
        "laughing" => "laugh",
        "crying" => "cry",
        "sighing" => "sigh",
        "loud" => "shouting",
        "chuckling" => "chuckle",
        "gasping" => "gasp",
        "soft tone" => "soft",
        "crying loudly" => "cry",
        "in a hurry tone" => "fast",
        "break" => "pause",
        "long-break" => "long-pause",
        "crowd laughing" => "audience laughing",
        _ => &lower,
    }
    .to_owned()
}
pub fn filter(text: &str, provider: &str, enabled: &HashMap<String, bool>) -> String {
    let Ok(re) = Regex::new(
        r"(?i)<[\t\n\x{b}\x{c}\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*(/?)[\t\n\x{b}\x{c}\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*([a-z][a-z -]*?)[\t\n\x{b}\x{c}\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*>|\[([^\[\]]*)\]",
    ) else {
        return text.into();
    };
    let text = re.replace_all(text, |c: &Captures<'_>| {
        let angle = c.get(2);
        let raw = angle.or_else(|| c.get(3)).map_or("", |m| m.as_str());
        let raw = if angle.is_some() {
            Regex::new(r"[\t\n\x{b}\x{c}\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*-[\t\n\x{b}\x{c}\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*")
                .map(|r| r.replace_all(raw, "-").into_owned())
                .unwrap_or_else(|_| raw.into())
        } else {
            raw.into()
        };
        let tag = canonical(&raw);
        if provider == "fish"
            && EXPRESSIVE_TAGS.contains(&tag.as_str())
            && enabled.get(&tag) == Some(&true)
        {
            if angle.is_some() {
                format!("<{}{tag}>", c.get(1).map_or("", |m| m.as_str()))
            } else {
                format!("[{tag}]")
            }
        } else if angle.is_some() {
            String::new()
        } else {
            " ".into()
        }
    });
    let collapsed = Regex::new(" {2,}")
        .map(|r| r.replace_all(&text, " ").into_owned())
        .unwrap_or_else(|_| text.into_owned());
    trim(&collapsed).into()
}
pub fn reinforce(text: &str) -> String {
    // Regex backreferences are unavailable: consume consecutive identical tokens explicitly.
    let Ok(re) = Regex::new(r"\[([a-z -]+)\]") else {
        return text.into();
    };
    let mut out = String::new();
    let mut end = 0;
    for cap in re.captures_iter(text) {
        let Some(m) = cap.get(0) else { continue };
        if m.start() < end {
            continue;
        }
        out.push_str(text.get(end..m.start()).unwrap_or_default());
        let tag = cap.get(1).map_or("", |m| m.as_str());
        let mut next = m.end();
        loop {
            let rest = text.get(next..).unwrap_or_default();
            let trimmed = dima_text::trim_start(rest);
            if trimmed.starts_with(m.as_str()) {
                next = text.len() - trimmed.len() + m.as_str().len();
            } else {
                break;
            }
        }
        if next == m.end() && EXPRESSIVE_TAGS.contains(&tag) {
            out.push_str(&format!("[{tag}] [{tag}]"));
        } else {
            out.push_str(text.get(m.start()..next).unwrap_or_default());
        }
        end = next;
    }
    out.push_str(text.get(end..).unwrap_or_default());
    out
}

/// Expand the legacy inline/wrapping switches, defaulting every missing/nonboolean cue to on.
pub fn normalize_settings(input: &serde_json::Value) -> HashMap<String, bool> {
    EXPRESSIVE_TAGS
        .iter()
        .map(|tag| {
            let legacy = if *tag == "long-pause" {
                "longPause"
            } else {
                tag
            };
            let value = input
                .get(tag)
                .filter(|v| !v.is_null())
                .or_else(|| {
                    input
                        .get("inline")
                        .and_then(|v| v.get(legacy))
                        .filter(|v| !v.is_null())
                })
                .or_else(|| {
                    input
                        .get("wrapping")
                        .and_then(|v| v.get(legacy))
                        .filter(|v| !v.is_null())
                });
            (
                (*tag).into(),
                value.and_then(serde_json::Value::as_bool).unwrap_or(true),
            )
        })
        .collect()
}
