//! ECMAScript `Number(value)` coercion for ordinary JSON payloads.
//!
//! Shared by credit calculations and Twitch reward normalization. JSON has no
//! undefined value, Symbols, BigInts, prototypes or custom coercion hooks; an
//! absent field must be handled separately by its caller.

use super::js_compat::trim as js_trim;
use serde_json::Value;

pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => string_number(value),
        Value::Array(_) => string_number(&array_primitive(value)),
        Value::Object(_) => f64::NAN,
    }
}

fn array_primitive(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Array(values) => values
            .iter()
            .map(array_primitive)
            .collect::<Vec<_>>()
            .join(","),
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

pub(crate) fn string_number(value: &str) -> f64 {
    let value = js_trim(value);
    if value.is_empty() {
        return 0.0;
    }
    match value {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|ch| ch.is_digit(radix)) {
                return f64::NAN;
            }
            return radix_number(digits, radix);
        }
    }
    // Rust's float parser also accepts `inf`/`infinity`; ECMAScript does not.
    if !value
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return f64::NAN;
    }
    value.parse::<f64>().unwrap_or(f64::NAN)
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    let width = radix.trailing_zeros() as usize;
    let bits: Vec<u32> = digits
        .chars()
        .flat_map(|ch| {
            let digit = ch.to_digit(radix).expect("validated radix digit");
            (0..width).rev().map(move |shift| (digit >> shift) & 1)
        })
        .skip_while(|bit| *bit == 0)
        .collect();
    if bits.len() > 1024 {
        return f64::INFINITY;
    }
    let mut significand = bits
        .iter()
        .take(53)
        .fold(0_u64, |n, &bit| (n << 1) | u64::from(bit));
    if bits.len() <= 53 {
        return significand as f64;
    }
    if bits[53] != 0 && (significand & 1 != 0 || bits[54..].contains(&1)) {
        significand += 1;
    }
    (significand as f64) * 2.0_f64.powi((bits.len() - 53) as i32)
}

/// JavaScript Number string form, shared with the AST evaluator.
pub fn number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == f64::INFINITY {
        return "Infinity".into();
    }
    if n == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let negative = n < 0.0;
    let magnitude = n.abs();
    // Every integral binary64 within +/-2^53 has exact integer text, and this
    // whole interval uses fixed-point JS notation. Keep the bound: above it,
    // the shortest JS spelling can differ from the integer's exact digits.
    if n.is_finite() && magnitude <= 9_007_199_254_740_992.0 && n.fract() == 0.0 {
        return (n as i64).to_string();
    }
    // Display breaks some equally short decimal ties differently from V8.
    // Reuse the existing JSON serializer's finite-f64 digit seed once, then
    // retain the ECMAScript notation normalization below. No Value roundtrip.
    let mut raw = serde_json::to_string(&magnitude).expect("finite f64 serialization");
    if (1e-6..1e21).contains(&magnitude) && !raw.contains(['e', 'E']) {
        // An exponent-free integral float may carry Serde's .0 suffix; its
        // removal preserves the value. Other fractional trailing zeros still
        // require the fallback. Integer trailing zeros must be retained.
        if raw.ends_with(".0") {
            raw.truncate(raw.len() - 2);
        }
        // Keep both shape guards: the serializer's notation policy is not the
        // JS contract, and e.g. `1.20` still needs existing normalization.
        if !raw.contains('.') || !raw.ends_with('0') {
            if negative {
                raw.insert(0, '-');
            }
            return raw;
        }
    }
    let (mantissa, exponent) = raw
        .split_once(['e', 'E'])
        .map_or((raw.as_str(), 0), |(m, e)| {
            (m, e.parse::<i32>().unwrap_or(0))
        });
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    let mut decimal = point + exponent;
    let zeros = digits.bytes().take_while(|b| *b == b'0').count();
    digits.drain(..zeros);
    decimal -= zeros as i32;
    while digits.ends_with('0') {
        digits.pop();
    }
    let mut out = if decimal > 0 && decimal <= 21 {
        if decimal as usize >= digits.len() {
            format!("{}{}", digits, "0".repeat(decimal as usize - digits.len()))
        } else {
            format!(
                "{}.{}",
                &digits[..decimal as usize],
                &digits[decimal as usize..]
            )
        }
    } else if decimal <= 0 && decimal > -6 {
        format!("0.{}{}", "0".repeat((-decimal) as usize), digits)
    } else {
        let e = decimal - 1;
        let mantissa = if digits.len() == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{mantissa}e{}{e}", if e >= 0 { "+" } else { "" })
    };
    if negative {
        out.insert(0, '-');
    }
    out
}
