//! Credit fallback policy; no accounting is performed here.
use dima_billing::plans::PlanTier;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub mode: String,
    pub text: String,
    pub provider: String,
    pub model: Option<String>,
    pub language: String,
    pub voice: String,
    pub clone_name: Option<String>,
    pub piper_fallback_voice: Option<String>,
    pub kokoro_fallback_voice: Option<String>,
}
pub const KOKORO_VOICES: &[&str] = &[
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_heart",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
    "ef_dora",
    "em_alex",
    "em_santa",
    "ff_siwis",
    "hf_alpha",
    "hf_beta",
    "hm_omega",
    "hm_psi",
    "if_sara",
    "im_nicola",
    "jf_alpha",
    "jf_gongitsune",
    "jf_nezumi",
    "jf_tebukuro",
    "jm_kumo",
    "pf_dora",
    "pm_alex",
    "pm_santa",
    "zf_xiaobei",
    "zf_xiaoni",
    "zf_xiaoxiao",
    "zf_xiaoyi",
    "zm_yunjian",
    "zm_yunxi",
    "zm_yunxia",
    "zm_yunyang",
];
pub fn kokoro_voice(input: &str) -> Option<String> {
    let voice = dima_text::to_lower(dima_text::trim(input));
    KOKORO_VOICES.contains(&voice.as_str()).then_some(voice)
}
pub fn resolve(mut request: Request, status: &str, tier: PlanTier) -> Request {
    if request.provider == "piper" || status == "available" {
        return request;
    }
    let kokoro = status == "exhausted" && matches!(tier, PlanTier::Premium | PlanTier::Pro);
    let voice = if kokoro {
        (request.provider == "kokoro")
            .then(|| kokoro_voice(&request.voice))
            .flatten()
            .or_else(|| {
                request
                    .kokoro_fallback_voice
                    .as_deref()
                    .and_then(kokoro_voice)
            })
            .unwrap_or_else(|| {
                if request.language == "en" {
                    "af_heart"
                } else {
                    "ef_dora"
                }
                .into()
            })
    } else {
        request
            .piper_fallback_voice
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if request.language == "en" {
                    "en_US-ryan-medium"
                } else {
                    "es_MX-ald-medium"
                }
                .into()
            })
    };
    request.provider = if kokoro { "kokoro" } else { "piper" }.into();
    request.text = crate::tags::filter(&request.text, &request.provider, &Default::default());
    if request.mode == "clone" {
        request.mode = "speak".into();
    }
    request.voice = voice;
    request.model = None;
    request.clone_name = None;
    request
}
