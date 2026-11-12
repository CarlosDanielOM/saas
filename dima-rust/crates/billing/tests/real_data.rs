//! The effective plan of every user of the local production copy (`domdimabot`, read only),
//! computed by Rust and compared with the reference's answers recorded once by
//! `tests/real_data/reference.mjs` from the real `billing.ts` over a dump of the plan fields.
//!
//! **What this shows, and what it does not.** Polar is not asked about these customers: every
//! user is replayed against two **scripted** Polar answers derived from the user's own stored
//! `plan_tier` (no subscription at all, and one active subscription of the stored paid tier:
//! [`active_answer`]), and the same scripts were given to the reference. So the comparison shows
//! that the Rust logic and the TypeScript reach the same decisions for these 168 real stored
//! states under those answers (limits, plan versions, billing contexts, checkout scenarios,
//! skip rules). It does **not** show that either agrees with Polar's real answers for these
//! customers (their actual subscriptions, trials, past-due grace or meters), which only the
//! rig's stateful Polar mock and the scenario tests (`flush.rs`, `grant_identity.rs`,
//! `pagination.rs`, `balance_revision.rs`, `balance_states.rs`, `write_faults.rs`) exercise.
//!
//! The dump (`tests/real_data/users.json`) holds user ids and plan fields only: no e-mail, name,
//! token or Twitch id. The Polar customer id is replaced by a pseudonym that keeps what the
//! decisions read (missing, `null`, empty, a UUID v4 or another id); the referral code by its
//! truthiness. Re-record when the copy changes:
//!
//! ```text
//! eval "$(dima-rust/tools/test-env)"
//! DIMA_BILLING_DUMP=dima-rust/crates/billing/tests/real_data/users.json \
//!   dima-rust/tools/cargo test -p dima-billing --test real_data -- --ignored dump
//! docker run --rm --network none -v "$PWD":/work:ro -v "$PWD/dima-rust/crates/billing/tests/real_data":/out \
//!   -v /home/dom/Projects/saas/dimabot/node_modules:/deps/node_modules:ro -w /work node:24-alpine \
//!   node dima-rust/crates/billing/tests/real_data/reference.mjs /out/users.json /out/reference.json
//! ```
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

mod support;

use bson::{Bson, Document};
use dima_billing::plans::checkout::{self, BillingAction, BillingUser};
use dima_billing::plans::credits::build_ai_credits_data_from_meter;
use dima_billing::plans::projection::{
    PlanOwnerState, state_change_is_unchanged, state_change_keeps_unmanaged_tier,
};
use dima_billing::plans::{self, PaidTier, PlanTier};
use dima_billing::polar::PolarClient;
use dima_billing::products::{
    AI_CREDITS_METER_ID, LEGACY_USAGE_METER_ID, PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID,
};
use dima_core::SecretString;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use futures_util::TryStreamExt;
use serde_json::{Map, Value, json};
use support::{field, number, same, text};

fn dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/real_data")
}

/// The pseudonym of a customer id: its shape is kept, its value is not.
fn customer_pseudonym(value: Option<&Bson>) -> Value {
    match value {
        None => json!({"$undefined": true}),
        Some(Bson::Null) => Value::Null,
        Some(Bson::String(id)) if id.is_empty() => json!(""),
        Some(Bson::String(id)) => {
            let hex = dima_core::crypto::sha256(id).hex();
            let part = |a: usize, b: usize| dima_text::slice_chars(&hex, a, b).to_owned();
            if checkout::is_uuid_v4(Some(id)) {
                json!(format!(
                    "{}-{}-4{}-8{}-{}",
                    part(0, 8),
                    part(8, 12),
                    part(12, 15),
                    part(15, 18),
                    part(18, 30)
                ))
            } else {
                json!(format!("cus_{}", part(0, 16)))
            }
        }
        Some(other) => json!({"$type": format!("{:?}", other.element_type())}),
    }
}

fn date_field(document: &Document, key: &str) -> Value {
    match document.get(key) {
        None => json!({"$undefined": true}),
        Some(Bson::Null) => Value::Null,
        Some(Bson::DateTime(date)) => json!({"$date": date.timestamp_millis()}),
        Some(other) => json!({"$type": format!("{:?}", other.element_type())}),
    }
}

fn text_field(document: &Document, key: &str) -> Value {
    match document.get(key) {
        None => json!({"$undefined": true}),
        Some(Bson::Null) => Value::Null,
        Some(Bson::String(text)) => json!(text),
        Some(other) => json!({"$type": format!("{:?}", other.element_type())}),
    }
}

/// The plan fields of one stored user, as the dump holds them.
fn dump_of(document: &Document) -> Value {
    let referral = match document.get("referralCodeUsed") {
        None => json!({"$undefined": true}),
        Some(Bson::Null) => Value::Null,
        Some(Bson::String(code)) if code.is_empty() => json!(""),
        Some(Bson::String(_)) => json!("REFERRAL"),
        Some(other) => json!({"$type": format!("{:?}", other.element_type())}),
    };
    let snapshot = match document.get("polar_credit_snapshot") {
        Some(Bson::Document(snapshot)) => {
            let meters: Vec<Value> = match snapshot.get("meters") {
                Some(Bson::Array(items)) => items
                    .iter()
                    .map(dima_billing::js::bson_to_json)
                    .filter(|m| {
                        let id = m.get("meter_id").and_then(Value::as_str);
                        id == Some(AI_CREDITS_METER_ID) || id == Some(LEGACY_USAGE_METER_ID)
                    })
                    .collect(),
                _ => Vec::new(),
            };
            json!({"occurredAt": date_field(snapshot, "occurredAt"), "eventKey": text_field(snapshot, "eventKey"), "meters": meters})
        }
        _ => Value::Null,
    };
    let twitch = document
        .get_array("accounts")
        .map(|accounts| {
            accounts
                .iter()
                .filter(|a| {
                    a.as_document()
                        .and_then(|d| d.get_str("type").ok())
                        .unwrap_or("twitch")
                        == "twitch"
                })
                .count()
        })
        .unwrap_or(0);
    json!({
        "_id": document.get_object_id("_id").map(|id| id.to_hex()).unwrap_or_default(),
        "plan_tier": text_field(document, "plan_tier"),
        "plan_tier_until": date_field(document, "plan_tier_until"),
        "polar_sh_customer_id": customer_pseudonym(document.get("polar_sh_customer_id")),
        "polar_plan_event_at": date_field(document, "polar_plan_event_at"),
        "polar_plan_event_key": text_field(document, "polar_plan_event_key"),
        "polar_plan_effects_pending": document.get("polar_plan_effects_pending").map_or(json!({"$undefined": true}), dima_billing::js::bson_to_json),
        "polar_plan_entitlement_fingerprint": text_field(document, "polar_plan_entitlement_fingerprint"),
        "last_app_activity_at": date_field(document, "last_app_activity_at"),
        "updated_at": date_field(document, "updated_at"),
        "referralCodeUsed": referral,
        "twitch_accounts": twitch,
        "polar_credit_snapshot": snapshot,
    })
}

async fn users(store: &dima_store::mongo::MongoStore) -> Vec<Value> {
    let mut cursor = store
        .documents("users")
        .find(bson::doc! {})
        .sort(bson::doc! {"_id": 1})
        .await
        .unwrap();
    let mut out = Vec::new();
    while let Some(document) = cursor.try_next().await.unwrap() {
        out.push(dump_of(&document));
    }
    out
}

#[tokio::test]
#[ignore = "writes the dump the reference script reads; run by hand when the copy changes"]
async fn dump() {
    let Some(store) = support::real_store().await.unwrap() else {
        return;
    };
    let path = std::env::var("DIMA_BILLING_DUMP").expect("DIMA_BILLING_DUMP");
    let users = users(&store).await;
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json!({"users": users})).unwrap() + "\n",
    )
    .unwrap();
    eprintln!("dumped {} users", users.len());
}

fn ms(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| v.get("$date")).and_then(Value::as_i64)
}

fn billing_user(user: &Value) -> BillingUser {
    BillingUser {
        id: user["_id"].as_str().unwrap().into(),
        email: None,
        name: None,
        plan_tier: text(user, "plan_tier").unwrap_or("free").into(),
        polar_sh_customer_id: text(user, "polar_sh_customer_id").map(Into::into),
        last_app_activity_at: ms(user.get("last_app_activity_at")),
        updated_at: ms(user.get("updated_at")),
        referral_code_used: text(user, "referralCodeUsed").map(Into::into),
    }
}

fn context_json(c: &checkout::BillingContext) -> Value {
    let mut map = Map::new();
    map.insert("planTier".into(), json!(c.plan_tier));
    map.insert(
        "hasActiveSubscription".into(),
        json!(c.has_active_subscription),
    );
    map.insert(
        "hasAnySubscriptionHistory".into(),
        json!(c.has_any_subscription_history),
    );
    map.insert(
        "hasPaidSubscriptionHistory".into(),
        json!(c.has_paid_subscription_history),
    );
    map.insert("hasUsedTrial".into(), json!(c.has_used_trial));
    map.insert("inactivityMonths".into(), json!(c.inactivity_months as f64));
    map.insert("isWinbackEligible".into(), json!(c.is_winback_eligible));
    map.insert("scenario".into(), json!(c.scenario.as_str()));
    for (key, value) in [
        ("activeSubscriptionId", &c.active_subscription_id),
        ("activeProductId", &c.active_product_id),
        ("recoverySubscriptionId", &c.recovery_subscription_id),
    ] {
        if let Some(v) = value {
            map.insert(key.into(), json!(v));
        }
    }
    if let Some(p) = c.target_product_id {
        map.insert("targetProductId".into(), json!(p));
    }
    map.insert("isReferralEligible".into(), json!(c.is_referral_eligible));
    Value::Object(map)
}

/// Polar's answer for the "active" variant: one active subscription of the stored paid tier.
/// A script derived from the stored tier, not the customer's real Polar state (see the module
/// docs).
fn active_answer(user: &Value) -> Value {
    let product = match text(user, "plan_tier") {
        Some("pro") => Some(PRO_PRODUCT_ID),
        Some("premium") => Some(PREMIUM_PRODUCT_ID),
        _ => None,
    };
    let items: Vec<Value> = product
        .map(|p| vec![json!({"id": "sub_real", "status": "active", "product_id": p, "current_period_end": "2026-12-01T00:00:00Z"})])
        .unwrap_or_default();
    json!({"items": items})
}

#[tokio::test]
async fn effective_plan_of_every_user_matches_the_reference() {
    let Some(store) = support::real_store().await.unwrap() else {
        return;
    };
    let dumped: Value =
        serde_json::from_slice(&std::fs::read(dir().join("users.json")).unwrap()).unwrap();
    let reference: Value =
        serde_json::from_slice(&std::fs::read(dir().join("reference.json")).unwrap()).unwrap();
    let now = reference["now"].as_i64().unwrap();
    let live = users(&store).await;
    // The fixture must describe the copy as it is now: otherwise it is re-recorded, not trusted.
    assert_eq!(
        live.len(),
        dumped["users"].as_array().unwrap().len(),
        "the copy changed: re-record tests/real_data"
    );
    let answers = reference["answers"].as_object().unwrap();
    let http = HttpClient::builder().build().unwrap();
    let mut compared = 0;
    let mut failures = Vec::new();
    for user in &live {
        let id = user["_id"].as_str().unwrap();
        let dumped_user = dumped["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["_id"] == id)
            .expect("user in the dump");
        assert_eq!(
            dumped_user, user,
            "user {id} changed: re-record tests/real_data"
        );
        let expected = &answers[id];
        let mut actual = Map::new();

        let tier = text(user, "plan_tier");
        actual.insert("limit".into(), json!(plans::ai_credit_limit_for_plan(tier)));
        let version = dima_store::dragonfly::plan_cache_fence::plan_cache_version(
            ms(user.get("polar_plan_event_at")),
            text(user, "polar_plan_event_key"),
        )
        .unwrap();
        actual.insert("planVersion".into(), json!(version));

        let buyer = billing_user(user);
        for (variant, answer) in [
            ("none", json!({"items": []})),
            ("active", active_answer(user)),
        ] {
            let server = MockServer::start().await.unwrap();
            let body = serde_json::to_string(&answer).unwrap();
            let all = serde_json::to_string(&answer).unwrap();
            server.fallback(move |request| {
                if request.target.contains("active=true") {
                    MockResponse::json(200, &body)
                } else {
                    MockResponse::json(200, &all)
                }
            });
            let polar = PolarClient::new(
                http.clone(),
                server
                    .provider(PolarClient::provider(&Default::default()))
                    .unwrap(),
                Some(SecretString::from("t")),
            );
            for target in [None, Some(PaidTier::Premium), Some(PaidTier::Pro)] {
                for action in ["auto", "new", "reactivate"] {
                    let context = checkout::billing_context(
                        &polar,
                        &buyer,
                        target,
                        BillingAction::parse(action).unwrap(),
                        now,
                    )
                    .await
                    .unwrap();
                    let key = format!(
                        "context:{variant}:{}:{action}",
                        target.map_or("none", PaidTier::as_str)
                    );
                    actual.insert(key, context_json(&context));
                }
            }
        }

        // The credit snapshot the state webhook projects (applyPolarCreditsDomainEvent).
        if let Some(snapshot) = user.get("polar_credit_snapshot").filter(|s| !s.is_null()) {
            let meters = snapshot["meters"].as_array().unwrap();
            let meter = |id: &str| {
                meters
                    .iter()
                    .find(|m| m.get("meter_id").and_then(Value::as_str) == Some(id))
            };
            let occurred = ms(snapshot.get("occurredAt"))
                .and_then(dima_text::to_iso_string)
                .unwrap();
            let credits = meter(AI_CREDITS_METER_ID)
                .map(|m| build_ai_credits_data_from_meter(Some(m), tier, occurred.clone()));
            let exhaustion = match (
                &credits,
                meter(LEGACY_USAGE_METER_ID).and_then(|m| m.get("balance")),
            ) {
                (Some(c), _) => {
                    if c.balance <= 0.0 {
                        "1"
                    } else {
                        "0"
                    }
                }
                (None, Some(b)) => {
                    if dima_billing::js::number(Some(b)) <= 0.0 {
                        "1"
                    } else {
                        "0"
                    }
                }
                (None, None) => "",
            };
            // What `SYNC_CREDITS_SCRIPT` receives (one Twitch account or more), or the pure answer.
            let text = credits.as_ref().map(|c| {
                let mut map = c.to_json();
                if !version.is_empty() {
                    map.insert(
                        dima_store::dragonfly::plan_cache_fence::PLAN_CACHE_VERSION_FIELD.into(),
                        json!(version),
                    );
                }
                dima_text::to_js_json(&Value::Object(map))
            });
            if user["twitch_accounts"].as_u64().unwrap_or(0) > 0 {
                actual.insert(
                    "snapshotCredits".into(),
                    text.as_deref()
                        .map_or(Value::Null, |t| serde_json::from_str(t).unwrap()),
                );
                actual.insert(
                    "snapshotCreditsText".into(),
                    json!(text.unwrap_or_default()),
                );
            } else {
                actual.insert(
                    "snapshotCredits".into(),
                    credits.map_or(Value::Null, |c| Value::Object(c.to_json())),
                );
            }
            actual.insert("snapshotExhaustion".into(), json!(exhaustion));
        }

        let owner = PlanOwnerState {
            id: bson::oid::ObjectId::parse_str(id).unwrap(),
            customer_id: text(user, "polar_sh_customer_id")
                .filter(|c| !c.is_empty())
                .map(Into::into),
            plan_tier: text(user, "plan_tier").unwrap_or("free").into(),
            plan_tier_until: ms(user.get("plan_tier_until")),
            effects_pending: user["polar_plan_effects_pending"] == true,
            event_key: text(user, "polar_plan_event_key").map(Into::into),
            fingerprint: text(user, "polar_plan_entitlement_fingerprint").map(Into::into),
            twitch_ids: Vec::new(),
        };
        let stored_fingerprint = owner
            .fingerprint
            .clone()
            .unwrap_or_else(|| "no-stored-fingerprint".into());
        actual.insert(
            "stateUnchanged".into(),
            json!(state_change_is_unchanged(&owner, &stored_fingerprint, now)),
        );
        for (tier, name) in [
            (PlanTier::Free, "free"),
            (PlanTier::Premium, "premium"),
            (PlanTier::Pro, "pro"),
        ] {
            actual.insert(
                format!("keepsUnmanaged:{name}"),
                json!(state_change_keeps_unmanaged_tier(&owner, tier)),
            );
        }

        let actual = Value::Object(actual);
        compared += 1;
        if !same(expected, &actual) && failures.len() < 5 {
            let differing: Vec<_> = expected
                .as_object()
                .unwrap()
                .iter()
                .filter(|(k, v)| !actual.get(*k).is_some_and(|a| same(v, a)))
                .map(|(k, v)| {
                    format!(
                        "{k}: expected {v} got {}",
                        actual.get(k).unwrap_or(&Value::Null)
                    )
                })
                .collect();
            failures.push(format!("user {id}: {}", differing.join("; ")));
        }
        let _ = (field(user, "_id"), number(&Value::Null));
    }
    assert!(
        failures.is_empty(),
        "{} users differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(compared, answers.len(), "every recorded user compared");
    eprintln!("effective plan compared for {compared} users");
}
