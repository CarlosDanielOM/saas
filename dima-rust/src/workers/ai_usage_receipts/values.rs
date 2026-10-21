//! JavaScript coercions used by the queue parser, without accepting application payload fields.
use mongodb::bson::{Bson, DateTime, Document};
use serde_json::Value;

pub(super) const DAY: i64 = 86_400_000;
pub(super) fn now() -> i64 {
    DateTime::now().timestamp_millis()
}
pub(super) fn date(ms: i64) -> DateTime {
    DateTime::from_millis(ms)
}
pub(super) fn iso(ms: i64) -> String {
    let base = date(ms.div_euclid(1000) * 1000)
        .try_to_rfc3339_string()
        .unwrap_or_default();
    format!(
        "{}.{:03}Z",
        base.trim_end_matches('Z')
            .split('.')
            .next()
            .unwrap_or_default(),
        ms.rem_euclid(1000)
    )
}
pub(super) fn day(ms: i64) -> String {
    iso(ms)[..10].to_owned()
}
pub(super) fn parse_date(value: &str) -> Option<i64> {
    let date = if value.len() == 10 {
        format!("{value}T00:00:00Z")
    } else {
        value.to_owned()
    };
    DateTime::parse_rfc3339_str(date)
        .ok()
        .map(|value| value.timestamp_millis())
}
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(|character:char| matches!(character,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let scientific = format!("{value:e}");
        let (mantissa, exponent) = scientific
            .split_once('e')
            .expect("exponential float formatting");
        let exponent = exponent.parse::<i32>().expect("exponential float exponent");
        format!(
            "{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        )
    } else {
        value.to_string()
    }
}
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(v) => v.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => number_string(v.as_f64().unwrap_or(0.0)),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() || v.is_array() && v.as_array().is_some_and(Vec::is_empty) {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub(super) fn number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(v) => v.as_f64()?,
        Value::String(v) => {
            let v = js_trim(v);
            if v.is_empty() {
                0.0
            } else {
                let radix = if v.starts_with("0x") || v.starts_with("0X") {
                    Some(16)
                } else if v.starts_with("0b") || v.starts_with("0B") {
                    Some(2)
                } else if v.starts_with("0o") || v.starts_with("0O") {
                    Some(8)
                } else {
                    None
                };
                if let Some(radix) = radix {
                    let digits = &v[2..];
                    if digits.is_empty() {
                        return None;
                    }
                    if let Ok(integer) = u128::from_str_radix(digits, radix) {
                        integer as f64
                    } else {
                        let mut number = 0.0;
                        for digit in digits.chars() {
                            number = number * f64::from(radix) + f64::from(digit.to_digit(radix)?);
                        }
                        number
                    }
                } else {
                    v.parse().ok()?
                }
            }
        }
        Value::Array(_) => return number(Some(&Value::String(js_string(value)))),
        _ => return None,
    };
    number.is_finite().then_some(number)
}
pub(super) fn text(value: Option<&Value>) -> Option<String> {
    let value = js_trim(value?.as_str()?);
    if value.is_empty() {
        return None;
    }
    // JS slice(0,128) counts UTF-16 units. A split surrogate is represented by
    // U+FFFD on BSON UTF-8 serialization, matching the Node writer.
    Some(String::from_utf16_lossy(
        &value.encode_utf16().take(128).collect::<Vec<_>>(),
    ))
}
pub(super) fn category(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("tts") => "tts",
        Some("ai_chat") => "ai_chat",
        Some("ai_agent") => "ai_agent",
        Some("memory") => "memory",
        Some("clip_recommendation") => "clip_recommendation",
        Some("credit_adjustment") => "credit_adjustment",
        Some("other") => "other",
        _ => "uncategorized",
    }
}
pub(super) fn retention(tier: &str) -> i64 {
    match tier {
        "pro" => 90,
        "premium" => 60,
        _ => 30,
    }
}
pub(super) fn bson_number(value: f64) -> Bson {
    let negative_zero = value == 0.0 && value.is_sign_negative();
    if !negative_zero
        && value.is_finite()
        && value.fract() == 0.0
        && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value)
    {
        Bson::Int32(value as i32)
    } else {
        Bson::Double(value)
    }
}
pub(super) fn bson_json(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(v) => Bson::Boolean(*v),
        Value::String(v) => Bson::String(v.clone()),
        Value::Number(v) => bson_number(v.as_f64().unwrap_or(0.0)),
        Value::Array(v) => Bson::Array(v.iter().map(bson_json).collect()),
        Value::Object(v) => {
            Bson::Document(v.iter().map(|(k, v)| (k.clone(), bson_json(v))).collect())
        }
    }
}
pub(super) fn numeric(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(v)) => f64::from(*v),
        Some(Bson::Int64(v)) => *v as f64,
        Some(Bson::Double(v)) => *v,
        _ => 0.0,
    }
}
pub(super) fn round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

pub(super) fn adjustment(row: &Value, kind: &str) -> Option<String> {
    if kind != "adjustment" {
        return None;
    }
    if let Some(v) = row["adjustmentType"].as_str().filter(|v| {
        [
            "manual_grant",
            "monthly_reset",
            "subscription_credits",
            "purchased_pack",
            "gifted_credits",
            "native_grant",
            "refund",
            "correction",
            "activation",
            "other",
        ]
        .contains(v)
    }) {
        return Some(v.into());
    }
    let source = if truthy(&row["source"]) {
        js_string(&row["source"])
    } else {
        String::new()
    };
    let operation = if truthy(&row["operation"]) {
        js_string(&row["operation"])
    } else {
        String::new()
    };
    Some(
        (if source == "polar_meter_credit" {
            "native_grant"
        } else if ["free_credit_reset", "free_credit_reset_worker"].contains(&source.as_str())
            || operation == "monthly_reset"
        {
            "monthly_reset"
        } else if source == "admin_credit_grant" {
            "manual_grant"
        } else if source == "credit_pack_purchase" || operation == "purchase_pack" {
            "purchased_pack"
        } else if operation == "refund" {
            "refund"
        } else if operation == "correction" {
            "correction"
        } else if source == "activation" || row["reason"] == "Free benefits" {
            "activation"
        } else {
            "other"
        })
        .into(),
    )
}

#[derive(Debug)]
pub(super) struct Receipt {
    pub channel: String,
    pub customer: String,
    pub occurred: i64,
    pub document: Document,
}
pub(super) fn parse_receipt(raw: &str) -> Option<Receipt> {
    let row: Value = serde_json::from_str(raw).ok()?;
    for key in ["channelID", "customerId", "id"] {
        if !row.get(key).is_some_and(truthy) {
            return None;
        }
    }
    let occurred = parse_date(&js_string(row.get("occurredAt")?))?;
    let credits = number(row.get("credits"))?;
    let kind = if row["entryKind"] == "adjustment" || credits < 0.0 {
        "adjustment"
    } else {
        "usage"
    };
    let channel = js_string(&row["channelID"]);
    let customer = js_string(&row["customerId"]);
    let mut document = mongodb::bson::doc! {"channelID": &channel,"customerId": &customer,"entryId": js_string(&row["id"]),"occurredAt": date(occurred),"entryKind":kind,"category":category(row.get("category")),"credits":bson_number(credits),"itemized":row["itemized"] == true};
    for key in ["requestId", "source", "model", "resourceId"] {
        document.insert(key, text(row.get(key)).map_or(Bson::Null, Bson::String));
    }
    document.insert(
        "operation",
        text(row.get("operation")).unwrap_or_else(|| "usage".into()),
    );
    document.insert(
        "provider",
        text(row.get("provider")).unwrap_or_else(|| "unknown".into()),
    );
    document.insert(
        "adjustmentType",
        adjustment(&row, kind).map_or(Bson::Null, Bson::String),
    );
    document.insert(
        "quantity",
        number(row.get("quantity")).map_or(Bson::Null, bson_number),
    );
    document.insert(
        "unit",
        row["unit"]
            .as_str()
            .filter(|v| ["characters", "tokens", "minutes"].contains(v))
            .map_or(Bson::Null, |v| Bson::String(v.into())),
    );
    document.insert(
        "resourceType",
        row["resourceType"]
            .as_str()
            .filter(|v| ["speech", "voice_preview", "llm_generation", "vod_analysis"].contains(v))
            .map_or(Bson::Null, |v| Bson::String(v.into())),
    );
    Some(Receipt {
        channel,
        customer,
        occurred,
        document,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rounding_matches_js_at_adjacent_halves_and_negative_zero() {
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(0.5), 1.0);
        assert_eq!(round(-0.5000000000000001), -1.0);
        assert!(round(-0.5).is_sign_negative());
        assert!(round(-0.1).is_sign_negative());
        assert_eq!(round(-1.5), -1.0);
        assert!(round(-0.0).is_sign_negative());
    }
    #[test]
    fn numeric_strings_use_js_double_coercion_and_exponent_boundaries() {
        assert_eq!(
            js_string(&serde_json::from_str::<Value>("1.0").unwrap()),
            "1"
        );
        assert_eq!(
            js_string(&serde_json::from_str::<Value>("9007199254740993").unwrap()),
            "9007199254740992"
        );
        assert_eq!(number_string(1e21), "1e+21");
        assert_eq!(number_string(1e-7), "1e-7");
        assert_eq!(number_string(1e-6), "0.000001");
    }
    #[test]
    fn number_and_text_trim_follow_ecmascript_not_rust_whitespace() {
        assert_eq!(number(Some(&json!("\u{feff}0b101\u{feff}"))), Some(5.0));
        assert_eq!(number(Some(&json!("0o17"))), Some(15.0));
        assert_eq!(number(Some(&json!("0x10"))), Some(16.0));
        assert_eq!(number(Some(&json!("\u{0085}1"))), None);
        assert_eq!(
            text(Some(&json!("\u{feff} hello \u{feff}"))).as_deref(),
            Some("hello")
        );
        assert_eq!(
            adjustment(&json!({"operation":["refund"]}), "adjustment").as_deref(),
            Some("refund")
        );
    }
    #[test]
    fn parser_keeps_fractional_and_negative_credits_and_null_quantity_coercion() {
        let mut row = json!({"channelID":"c","customerId":"u","id":"r","occurredAt":"2026-10-21T12:00:00.000Z","credits":-1.25,"quantity":null,"source":"admin_credit_grant","entryKind":"usage","itemized":true});
        let r = parse_receipt(&row.to_string()).unwrap();
        assert_eq!(numeric(&r.document, "credits"), -1.25);
        assert_eq!(r.document.get_str("entryKind").unwrap(), "adjustment");
        assert_eq!(
            r.document.get_str("adjustmentType").unwrap(),
            "manual_grant"
        );
        assert_eq!(numeric(&r.document, "quantity"), 0.0);
        row["credits"] = json!(0.25);
        row["quantity"] = json!("3.5");
        let r = parse_receipt(&row.to_string()).unwrap();
        assert_eq!(r.document.get("adjustmentType"), Some(&Bson::Null));
        assert_eq!(numeric(&r.document, "quantity"), 3.5);
    }
    #[test]
    fn parser_distinguishes_missing_from_null_numbers_and_uses_utf16_limit() {
        assert_eq!(number(None), None);
        assert_eq!(number(Some(&Value::Null)), Some(0.0));
        assert_eq!(
            text(Some(&json!("😀".repeat(65))))
                .unwrap()
                .encode_utf16()
                .count(),
            128
        );
        assert!(parse_receipt("null").is_none());
        assert!(parse_receipt("{}").is_none());
        assert_eq!(
            iso(parse_date("2026-10-21T12:00:00Z").unwrap()),
            "2026-10-21T12:00:00.000Z"
        );
    }
    #[test]
    fn classification_priorities_match_accounting() {
        assert_eq!(
            adjustment(
                &json!({"adjustmentType":"refund","source":"polar_meter_credit"}),
                "adjustment"
            )
            .as_deref(),
            Some("refund")
        );
        assert_eq!(
            adjustment(
                &json!({"operation":"refund","source":"free_credit_reset_worker"}),
                "adjustment"
            )
            .as_deref(),
            Some("monthly_reset")
        );
        assert_eq!(adjustment(&json!({"operation":"refund"}), "usage"), None);
    }
}
