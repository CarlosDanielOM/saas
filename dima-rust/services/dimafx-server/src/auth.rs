//! Extension-specific Node decoding compatibility; the shared base64 decoder is strict.
use dima_core::{
    SecretBytes,
    crypto::digest::{constant_time_eq, hmac_sha256},
};
use serde_json::Value;

/// Node Buffer.from(value, 'base64'/'base64url'): ignores junk, stops at padding,
/// accepts incomplete groups and nonzero trailing bits. Non-ASCII uses low UTF-16 bytes.
pub fn decode(value: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for c in value.chars() {
        let scalar = u32::from(c);
        let units = if scalar > 0xffff {
            vec![
                ((scalar - 0x10000) >> 10) + 0xd800,
                ((scalar - 0x10000) & 1023) + 0xdc00,
            ]
        } else {
            vec![scalar]
        };
        for unit in units {
            let b = unit as u8;
            if b == b'=' {
                return out;
            }
            let n = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' | b'-' => 62,
                b'/' | b'_' => 63,
                _ => continue,
            };
            bits = (bits << 6) | u32::from(n);
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
            }
        }
    }
    out
}

pub fn keys(secret: &str) -> Vec<SecretBytes> {
    if secret.is_empty() {
        return vec![];
    }
    let mut keys = vec![];
    for bytes in [decode(secret), secret.as_bytes().to_vec()] {
        let key = SecretBytes::new(bytes);
        if !key.is_empty() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}
fn json(part: &str) -> Option<Value> {
    dima_text::parse_js_json(
        &String::from_utf8_lossy(&decode(part)),
        dima_text::JsonLimits {
            max_depth: 128,
            max_bytes: 32768,
        },
    )
    .ok()
}
/// Signature comparison deliberately delegates to core's constant-time primitive.
pub fn verify(token: &str, keys: &[SecretBytes], allow: bool, now_ms: i64) -> Option<Value> {
    let parts: Vec<_> = token.split('.').collect();
    let payload = if keys.is_empty() {
        if !allow || parts.len() < 2 || parts[1].is_empty() {
            return None;
        }
        json(parts[1])?
    } else {
        if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
            return None;
        }
        if json(parts[0])?.get("alg")?.as_str()? != "HS256" {
            return None;
        }
        let signed = format!("{}.{}", parts[0], parts[1]);
        let signature = decode(parts[2]);
        if !keys
            .iter()
            .any(|key| constant_time_eq(hmac_sha256(key, &signed).bytes(), &signature))
        {
            return None;
        }
        let payload = json(parts[1])?;
        let exp = &payload["exp"];
        if dima_text::js_truthy(exp) && dima_text::js_number(exp) * 1000. < now_ms as f64 {
            return None;
        }
        payload
    };
    if !dima_text::js_truthy(&payload["channel_id"]) {
        return None;
    }
    Some(payload)
}
