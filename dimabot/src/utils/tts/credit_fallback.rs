//! Credit policy for queue/pet requests, before conversion to synthesis input.
use super::{
    DEFAULT_KOKORO_VOICE_EN, DEFAULT_KOKORO_VOICE_ES, TtsLanguage, TtsMode, TtsProvider,
    resolve_kokoro_voice_str,
};
use crate::utils::{
    js_string::JsString,
    tts_defaults::{PIPER_VOICE_EN, PIPER_VOICE_ES},
};
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiCreditStatus {
    Available,
    Exhausted,
    Unavailable,
}

/// `extra` carries every caller-specific field (queue context, IDs, etc.).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreditFallbackRequest<T: Clone> {
    pub mode: TtsMode,
    pub text: JsString,
    pub provider: TtsProvider,
    pub model: Option<JsString>,
    pub language: TtsLanguage,
    pub voice: JsString,
    pub clone_name: Option<JsString>,
    pub piper_fallback_voice: Option<JsString>,
    pub kokoro_fallback_voice: Option<JsString>,
    pub extra: T,
}

/// Removes tags for the two non-expressive providers, preserving UTF-16 code units.
pub fn filter_fallback_text(text: &JsString) -> JsString {
    super::filter_expressive_tts_tags_js(text, TtsProvider::Piper, None)
}

pub fn resolve_tts_for_credit_status<'a, T: Clone>(
    request: &'a CreditFallbackRequest<T>,
    status: AiCreditStatus,
    tier: Option<&str>,
) -> Cow<'a, CreditFallbackRequest<T>> {
    if request.provider == TtsProvider::Piper || status == AiCreditStatus::Available {
        return Cow::Borrowed(request);
    }
    let provider = if status == AiCreditStatus::Exhausted && matches!(tier, Some("premium" | "pro"))
    {
        TtsProvider::Kokoro
    } else {
        TtsProvider::Piper
    };
    // Every catalog ID is ASCII; trimming and lowercasing cannot make a lone
    // surrogate into one of those IDs.
    let kokoro_voice = |v: &JsString| v.as_str().and_then(resolve_kokoro_voice_str);
    let voice = if provider == TtsProvider::Kokoro {
        (request.provider == TtsProvider::Kokoro)
            .then(|| kokoro_voice(&request.voice))
            .flatten()
            .or_else(|| {
                request
                    .kokoro_fallback_voice
                    .as_ref()
                    .and_then(kokoro_voice)
            })
            .unwrap_or_else(|| {
                match request.language {
                    TtsLanguage::En => DEFAULT_KOKORO_VOICE_EN,
                    TtsLanguage::Es => DEFAULT_KOKORO_VOICE_ES,
                }
                .to_owned()
            })
            .into()
    } else {
        request
            .piper_fallback_voice
            .as_ref()
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                match request.language {
                    TtsLanguage::En => PIPER_VOICE_EN,
                    TtsLanguage::Es => PIPER_VOICE_ES,
                }
                .into()
            })
    };
    Cow::Owned(CreditFallbackRequest {
        mode: if request.mode == TtsMode::Clone {
            TtsMode::Speak
        } else {
            request.mode
        },
        provider,
        text: filter_fallback_text(&request.text),
        model: None,
        language: request.language,
        voice,
        clone_name: None,
        piper_fallback_voice: request.piper_fallback_voice.clone(),
        kokoro_fallback_voice: request.kokoro_fallback_voice.clone(),
        extra: request.extra.clone(),
    })
}
