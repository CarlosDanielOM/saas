//! Shared harness of the EventSub replay tests (`eventsub_manage.rs`, `eventsub_reconcile.rs`):
//! seeds a throwaway database the way the recorder seeded the reference's, answers Helix with
//! the recorded answers in order (OAuth with a local token endpoint), and compares what Rust sent,
//! returned and stored with the recording.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use crate::support::{Process, Stores, cipher, fast_timings, user_document};
use anyhow::{Context, Result};
use bson::{Bson, Document, doc};
use dima_core::{Clock, ManualClock, SecretString, Shutdown, SystemRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_twitch::events::RecordingEvents;
use dima_twitch::eventsub::{EventsubManager, EventsubSettings};
use dima_twitch::{Twitch, TwitchConfig, TwitchDeps};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

/// The recordings' webhook secret (a test value).
pub const SECRET: &str = "test-eventsub-secret-0123456789";
/// The recordings' client id.
pub const CLIENT_ID: &str = "test-client-id";
/// The recordings' client secret (the token endpoint's).
pub const CLIENT_SECRET: &str = "test-client-secret-value";

/// A recording of `tests/eventsub/`.
pub fn load(name: &str) -> Result<Value> {
    let path = format!("{}/tests/eventsub/{name}", env!("CARGO_MANIFEST_DIR"));
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

/// The recording names the hash of every reference file it loaded; one that changed since
/// fails here (record again).
pub fn assert_sources_unchanged(recording: &Value) -> Result<()> {
    assert_eq!(
        recording["reference"].as_str(),
        Some("0c71108ee6e5d537104ad26b10db9d558fac22ab")
    );
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dimabot");
    for (path, hash) in recording["sources"].as_object().context("sources")? {
        let bytes = std::fs::read(format!("{root}/{path}"))?;
        assert_eq!(
            dima_core::crypto::sha256(&bytes).hex(),
            hash.as_str().unwrap_or_default(),
            "{path} changed since the recording: record again"
        );
    }
    Ok(())
}

/// A body with the test secret masked, for failure messages.
pub fn mask(text: &str) -> String {
    text.replace(SECRET, "<secret>")
}

/// Users as the recorder seeded them: one Twitch account each, with a usable token unless the
/// channel says `token: false` (then only a refresh token Twitch refuses).
pub async fn seed_channels(stores: &Stores, channels: &Value, now_ms: i64) -> Result<()> {
    for channel in channels.as_array().context("channels")? {
        let id = channel["id"].as_str().context("id")?;
        let name = channel["name"].as_str().context("name")?;
        let token = channel["token"].as_bool().unwrap_or(true);
        let mut user = user_document(
            id,
            name,
            &format!("{id}-access"),
            &format!("{id}-refresh"),
            Some(now_ms / 1000 + 3600),
        );
        let accounts = user.get_array_mut("accounts")?;
        if let Some(Bson::Document(account)) = accounts.first_mut() {
            account.insert("actived", channel["actived"].as_bool().unwrap_or(true));
            account.insert(
                "has_permissions",
                channel["has_permissions"].as_bool().unwrap_or(true),
            );
            if !token {
                account.remove("access_token");
                account.insert("access_token_expires_at", Bson::Int32(1));
            }
        }
        stores.mongo.documents("users").insert_one(user).await?;
    }
    Ok(())
}

/// The indexes the reference's models create (`Model.init()`): the query planner picks them, so
/// they decide the order of `find` results, as in production.
pub async fn create_indexes(stores: &Stores) -> Result<()> {
    for info in [
        &dima_model::eventsubs::INFO,
        &dima_model::users::INFO,
        &dima_model::raid_subscription_preferences::INFO,
        &dima_model::admins::INFO,
    ] {
        let policy = dima_model::index::startup_policy(info).context("policy")?;
        let report = dima_model::index::ensure_indexes(
            &stores.mongo,
            info,
            policy,
            std::time::Duration::from_secs(30),
        )
        .await;
        report
            .require()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    Ok(())
}

/// Inserts recorded documents (canonical extended JSON) as they are.
pub async fn seed_documents(stores: &Stores, collection: &str, documents: &Value) -> Result<()> {
    for document in documents.as_array().context("documents")? {
        let document = Document::try_from(document.as_object().context("document")?.clone())?;
        stores
            .mongo
            .documents(collection)
            .insert_one(document)
            .await?;
    }
    Ok(())
}

/// Every document of `collection` in natural order, as canonical extended JSON.
pub async fn documents(stores: &Stores, collection: &str) -> Result<Vec<Value>> {
    let mut cursor = stores.mongo.documents(collection).find(doc! {}).await?;
    let mut found = Vec::new();
    while let Some(document) = cursor.try_next().await? {
        found.push(Bson::Document(document).into_canonical_extjson());
    }
    Ok(found)
}

/// The ObjectIds of a set of recorded documents.
pub fn object_ids(documents: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    for document in documents.as_array().into_iter().flatten() {
        if let Some(id) = document["_id"]["$oid"].as_str() {
            ids.insert(id.to_owned());
        }
    }
    ids
}

/// Replaces every ObjectId (`{"$oid"}`, or the text of an `_id`) that is not in `known` with a
/// placeholder: the server generates those.
pub fn normalize(value: &mut Value, known: &HashSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(id)) = map.get_mut("$oid")
                && !known.contains(id.as_str())
            {
                *id = "<generated>".into();
            }
            if let Some(Value::String(id)) = map.get_mut("_id")
                && id.len() == 24
                && !known.contains(id.as_str())
            {
                *id = "<generated>".into();
            }
            for item in map.values_mut() {
                normalize(item, known);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, known)),
        _ => {}
    }
}

/// A recorded answer as a mock answer.
pub fn answer(response: &Value) -> MockResponse {
    let status = u16::try_from(response["status"].as_u64().unwrap_or(500)).unwrap_or(500);
    let mut answer = MockResponse::new(status);
    match response["headers"].as_object() {
        Some(headers) => {
            for (name, value) in headers {
                answer = answer.header(name, value.as_str().unwrap_or_default());
            }
        }
        None if response["body"].is_string() => {
            answer = answer.header("content-type", "application/json");
        }
        None => {}
    }
    if let Some(body) = response["body"].as_str() {
        answer = answer.body(body.as_bytes().to_vec());
    }
    answer
}

/// The token endpoint of the replays: app tokens when `app_token`, every refresh refused.
fn token_endpoint(request: &RecordedRequest, app_token: bool) -> MockResponse {
    let body = request.body_text();
    if body.contains("grant_type=client_credentials") && app_token {
        MockResponse::json(
            200,
            r#"{"access_token":"app-token-1","expires_in":5011271,"token_type":"bearer"}"#,
        )
    } else if body.contains("grant_type=client_credentials") {
        MockResponse::json(403, r#"{"status":403,"message":"invalid client"}"#)
    } else {
        MockResponse::json(400, r#"{"status":400,"message":"Invalid refresh token"}"#)
    }
}

/// A Twitch mock answering Helix with `answers` in order (a request past them gets 599 and fails
/// the comparison).
pub async fn replay_twitch(answers: Vec<MockResponse>, app_token: bool) -> Result<MockServer> {
    let server = MockServer::start().await?;
    let queue = Arc::new(Mutex::new(VecDeque::from(answers)));
    server.fallback(move |request| {
        if request.path() == "/oauth2/token" {
            return token_endpoint(request, app_token);
        }
        queue
            .lock()
            .expect("queue")
            .pop_front()
            .unwrap_or_else(|| MockResponse::json(599, r#"{"error":"unexpected request"}"#))
    });
    Ok(server)
}

/// A Twitch mock whose Helix answers come from `helix` (stateful fakes).
pub async fn twitch_with(
    app_token: bool,
    helix: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
) -> Result<MockServer> {
    let server = MockServer::start().await?;
    server.fallback(move |request| {
        if request.path() == "/oauth2/token" {
            token_endpoint(request, app_token)
        } else {
            helix(request)
        }
    });
    Ok(server)
}

/// A process on the stores and the mock, with `client_id` and the clock at `now_ms`.
pub fn process(
    stores: &Stores,
    server: &MockServer,
    client_id: &str,
    now_ms: i64,
) -> Result<Process> {
    process_split(stores, server, server, client_id, now_ms)
}

/// A process whose Helix and OAuth providers point at different servers.
pub fn process_split(
    stores: &Stores,
    helix: &MockServer,
    oauth: &MockServer,
    client_id: &str,
    now_ms: i64,
) -> Result<Process> {
    let server = oauth;
    let mut config = TwitchConfig::new(client_id, SecretString::from(CLIENT_SECRET));
    config.keys = stores.keys.clone();
    config.timings = fast_timings();
    let clock = ManualClock::new(now_ms);
    let shutdown = Shutdown::new();
    let events = Arc::new(RecordingEvents::default());
    let clock_dyn: Arc<dyn Clock> = Arc::new(clock.clone());
    let twitch = Twitch::new(
        config,
        TwitchDeps {
            http: HttpClient::builder()
                .shutdown(shutdown.clone())
                .clock(Arc::clone(&clock_dyn))
                .build()?,
            exchange_http: dima_twitch::exchange_client(
                HttpClient::builder().clock(Arc::clone(&clock_dyn)),
            )?,
            helix: helix.provider(dima_twitch::helix_provider(client_id))?,
            oauth: server.provider(dima_twitch::oauth_provider())?,
            mongo: stores.mongo.clone(),
            dragonfly: stores.dragonfly.clone(),
            cipher: cipher(),
            clock: clock_dyn,
            random: Arc::new(SystemRandom),
            events: events.clone(),
            shutdown: shutdown.clone(),
        },
    );
    Ok(Process {
        twitch,
        events,
        clock,
        shutdown,
    })
}

/// The manager of `process` with the recordings' callback and `secret`.
pub fn manager(process: &Process, secret: Option<&str>) -> Result<EventsubManager> {
    let settings = EventsubSettings::reference(secret.map(SecretString::from))?;
    Ok(EventsubManager::new(process.twitch.clone(), settings))
}

/// The Helix requests the mock received.
pub fn helix_requests(server: &MockServer) -> Vec<RecordedRequest> {
    server
        .requests()
        .into_iter()
        .filter(|request| request.path().starts_with("/helix/"))
        .collect()
}

/// A sent request in the recording's shape (secret masked in the body).
pub fn shape(request: &RecordedRequest) -> Value {
    json!({
        "method": request.method,
        "target": request.target,
        "client-id": request.header("client-id"),
        "authorization": request.header("authorization"),
        "content-type": request.header("content-type"),
        "body": mask(&request.body_text()),
    })
}

/// A recorded request in the same shape.
pub fn recorded_shape(exchange: &Value) -> Value {
    let request = &exchange["request"];
    json!({
        "method": request["method"],
        "target": request["target"],
        "client-id": request["headers"]["client-id"],
        "authorization": request["headers"]["authorization"],
        "content-type": request["headers"]["content-type"],
        "body": mask(request["body"].as_str().unwrap_or_default()),
    })
}

/// Asserts the exact body bytes were sent (the masked comparison hides the secret only).
pub fn assert_same_bodies(name: &str, recorded: &[Value], sent: &[RecordedRequest]) {
    for (exchange, request) in recorded.iter().zip(sent) {
        let expected = exchange["request"]["body"].as_str().unwrap_or_default();
        assert!(
            request.body_text() == expected,
            "{name}: body bytes differ:\n rust {}\n   ts {}",
            mask(&request.body_text()),
            mask(expected)
        );
    }
}
