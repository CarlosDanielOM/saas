//! Shared by the authentication, access and OAuth tests: scratch stores that are cleaned up
//! also when a test fails, the Twitch mock scripted from `auth-cases.json`, and the drift check
//! of the reference sources a recording was made from.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use anyhow::{Context, Result};
use dima_core::Random;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use serde_json::Value;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

/// `true` when the gate runs (a missing store is a failure, not a skip).
pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1")
}

/// A scratch MongoDB database and a Dragonfly logical database, with the keys to delete.
#[derive(Clone)]
pub struct Stores {
    pub mongo: MongoStore,
    pub cache: Dragonfly,
    pub db: u8,
    /// Random per run: in every key, token and id a test creates.
    pub run: String,
    keys: Arc<Mutex<Vec<String>>>,
}

impl Stores {
    /// Remembers a key to delete at the end.
    pub fn track(&self, key: impl Into<String>) {
        self.keys.lock().unwrap().push(key.into());
    }

    /// A second, independent connection to the same stores (another process, for races).
    pub async fn second(&self) -> Result<Stores> {
        let mongo = connect_mongo(self.mongo.database().name()).await?;
        let cache = connect_cache(self.db).await?;
        Ok(Stores {
            mongo,
            cache,
            db: self.db,
            run: self.run.clone(),
            keys: self.keys.clone(),
        })
    }
}

async fn connect_mongo(database: &str) -> Result<MongoStore> {
    let uri = std::env::var("DIMA_TEST_MONGO_URI").context("DIMA_TEST_MONGO_URI")?;
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.to_owned());
    Ok(MongoStore::connect(&config, None).await?)
}

pub async fn connect_cache(db: u8) -> Result<Dragonfly> {
    let address = std::env::var("DIMA_TEST_DRAGONFLY").context("DIMA_TEST_DRAGONFLY")?;
    let (host, port) = address.rsplit_once(':').context("address")?;
    Ok(Dragonfly::connect(
        DragonflyConfig::from_env_values(
            Some(host),
            Some(&format!("{port}/{db}")),
            "platform-guard-tests",
        ),
        Hooks::default(),
    )
    .await?)
}

/// Runs `body` with fresh stores, then drops the database and deletes every key it tracked or
/// that contains the run id, whatever `body` did (a panic is re-raised after the cleanup).
/// Without the stores and outside the gate, the test is skipped.
pub async fn with_stores<F, Fut>(db: u8, body: F) -> Result<()>
where
    F: FnOnce(Stores) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    if std::env::var("DIMA_TEST_MONGO_URI").is_err()
        || std::env::var("DIMA_TEST_DRAGONFLY").is_err()
    {
        anyhow::ensure!(
            !stores_required(),
            "the local stores are required (DIMA_TEST_REQUIRE_STORES=1)"
        );
        return Ok(());
    }
    let run = dima_core::SystemRandom.hex_token(8)?;
    let database = format!("dima_test_platform_{run}");
    let stores = Stores {
        mongo: connect_mongo(&database).await?,
        cache: connect_cache(db).await?,
        db,
        run: run.clone(),
        keys: Arc::new(Mutex::new(Vec::new())),
    };
    let result = AssertUnwindSafe(body(stores.clone())).catch_unwind().await;
    let cleanup = cleanup(&stores, &database).await;
    match result {
        Ok(outcome) => {
            outcome?;
            cleanup
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn cleanup(stores: &Stores, database: &str) -> Result<()> {
    anyhow::ensure!(
        database.starts_with("dima_test_platform_"),
        "refusing to drop {database}"
    );
    stores.mongo.database().drop().await?;
    let tracked: Vec<String> = stores.keys.lock().unwrap().clone();
    for key in &tracked {
        stores.cache.del(&[key]).await?;
    }
    let mut scan = stores.cache.scan(&format!("*{}*", stores.run), Some(200));
    while let Some(page) = scan.next_page().await? {
        for key in page {
            stores.cache.del(&[std::str::from_utf8(&key)?]).await?;
        }
    }
    Ok(())
}

/// The bytes of a reference source, for the drift check of a recording.
pub fn reference_sha256(relative: &str) -> Result<String> {
    let path = format!("{}/../../../dimabot/{relative}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).with_context(|| path.clone())?;
    Ok(dima_core::crypto::digest::sha256(bytes).hex())
}

/// Fails when a reference file changed since the recording.
pub fn check_drift(recording: &Value) -> Result<()> {
    let recorded = recording["sha256"].as_object().context("sha256")?;
    for (file, digest) in recorded {
        anyhow::ensure!(
            reference_sha256(file)? == digest.as_str().unwrap_or_default(),
            "{file} changed since the recording: run the recorder again"
        );
    }
    Ok(())
}

/// Token and Twitch id of a case kind, for one run (the recorder's scheme).
pub fn token_of(kind: &str, run: &str) -> String {
    if kind == "long" {
        "a".repeat(3000)
    } else {
        format!("{kind}_{run}")
    }
}

pub fn id_of(kind: &str, run: &str) -> String {
    if kind == "creator" {
        return "533538623".to_owned();
    }
    let digits: String = dima_core::crypto::digest::sha256(format!("{kind}{run}"))
        .hex()
        .chars()
        .filter(char::is_ascii_digit)
        .take(9)
        .collect();
    format!("9{digits}")
}

/// Which Twitch endpoint a mock request was for.
pub fn endpoint(request: &RecordedRequest) -> &'static str {
    if request.path().ends_with("/oauth2/validate") {
        "validate"
    } else if request.path().ends_with("/helix/users") {
        "users"
    } else {
        "other"
    }
}

/// The Twitch mock of `record-auth.mts`: answers by token from `cases.tokens`; unknown tokens are
/// refused; `/users` refuses a token of another application (`client`).
pub fn script_twitch(server: &MockServer, cases: &Value, run: &str) {
    let client_id = cases["client_id"].as_str().unwrap_or_default().to_owned();
    let tokens: Vec<(String, Value)> = cases["tokens"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(kind, spec)| (token_of(kind, run), spec.clone()))
                .collect()
        })
        .unwrap_or_default();
    let run = run.to_owned();
    server.fallback(move |request| {
        let auth = request.header("authorization").unwrap_or_default();
        let token = auth
            .strip_prefix("Bearer ")
            .or_else(|| auth.strip_prefix("OAuth "))
            .unwrap_or(auth);
        let refused = || MockResponse::json(401, r#"{"status":401,"message":"invalid access token"}"#);
        let which = endpoint(request);
        let Some(spec) = tokens.iter().find(|(t, _)| t == token).map(|(_, s)| s) else {
            return refused();
        };
        if which == "other" {
            return refused();
        }
        let answer = &spec[which];
        if answer.as_str() == Some("drop") {
            return MockResponse::drop_connection();
        }
        let client = spec["client"].as_str().unwrap_or(&client_id).to_owned();
        if which == "users" && request.header("client-id") != Some(client.as_str()) {
            return MockResponse::json(
                401,
                r#"{"error":"Unauthorized","status":401,"message":"Client ID and OAuth token do not match"}"#,
            );
        }
        let user = spec["user"].as_str().unwrap_or_default();
        let mut body = answer["body"].clone();
        if which == "users" {
            complete_helix_users(&mut body);
        }
        let text = match &body {
            Value::String(raw) => raw.clone(),
            body => serde_json::to_string(body)
                .unwrap_or_default()
                .replace("$CLIENT", &client)
                .replace("$ID", &id_of(user, &run))
                .replace("$LOGIN", &format!("login_{user}")),
        };
        let status = u16::try_from(answer["status"].as_u64().unwrap_or(500)).unwrap_or(500);
        MockResponse::json(status, &text)
    });
}

/// Real Helix sends every documented field of a user (`""` for a missing picture); the
/// recorded cases list only those the reference reads. The typed `Twitch::user_by_token`
/// decodes the documented user, so the mock completes each entry as Helix would. The
/// reference read none of the added fields, so its recording stays valid.
pub fn complete_helix_users(body: &mut Value) {
    let Some(users) = body.get_mut("data").and_then(Value::as_array_mut) else {
        return;
    };
    for user in users.iter_mut().filter_map(Value::as_object_mut) {
        for (field, value) in [
            ("type", Value::from("")),
            ("broadcaster_type", Value::from("")),
            ("description", Value::from("")),
            ("profile_image_url", Value::from("")),
            ("offline_image_url", Value::from("")),
            ("view_count", Value::from(0)),
            ("created_at", Value::from("2020-01-01T00:00:00Z")),
        ] {
            user.entry(field).or_insert(value);
        }
    }
}

/// The two calls with a user's own token, as production makes them: a [`dima_twitch::Twitch`]
/// for `client_id` whose providers point at the test's mock (or nowhere).
pub fn user_api(
    stores: &Stores,
    oauth: dima_http::Provider,
    helix: dima_http::Provider,
    client_id: &str,
) -> Result<std::sync::Arc<dima_twitch::Twitch>> {
    use dima_core::{SecretString, Shutdown, SystemClock, SystemRandom};
    let mut config = dima_twitch::TwitchConfig::new(client_id, SecretString::from("test-secret"));
    config.keys = dima_twitch::KeySpace::prefixed(format!("platform_test_{}:tw:", stores.run));
    Ok(std::sync::Arc::new(dima_twitch::Twitch::new(
        config,
        dima_twitch::TwitchDeps {
            http: dima_http::HttpClient::builder().build()?,
            exchange_http: dima_twitch::exchange_client(dima_http::HttpClient::builder())?,
            helix,
            oauth,
            mongo: stores.mongo.clone(),
            dragonfly: stores.cache.clone(),
            cipher: dima_core::crypto::CredentialCipher::new("platform-test-only")?,
            clock: std::sync::Arc::new(SystemClock),
            random: std::sync::Arc::new(SystemRandom),
            events: std::sync::Arc::new(dima_twitch::NoopEvents),
            shutdown: Shutdown::new(),
        },
    )))
}
