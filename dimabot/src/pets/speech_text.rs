//! Pure pet speech composition. Runtime lookup, billing and persistence remain
//! the caller's responsibility; pass the effective provider after fallback.
use crate::utils::{
    js_string::JsString,
    lossless_json::JsonValue,
    tts::{
        NormalizeTtsMessageOptions, NormalizeTtsMessageResultJs, TtsProvider,
        filter_expressive_tts_tags_json_js, normalize_tts_message_js,
    },
};

/// `expressive_tags` may borrow the raw `expressiveTags` field from the
/// channel settings' `filters` object, preserving its lossless JSON values.
pub fn filter_pet_talk_text(
    text: &JsString,
    provider: TtsProvider,
    filters: &NormalizeTtsMessageOptions<'_>,
    expressive_tags: Option<&JsonValue>,
) -> NormalizeTtsMessageResultJs {
    let filtered = filter_expressive_tts_tags_json_js(text, provider, expressive_tags);
    normalize_tts_message_js(&filtered, filters)
}
