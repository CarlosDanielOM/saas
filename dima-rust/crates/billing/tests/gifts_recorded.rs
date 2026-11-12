//! The gift scenario recorded from the frozen TypeScript (`gifts_recorded/record.mts`, header
//! there), replayed by Rust: every step's return value, every request to Polar (method, target,
//! authorization, content type, idempotency key, body), every document of `creditgifts` and
//! `users` (canonical extended JSON: BSON types, missing versus null), the chat messages, and
//! the recipient's cached balance (by meaning: Dragonfly is internal) are compared exactly.
//!
//! Intended differences are applied in code with their reason ([`intended`]); none is needed
//! by this scenario today.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod gift_support;
mod support;

use bson::oid::ObjectId;
use dima_billing::NoopObserver;
use dima_billing::gifts::worker::CacheRefresh;
use dima_billing::gifts::{
    ChatSend, CheckoutRequest, GiftConfig, GiftEffects, GiftError, Gifts, StageEnd,
    accept_credit_gift_paid_order, apply_credit_gift_domain_event, create_credit_gift_checkout,
    find_gift_recipient, get_credit_gift, gift_pack_catalog, process_credit_gift,
    search_gift_recipients,
};
use dima_billing::plans::credits_cache::{CreditsCache, MongoPlanLookup};
use dima_core::Clock;
use dima_http::testing::MockServer;
use futures_util::future::BoxFuture;
use gift_support::{Replay, Sent, insert_ejson, snapshot, sorted};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn recording() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/gifts_recorded/typescript.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// The chat as the recording answered it, and what was sent.
#[derive(Default)]
struct Chat {
    held: Mutex<bool>,
    sent: Mutex<Vec<Value>>,
}

impl GiftEffects for Chat {
    fn send_chat<'a>(&'a self, channel_id: &'a str, message: &'a str) -> BoxFuture<'a, ChatSend> {
        Box::pin(async move {
            self.sent
                .lock()
                .unwrap()
                .push(json!({ "channel": channel_id, "message": message }));
            if *self.held.lock().unwrap() {
                ChatSend::HeldForModeration
            } else {
                ChatSend::Sent {
                    message_id: Some("msg-1".into()),
                }
            }
        })
    }
}

fn outcome(result: Result<Value, GiftError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(GiftError::Request { message, status }) => {
            json!({ "error": message, "status": status, "request": true })
        }
        Err(error) => json!({ "error": error.message(), "status": null, "request": false }),
    }
}

/// Deletes the keys the scenario's channels can have in Dragonfly database 10.
async fn clean(dragonfly: &dima_store::dragonfly::Dragonfly) {
    for channel in ["9101", "9102", "9105"] {
        support::cleanup(dragonfly, &format!("twitch:{channel}:"))
            .await
            .unwrap();
        dragonfly
            .del(&[&format!("{channel}:ai:exhaust")])
            .await
            .unwrap();
    }
}

/// The intended differences between the recording and Rust, each with its reason.
mod intended {
    /// None: the scenario's documents, requests and answers are the reference's.
    pub fn apply(_step: &str, _value: &mut serde_json::Value) {}
}

#[tokio::test]
async fn the_recorded_gift_scenario_replays_exactly() {
    let recorded = recording();
    support::with_mongo(|store| async move {
        let Some(dragonfly) = support::dragonfly(10).await? else {
            return Ok(());
        };
        clean(&dragonfly).await;
        insert_ejson(&store, "users", recorded["users"].as_array().unwrap()).await;
        let server = MockServer::start().await?;
        let replay = Replay::default();
        replay.install(&server);
        let polar = gift_support::polar(&server);
        let clock = Arc::new(gift_support::clock(recorded["now"].as_i64().unwrap()));
        let random = gift_support::random();
        let config = GiftConfig::default();
        let gifts = Gifts {
            mongo: &store,
            polar: &polar,
            clock: clock.as_ref(),
            random: &random,
            observer: &NoopObserver,
            config: &config,
            interrupt: None,
        };
        let cache = CreditsCache::new(dragonfly.clone(), clock.clone(), Arc::new(NoopObserver));
        let plans = MongoPlanLookup::new(store.database());
        let refresh = CacheRefresh {
            dragonfly: &dragonfly,
            cache: &cache,
            plans: &plans,
            polar: &polar,
        };
        let chat = Chat::default();
        let load_user = |id: &str| {
            let store = store.clone();
            let id = ObjectId::parse_str(id).unwrap();
            async move {
                let document = store
                    .documents("users")
                    .find_one(bson::doc! { "_id": id })
                    .await
                    .unwrap()
                    .unwrap();
                dima_model::decode_document::<dima_model::users::User>(&document).unwrap()
            }
        };
        for step in recorded["steps"].as_array().unwrap() {
            let name = step["name"].as_str().unwrap();
            let input = &step["input"];
            clock.set(step["now"].as_i64().unwrap());
            let before = server.requests().len();
            replay.load(step["requests"].as_array().unwrap());
            if name == "work-second-held" {
                *chat.held.lock().unwrap() = true;
            }
            let result = match step["op"].as_str().unwrap() {
                "catalog" => outcome(
                    gift_pack_catalog(&polar)
                        .await
                        .map(|o| dima_billing::gifts::provider::catalog_json(&o)),
                ),
                "find" => outcome(
                    find_gift_recipient(&gifts, input["login"].as_str().unwrap())
                        .await
                        .map(|r| r.to_json()),
                ),
                "search" => {
                    let buyer = ObjectId::parse_str(input["buyer"].as_str().unwrap()).unwrap();
                    outcome(
                        search_gift_recipients(&gifts, input["query"].as_str().unwrap(), buyer)
                            .await
                            .map(|list| Value::Array(list.iter().map(|r| r.to_json()).collect())),
                    )
                }
                "create" => {
                    let user = load_user(input["userId"].as_str().unwrap()).await;
                    let request = CheckoutRequest {
                        user: &user,
                        product_id: input["productId"].as_str().unwrap(),
                        recipient_id: input["recipientId"].as_str().unwrap(),
                        request_id: input["requestId"].as_str().unwrap(),
                        acknowledge_no_refunds: input["acknowledgeNoRefunds"] == json!(true),
                        success_url: input["successUrl"].as_str(),
                        return_url: input["returnUrl"].as_str(),
                    };
                    outcome(
                        create_credit_gift_checkout(&gifts, request)
                            .await
                            .map(|r| r.to_json()),
                    )
                }
                "view" => {
                    let user = ObjectId::parse_str(input["userId"].as_str().unwrap()).unwrap();
                    outcome(get_credit_gift(&gifts, input["id"].as_str().unwrap(), user).await)
                }
                "event" => outcome(
                    apply_credit_gift_domain_event(
                        &gifts,
                        input["source"].as_str().unwrap(),
                        input["type"].as_str().unwrap(),
                        &input["payload"],
                    )
                    .await
                    .map(|()| Value::Null),
                ),
                "accept" => outcome(
                    accept_credit_gift_paid_order(&gifts, input["orderId"].as_str().unwrap())
                        .await
                        .map(|()| Value::Null),
                ),
                "process" => outcome(
                    process_credit_gift(&gifts, &chat, &refresh)
                        .await
                        .map(|end| Value::Bool(end == StageEnd::Processed)),
                ),
                other => panic!("unknown op {other}"),
            };
            let mut expected = step["result"].clone();
            intended::apply(name, &mut expected);
            assert_eq!(result, expected, "{name}: result");
            let mut sent: Vec<Sent> = server.requests()[before..].iter().map(Sent::of).collect();
            let mut wanted: Vec<Sent> = step["requests"]
                .as_array()
                .unwrap()
                .iter()
                .map(Sent::recorded)
                .collect();
            let key = |s: &Sent| format!("{} {} {:?}", s.method, s.target, s.body);
            sent.sort_by_key(key);
            wanted.sort_by_key(key);
            assert_eq!(sent, wanted, "{name}: requests to Polar");
            assert!(replay.unused().is_empty(), "{name}: requests not made");
            let gifts_now: Vec<Value> = snapshot(&store, "creditgifts")
                .await
                .iter()
                .map(sorted)
                .collect();
            let gifts_then: Vec<Value> = step["documents"]["creditgifts"]
                .as_array()
                .unwrap()
                .iter()
                .map(sorted)
                .collect();
            assert_eq!(gifts_now, gifts_then, "{name}: creditgifts");
            assert_eq!(
                Value::Array(snapshot(&store, "users").await),
                step["documents"]["users"],
                "{name}: users"
            );
            let chats = std::mem::take(&mut *chat.sent.lock().unwrap());
            assert_eq!(Value::Array(chats), step["chats"], "{name}: chat");
        }
        // The recipient's balance, by meaning (Dragonfly is internal).
        let cached: Value = serde_json::from_str(
            &dragonfly
                .get_text("twitch:9102:ai:credits")
                .await?
                .expect("cached balance"),
        )?;
        let expected = &recorded["recipientCredits"];
        for field in ["used", "limit", "balance", "available", "status", "meterId"] {
            assert_eq!(cached[field], expected[field], "recipient balance {field}");
        }
        clean(&dragonfly).await;
        eprintln!(
            "replayed {} recorded gift steps",
            recorded["steps"].as_array().map_or(0, Vec::len)
        );
        let _ = clock.now_ms();
        Ok(())
    })
    .await
    .unwrap();
}
