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
        r"(?i)<[\s\x{FEFF}]*(/?)[\s\x{FEFF}]*([a-z][a-z -]*?)[\s\x{FEFF}]*>|\[([^\[\]]*)\]",
    ) else {
        return text.into();
    };
    let text = re.replace_all(text, |c: &Captures<'_>| {
        let angle = c.get(2);
        let raw = angle.or_else(|| c.get(3)).map_or("", |m| m.as_str());
        let raw = if angle.is_some() {
            Regex::new(r"[\s\x{FEFF}]*-[\s\x{FEFF}]*")
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
