//! Credit policy for queue/pet requests, before conversion to synthesis input.
use super::{
    DEFAULT_KOKORO_VOICE_EN, DEFAULT_KOKORO_VOICE_ES, TtsLanguage, TtsMode, TtsProvider,
    expressive_tag_regex, resolve_kokoro_voice_str,
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
/// The shadow string only supplies regex positions; retained text comes from the
/// original units, including unpaired surrogates and whitespace around them.
pub fn filter_fallback_text(text: &JsString) -> JsString {
    if let Some(text) = text.as_str() {
        return super::filter_expressive_tts_tags(text, TtsProvider::Piper, None).into();
    }
    let tags = expressive_tag_regex();
    let units = text.units();
    let mut shadow = String::new();
    let mut offsets = vec![(0, 0)];
    let mut index = 0;
    while index < units.len() {
        let first = units[index];
        let pair = (0xd800..=0xdbff).contains(&first)
            && units
                .get(index + 1)
                .is_some_and(|u| (0xdc00..=0xdfff).contains(u));
        let c = if pair {
            char::from_u32(
                0x10000
                    + ((u32::from(first) - 0xd800) << 10)
                    + (u32::from(units[index + 1]) - 0xdc00),
            )
            .unwrap()
        } else {
            char::from_u32(u32::from(first)).unwrap_or('\u{fffd}')
        };
        shadow.push(c);
        index += if pair { 2 } else { 1 };
        offsets.push((shadow.len(), index));
    }
    let at = |byte| {
        offsets
            .binary_search_by_key(&byte, |p| p.0)
            .map(|i| offsets[i].1)
            .unwrap()
    };
    let mut result = Vec::new();
    let mut previous = 0;
    for m in tags.find_iter(&shadow) {
        result.extend_from_slice(&units[at(previous)..at(m.start())]);
        if m.as_str().starts_with('[') {
            result.push(0x20);
        }
        previous = m.end();
    }
    result.extend_from_slice(&units[at(previous)..]);
    let mut collapsed = Vec::with_capacity(result.len());
    for unit in result {
        if unit != 0x20 || collapsed.last() != Some(&0x20) {
            collapsed.push(unit);
        }
    }
    JsString::from_units(collapsed).trim()
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
