//! Pure channel TTS defaults and normalization from channel_tts_settings.schema.ts.
//!
//! Inputs are ordinary JSON data: objects have the usual Object prototype,
//! arrays have the usual Array prototype, and own fields are not callable.
//! Consequently an own `toString` field can cause the source's TypeError, but
//! accessors, custom prototypes, functions and executable coercion hooks are
//! outside this data boundary. UTF-16 strings remain lossless until a caller
//! explicitly chooses a UTF-8/BSON boundary.

use super::{
    DEFAULT_KOKORO_VOICE_ES, ExpressiveTagConfig, TtsProvider, expressive_tags,
    resolve_kokoro_voice_json,
};
use crate::utils::{
    js_string::JsString,
    json_number::{number_string, string_number},
    lossless_json::JsonValue,
    tts_defaults::{PIPER_VOICE_EN, PIPER_VOICE_ES},
};
use std::fmt;

const DEFAULT_CLONE_VOICE: &str = "gojo";
const DEFAULT_MAX_LENGTH: f64 = 280.0;
const DEFAULT_MAX_ITEMS: f64 = 5.0;

/// Ordinary JavaScript coercion failures are separate from persisted schema
/// validation errors. Every error currently corresponds to a TypeError.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsError;

impl SettingsError {
    pub fn name(&self) -> &'static str {
        "TypeError"
    }
}
impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Cannot convert object to primitive value")
    }
}
impl std::error::Error for SettingsError {}

fn object<const N: usize>(fields: [(&str, JsonValue); N]) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (JsString::from(key), value))
            .collect(),
    )
}
fn text(value: &str) -> JsonValue {
    JsonValue::String(JsString::from(value))
}
fn field<'a>(value: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    // All property names used here are non-index names absent from the boxed
    // primitive prototypes. JSON scalar boxing therefore yields undefined.
    value.and_then(|value| value.get(key))
}
fn string(value: Option<&JsonValue>) -> Option<&JsString> {
    match value {
        Some(JsonValue::String(value)) => Some(value),
        _ => None,
    }
}
fn is_null(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Null)
}
pub(crate) fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(value) => *value,
        JsonValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsonValue::String(value) => !value.is_empty(),
        JsonValue::Array(_) | JsonValue::Object(_) => true,
    }
}
fn nullish_flag(value: Option<&JsonValue>) -> JsonValue {
    value
        .filter(|value| !is_null(value))
        .cloned()
        .unwrap_or(JsonValue::Bool(true))
}

/// JSON-data String(value), including Array.join and own non-callable toString.
pub(crate) fn js_string(value: &JsonValue) -> Result<JsString, SettingsError> {
    match value {
        JsonValue::Null => Ok(JsString::from("null")),
        JsonValue::Bool(value) => Ok(JsString::from(if *value { "true" } else { "false" })),
        JsonValue::Number(value) => Ok(JsString::from(number_string(*value))),
        JsonValue::String(value) => Ok(value.clone()),
        JsonValue::Object(_) if value.get("toString").is_some() => Err(SettingsError),
        JsonValue::Object(_) => Ok(JsString::from("[object Object]")),
        JsonValue::Array(values) => {
            let mut units = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    units.push(u16::from(b','));
                }
                if !is_null(value) {
                    units.extend(js_string(value)?.code_units());
                }
            }
            Ok(JsString::from_units(units))
        }
    }
}
pub(crate) fn js_number(value: Option<&JsonValue>) -> Result<f64, SettingsError> {
    Ok(match value {
        None => f64::NAN,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Bool(value)) => f64::from(u8::from(*value)),
        Some(JsonValue::Number(value)) => *value,
        Some(value) => js_string(value)?.as_str().map_or(f64::NAN, string_number),
    })
}
fn clamp_number(
    value: Option<&JsonValue>,
    fallback: f64,
    minimum: f64,
    maximum: f64,
) -> Result<JsonValue, SettingsError> {
    let number = js_number(value)?;
    Ok(JsonValue::Number(if number.is_finite() {
        number.trunc().clamp(minimum, maximum)
    } else {
        fallback
    }))
}
fn voice(value: Option<&JsonValue>, fallback: &str) -> Result<JsonValue, SettingsError> {
    let value = match value.filter(|value| truthy(value)) {
        Some(value) => js_string(value)?.trim(),
        None => JsString::from(fallback),
    };
    Ok(JsonValue::String(if value.is_empty() {
        JsString::from(fallback)
    } else {
        value
    }))
}
fn provider(value: Option<&JsonValue>) -> TtsProvider {
    match string(value).and_then(JsString::as_str) {
        Some("fish") => TtsProvider::Fish,
        Some("kokoro") => TtsProvider::Kokoro,
        // The legacy xai/openrouter aliases and every unknown value default
        // to Piper, just as the source's sanitizeProvider fallback does.
        _ => TtsProvider::Piper,
    }
}
fn provider_name(provider: TtsProvider) -> &'static str {
    match provider {
        TtsProvider::Piper => "piper",
        TtsProvider::Fish => "fish",
        TtsProvider::Kokoro => "kokoro",
    }
}
fn expressive_settings(input: Option<&JsonValue>) -> JsonValue {
    let config = ExpressiveTagConfig::new(input);
    JsonValue::Object(
        expressive_tags()
            .map(|tag| (JsString::from(tag), JsonValue::Bool(config.tag(tag))))
            .collect(),
    )
}

/// Produce a new, independently owned settings tree. Identity strings are
/// copied verbatim; only normalization trims a channel name.
pub fn create_default_channel_tts_settings(channel_id: &JsString, channel: &JsString) -> JsonValue {
    object([
        ("channelID", JsonValue::String(channel_id.clone())),
        ("channel", JsonValue::String(channel.clone())),
        ("enabled", JsonValue::Bool(true)),
        ("provider", text("piper")),
        ("defaultLanguage", text("es")),
        (
            "voices",
            object([
                ("en", text(PIPER_VOICE_EN)),
                ("es", text(PIPER_VOICE_ES)),
                ("cloneDefault", text(DEFAULT_CLONE_VOICE)),
                ("kokoroDefault", text(DEFAULT_KOKORO_VOICE_ES)),
            ]),
        ),
        (
            "filters",
            object([
                ("skipEmotes", JsonValue::Bool(true)),
                ("stripLinks", JsonValue::Bool(true)),
                ("normalizeWhitespace", JsonValue::Bool(true)),
                ("maxLength", JsonValue::Number(DEFAULT_MAX_LENGTH)),
                ("expressiveTags", expressive_settings(None)),
            ]),
        ),
        (
            "queue",
            object([("maxItems", JsonValue::Number(DEFAULT_MAX_ITEMS))]),
        ),
    ])
}

/// Match the source normalizer before Mongoose casts persisted field types.
/// `None` represents undefined, distinct from an explicitly present JSON null.
/// Nullish-coalesced enabled/filter values remain arbitrary JSON values.
pub fn normalize_channel_tts_settings(
    input: Option<&JsonValue>,
    channel_id: &JsString,
    channel: &JsString,
) -> Result<JsonValue, SettingsError> {
    let selected_provider = provider(field(input, "provider"));
    let channel_name = match field(input, "channel").filter(|value| truthy(value)) {
        Some(value) => js_string(value)?,
        None => channel.clone(),
    }
    .trim();
    let voices = field(input, "voices");
    let filters = field(input, "filters");
    let queue = field(input, "queue");
    let clone_voice = string(field(voices, "cloneDefault"))
        .map(JsString::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| JsString::from(DEFAULT_CLONE_VOICE));
    let kokoro_voice = field(voices, "kokoroDefault")
        .and_then(resolve_kokoro_voice_json)
        .unwrap_or_else(|| DEFAULT_KOKORO_VOICE_ES.to_owned());
    Ok(object([
        ("channelID", JsonValue::String(channel_id.clone())),
        ("channel", JsonValue::String(channel_name)),
        ("enabled", nullish_flag(field(input, "enabled"))),
        ("provider", text(provider_name(selected_provider))),
        (
            "defaultLanguage",
            text(
                if string(field(input, "defaultLanguage")).and_then(JsString::as_str) == Some("en")
                {
                    "en"
                } else {
                    "es"
                },
            ),
        ),
        (
            "voices",
            object([
                ("en", voice(field(voices, "en"), PIPER_VOICE_EN)?),
                ("es", voice(field(voices, "es"), PIPER_VOICE_ES)?),
                ("cloneDefault", JsonValue::String(clone_voice)),
                ("kokoroDefault", text(&kokoro_voice)),
            ]),
        ),
        (
            "filters",
            object([
                ("skipEmotes", nullish_flag(field(filters, "skipEmotes"))),
                ("stripLinks", nullish_flag(field(filters, "stripLinks"))),
                (
                    "normalizeWhitespace",
                    nullish_flag(field(filters, "normalizeWhitespace")),
                ),
                (
                    "maxLength",
                    clamp_number(field(filters, "maxLength"), DEFAULT_MAX_LENGTH, 30.0, 500.0)?,
                ),
                (
                    "expressiveTags",
                    expressive_settings(field(filters, "expressiveTags")),
                ),
            ]),
        ),
        (
            "queue",
            object([(
                "maxItems",
                clamp_number(field(queue, "maxItems"), DEFAULT_MAX_ITEMS, 1.0, 20.0)?,
            )]),
        ),
    ]))
}
