#![cfg(feature = "twitch-functions")]
//! Fixture-only native HTTP requests and Redis semantics. No production
//! configuration, credentials or application-global clients are accessed.

#[path = "../src/utils/test_http.rs"]
mod test_http;

use dima_rust::{
    functions::{
        CacheCommand, CacheValue, FunctionAuth, FunctionCache, FunctionFailure, FunctionFuture,
        RequestCancellation, TwitchFunctions,
        moderation::{ModerationExecutionInput, ModerationOffenseStep, ModerationRule},
    },
    utils::twitch::{
        AccessToken, TWITCH_BOT_ACCOUNT_ID, TwitchAuth, TwitchClient, TwitchEndpoints,
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use test_http::{CannedResponse, Recorder};

#[derive(Default)]
struct State {
    auth: Vec<Value>,
    commands: Vec<Value>,
    values: HashMap<String, String>,
    sets: HashMap<String, Vec<String>>,
}
struct Auth {
    state: Arc<Mutex<State>>,
    failure: Option<String>,
}
impl FunctionAuth for Auth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move {
            let label = match auth {
                TwitchAuth::App => "app".into(),
                TwitchAuth::Bot => "bot".into(),
                TwitchAuth::Streamer(id) => format!("streamer:{id}"),
            };
            self.state.lock().unwrap().auth.push(Value::String(label));
            if let Some(message) = &self.failure {
                return Err(FunctionFailure::Denied(message.clone()));
            }
            Ok(match auth {
                TwitchAuth::App => AccessToken::app("fixture-app"),
                TwitchAuth::Bot => AccessToken::user("fixture-bot", TWITCH_BOT_ACCOUNT_ID),
                TwitchAuth::Streamer(id) => AccessToken::user("fixture-streamer", id),
            })
        })
    }
}
struct Cache {
    state: Arc<Mutex<State>>,
    failure: bool,
    notice_acquired: bool,
}
impl FunctionCache for Cache {
    fn execute<'a>(
        &'a self,
        command: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async move {
            if self.failure {
                return Err(FunctionFailure::Internal);
            }
            let mut state = self.state.lock().unwrap();
            use CacheCommand::*;
            Ok(match command {
                Acquire => CacheValue::Unit,
                Get(key) => {
                    state.commands.push(json!(["get", key]));
                    CacheValue::Text(state.values.get(&key).cloned())
                }
                Set { key, value, ttl } => {
                    state.commands.push(json!([
                        "set",
                        key,
                        serde_json::from_str::<Value>(&value).unwrap(),
                        ttl
                    ]));
                    state.values.insert(key, value);
                    CacheValue::Unit
                }
                Delete(key) => {
                    state.commands.push(json!(["delete", key]));
                    state.values.remove(&key);
                    state.sets.remove(&key);
                    CacheValue::Unit
                }
                Members(key) => {
                    state.commands.push(json!(["members", key]));
                    CacheValue::Strings(state.sets.get(&key).cloned().unwrap_or_default())
                }
                IsMember { key, value } => {
                    state.commands.push(json!(["isMember", key, value]));
                    CacheValue::Flag(
                        state
                            .sets
                            .get(&key)
                            .is_some_and(|values| values.contains(&value)),
                    )
                }
                Exists(key) => {
                    state.commands.push(json!(["exists", key]));
                    CacheValue::Flag(
                        state.values.contains_key(&key) || state.sets.contains_key(&key),
                    )
                }
                AddMembers { key, values } => {
                    state.commands.push(json!(["addMembers", key, values]));
                    state.sets.insert(key, values);
                    CacheValue::Unit
                }
                Hash { key, entries } => {
                    let mapping: serde_json::Map<_, _> = entries
                        .into_iter()
                        .map(|(key, value)| (key, Value::String(value)))
                        .collect();
                    state.commands.push(json!(["hash", key, mapping]));
                    CacheValue::Unit
                }
                Expire { key, seconds } => {
                    state.commands.push(json!(["expire", key, seconds]));
                    CacheValue::Unit
                }
                SetIfAbsent {
                    key,
                    value,
                    seconds,
                } => {
                    state.commands.push(json!(["setNx", key, value, seconds]));
                    CacheValue::Flag(self.notice_acquired)
                }
            })
        })
    }
}

fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| equal(value, other)))
        }
        _ => left == right,
    }
}
fn corpus() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/twitch_functions_cases.json"
        ))
        .expect("generate fixture in task-owned Node container first"),
    )
    .unwrap()
}

fn fixture(input: &Value) -> (TwitchFunctions, Recorder, Arc<Mutex<State>>) {
    let mut state = State::default();
    if let Some(values) = input.get("initial").and_then(Value::as_object) {
        for (key, value) in values {
            state.values.insert(key.clone(), value.to_string());
        }
    }
    if let Some(sets) = input.get("sets").and_then(Value::as_object) {
        for (key, values) in sets {
            state.sets.insert(
                key.clone(),
                values
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap().into())
                    .collect(),
            );
        }
    }
    let state = Arc::new(Mutex::new(state));
    let response = input.clone();
    let recorder = Recorder::start(move |request| {
        let status = if request.path.starts_with("/chat/messages") {
            200
        } else {
            response
                .get("httpStatus")
                .and_then(Value::as_u64)
                .unwrap_or(200) as u16
        };
        let body = if status == 204 {
            Vec::new()
        } else {
            response
                .get("rawResponse")
                .and_then(Value::as_str)
                .map(str::as_bytes)
                .map(Vec::from)
                .unwrap_or_else(|| {
                    serde_json::to_vec(response.get("response").unwrap_or(&json!({"data":[]})))
                        .unwrap()
                })
        };
        let mut headers = vec![("content-type", "application/json".into())];
        if let Some(values) = response.get("headers").and_then(Value::as_object) {
            for (name, value) in values {
                let name = match name.as_str() {
                    "ratelimit-remaining" => "ratelimit-remaining",
                    "ratelimit-reset" => "ratelimit-reset",
                    "retry-after" => "retry-after",
                    other => panic!("unexpected fixture header {other}"),
                };
                headers.push((name, value.as_str().unwrap().into()));
            }
        }
        CannedResponse {
            status,
            headers,
            body,
        }
    });
    let endpoints =
        TwitchEndpoints::new(&recorder.base_url, &format!("{}/oauth/", recorder.base_url)).unwrap();
    let client =
        TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(3))).unwrap();
    let auth = Arc::new(Auth {
        state: state.clone(),
        failure: input
            .get("authError")
            .and_then(Value::as_str)
            .map(str::to_owned),
    });
    let cache = Arc::new(Cache {
        state: state.clone(),
        failure: input["cacheError"] == true,
        notice_acquired: input["noticeAcquired"] != false,
    });
    (
        TwitchFunctions::with_adapters(client, auth, cache, None, None),
        recorder,
        state,
    )
}

async fn evaluate(service: &TwitchFunctions, operation: &str, input: &Value) -> Value {
    let channel = input["channel"].as_str().unwrap();
    let user = input["user"].as_str().unwrap();
    let cache = input["cache"] == true;
    match operation {
        "get_poll" => service.get_poll(channel, input["id"].as_str(), cache).await,
        "create_poll" => {
            service
                .create_poll(
                    channel,
                    input["title"].as_str().unwrap(),
                    &input["choices"],
                    &input["duration"],
                    cache,
                    input.get("points").and_then(Value::as_f64).unwrap_or(0.0),
                )
                .await
        }
        "end_poll" => {
            service
                .end_poll(
                    channel,
                    input["id"].as_str().unwrap_or_default(),
                    input["status"].as_str().unwrap(),
                )
                .await
        }
        "get_prediction" => {
            service
                .get_prediction(channel, input["id"].as_str(), cache)
                .await
        }
        "create_prediction" => {
            service
                .create_prediction(
                    channel,
                    input["title"].as_str().unwrap(),
                    &input["choices"],
                    &input["duration"],
                    cache,
                )
                .await
        }
        "end_prediction" => {
            service
                .end_prediction(
                    channel,
                    input["id"].as_str().unwrap_or_default(),
                    input["status"].as_str().unwrap(),
                    input["winner"].as_str(),
                )
                .await
        }
        "ban" => {
            let cancel = RequestCancellation::new();
            if input["cancelled"] == true {
                cancel.cancel();
            }
            service
                .ban(
                    channel,
                    user,
                    TWITCH_BOT_ACCOUNT_ID,
                    input["duration"].as_f64(),
                    input["reason"].as_str(),
                    Some(&cancel),
                )
                .await
        }
        "warn" => {
            service
                .warn_user(channel, user, input["reason"].as_str().unwrap_or("fixture"))
                .await
        }
        "moderators" => {
            let users: Vec<_> =
                input
                    .get("userIds")
                    .and_then(Value::as_array)
                    .map_or_else(Vec::new, |values| {
                        values
                            .iter()
                            .map(|value| value.as_str().unwrap().into())
                            .collect()
                    });
            service.get_channel_moderators(channel, &users, cache).await
        }
        "moderator_ids" => {
            service
                .get_twitch_moderators_ids(channel, input["skip"] == true)
                .await
        }
        "moderator_id" => {
            service
                .is_twitch_moderator_by_id(channel, user, input["skip"] == true)
                .await
        }
        "moderator_login" => {
            service
                .is_twitch_moderator_by_login(channel, user, input["skip"] == true)
                .await
        }
        "execute" => {
            service
                .execute_moderation_action(&ModerationExecutionInput {
                    channel_id: channel.into(),
                    user_id: user.into(),
                    username: input["username"].as_str().unwrap().into(),
                    message_id: "message".into(),
                    message_text: "fixture message".into(),
                    rule: ModerationRule {
                        id: "rule".into(),
                        rule_type: "caps".into(),
                        reason: input["reason"].as_str().unwrap_or("fixture").into(),
                    },
                    step: ModerationOffenseStep {
                        action: input["action"].as_str().unwrap().into(),
                        timeout_seconds: 60.0,
                    },
                    offense_number: 2.0,
                    decision_id: None,
                })
                .await
        }
        other => panic!("unknown function fixture {other}"),
    }
}

#[tokio::test]
async fn all_native_functions_match_actual_typescript_requests_results_and_cache_effects() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 75);
    for case in cases {
        let (service, recorder, state) = fixture(&case["input"]);
        let result = evaluate(
            &service,
            case["operation"].as_str().unwrap(),
            &case["input"],
        )
        .await;
        // Source and native terminal cache cleanup run asynchronously. Yield
        // until the fixture task has had a scheduling turn without sleeping.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert!(
            equal(&result, &case["expected"]["result"]),
            "{} result actual:{result} expected:{}",
            case["name"],
            case["expected"]["result"]
        );
        let mut requests = Vec::new();
        for _ in case["expected"]["requests"].as_array().unwrap() {
            let request = recorder.next(Duration::from_secs(2));
            requests.push(json!({"method":request.method,"path":request.path,"authorization":request.header("authorization"),"body":if request.body.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&request.body).unwrap()}}));
        }
        let state = state.lock().unwrap();
        let actual = json!({"requests":requests,"commands":state.commands,"auth":state.auth});
        let expected = json!({"requests":case["expected"]["requests"],"commands":case["expected"]["commands"],"auth":case["expected"]["auth"]});
        assert!(
            equal(&actual, &expected),
            "{} effects actual:{actual} expected:{expected}",
            case["name"]
        );
    }
}

#[tokio::test]
async fn requester_identity_never_replaces_the_bot_moderator() {
    let (service, recorder, _) = fixture(&json!({"response":{"data":[]}}));
    assert_eq!(
        service
            .ban(
                "channel",
                "viewer",
                "requester-is-not-the-bot",
                None,
                None,
                None
            )
            .await["error"],
        false
    );
    let request = recorder.next(Duration::from_secs(2));
    assert!(request.path.contains("moderator_id=698614112"));
    assert_eq!(request.header("authorization"), Some("Bearer fixture-bot"));
}

#[tokio::test]
#[ignore = "explicit task-owned MongoDB and Redis fixtures only"]
async fn native_moderation_logging_and_notice_throttle_use_real_isolated_stores() {
    use dima_rust::functions::RedisFunctionCache;
    use mongodb::{
        Client,
        bson::{Document, doc},
    };
    let uri = std::env::var("TWITCH_FUNCTION_FIXTURE_MONGO_URI").expect("explicit fixture URI");
    let redis = std::env::var("TWITCH_FUNCTION_FIXTURE_REDIS_URL").expect("explicit fixture URL");
    assert_eq!(uri, "mongodb://keyword-mongo:27017");
    assert_eq!(redis, "redis://keyword-redis:6379/");
    let name = std::env::var("TWITCH_FUNCTION_FIXTURE_DATABASE").expect("explicit unique database");
    assert!(name.starts_with("twitch_function_fixture_"));
    let client = Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&name);
    assert!(db.list_collection_names().await.unwrap().is_empty());
    let input = json!({"response":{"data":[{"is_sent":true}]}});
    let (_service, recorder, state) = fixture(&input);
    let redis = redis::Client::open(redis).unwrap();
    let service = TwitchFunctions::with_adapters(
        TwitchClient::new(
            "fixture-client",
            TwitchEndpoints::new(&recorder.base_url, &format!("{}/oauth/", recorder.base_url))
                .unwrap(),
            Some(Duration::from_secs(3)),
        )
        .unwrap(),
        Arc::new(Auth {
            state,
            failure: None,
        }),
        Arc::new(RedisFunctionCache::new(redis.clone())),
        Some(db.clone()),
        None,
    );
    service.install_moderation_action_indexes().await.unwrap();
    let channel = format!("fixture-{name}");
    let data = ModerationExecutionInput {
        channel_id: channel.clone(),
        user_id: "viewer".into(),
        username: "cdom201".into(),
        message_id: "message".into(),
        message_text: "x".repeat(230),
        rule: ModerationRule {
            id: "rule".into(),
            rule_type: "caps".into(),
            reason: "reason".into(),
        },
        step: ModerationOffenseStep {
            action: "warn".into(),
            timeout_seconds: 60.0,
        },
        offense_number: 2.0,
        decision_id: Some("fixture-decision".into()),
    };
    db.collection::<Document>("moderation_decisions")
        .insert_one(doc! {"_id":"fixture-decision"})
        .await
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            service.execute_moderation_action(&data).await["error"],
            false
        );
    }
    let first = recorder.next(Duration::from_secs(2));
    let notice = recorder.next(Duration::from_secs(2));
    let second = recorder.next(Duration::from_secs(2));
    assert!(first.path.starts_with("/moderation/warnings"));
    assert!(notice.path.starts_with("/chat/messages"));
    assert!(second.path.starts_with("/moderation/warnings"));
    assert_eq!(
        db.collection::<Document>("moderation_action_logs")
            .count_documents(doc! {})
            .await
            .unwrap(),
        2
    );
    let log = db
        .collection::<Document>("moderation_action_logs")
        .find_one(doc! {})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(log.get_str("messageExcerpt").unwrap().len(), 200);
    assert!(log.get_bool("success").unwrap());
    let decision = db
        .collection::<Document>("moderation_decisions")
        .find_one(doc! {})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        decision
            .get_document("consequence")
            .unwrap()
            .get_str("status")
            .unwrap(),
        "executed"
    );
    let mut connection = redis.get_multiplexed_async_connection().await.unwrap();
    let key = format!("moderation:{channel}:notice:viewer");
    let ttl: i64 = redis::cmd("TTL")
        .arg(&key)
        .query_async(&mut connection)
        .await
        .unwrap();
    assert!((1..=60).contains(&ttl));
    let _: i64 = redis::cmd("DEL")
        .arg(key)
        .query_async(&mut connection)
        .await
        .unwrap();
    db.drop().await.unwrap();
}
