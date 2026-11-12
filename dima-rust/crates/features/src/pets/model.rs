//! Settings validation and legacy read normalization; JSON is the dashboard contract,
//! as in the sibling widget model. Validated values are inputs to model write helpers.
use super::moods;
use serde_json::{Map, Value, json};

/// Expected domain refusal; no private input is included in errors.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct PetError {
    /// Stable client error code.
    pub code: &'static str,
    /// HTTP status used by the later route adapter.
    pub status: u16,
}
impl PetError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code, status: 400 }
    }
}
fn invalid() -> PetError {
    PetError::new("invalid_settings")
}
pub(crate) fn object<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, PetError> {
    v.as_object()
        .filter(|m| m.keys().all(|k| keys.contains(&k.as_str())))
        .ok_or_else(invalid)
}
fn text(v: &Value, max: usize, empty: bool) -> Result<String, PetError> {
    let s = v.as_str().ok_or_else(invalid)?;
    if s.chars().count() > max
        || (!empty && dima_text::trim(s).is_empty())
        || s.chars()
            .any(|c| matches!(c, '\0'..='\u{8}' | '\u{b}'..='\u{c}' | '\u{e}'..='\u{1f}'))
    {
        return Err(invalid());
    }
    Ok(dima_text::trim(s).into())
}
fn boolean(v: &Value) -> Result<bool, PetError> {
    v.as_bool().ok_or_else(invalid)
}
fn integer(v: &Value, min: u64, max: u64) -> Result<u64, PetError> {
    let n = v.as_f64().ok_or_else(invalid)?;
    if n.fract() != 0.0 || n < min as f64 || n > max as f64 {
        return Err(invalid());
    }
    Ok(n as u64)
}
fn choice<'a>(v: &'a Value, values: &[&str]) -> Result<&'a str, PetError> {
    v.as_str()
        .filter(|s| values.contains(s))
        .ok_or_else(invalid)
}
/// Hex identifiers are carried unchanged (including uppercase).
pub fn valid_id(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn nullable_id(v: &Value) -> Result<Value, PetError> {
    if v.is_null() || v.as_str().is_some_and(valid_id) {
        Ok(v.clone())
    } else {
        Err(invalid())
    }
}
/// Plan gate after the caller proves ownership through the Twitch account.
pub fn require_plan(owns_channel: bool, tier: &str) -> Result<(), PetError> {
    if !owns_channel {
        return Err(PetError {
            code: "access_denied",
            status: 403,
        });
    }
    if !["premium", "pro"].contains(&tier) {
        return Err(PetError {
            code: "plan_required",
            status: 403,
        });
    }
    Ok(())
}
/// New settings; identical to `defaultPetSettings`.
pub fn default_settings() -> Value {
    json!({"moods":moods::defaults(),"sources":{"independent":true,"readTts":false},"ttsAudio":"pet","appearance":{"kind":"png","idleAssetId":null,"talkingAssetId":null},"playback":{"target":"browser","desktopSessionId":null,"vtsSessionId":null},"enabled":false,"name":"Dima","tts":{"enabled":true,"provider":"piper","language":"es","voice":"es_MX-ald-medium"},"personality":{"source":"custom","profileId":"","prompt":"You are a friendly, playful virtual companion. Keep replies short and respectful."},"rules":[],"behavior":{"respondToChat":true,"respondToEvents":true,"cooldownSeconds":15,"maxReplyLength":280,"queueSize":5,"askLane":"independent"}})
}
fn fallback<'a>(v: &'a Value, default: &'a Value) -> &'a Value {
    if v.is_null() { default } else { v }
}
/// Validate a complete dashboard settings object. Optional moods fail closed to
/// defaults, as in the reference. User text limits count scalars per MIGRATION §4.
pub fn validate_settings(v: &Value) -> Result<Value, PetError> {
    object(
        v,
        &[
            "enabled",
            "name",
            "tts",
            "personality",
            "rules",
            "behavior",
            "appearance",
            "playback",
            "sources",
            "ttsAudio",
            "moods",
        ],
    )?;
    let d = default_settings();
    let sources = fallback(&v["sources"], &d["sources"]);
    object(sources, &["independent", "readTts"])?;
    let appearance = fallback(&v["appearance"], &d["appearance"]);
    object(appearance, &["kind", "idleAssetId", "talkingAssetId"])?;
    let playback = fallback(&v["playback"], &d["playback"]);
    object(playback, &["target", "desktopSessionId", "vtsSessionId"])?;
    for (obj, keys) in [
        (appearance, ["idleAssetId", "talkingAssetId"]),
        (playback, ["desktopSessionId", "vtsSessionId"]),
    ] {
        for key in keys {
            if obj.get(key).is_none() {
                return Err(invalid());
            }
        }
    }
    let tts = &v["tts"];
    object(tts, &["enabled", "provider", "language", "voice"])?;
    let persona = &v["personality"];
    object(persona, &["source", "profileId", "prompt"])?;
    let b = &v["behavior"];
    object(
        b,
        &[
            "respondToChat",
            "respondToEvents",
            "cooldownSeconds",
            "maxReplyLength",
            "queueSize",
            "askLane",
        ],
    )?;
    let provider = choice(&tts["provider"], &["piper", "kokoro", "fish"])?;
    let language = choice(&tts["language"], &["en", "es"])?;
    let source = choice(&persona["source"], &["custom", "profile"])?;
    let voice = text(&tts["voice"], 100, false)?;
    let voice_valid = match provider {
        "fish" => voice.len() == 32 && voice.bytes().all(|b| b.is_ascii_hexdigit()),
        "piper" => matches!(
            (voice.as_str(), language),
            ("en_US-ryan-medium", "en") | ("es_MX-ald-medium", "es")
        ),
        _ => {
            dima_tts::credit_fallback::KOKORO_VOICES.contains(&voice.as_str())
                && if voice.starts_with('e') {
                    language == "es"
                } else {
                    voice.starts_with(['a', 'b']) && language == "en"
                }
        }
    };
    if sources["independent"] != false && !voice_valid {
        return Err(PetError::new("invalid_voice"));
    }
    let rules = v["rules"]
        .as_array()
        .filter(|a| a.len() <= 20)
        .ok_or_else(|| PetError::new("invalid_rules"))?;
    Ok(
        json!({"moods":moods::validate(v.get("moods").unwrap_or(&d["moods"])).unwrap_or_else(|_| moods::defaults()),
    "enabled":boolean(&v["enabled"])?,"name":text(&v["name"],40,false)?,
    "sources":{"independent":boolean(&sources["independent"])?,"readTts":boolean(&sources["readTts"])?},
    "ttsAudio":choice(fallback(&v["ttsAudio"],&d["ttsAudio"]),&["pet","overlay"])?,
    "appearance":{"kind":choice(&appearance["kind"],&["png","vts"])?,"idleAssetId":nullable_id(&appearance["idleAssetId"])?,"talkingAssetId":nullable_id(&appearance["talkingAssetId"])?},
    "playback":{"target":choice(&playback["target"],&["browser","desktop"])?,"desktopSessionId":nullable_id(&playback["desktopSessionId"])?,"vtsSessionId":nullable_id(&playback["vtsSessionId"])?},
    "tts":{"enabled":boolean(&tts["enabled"])?,"provider":provider,"language":language,"voice":voice},
    "personality":{"source":source,"profileId":text(&persona["profileId"],100,source=="custom")?,"prompt":text(&persona["prompt"],4000,source=="profile")?},
    "rules":rules.iter().map(|r|text(r,300,false)).collect::<Result<Vec<_>,_>>()?,
    "behavior":{"respondToChat":boolean(&b["respondToChat"])?,"respondToEvents":boolean(&b["respondToEvents"])?,"cooldownSeconds":integer(&b["cooldownSeconds"],0,3600)?,"maxReplyLength":integer(&b["maxReplyLength"],30,500)?,"queueSize":integer(fallback(&b["queueSize"],&d["behavior"]["queueSize"]),1,10)?,"askLane":choice(fallback(&b["askLane"],&d["behavior"]["askLane"]),&["independent","tts"])?}}),
    )
}
/// Legacy read normalization only; preserves unknown saved fields and never writes.
pub fn normalize_saved_settings(saved: Option<&Value>) -> Value {
    let d = default_settings();
    let mut s = saved.unwrap_or(&d).clone();
    s["moods"] = moods::saved(s.get("moods"));
    for key in ["appearance", "playback", "ttsAudio"] {
        if s[key].is_null() {
            s[key] = d[key].clone();
        }
    }
    s["sources"] = json!({"independent":s["sources"]["independent"].as_bool().unwrap_or(true),"readTts":s["sources"]["readTts"].as_bool().unwrap_or(false)});
    for key in ["queueSize", "askLane"] {
        if s["behavior"][key].is_null() {
            s["behavior"][key] = d["behavior"][key].clone();
        }
    }
    s
}
/// Validate a cancellation/selection command ID (ASCII identity, no normalization).
pub fn command_id(v: &Value) -> Result<&str, PetError> {
    v.as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 100
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
        })
        .ok_or_else(|| PetError::new("invalid_command"))
}
/// Public request view; released players see queued as accepted. Inputs come from
/// the model's request record, never directly from an unchecked client.
pub fn request_view(request: Option<&Value>, moods_enabled: bool) -> Value {
    let Some(r) = request else { return Value::Null };
    let mut out = json!({"requestId":r["_id"],"operation":r["operation"],"status":if r["status"]=="queued" {json!("accepted")}else{r["status"].clone()},"version":r["version"]});
    for (source, target) in [("outputText", "text"), ("errorCode", "errorCode")] {
        if r[source].as_str().is_some_and(|s| !s.is_empty()) {
            out[target] = r[source].clone();
        }
    }
    if moods_enabled && let Some(mood) = r.get("mood") {
        out["mood"] =
            if mood == "neutral" || mood.as_str().is_some_and(|s| moods::NAMES.contains(&s)) {
                mood.clone()
            } else {
                json!("neutral")
            };
    }
    out
}
/// Whether a request is immutable terminal work (`PET_TERMINAL`).
pub fn terminal(status: &str) -> bool {
    ["completed", "cancelled", "failed", "expired"].contains(&status)
}
