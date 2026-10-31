#![cfg(feature = "polar-billing-events")]

//! Signature semantics for `domain_event_contracts::polar_billing::webhook_signature`
//! (source: `src/server/routes/webhooks/polarsh.webhook.ts` and the Polar SDK's
//! `validateEvent`). Pure functions only: no HTTP route and no network.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use dima_rust::domain_event_contracts::polar_billing::webhook_signature::{
    self, INTERNAL_ERROR_MESSAGE, SECRET_MISSING_MESSAGE, WEBHOOK_TOLERANCE_SECONDS,
    WebhookHeaders, WebhookRejection, WebhookResponse,
};
use std::collections::BTreeMap;

/// RFC 4231 HMAC-SHA-256 vectors. Values are the published hex digests.
#[test]
fn hmac_sha256_matches_rfc_4231() {
    let cases: Vec<(Vec<u8>, Vec<u8>, &str)> = vec![
        (
            vec![0x0b; 20],
            b"Hi There".to_vec(),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        ),
        (
            b"Jefe".to_vec(),
            b"what do ya want for nothing?".to_vec(),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        ),
        (
            vec![0xaa; 20],
            vec![0xdd; 50],
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
        ),
        (
            (0x01u8..=0x19).collect::<Vec<u8>>(),
            vec![0xcd; 50],
            "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
        ),
        (
            vec![0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First".to_vec(),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        ),
        (
            vec![0xaa; 131],
            b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.".to_vec(),
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
        ),
    ];
    for (key, message, expected) in cases {
        assert_eq!(
            format!("{:x}", webhook_signature::hmac_sha256(&key, &message)),
            expected
        );
    }
}

fn sign(secret: &str, id: &str, timestamp: i64, body: &[u8]) -> String {
    let mut signed = Vec::new();
    signed.extend_from_slice(id.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(timestamp.to_string().as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(body);
    STANDARD.encode(webhook_signature::hmac_sha256(secret.as_bytes(), &signed))
}

const SECRET: &str = "TestSecret";
const NOW_MS: i64 = 1_788_000_000_000;
const BODY: &[u8] = br#"{"type":"customer.state_changed","data":{"id":"customer"}}"#;

fn headers(id: &str, timestamp: i64, signature: &str) -> WebhookHeaders {
    WebhookHeaders {
        id: id.into(),
        timestamp: timestamp.to_string(),
        signature: signature.into(),
    }
}

#[test]
fn a_valid_signature_is_accepted() {
    let timestamp = NOW_MS.div_euclid(1000);
    let signature = sign(SECRET, "WEBHOOK_ID", timestamp, BODY);
    let verification = webhook_signature::verify_polar_webhook(
        Some(SECRET),
        &headers("WEBHOOK_ID", timestamp, &format!("v1,{signature}")),
        BODY,
        NOW_MS,
    )
    .expect("accepted");
    assert_eq!(verification.webhook_id, "WEBHOOK_ID");
    assert_eq!(verification.timestamp_seconds, timestamp);
}

#[test]
fn a_tampered_body_or_signature_is_rejected() {
    let timestamp = NOW_MS.div_euclid(1000);
    let signature = sign(SECRET, "WEBHOOK_ID", timestamp, BODY);
    let mut tampered = BODY.to_vec();
    tampered.push(b' ');
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("WEBHOOK_ID", timestamp, &format!("v1,{signature}")),
            &tampered,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("WEBHOOK_ID", timestamp, "v1,AAAA"),
            BODY,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
    // A different secret, a different id, and a non-v1 scheme all fail.
    let wrong_secret = sign("AnotherSecret", "WEBHOOK_ID", timestamp, BODY);
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("WEBHOOK_ID", timestamp, &format!("v1,{wrong_secret}")),
            BODY,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("OTHER_ID", timestamp, &format!("v1,{signature}")),
            BODY,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("WEBHOOK_ID", timestamp, "v2,AAAA"),
            BODY,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
}

#[test]
fn the_timestamp_tolerance_is_300_seconds_in_both_directions() {
    let now_seconds = NOW_MS.div_euclid(1000);
    for (offset, accepted) in [
        (0i64, true),
        (WEBHOOK_TOLERANCE_SECONDS, true),
        (-WEBHOOK_TOLERANCE_SECONDS, true),
        (WEBHOOK_TOLERANCE_SECONDS + 1, false),
        (-WEBHOOK_TOLERANCE_SECONDS - 1, false),
    ] {
        let timestamp = now_seconds + offset;
        let signature = sign(SECRET, "WEBHOOK_ID", timestamp, BODY);
        let result = webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("WEBHOOK_ID", timestamp, &format!("v1,{signature}")),
            BODY,
            NOW_MS,
        );
        assert_eq!(
            result.is_ok(),
            accepted,
            "offset {offset}s must be {}",
            if accepted { "inside" } else { "outside" }
        );
    }
    assert_eq!(WEBHOOK_TOLERANCE_SECONDS, 300);

    // A non-numeric timestamp is a verification failure, not a panic.
    assert!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &headers("WEBHOOK_ID", 0, "v1,AAAA"),
            BODY,
            NOW_MS,
        )
        .is_err()
    );
    let mut invalid = headers("WEBHOOK_ID", 0, "v1,AAAA");
    invalid.timestamp = "not-a-timestamp".into();
    assert_eq!(
        webhook_signature::verify_polar_webhook(Some(SECRET), &invalid, BODY, NOW_MS),
        Err(WebhookRejection::VerificationFailed)
    );
}

#[test]
fn a_missing_or_empty_secret_is_the_sources_500() {
    for secret in [None, Some("")] {
        assert_eq!(
            webhook_signature::verify_polar_webhook(secret, &headers("id", 0, "v1,AAAA"), BODY, NOW_MS),
            Err(WebhookRejection::SecretMissing)
        );
    }
    let response = WebhookResponse::for_result(Err(WebhookRejection::SecretMissing));
    assert_eq!(response.status, 500);
    assert_eq!(response.body, SECRET_MISSING_MESSAGE);
    assert_eq!(SECRET_MISSING_MESSAGE, "POLARSH_WEBHOOK_SECRET not configured");
    // The route's envelope is `{ error, message, status }`.
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&response.body).expect("json"),
        serde_json::json!({
            "error": true,
            "message": "POLARSH_WEBHOOK_SECRET not configured",
            "status": 500
        })
    );
}

#[test]
fn response_mapping_matches_the_source() {
    assert_eq!(WebhookResponse::accepted().status, 202);
    assert_eq!(WebhookResponse::accepted().body, "");
    assert_eq!(WebhookResponse::verification_failed().status, 403);
    assert_eq!(WebhookResponse::verification_failed().body, "");
    assert_eq!(WebhookResponse::internal_error().status, 500);
    assert_eq!(INTERNAL_ERROR_MESSAGE, "Internal server error");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&WebhookResponse::internal_error().body)
            .expect("json")["message"],
        serde_json::json!("Internal server error")
    );
    let (response, verification) = webhook_signature::verify_and_respond(
        Some(SECRET),
        vec![
            ("Webhook-Id".to_string(), vec!["WEBHOOK_ID".to_string()]),
            (
                "Webhook-Timestamp".to_string(),
                vec![NOW_MS.div_euclid(1000).to_string()],
            ),
            (
                "Webhook-Signature".to_string(),
                vec![format!(
                    "v1,{}",
                    sign(SECRET, "WEBHOOK_ID", NOW_MS.div_euclid(1000), BODY)
                )],
            ),
        ],
        BODY,
        NOW_MS,
    );
    assert_eq!(response.status, 202);
    assert_eq!(verification.expect("verified").webhook_id, "WEBHOOK_ID");
}

#[test]
fn header_normalisation_lowercases_names_and_joins_arrays_with_commas() {
    let normalized = webhook_signature::normalize_webhook_headers(vec![
        ("Webhook-Id".to_string(), vec!["first".to_string()]),
        (
            "Webhook-Signature".to_string(),
            vec!["v1,one".to_string(), "v1,two".to_string()],
        ),
        (
            "Webhook-Timestamp".to_string(),
            vec![NOW_MS.div_euclid(1000).to_string()],
        ),
    ]);
    assert_eq!(normalized.get("webhook-id").map(String::as_str), Some("first"));
    assert_eq!(
        normalized.get("webhook-signature").map(String::as_str),
        Some("v1,one,v1,two")
    );
    let headers = WebhookHeaders::from_normalized(&normalized);
    assert_eq!(headers.id, "first");
    // A single header value with the standard space-separated list still verifies.
    let timestamp = NOW_MS.div_euclid(1000);
    let good = sign(SECRET, "WEBHOOK_ID", timestamp, BODY);
    assert!(webhook_signature::verify_polar_webhook(
        Some(SECRET),
        &WebhookHeaders {
            id: "WEBHOOK_ID".into(),
            timestamp: timestamp.to_string(),
            signature: format!("v1,AAAA v1,{good}"),
        },
        BODY,
        NOW_MS,
    )
    .is_ok());
    // The comma-joined array form is not a valid signature list, so it fails
    // closed instead of accepting a partially joined value.
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &WebhookHeaders {
                id: "WEBHOOK_ID".into(),
                timestamp: timestamp.to_string(),
                signature: format!("v1,AAAA,v1,{good}"),
            },
            BODY,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
    // Missing headers fail closed.
    let empty: BTreeMap<String, String> = BTreeMap::new();
    assert_eq!(
        webhook_signature::verify_polar_webhook(
            Some(SECRET),
            &WebhookHeaders::from_normalized(&empty),
            BODY,
            NOW_MS,
        ),
        Err(WebhookRejection::VerificationFailed)
    );
}
