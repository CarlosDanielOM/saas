//! Pure pricing from `tts_usage.ts`; tracking and billing are separate.
#[cfg(feature = "tts-utilities")]
use crate::utils::{js_string::JsString, lossless_json::JsonValue};

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "credit-policy", derive(serde::Serialize))]
#[cfg_attr(feature = "credit-policy", serde(rename_all = "camelCase"))]
pub struct TtsUsageResult {
    pub characters: f64,
    pub credits_consumed: f64,
    pub polarsh_cost: f64,
    pub cost_usd: f64,
}

#[cfg(feature = "tts-utilities")]
impl TtsUsageResult {
    /// JavaScript JSON.stringify property order and number semantics.
    pub fn to_json_string(&self) -> String {
        JsonValue::Object(vec![
            ("characters".into(), JsonValue::Number(self.characters)),
            (
                "creditsConsumed".into(),
                JsonValue::Number(self.credits_consumed),
            ),
            ("polarshCost".into(), JsonValue::Number(self.polarsh_cost)),
            ("costUsd".into(), JsonValue::Number(self.cost_usd)),
        ])
        .to_json_string()
    }
}

// Mirrors credit_policy's JS round: avoid adding 0.5 before flooring, which
// rounds representable values just below a tie incorrectly.
pub(crate) fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 || value.abs() >= 4_503_599_627_370_496.0 {
        return value;
    }
    if (-0.5..0.0).contains(&value) {
        return -0.0;
    }
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

/// Provider is the unmodified, case-sensitive JavaScript string.
pub fn calculate_tts_usage(provider: &str, characters: f64) -> TtsUsageResult {
    let credits_consumed = match provider {
        "fish" => (characters * 1.5).ceil(),
        "piper" => (characters / 50.0).ceil(),
        "kokoro" => (characters / 15.0).ceil(),
        "constructor"
        | "__defineGetter__"
        | "__defineSetter__"
        | "hasOwnProperty"
        | "__lookupGetter__"
        | "__lookupSetter__"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "toString"
        | "valueOf"
        | "__proto__"
        | "toLocaleString" => 0.0,
        _ => (characters / 100.0).ceil(),
    };
    let polarsh_cost = credits_consumed / 1000.0;
    let cost_usd = credits_consumed * 0.00001;
    TtsUsageResult {
        characters,
        credits_consumed,
        polarsh_cost: js_round(polarsh_cost * 100_000.0) / 100_000.0,
        cost_usd: js_round(cost_usd * 100_000.0) / 100_000.0,
    }
}

/// Lossless UTF-16 provider; a lone surrogate cannot equal any table or
/// Object.prototype key, so it takes the ordinary unknown-provider path.
#[cfg(feature = "tts-utilities")]
pub fn calculate_tts_usage_js(provider: &JsString, characters: f64) -> TtsUsageResult {
    calculate_tts_usage(provider.as_str().unwrap_or(""), characters)
}
