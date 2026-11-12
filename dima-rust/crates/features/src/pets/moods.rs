//! Optional mood decoration; invalid data never interrupts speech.
use super::model::{PetError, object, valid_id};
use serde_json::{Value, json};
/// Stable order for mood selection and image slots.
pub const NAMES: [&str; 8] = [
    "happy",
    "excited",
    "sad",
    "angry",
    "surprised",
    "scared",
    "embarrassed",
    "thinking",
];
/// Disabled defaults from `pets/moods.ts`.
pub fn defaults() -> Value {
    json!({"enabled":false,"holdMs":2000,"images":{},"emotions":{"happy": ["happy", "delighted", "satisfied", "grateful", "proud", "confident", "optimistic", "hopeful", "moved", "empathetic", "sympathetic", "compassionate", "laugh", "chuckle", "giggle"], "excited": ["excited", "hysterical", "determined"], "sad": ["sad", "disappointed", "depressed", "unhappy", "regretful", "lonely", "nostalgic", "resigned", "pessimistic", "guilty", "cry", "sobbing"], "angry": ["angry", "frustrated", "upset", "disgusted", "contemptuous", "disdainful", "jealous", "envious", "sarcastic"], "surprised": ["surprised", "gasp"], "scared": ["scared", "nervous", "anxious", "worried"], "embarrassed": ["embarrassed", "ashamed"], "thinking": ["curious", "confused", "uncertain", "doubtful"]}})
}
// Emotions and sounds only; delivery/effects never select a mood.
fn known(tag: &str) -> bool {
    dima_tts::tags::EXPRESSIVE_TAGS.contains(&tag)
        && ![
            "whisper",
            "shouting",
            "soft",
            "singing",
            "slow",
            "fast",
            "emphasis",
            "screaming",
            "pause",
            "long-pause",
            "audience laughing",
            "background laughter",
        ]
        .contains(&tag)
}
fn invalid() -> PetError {
    PetError::new("invalid_moods")
}
/// Strict mood validation, including alias normalization and cross-list uniqueness.
pub fn validate(v: &Value) -> Result<Value, PetError> {
    let run = || -> Result<Value, PetError> {
        object(v, &["enabled", "holdMs", "emotions", "images"])?;
        let enabled = v["enabled"].as_bool().ok_or_else(invalid)?;
        let hold = v["holdMs"]
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= 10000.0)
            .ok_or_else(invalid)? as u64;
        let lists = object(&v["emotions"], &NAMES)?;
        let images = object(&v["images"], &NAMES)?;
        let mut seen = std::collections::HashSet::new();
        let mut emotions = json!({});
        let mut result = json!({});
        for mood in NAMES {
            let tags = lists
                .get(mood)
                .and_then(Value::as_array)
                .ok_or_else(invalid)?;
            let mut normalized = Vec::new();
            for raw in tags {
                let tag = dima_tts::tags::canonical(raw.as_str().ok_or_else(invalid)?);
                if !known(&tag) || !seen.insert(tag.clone()) {
                    return Err(invalid());
                }
                normalized.push(tag);
            }
            emotions[mood] = json!(normalized);
            if let Some(image) = images.get(mood) {
                object(image, &["idleAssetId", "talkingAssetId"])?;
                let mut entry = json!({});
                for key in ["idleAssetId", "talkingAssetId"] {
                    if let Some(id) = image.get(key).filter(|v| !v.is_null() && **v != "") {
                        let s = id.as_str().filter(|s| valid_id(s)).ok_or_else(invalid)?;
                        entry[key] = json!(s);
                    }
                }
                if entry.as_object().is_some_and(|m| !m.is_empty()) {
                    result[mood] = entry;
                }
            }
        }
        Ok(json!({"enabled":enabled,"holdMs":hold,"emotions":emotions,"images":result}))
    };
    run().map_err(|_| invalid())
}
/// Normalize Mongo-minimized image maps; invalid stored decoration falls back.
pub fn saved(v: Option<&Value>) -> Value {
    let Some(v) = v else { return defaults() };
    let mut v = v.clone();
    if v.is_object() && v.get("images").is_none() {
        v["images"] = json!({});
    }
    validate(&v).unwrap_or_else(|_| defaults())
}
/// Paid plan image cap, in stable mood then idle/talking order.
pub fn image_limit(tier: &str) -> usize {
    match tier {
        "pro" => 16,
        "premium" => 8,
        _ => 0,
    }
}
/// Public mood configuration never exposes image asset identifiers.
pub fn configuration(v: &Value, tier: &str) -> Value {
    if image_limit(tier) == 0 {
        json!({"available":false,"enabled":false})
    } else {
        json!({"available":true,"enabled":v["enabled"],"holdMs":v["holdMs"],"emotions":v["emotions"]})
    }
}
/// Ordered configured image slots, including slots hidden by a plan downgrade.
pub fn image_slots(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for mood in NAMES {
        for key in ["idleAssetId", "talkingAssetId"] {
            if let Some(id) = v["images"][mood][key].as_str().filter(|s| !s.is_empty()) {
                out.push(json!({"mood":mood,"key":key,"assetId":id}));
            }
        }
    }
    out
}
/// Image subset visible under this plan; does not modify saved configuration.
pub fn active_images(v: &Value, tier: &str) -> Value {
    let mut out = json!({});
    for slot in image_slots(v).into_iter().take(image_limit(tier)) {
        if let (Some(mood), Some(key)) = (slot["mood"].as_str(), slot["key"].as_str()) {
            if out.get(mood).is_none() {
                out[mood] = json!({});
            }
            out[mood][key] = slot["assetId"].clone();
        }
    }
    out
}
/// First known emotion/sound cue wins, even when unassigned (neutral).
pub fn resolve(text: &str, v: &Value) -> &'static str {
    let Ok(re) = regex::Regex::new(
        r"(?i)<[\s\x{feff}]*(/?)[\s\x{feff}]*([a-z][a-z -]*?)[\s\x{feff}]*>|\[([^\[\]]*)\]",
    ) else {
        return "neutral";
    };
    for c in re.captures_iter(text) {
        if c.get(1).is_some_and(|m| m.as_str() == "/") {
            continue;
        }
        let tag =
            dima_tts::tags::canonical(c.get(2).or_else(|| c.get(3)).map_or("", |m| m.as_str()));
        if !known(&tag) {
            continue;
        }
        return NAMES
            .into_iter()
            .find(|m| {
                v["emotions"][*m]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == &tag))
            })
            .unwrap_or("neutral");
    }
    "neutral"
}
/// AI instruction supplied by the later AI caller, with no tools or private data.
pub fn instruction(v: &Value) -> String {
    let tags: Vec<&str> = NAMES
        .iter()
        .flat_map(|m| {
            v["emotions"][*m]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
        })
        .collect();
    if tags.is_empty() {
        String::new()
    } else {
        format!(
            "Begin your reply with exactly one emotion tag from this list, in square brackets: {}.",
            tags.join(", ")
        )
    }
}
