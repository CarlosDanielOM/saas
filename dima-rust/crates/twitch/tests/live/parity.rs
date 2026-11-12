//! The 17 `refreshTwitchToken` traces of `tests/corpus/reference.json`, recorded from the
//! TypeScript, replayed through Rust against the real stores and the mock: same outcome, same
//! MongoDB `$set` (envelopes compared by their plaintext, numbers by BSON type), same cache
//! fields, same log actions in the same order, same number of attempts.

use crate::support::*;
use anyhow::{Context, Result};
use bson::{Bson, doc};
use dima_core::ManualClock;
use dima_http::testing::{MockResponse, MockServer};
use dima_twitch::{RefreshContext, RefreshFailureKind, RefreshOutcome, RefreshToken};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const USER: &str = "fixture-user";

fn corpus() -> Result<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/reference.json");
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn mock_answer(answer: &Value) -> MockResponse {
    let status = u16::try_from(answer[0].as_u64().unwrap_or(500)).unwrap_or(500);
    match &answer[1] {
        Value::String(text) => MockResponse::new(status).body(text.clone()),
        other => MockResponse::json(status, &other.to_string()),
    }
}

fn expected_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(flag) => Bson::Boolean(*flag),
        Value::Number(number) => {
            dima_store::mongo::number::js_number(number.as_f64().unwrap_or(f64::NAN))
        }
        other => unreachable!("unexpected $set value {other}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_traces_match_the_reference() -> Result<()> {
    with_stores(|stores| async move {
        let corpus = corpus()?;
        let now_ms = corpus["now_ms"].as_i64().context("now")?;
        for case in corpus["refresh"].as_array().context("refresh")? {
            let name = case["name"].as_str().unwrap_or_default();
            let rotated = case["options"]["stored"].is_string();
            let missing_user = case["options"]["missingUser"].as_bool().unwrap_or(false);
            let (access, refresh, expires) = if rotated {
                (
                    "winner-access",
                    "winner-refresh",
                    case["options"]["expires"].as_str().unwrap_or_default(),
                )
            } else {
                ("old-access", "old-refresh", "1000")
            };
            stores.mongo.documents("users").delete_many(doc! {}).await?;
            stores.dragonfly.del(&[&stores.keys.account(USER)]).await?;
            if !missing_user {
                insert_user(
                    &stores,
                    user_document(USER, "chan", access, refresh, Some(1000)),
                )
                .await?;
            }
            set_cache(
                &stores,
                USER,
                &[
                    ("access_token", access),
                    ("refresh_token", refresh),
                    ("expires_at", expires),
                ],
            )
            .await?;
            let seeded = if missing_user {
                None
            } else {
                Some(stored_account(&stores, USER).await?)
            };

            let server = MockServer::start().await?;
            let answers: Vec<Value> = case["answers"].as_array().context("answers")?.clone();
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&calls);
            server.fallback(move |_| {
                let call = counter.fetch_add(1, Ordering::SeqCst);
                mock_answer(&answers[call.min(answers.len() - 1)])
            });
            let process = process_at(&stores, &server, fast_timings(), ManualClock::new(now_ms))?;
            let outcome = process
                .twitch
                .refresh_token(
                    &RefreshToken::new("old-refresh"),
                    USER,
                    RefreshContext::new("token_refresh", "corpus"),
                )
                .await;

            // Outcome.
            let result = &case["result"];
            match (&outcome, result["kind"].as_str()) {
                (
                    RefreshOutcome::Success {
                        access_token,
                        refresh_token,
                        expires_in,
                    },
                    Some("success"),
                ) => {
                    assert_eq!(
                        Some(access_token.expose()),
                        result["token"].as_str(),
                        "{name}"
                    );
                    assert_eq!(
                        Some(refresh_token.expose()),
                        result["refreshToken"].as_str(),
                        "{name}"
                    );
                    assert_eq!(Some(*expires_in), result["expiresIn"].as_f64(), "{name}");
                }
                (
                    RefreshOutcome::Failure {
                        kind,
                        status,
                        message,
                    },
                    Some(expected),
                ) => {
                    let kind = match kind {
                        RefreshFailureKind::Permanent => "permanent_failure",
                        RefreshFailureKind::Transient => "transient_failure",
                    };
                    assert_eq!(kind, expected, "{name}");
                    assert_eq!(status.map(u64::from), result["status"].as_u64(), "{name}");
                    assert_eq!(Some(message.as_str()), result["message"].as_str(), "{name}");
                }
                (outcome, expected) => {
                    panic!("{name}: {outcome:?} where the reference gave {expected:?}")
                }
            }
            assert_eq!(
                calls.load(Ordering::SeqCst),
                usize::try_from(case["attempts"].as_u64().unwrap_or(0))?,
                "{name}: attempts"
            );

            // MongoDB.
            let effects = &case["effects"];
            if let Some(seeded) = seeded {
                let after = stored_account(&stores, USER).await?;
                match effects["store"].as_array().and_then(|writes| writes.last()) {
                    Some(set) => {
                        for (path, value) in set.as_object().context("$set")? {
                            let field = path.trim_start_matches("accounts.$.");
                            if let Some(plain) = value.get("plain") {
                                assert_eq!(
                                    decrypt_field(&after, field).as_deref(),
                                    plain.as_str(),
                                    "{name}: {field}"
                                );
                                if plain.is_null() {
                                    assert_eq!(
                                        after.get_document(field)?,
                                        &doc! { "iv": Bson::Null, "content": Bson::Null },
                                        "{name}: {field}"
                                    );
                                }
                            } else {
                                assert_eq!(
                                    after.get(field),
                                    Some(&expected_bson(value)),
                                    "{name}: {field}"
                                );
                            }
                        }
                    }
                    None => assert_eq!(after, seeded, "{name}: nothing written"),
                }
            }

            // Cache.
            let cache = cache_fields(&stores, USER).await?;
            for (field, value) in case["finalCache"].as_object().context("finalCache")? {
                assert_eq!(
                    cache.get(field).map(String::as_str),
                    value.as_str(),
                    "{name}: cache {field}"
                );
            }

            // Log actions, in order.
            let expected: Vec<String> = effects["actions"]
                .as_array()
                .context("actions")?
                .iter()
                .filter_map(|a| a.as_str().map(str::to_owned))
                .collect();
            let got: Vec<String> = process
                .events
                .entries()
                .iter()
                .filter(|entry| {
                    matches!(
                        entry.data["function"].as_str(),
                        Some("refreshTwitchToken" | "invalidateStoredTwitchTokens")
                    )
                })
                .map(|entry| {
                    let label = entry.data["action"]
                        .as_str()
                        .or_else(|| entry.data["reason"].as_str())
                        .unwrap_or_default();
                    format!("{}:{label}", entry.level.as_str())
                })
                .collect();
            assert_eq!(got, expected, "{name}: log actions");
            assert_no_secrets(
                &process.events,
                &[
                    "old-refresh",
                    "old-access",
                    "new-access",
                    "new-refresh",
                    "winner-access",
                    "winner-refresh",
                ],
            );
        }
        Ok(())
    })
    .await
}
