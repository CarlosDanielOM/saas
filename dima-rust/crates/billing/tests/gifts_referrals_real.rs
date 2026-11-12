//! Real data (read only, the local `domdimabot` copy): every gift decodes and gives the view
//! the TypeScript gave its buyer; every referral owner's stats, people page and timeline page
//! equal the TypeScript's answers (`gifts_referrals_real/reference.json`, recorded by
//! `record.mts` there with ids and numbers only: names, logins, labels and codes are compared
//! by their SHA-256 prefix).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod gift_support;
mod support;

use bson::doc;
use bson::oid::ObjectId;
use dima_billing::NoopObserver;
use dima_billing::gifts::{Gift, GiftConfig, Gifts, get_credit_gift};
use dima_billing::referrals::{get_referral_stats, referral_people_page, referral_timeline_page};
use dima_http::testing::MockServer;
use futures_util::TryStreamExt;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const HASHED: [&str; 5] = ["name", "login", "displayName", "label", "code"];

fn scrub(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| scrub(v, "")).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), scrub(v, k)))
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) if HASHED.contains(&key) => {
            let digest = hex::encode(Sha256::digest(text.as_bytes()));
            Value::String(format!("sha256:{}", digest.get(..16).unwrap()))
        }
        other => other.clone(),
    }
}

fn answer<E: std::fmt::Display>(result: Result<Value, E>) -> Value {
    match result {
        Ok(value) => json!({ "ok": scrub(&value, "") }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

#[tokio::test]
async fn real_gifts_and_referrals_read_as_the_typescript_read_them() {
    let Some(store) = support::real_store().await.unwrap() else {
        return;
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/gifts_referrals_real/reference.json");
    let reference: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    gift_support::check_sources(&reference);

    // Every stored gift decodes.
    let stored: Vec<bson::Document> = store
        .documents("creditgifts")
        .find(doc! {})
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    for document in &stored {
        Gift::decode(document).unwrap();
    }
    assert_eq!(stored.len(), reference["gifts"].as_array().unwrap().len());

    let server = MockServer::start().await.unwrap();
    let polar = gift_support::polar(&server);
    let clock = dima_core::SystemClock;
    let config = GiftConfig::default();
    let gifts = Gifts {
        mongo: &store,
        polar: &polar,
        clock: &clock,
        random: &dima_core::SystemRandom,
        observer: &NoopObserver,
        config: &config,
        interrupt: None,
    };
    for gift in reference["gifts"].as_array().unwrap() {
        let buyer = ObjectId::parse_str(gift["buyer"].as_str().unwrap()).unwrap();
        let view = answer(get_credit_gift(&gifts, gift["id"].as_str().unwrap(), buyer).await);
        assert_eq!(view, gift["view"], "gift {}", gift["id"]);
    }
    assert!(server.requests().is_empty(), "reads never call Polar");

    let mut compared = 0;
    for owner in reference["referrals"].as_array().unwrap() {
        let id = ObjectId::parse_str(owner["owner"].as_str().unwrap()).unwrap();
        assert_eq!(
            answer(get_referral_stats(&store, id).await),
            owner["stats"],
            "stats {id}"
        );
        assert_eq!(
            answer(referral_people_page(&store, id, 0).await),
            owner["people"],
            "people {id}"
        );
        assert_eq!(
            answer(referral_timeline_page(&store, id, 0).await),
            owner["timeline"],
            "timeline {id}"
        );
        compared += 3;
    }
    assert!(compared > 0);
    eprintln!(
        "{} gifts and {compared} referral reads agree with the TypeScript",
        stored.len()
    );
}
