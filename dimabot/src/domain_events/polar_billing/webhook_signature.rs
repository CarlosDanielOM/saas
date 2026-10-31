//! Polar webhook signature verification (pure, no HTTP).
//!
//! Source contract: `dimabot/src/server/routes/webhooks/polarsh.webhook.ts`
//! (`createPolarWebhookRouter`'s `validateEvent` boundary) and the Polar SDK's
//! `@polar-sh/sdk/webhooks.validateEvent`, which wraps `standardwebhooks`'
//! `Webhook.verify`.
//!
//! Preserved behaviour:
//! - the signed content is `{webhook-id}.{webhook-timestamp}.{raw_body}`;
//! - the signature is HMAC-SHA256, base64-encoded, and compared in constant time
//!   against every `v1,<signature>` candidate in the space-separated
//!   `webhook-signature` header;
//! - the timestamp must be within ±300 seconds of now (`standardwebhooks`'
//!   default tolerance), so a replayed or stale delivery is rejected;
//! - header values are normalized the way the route does it: lowercase names,
//!   and array values joined with `,`;
//! - a missing/empty `POLARSH_WEBHOOK_SECRET` is the source's 500
//!   `POLARSH_WEBHOOK_SECRET not configured`, a verification failure is the
//!   source's 403 with an empty body, an unexpected internal failure is the
//!   source's 500 `Internal server error`, and success is the source's 202 with
//!   an empty body.
//!
//! Secret handling: the SDK computes `base64(utf8(secret))` and hands that to
//! `new Webhook(...)`, which base64-decodes it again, so the effective HMAC key
//! is exactly the UTF-8 bytes of the configured secret. This module uses those
//! bytes directly; no `whsec_` prefix is stripped, matching the SDK call site.
//!
//! Deliberately NOT here: the axum route, the raw-body middleware, event
//! parsing/ingestion, dotenv loading, or any shared crypto abstraction. The
//! `hmac` crate is not a dependency and is not added: [`hmac_sha256`] implements
//! RFC 2104 over the existing `sha2`. `src/media/asset_library_route.rs` has an
//! equivalent helper behind team4's media feature, so this local copy is a
//! flagged consolidation candidate for integration — not a new abstraction.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// `standardwebhooks`' default tolerance, in both directions.
pub const WEBHOOK_TOLERANCE_SECONDS: i64 = 300;
pub const SECRET_MISSING_MESSAGE: &str = "POLARSH_WEBHOOK_SECRET not configured";
pub const INTERNAL_ERROR_MESSAGE: &str = "Internal server error";

/// `normalizeHeaders`: lowercase names, array values joined with `,`.
pub fn normalize_webhook_headers(
    headers: impl IntoIterator<Item = (String, Vec<String>)>,
) -> BTreeMap<String, String> {
    let mut normalized = BTreeMap::new();
    for (name, values) in headers {
        normalized.insert(name.to_lowercase(), values.join(","));
    }
    normalized
}

/// The three headers verification needs, taken from normalized headers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebhookHeaders {
    pub id: String,
    pub timestamp: String,
    pub signature: String,
}

impl WebhookHeaders {
    pub fn from_normalized(headers: &BTreeMap<String, String>) -> Self {
        Self {
            id: headers.get("webhook-id").cloned().unwrap_or_default(),
            timestamp: headers.get("webhook-timestamp").cloned().unwrap_or_default(),
            signature: headers.get("webhook-signature").cloned().unwrap_or_default(),
        }
    }
}

/// Successful verification. The route must ingest `webhook_id` with the event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookVerification {
    pub webhook_id: String,
    pub timestamp_seconds: i64,
}

/// Verification failures. An unexpected handler error after a successful
/// verification maps to [`WebhookResponse::internal_error`], the source's
/// catch-all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookRejection {
    SecretMissing,
    VerificationFailed,
}

/// The exact response the route must produce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookResponse {
    pub status: u16,
    pub body: String,
}

impl WebhookResponse {
    /// `202` with an empty body.
    pub fn accepted() -> Self {
        Self {
            status: 202,
            body: String::new(),
        }
    }

    /// `403` with an empty body (`WebhookVerificationError`).
    pub fn verification_failed() -> Self {
        Self {
            status: 403,
            body: String::new(),
        }
    }

    /// `500` with the source's configuration envelope.
    pub fn secret_missing() -> Self {
        Self {
            status: 500,
            body: error_body(SECRET_MISSING_MESSAGE),
        }
    }

    /// `500` with the source's catch-all envelope.
    pub fn internal_error() -> Self {
        Self {
            status: 500,
            body: error_body(INTERNAL_ERROR_MESSAGE),
        }
    }

    /// Maps a verification result onto the source's response.
    pub fn for_result(result: Result<WebhookVerification, WebhookRejection>) -> Self {
        match result {
            Ok(_) => Self::accepted(),
            Err(WebhookRejection::SecretMissing) => Self::secret_missing(),
            Err(WebhookRejection::VerificationFailed) => Self::verification_failed(),
        }
    }
}

/// `res.status(500).json({ error: true, message, status: 500 })`.
fn error_body(message: &str) -> String {
    json!({"error": true, "message": message, "status": 500}).to_string()
}

/// HMAC-SHA256 per RFC 2104 over `sha2`'s SHA-256 (64-byte block size).
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut normalized = [0u8; 64];
    if key.len() > 64 {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for index in 0..64 {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// Constant-time comparison over equal-length inputs. A length mismatch returns
/// early, which only reveals the candidate's length, exactly like the SDK.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

/// `v1,<base64>` candidates from a space-separated signature header.
fn signature_candidates(header: &str) -> Vec<Vec<u8>> {
    let mut candidates = Vec::new();
    for entry in header.split(' ') {
        let mut parts = entry.splitn(2, ',');
        let version = parts.next().unwrap_or_default();
        let signature = parts.next().unwrap_or_default();
        if version != "v1" || signature.is_empty() {
            continue;
        }
        if let Ok(decoded) = STANDARD.decode(signature) {
            candidates.push(decoded);
            continue;
        }
        // `atob` tolerates missing padding; accept the unpadded form too.
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(signature) {
            candidates.push(decoded);
        }
    }
    candidates
}

/// `validateEvent`: verify the signature and timestamp only. Event-schema
/// parsing stays with the integration route.
pub fn verify_polar_webhook(
    secret: Option<&str>,
    headers: &WebhookHeaders,
    raw_body: &[u8],
    now_millis: i64,
) -> Result<WebhookVerification, WebhookRejection> {
    let secret = secret
        .filter(|secret| !secret.is_empty())
        .ok_or(WebhookRejection::SecretMissing)?;
    if headers.id.is_empty()
        || headers.timestamp.is_empty()
        || headers.signature.is_empty()
    {
        return Err(WebhookRejection::VerificationFailed);
    }
    let Ok(timestamp_seconds) = headers.timestamp.parse::<i64>() else {
        return Err(WebhookRejection::VerificationFailed);
    };
    let now_seconds = now_millis.div_euclid(1000);
    if timestamp_seconds < now_seconds - WEBHOOK_TOLERANCE_SECONDS
        || timestamp_seconds > now_seconds + WEBHOOK_TOLERANCE_SECONDS
    {
        return Err(WebhookRejection::VerificationFailed);
    }
    let mut signed = Vec::with_capacity(
        headers.id.len() + headers.timestamp.len() + raw_body.len() + 2,
    );
    signed.extend_from_slice(headers.id.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(headers.timestamp.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(raw_body);
    let expected = hmac_sha256(secret.as_bytes(), &signed);
    let mut accepted = false;
    for candidate in signature_candidates(&headers.signature) {
        // Never short-circuit: every candidate is compared in constant time.
        accepted |= constant_time_eq(&candidate, &expected);
    }
    if !accepted {
        return Err(WebhookRejection::VerificationFailed);
    }
    Ok(WebhookVerification {
        webhook_id: headers.id.clone(),
        timestamp_seconds,
    })
}

/// Convenience for the route: normalize, verify, and produce the response.
pub fn verify_and_respond(
    secret: Option<&str>,
    headers: impl IntoIterator<Item = (String, Vec<String>)>,
    raw_body: &[u8],
    now_millis: i64,
) -> (WebhookResponse, Option<WebhookVerification>) {
    let normalized = normalize_webhook_headers(headers);
    let headers = WebhookHeaders::from_normalized(&normalized);
    match verify_polar_webhook(secret, &headers, raw_body, now_millis) {
        Ok(verification) => (WebhookResponse::accepted(), Some(verification)),
        Err(rejection) => (
            WebhookResponse::for_result(Err(rejection)),
            None,
        ),
    }
}
