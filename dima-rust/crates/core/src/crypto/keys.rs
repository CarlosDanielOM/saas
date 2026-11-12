//! Hashed lookup keys and signed tokens the reference stores or compares (`ledger/runtime.md`
//! sections 4.2 and 4.3). Each function names its reference site; the output must match byte for
//! byte because TypeScript and Rust processes read each other's keys.

use super::digest::{constant_time_eq, hmac_sha256, md5, sha256};
use super::encoding::decode_hex_lenient;
use crate::random::{RandomError, SecureRandom};
use crate::secret::SecretString;
use serde_json::Value;

/// `sha256(token).hex`: overlay, duel, widgets, roulette and pet `tokenHash`, the pet audio
/// ticket key `pet:audio:<hash>`, memory digests, custom-widget content hashes.
pub fn token_hash(token: &str) -> String {
    sha256(token).hex()
}

/// `sha256(value).base64url`: the OAuth server's `hash()` (request ids, codes, access and refresh
/// tokens, PKCE challenge, rate buckets) and the desktop AI speech ticket hash.
pub fn sha256_base64url(value: &str) -> String {
    sha256(value).base64url()
}

/// The OAuth server's `secret(prefix)`: `prefix` + 32 random bytes as base64url (43 characters).
/// Access tokens use `dima_at_`, refresh tokens `dima_rt_`; request ids and codes no prefix.
pub fn oauth_secret(random: &dyn SecureRandom, prefix: &str) -> Result<String, RandomError> {
    Ok(format!("{prefix}{}", random.base64url_token(32)?))
}

/// `ratelimit:<scope>:<sha256(subject).base64url>` (`utils/rate_limit.ts`).
pub fn rate_limit_key(scope: &str, subject: &str) -> String {
    format!("ratelimit:{scope}:{}", sha256_base64url(subject))
}

/// `billing:credit-packs:context:v1:<first 20 hex of sha256(customerId)>` (`utils/billing.ts`).
pub fn billing_context_cache_key(customer_id: &str) -> String {
    let hash = sha256(customer_id).hex();
    format!(
        "billing:credit-packs:context:v1:{}",
        hash.get(..20).unwrap_or_default()
    )
}

/// The credit gift id: `sha256("<userId>:<requestId.toLowerCase()>").hex` (`utils/credit_gifts.ts`).
pub fn credit_gift_id(user_id: &str, request_id: &str) -> String {
    sha256(format!("{user_id}:{}", dima_text::to_lower(request_id))).hex()
}

/// `sha256(JSON.stringify(value)).hex` for idempotency, receipt and catalog ids. `value` must be
/// shaped as the TypeScript producer's object (see `dima_text::to_js_json`); cut the result for
/// the 12- and 24-character catalog digests.
///
/// Keys are written in JavaScript's enumeration order (`dima_text::js_key_order`: array-index
/// keys such as `"2"` and `"10"` first, in numeric order, then the rest in insertion order), so a
/// map built in Rust hashes as the same object built in JavaScript.
pub fn json_sha256_hex(value: &Value) -> String {
    let mut ordered = value.clone();
    dima_text::js_key_order(&mut ordered);
    sha256(dima_text::to_js_json(&ordered)).hex()
}

/// The 24 hex digits of an ObjectId made from `sha256(identity).hex` (follow-defense attack log
/// `_id`, `utils/follow_defense.ts`).
pub fn object_id_hex_from_sha256(identity: &str) -> String {
    sha256(identity)
        .hex()
        .get(..24)
        .unwrap_or_default()
        .to_owned()
}

/// `generateQdrantPointId(namespace, entityID, timestamp)`: the first 8 hex digits of
/// `md5("<namespace>:<entityID>:<timestamp>")` as an unsigned integer, with the timestamp written
/// as JavaScript writes the number.
pub fn qdrant_point_id(namespace: &str, entity_id: &str, timestamp: f64) -> u32 {
    let text = format!(
        "{namespace}:{entity_id}:{}",
        dima_text::number_to_string(timestamp)
    );
    let digest = md5(text).0;
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// Why a token signed with `SECRET_KEY` cannot be produced.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SigningError {
    /// `SECRET_KEY` is unset or empty (`Overlay signing is unavailable` in the reference).
    #[error("Overlay signing is unavailable")]
    Unavailable,
}

/// The DimaFX overlay token: `HMAC-SHA256(SECRET_KEY, "dimafx-overlay:" + channelID).hex`
/// (`server/services/dimafx-overlay.service.ts`).
pub fn dimafx_overlay_token(
    secret_key: &SecretString,
    channel_id: &str,
) -> Result<String, SigningError> {
    if secret_key.is_empty() {
        return Err(SigningError::Unavailable);
    }
    Ok(hmac_sha256(
        &secret_key.to_bytes(),
        format!("dimafx-overlay:{channel_id}"),
    )
    .hex())
}

/// `authorizeDimafxOverlay(channelID, token)`: the channel must match `^\w+$` and the token
/// `^[a-f0-9]{64}$` (else `false`); then the decoded bytes are compared in constant time. An
/// empty `SECRET_KEY` is an error, as the reference throws.
pub fn authorize_dimafx_overlay(
    secret_key: &SecretString,
    channel_id: &str,
    token: &str,
) -> Result<bool, SigningError> {
    let word = !channel_id.is_empty()
        && channel_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    let hex64 = token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !word || !hex64 {
        return Ok(false);
    }
    let expected = dimafx_overlay_token(secret_key, channel_id)?;
    Ok(constant_time_eq(
        &decode_hex_lenient(token),
        &decode_hex_lenient(&expected),
    ))
}

/// The internal-call trace signature `x-observability-signature`:
/// `HMAC-SHA256(SECRET_KEY, traceparent).hex` (`utils/observability/telemetry.ts`).
pub fn trace_signature(secret_key: &SecretString, traceparent: &str) -> Option<String> {
    (!secret_key.is_empty()).then(|| hmac_sha256(&secret_key.to_bytes(), traceparent).hex())
}

/// Whether an incoming traceparent is trusted: `SECRET_KEY` is set and `signature` equals
/// [`trace_signature`] (constant time). The reference throws (500) when a non-ASCII signature has
/// 64 characters but more bytes; that case is `false` here.
pub fn verify_trace_signature(
    secret_key: &SecretString,
    traceparent: &str,
    signature: &str,
) -> bool {
    trace_signature(secret_key, traceparent)
        .is_some_and(|expected| constant_time_eq(signature.as_bytes(), expected.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::SecretBytes;

    #[test]
    fn json_hashes_use_javascript_key_order_for_maps_built_in_rust() {
        // Built in Rust in insertion order; JavaScript enumerates array-index keys first.
        let mut nested = serde_json::Map::new();
        for (key, value) in [("1", "x"), ("a", "y"), ("0", "z"), ("01", "w")] {
            nested.insert(key.to_owned(), Value::from(value));
        }
        let mut item = serde_json::Map::new();
        item.insert("9".to_owned(), Value::from(1));
        item.insert("c".to_owned(), Value::from(2));
        let mut root = serde_json::Map::new();
        root.insert("b".to_owned(), Value::from(1));
        root.insert("10".to_owned(), Value::from(2));
        root.insert("2".to_owned(), Value::from(3));
        root.insert("nested".to_owned(), Value::Object(nested));
        root.insert("list".to_owned(), Value::Array(vec![Value::Object(item)]));
        // Node: sha256(JSON.stringify({b:1,10:2,2:3,nested:{1:"x",a:"y",0:"z","01":"w"},list:[{9:1,c:2}]}))
        // of `{"2":3,"10":2,"b":1,"nested":{"0":"z","1":"x","a":"y","01":"w"},"list":[{"9":1,"c":2}]}`.
        assert_eq!(
            json_sha256_hex(&Value::Object(root)),
            "6f713acf6dacb22678065191ee2275aa86f2e0c30bac08e2f6cdc6df5037d4f8"
        );
    }

    #[test]
    fn overlay_tokens() {
        let key = SecretString::from("k");
        let token = dimafx_overlay_token(&key, "123").unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(authorize_dimafx_overlay(&key, "123", &token), Ok(true));
        assert_eq!(authorize_dimafx_overlay(&key, "12-3", &token), Ok(false));
        assert_eq!(
            authorize_dimafx_overlay(&key, "123", &token.to_uppercase()),
            Ok(false)
        );
        assert_eq!(
            authorize_dimafx_overlay(&SecretString::from(""), "123", &token),
            Err(SigningError::Unavailable)
        );
        assert_eq!(
            token,
            hmac_sha256(&SecretBytes::from_text("k"), "dimafx-overlay:123").hex()
        );
    }

    #[test]
    fn trace_signatures() {
        let key = SecretString::from("k");
        let tp = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
        let signature = trace_signature(&key, tp).unwrap();
        assert!(verify_trace_signature(&key, tp, &signature));
        assert!(!verify_trace_signature(&SecretString::from(""), tp, ""));
    }
}
