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
    // The guards bound this conversion to integers exactly representable as f64.
    // Casting truncates toward zero, so only negative fractions need adjustment.
    let integral = (value as i64) as f64;
    let floor = if integral > value {
        integral - 1.0
    } else {
        integral
    };
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

#[cfg(test)]
mod tests {
    use super::js_round;

    #[test]
    fn rounds_ties_toward_positive_infinity_and_preserves_negative_zero() {
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(-0.5).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(js_round(-0.0).to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    #[ignore = "requires a disposable Node Math.round fixture"]
    fn matches_node_math_round_raw_bits() {
        let dir = std::env::var_os("DIMA_JS_ROUND_FIXTURE_DIR")
            .expect("DIMA_JS_ROUND_FIXTURE_DIR must point to a disposable fixture directory");
        let text =
            std::fs::read_to_string(std::path::Path::new(&dir).join("js-round-reference.json"))
                .expect("read Math.round fixture");
        let fixture: serde_json::Value = serde_json::from_str(&text).expect("valid JSON fixture");
        let metadata = &fixture["metadata"];
        assert_eq!(metadata["schema"].as_u64(), Some(1));
        assert_eq!(metadata["node"].as_str(), Some("v24.22.1"));
        assert_eq!(metadata["v8"].as_str(), Some("13.6.233.17-node.58"));
        for field in ["script", "nodeBinary"] {
            let hash = metadata["hashes"][field].as_str().expect("fixture hash");
            assert!(
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            );
        }
        let cases = fixture["cases"].as_array().expect("fixture cases");
        assert!(cases.len() >= 2_000);
        assert_eq!(metadata["count"].as_u64(), Some(cases.len() as u64));
        for (index, case) in cases.iter().enumerate() {
            let parse = |field: &str| {
                let value = case[field].as_str().expect("raw bits");
                assert!(
                    value.len() == 16
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                );
                u64::from_str_radix(value, 16).expect("hex bits")
            };
            let input = parse("input");
            assert_eq!(
                js_round(f64::from_bits(input)).to_bits(),
                parse("output"),
                "case {index}, input {input:016x}"
            );
        }
    }
}
