//! Referrals, paid-order rewards and the Polar account cancellation recorded from the frozen
//! TypeScript (`referrals_recorded/record.mts`, header there) and replayed by Rust: every
//! step's return value, every request to Polar, and every document of `referralcodes`,
//! `credittransactions` and `users` (canonical extended JSON) are compared exactly. Ids MongoDB
//! generated in either run are named by what they identify (a code by its text, a receipt by
//! its idempotency key) before the comparison.
//!
//! Intended differences, applied in code ([`intended`]): a Polar error's message carries no
//! response body (Polar echoes request fields there, an e-mail among them).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod gift_support;
mod support;

use bson::doc;
use bson::oid::ObjectId;
use dima_billing::account_cancellation::revoke_polar_subscriptions_for_account;
use dima_billing::order_rewards::{OrderRewards, PaidOrder, RewardError};
use dima_billing::referrals::{
    Cadence, ReferralError, apply_referral_code, create_campaign_code, delete_campaign_code,
    find_by_code, get_referral_stats, get_user_codes, referral_people_page, referral_timeline_page,
};
use dima_http::testing::MockServer;
use dima_store::mongo::MongoStore;
use gift_support::{Replay, Sent, insert_ejson, snapshot, sorted};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn recording() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/referrals_recorded/typescript.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

const FIXTURE_IDS: [&str; 16] = [
    "64d000000000000000000001",
    "64d000000000000000000002",
    "64d000000000000000000003",
    "64d000000000000000000004",
    "64d000000000000000000005",
    "64d000000000000000000006",
    "64d000000000000000000007",
    "64d000000000000000000008",
    "64d000000000000000000009",
    "64d00000000000000000000a",
    "64d000000000000000000030",
    "64d000000000000000000041",
    "64d000000000000000000042",
    "64d000000000000000000043",
    "64d000000000000000000044",
    "64d000000000000000000045",
];

/// Names every generated id of `documents` by what it identifies.
fn learn(names: &mut BTreeMap<String, String>, documents: &Value) {
    for code in documents["referralcodes"].as_array().unwrap() {
        let id = code["_id"]["$oid"].as_str().unwrap();
        if !FIXTURE_IDS.contains(&id) {
            names.insert(
                id.into(),
                format!("<code:{}>", code["code"].as_str().unwrap()),
            );
        }
    }
    for receipt in documents["credittransactions"].as_array().unwrap() {
        let id = receipt["_id"]["$oid"].as_str().unwrap();
        if !FIXTURE_IDS.contains(&id) {
            names.insert(
                id.into(),
                format!("<tx:{}>", receipt["idempotencyKey"].as_str().unwrap_or("?")),
            );
        }
    }
}

fn rename(value: &Value, names: &BTreeMap<String, String>) -> Value {
    let mut text = value.to_string();
    for (id, name) in names {
        text = text.replace(id, name);
    }
    serde_json::from_str(&text).unwrap()
}

/// The intended differences between the recording and Rust, each with its reason.
mod intended {
    use serde_json::Value;

    /// Polar's error body is never kept in a message (P2-BILLING-01b): `Polar API error 409:
    /// {...}` is `Polar API error 409`.
    pub fn apply(result: &mut Value) {
        if let Some(Value::String(message)) = result.get_mut("error")
            && message.starts_with("Polar API error ")
            && let Some((head, _)) = message.split_once(": ")
        {
            *message = head.to_owned();
        }
    }
}

fn referral(result: Result<Value, ReferralError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error.to_string(), "prerequisite": false }),
    }
}

fn reward(result: Result<(), RewardError>) -> Value {
    match result {
        Ok(()) => json!({ "ok": null }),
        Err(error @ RewardError::PrerequisiteMissing(_)) => {
            json!({ "error": error.to_string(), "prerequisite": true })
        }
        Err(error) => json!({ "error": error.to_string(), "prerequisite": false }),
    }
}

async fn documents(store: &MongoStore) -> Value {
    json!({
        "referralcodes": snapshot(store, "referralcodes").await,
        "credittransactions": snapshot(store, "credittransactions").await,
        "users": snapshot(store, "users").await,
    })
}

fn oid(value: &Value) -> ObjectId {
    ObjectId::parse_str(value.as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn the_recorded_referral_reward_and_cancellation_scenario_replays_exactly() {
    let recorded = recording();
    support::with_mongo(|store| async move {
        for (collection, key) in [
            ("users", "users"),
            ("credittransactions", "credittransactions"),
            ("referralcodes", "referralcodes"),
        ] {
            insert_ejson(
                &store,
                collection,
                recorded["fixtures"][key].as_array().unwrap(),
            )
            .await;
        }
        let server = MockServer::start().await?;
        let replay = Replay::default();
        replay.install(&server);
        let polar = gift_support::polar(&server);
        let rewards = OrderRewards::new(&store);
        let mut theirs = BTreeMap::new();
        let mut ours = BTreeMap::new();
        for step in recorded["steps"].as_array().unwrap() {
            let name = step["name"].as_str().unwrap();
            let input = &step["input"];
            let now = step["now"].as_i64().unwrap();
            replay.load(step["requests"].as_array().unwrap());
            let before = server.requests().len();
            let result = match step["op"].as_str().unwrap() {
                "create" => referral(
                    create_campaign_code(
                        &store,
                        oid(&input["owner"]),
                        input["code"].as_str().unwrap(),
                        input["label"].as_str().unwrap(),
                        now,
                    )
                    .await,
                ),
                "codes" => referral(
                    get_user_codes(&store, oid(&input["owner"]))
                        .await
                        .map(Value::Array),
                ),
                "find" => referral(
                    find_by_code(&store, input["code"].as_str().unwrap())
                        .await
                        .map(|found| {
                            found.map_or(
                                Value::Null,
                                |code| json!({ "code": code.code, "owner": code.owner.to_hex() }),
                            )
                        }),
                ),
                "apply" => referral(
                    apply_referral_code(
                        &store,
                        oid(&input["user"]),
                        input["code"].as_str().unwrap(),
                        now,
                    )
                    .await
                    .map(Value::Bool),
                ),
                "reward" => {
                    let order = PaidOrder {
                        owner_user_id: input["ownerUserId"].as_str().unwrap(),
                        order_id: input["orderId"].as_str().unwrap(),
                        product_id: input["productId"].as_str().unwrap(),
                        cadence: Cadence::parse(input["cadence"].as_str().unwrap()).unwrap(),
                    };
                    reward(
                        rewards
                            .apply_paid_order_reward(&order, now)
                            .await
                            .map(|_| ()),
                    )
                }
                "event" => {
                    let owner = input["owner"]
                        .as_str()
                        .map(|o| ObjectId::parse_str(o).unwrap());
                    reward(
                        rewards
                            .apply_polar_reward_domain_event(
                                "polar-webhook",
                                "billing.order.paid",
                                &input["payload"],
                                owner,
                                now,
                            )
                            .await
                            .map(|_| ()),
                    )
                }
                "stats" => referral(get_referral_stats(&store, oid(&input["owner"])).await),
                "people" => referral(
                    referral_people_page(
                        &store,
                        oid(&input["owner"]),
                        u32::try_from(input["page"].as_u64().unwrap()).unwrap(),
                    )
                    .await,
                ),
                "timeline" => referral(
                    referral_timeline_page(
                        &store,
                        oid(&input["owner"]),
                        u32::try_from(input["page"].as_u64().unwrap()).unwrap(),
                    )
                    .await,
                ),
                "delete" => {
                    let code = store
                        .documents("referralcodes")
                        .find_one(doc! { "code": input["code"].as_str().unwrap() })
                        .await?
                        .unwrap();
                    referral(
                        delete_campaign_code(
                            &store,
                            oid(&input["owner"]),
                            code.get_object_id("_id")?,
                            now,
                        )
                        .await
                        .map(Value::Bool),
                    )
                }
                "revoke" => match revoke_polar_subscriptions_for_account(
                    &store,
                    &polar,
                    oid(&input["user"]),
                )
                .await
                {
                    Ok(count) => json!({ "ok": count }),
                    Err(error) => json!({ "error": error.to_string(), "prerequisite": false }),
                },
                other => panic!("unknown op {other}"),
            };
            learn(&mut theirs, &step["documents"]);
            let now_documents = documents(&store).await;
            learn(&mut ours, &now_documents);
            let mut expected = rename(&step["result"], &theirs);
            intended::apply(&mut expected);
            assert_eq!(rename(&result, &ours), expected, "{name}: result");
            for collection in ["referralcodes", "credittransactions", "users"] {
                let mine: Vec<Value> = rename(&now_documents[collection], &ours)
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(sorted)
                    .collect();
                let reference: Vec<Value> = rename(&step["documents"][collection], &theirs)
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(sorted)
                    .collect();
                assert_eq!(mine, reference, "{name}: {collection}");
            }
            let mut sent: Vec<Sent> = server.requests()[before..].iter().map(Sent::of).collect();
            let mut wanted: Vec<Sent> = step["requests"]
                .as_array()
                .unwrap()
                .iter()
                .map(Sent::recorded)
                .collect();
            let key = |s: &Sent| format!("{} {}", s.method, s.target);
            sent.sort_by_key(key);
            wanted.sort_by_key(key);
            assert_eq!(sent, wanted, "{name}: requests to Polar");
        }
        eprintln!(
            "replayed {} recorded referral, reward and cancellation steps",
            recorded["steps"].as_array().map_or(0, Vec::len)
        );
        Ok(())
    })
    .await
    .unwrap();
}
