//! Pure `shared_chat_origin.ts`, `bits_message.ts`, and `badges.ts` rules.
//!
//! JSON chat payloads have no inherited properties/accessors. The bits helper
//! consequently models ordinary payloads, not arbitrary JS prototype objects.
//! Badges retain their declared string fields; invalid runtime casts, Symbols,
//! and custom coercion hooks are outside this API. Formatting is synchronous.
//! Gate with the opt-in `chat-message` feature (serde + serde_json).

use super::js_compat::trim as js_trim;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `None` uses the event's broadcaster, like omitted/undefined receiverID.
/// `Some(Value::Null)` remains an explicit null and never equals a string ID.
pub fn is_foreign_shared_chat_event(
    event_type: &str,
    event: &Value,
    receiver_id: Option<&Value>,
) -> bool {
    if !matches!(
        event_type,
        "channel.chat.message" | "channel.chat.notification"
    ) {
        return false;
    }
    let Some(source) = event
        .get("source_broadcaster_user_id")
        .and_then(Value::as_str)
    else {
        return false;
    };
    !source.is_empty()
        && Some(source)
            != receiver_id
                .or_else(|| event.get("broadcaster_user_id"))
                .and_then(Value::as_str)
}

pub fn get_bits_message_text(message: &Value) -> &str {
    message
        .as_str()
        .or_else(|| message.as_object()?.get("text")?.as_str())
        .unwrap_or("")
}

#[derive(Debug, Clone, Deserialize)]
pub struct Badge {
    pub set_id: String,
    pub id: String,
    pub info: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormattedBadges {
    pub formatted_badges: String,
    pub badge_list: Vec<String>,
    pub is_mod: bool,
    pub is_sub: bool,
    /// JS Number, including infinity for overflowing parseInt input.
    pub sub_months: f64,
}

pub fn format_badges(badges: &[Badge]) -> FormattedBadges {
    let find = |id: &str| badges.iter().find(|badge| badge.set_id == id);
    let mut labels = Vec::new();
    let mut is_mod = false;
    let mut is_sub = false;
    let mut sub_months = 0.0;
    if find("broadcaster").is_some() {
        labels.push("[STREAMER]".into());
        is_mod = true;
    } else if find("moderator").is_some() {
        labels.push("[MOD]".into());
        is_mod = true;
    } else if find("vip").is_some() {
        labels.push("[VIP]".into());
    }
    for (id, label) in [("founder", "FOUNDER"), ("subscriber", "SUB")] {
        if let Some(badge) = find(id) {
            sub_months = parse_badge_months(&badge.info);
            labels.push(format!("[{label} {}M]", js_integer_string(sub_months)));
            is_sub = true;
            break;
        }
    }
    for (id, label) in [
        ("premium", "PRIME"),
        ("partner", "PARTNER"),
        ("staff", "STAFF"),
        ("turbo", "TURBO"),
        ("sub-gifter", "SUB-GIFTER"),
    ] {
        if find(id).is_some() {
            labels.push(format!("[{label}]"));
        }
    }
    FormattedBadges {
        formatted_badges: if labels.is_empty() {
            String::new()
        } else {
            labels.join(" ") + " "
        },
        badge_list: labels,
        is_mod,
        is_sub,
        sub_months,
    }
}

// parseInt(info) || 0: inferred hexadecimal, signed prefixes, trailing junk,
// and ASCII decimal digits; this is intentionally not strict Rust parsing.
fn parse_badge_months(info: &str) -> f64 {
    let text = js_trim(info);
    let (negative, text) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let number = if text.starts_with("0x") || text.starts_with("0X") {
        // Accumulate exact binary bits, rounding only once. Repeated f64
        // multiply/add would round large hexadecimal integers multiple times.
        let digits: String = text[2..]
            .chars()
            .take_while(char::is_ascii_hexdigit)
            .collect();
        radix_integer(&digits, 16)
    } else {
        let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<f64>().unwrap_or(f64::NAN)
    };
    if number.is_nan() || number == 0.0 {
        0.0
    } else if negative {
        -number
    } else {
        number
    }
}

/// Exact integer-to-Number rounding for binary/octal/hex strings. Private to
/// this port; credit policy uses its own bounded JSON numeric coercion.
fn radix_integer(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let width = radix.trailing_zeros() as usize;
    let mut bits = Vec::new();
    for ch in digits.chars() {
        let digit = ch.to_digit(radix).expect("validated radix digit");
        for shift in (0..width).rev() {
            bits.push((digit >> shift) & 1);
        }
    }
    let Some(first) = bits.iter().position(|&bit| bit != 0) else {
        return 0.0;
    };
    let bits = &bits[first..];
    if bits.len() > 1024 {
        return f64::INFINITY;
    }
    let mut significand = 0_u64;
    for &bit in bits.iter().take(53) {
        significand = (significand << 1) | u64::from(bit);
    }
    if bits.len() <= 53 {
        return significand as f64;
    }
    if bits[53] != 0 && (significand & 1 != 0 || bits[54..].contains(&1)) {
        significand += 1;
    }
    (significand as f64) * 2.0_f64.powi((bits.len() - 53) as i32)
}

fn js_integer_string(number: f64) -> String {
    if number.is_infinite() {
        return if number.is_sign_negative() {
            "-Infinity"
        } else {
            "Infinity"
        }
        .into();
    }
    if number.abs() >= 1e21 {
        let scientific = format!("{number:e}");
        let (mantissa, exponent) = scientific.split_once('e').expect("scientific notation");
        return format!("{mantissa}e+{exponent}");
    }
    number.to_string()
}
