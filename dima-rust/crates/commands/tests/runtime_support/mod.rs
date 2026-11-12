//! Shared harness of the runtime tests: the local MongoDB and Dragonfly from `tools/test-env`,
//! a throwaway `dima_test_commands_<random>` database dropped even when a test fails, Dragonfly
//! logical database 11 with a unique key prefix removed afterwards, the recorded reference
//! (`tests/runtime/reference.json`), and a Twitch on `dima_http::testing::MockServer`. Without
//! the stores a test skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_commands::runtime::lookup::{CommandCache, CommandCacheConfig};
use dima_commands::runtime::{KeyPrefix, Stores};
use dima_core::crypto::CredentialCipher;
use dima_core::{Clock, ManualClock, SecretString, SeededRandom, Shutdown, SystemRandom};
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_http::{HttpClient, Provider};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use dima_twitch::events::RecordingEvents;
use dima_twitch::{KeySpace, Timings, Twitch, TwitchConfig, TwitchDeps};
use futures_util::{FutureExt, TryStreamExt};
use serde_json::Value;

pub const DRAGONFLY_DATABASE: u8 = 11;
pub const CLIENT_ID: &str = "test-client-id";
pub const TEST_SECRET_KEY: &str = "dima-commands-test-key";

pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

pub fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

pub fn random_suffix() -> String {
    let mut bytes = [0_u8; 6];
    let _ = dima_core::Random::fill(&SystemRandom, &mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn connect_dragonfly() -> Result<Option<Dragonfly>> {
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let (host, port) = address.rsplit_once(':').context("host:port")?;
    let mut config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{DRAGONFLY_DATABASE}")),
        "dima-commands-tests",
    );
    // Generous on a busy machine.
    config.response_timeout = Duration::from_secs(30);
    match Dragonfly::connect(config, Hooks::default()).await {
        Ok(dragonfly) => Ok(Some(dragonfly)),
        Err(error) => missing(&format!("the local Dragonfly cannot be reached: {error}")),
    }
}

pub async fn connect_mongo(database: &str) -> Result<Option<MongoStore>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.to_owned());
    match MongoStore::connect(&config, None).await {
        Ok(store) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// Deletes every key under `prefix`.
pub async fn clean_prefix(dragonfly: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = dragonfly.scan(&format!("{prefix}*"), Some(500));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        for key in page {
            keys.push(String::from_utf8(key)?);
        }
    }
    for key in keys {
        dragonfly.del(&[&key]).await?;
    }
    Ok(())
}

/// One test's stores and clock.
#[derive(Clone)]
pub struct Env {
    pub stores: Stores,
    pub database: String,
    pub clock: ManualClock,
}

impl Env {
    pub fn clock(&self) -> Arc<dyn Clock> {
        Arc::new(self.clock.clone())
    }

    pub fn random(&self) -> Arc<dyn dima_core::Random> {
        Arc::new(SeededRandom::new(7))
    }

    pub fn cache(&self) -> CommandCache {
        self.cache_with(CommandCacheConfig::default())
    }

    pub fn cache_with(&self, config: CommandCacheConfig) -> CommandCache {
        CommandCache::new(self.stores.clone(), self.clock(), Arc::new(SystemRandom), config)
    }

    pub fn key(&self, key: &str) -> String {
        self.stores.keys.key(key)
    }
}

/// Runs `test` with fresh stores at `now_ms`, then drops the database and the keys, whatever
/// the outcome.
pub async fn with_env<F, Fut>(now_ms: i64, test: F) -> Result<()>
where
    F: FnOnce(Env) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let suffix = random_suffix();
    let database = format!("dima_test_commands_{suffix}");
    let Some(mongo) = connect_mongo(&database).await? else {
        return Ok(());
    };
    let Some(dragonfly) = connect_dragonfly().await? else {
        return Ok(());
    };
    let prefix = format!("dcm{suffix}:");
    let env = Env {
        stores: Stores {
            mongo: mongo.clone(),
            dragonfly: dragonfly.clone(),
            keys: KeyPrefix::new(format!("{prefix}r:")),
        },
        database,
        clock: ManualClock::new(now_ms),
    };
    let outcome = AssertUnwindSafe(test(env)).catch_unwind().await;
    let dropped = mongo.database().drop().await;
    let cleaned = clean_prefix(&dragonfly, &prefix).await;
    match outcome {
        Ok(result) => {
            dropped.context("dropping the test database")?;
            cleaned.context("cleaning the test keys")?;
            result
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// The recorded reference.
pub fn reference() -> &'static Value {
    static REFERENCE: OnceLock<Value> = OnceLock::new();
    REFERENCE.get_or_init(|| {
        let text = include_str!("../runtime/reference.json");
        serde_json::from_str(text).expect("reference.json")
    })
}

/// Canonical extended JSON to BSON.
pub fn bson_of(value: &Value) -> Bson {
    Bson::try_from(value.clone()).expect("extended JSON")
}

pub fn documents_of(value: &Value) -> Vec<Document> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| match bson_of(item) {
            Bson::Document(document) => document,
            other => panic!("not a document: {other:?}"),
        })
        .collect()
}

/// Empties the three seeded collections and the runtime's keys, then inserts the recorded seed:
/// commands, rewards, admins.
pub async fn seed(env: &Env) -> Result<()> {
    for collection in ["commands", "redemptionrewards", "admins"] {
        env.stores.mongo.documents(collection).delete_many(doc! {}).await?;
    }
    clean_prefix(&env.stores.dragonfly, env.stores.keys.as_str()).await?;
    let seed = &reference()["seed"];
    for (collection, key) in [
        ("commands", "commands"),
        ("redemptionrewards", "rewards"),
        ("admins", "admins"),
    ] {
        let documents = documents_of(&seed[key]);
        env.stores
            .mongo
            .documents(collection)
            .insert_many(documents)
            .await?;
    }
    Ok(())
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && text.char_indices().all(|(index, c)| match index {
            8 | 13 | 18 | 23 => c == '-',
            14 => c == '4',
            19 => matches!(c, '8' | '9' | 'a' | 'b'),
            _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
        })
}

fn normalize_uuids(value: Value, seen: &mut BTreeMap<String, String>) -> Value {
    match value {
        Value::String(text) if is_uuid(&text) => {
            let next = format!("uuid-{}", seen.len() + 1);
            Value::String(seen.entry(text).or_insert(next).clone())
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_uuids(item, seen))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, normalize_uuids(item, seen)))
                .collect(),
        ),
        other => other,
    }
}

/// The documents of `collection` that differ from the seed, and the seed ids that are gone, as
/// `record.mts` writes them.
pub async fn changed_documents(env: &Env, collection: &str) -> Result<Value> {
    let key = match collection {
        "commands" => "commands",
        "redemptionrewards" => "rewards",
        _ => "admins",
    };
    let seed: BTreeMap<String, Value> = reference()["seed"][key]
        .as_array()
        .expect("seed")
        .iter()
        .map(|doc| (doc["_id"]["$oid"].as_str().unwrap().to_owned(), doc.clone()))
        .collect();
    let stored: Vec<Document> = env
        .stores
        .mongo
        .documents(collection)
        .find(doc! {})
        .sort(doc! { "_id": 1 })
        .await?
        .try_collect()
        .await?;
    let mut uuids = BTreeMap::new();
    let mut changed = Vec::new();
    let mut present = Vec::new();
    for document in stored {
        let json = normalize_uuids(Bson::Document(document).into_canonical_extjson(), &mut uuids);
        let id = json["_id"]["$oid"].as_str().unwrap_or_default().to_owned();
        if seed.get(&id) != Some(&json) {
            changed.push(json);
        }
        present.push(id);
    }
    let deleted: Vec<Value> = seed
        .keys()
        .filter(|id| !present.contains(id))
        .map(|id| Value::String(id.clone()))
        .collect();
    Ok(serde_json::json!({ "changed": changed, "deleted": deleted }))
}

pub fn oid(text: &str) -> ObjectId {
    ObjectId::parse_str(text).expect("object id")
}

// -------------------------------------------------------------------------------------------
// Twitch.
// -------------------------------------------------------------------------------------------

pub fn cipher() -> CredentialCipher {
    CredentialCipher::new(TEST_SECRET_KEY).expect("test key")
}

fn envelope(text: &str) -> Bson {
    let stored = cipher().encrypt(text, &SystemRandom).expect("encrypt");
    Bson::Document(doc! { "iv": stored.iv, "content": stored.content })
}

/// A streamer as sign-up stores it, its token valid for a day after `now_ms`.
pub fn user_document(id: &str, now_ms: i64) -> Document {
    doc! {
        "_id": ObjectId::new(),
        "name": "streamer",
        "email": "streamer@example.invalid",
        "accounts": [{
            "_id": ObjectId::new(),
            "type": "twitch",
            "id": id,
            "name": "streamer",
            "email": "streamer@example.invalid",
            "refresh_token": envelope("refresh-token"),
            "access_token": envelope("streamer-access"),
            "access_token_expires_at": now_ms / 1000 + 86_400,
            "actived": true,
            "chat_enabled": true,
            "has_permissions": true,
            "up_to_date_permissions": true,
        }],
        "plan_tier": "free",
        "plan_tier_until": Bson::Null,
        "polar_sh_customer_id": Bson::Null,
        "token_balance": 0,
        "created_at": bson::DateTime::from_millis(now_ms - 86_400_000),
        "updated_at": bson::DateTime::from_millis(now_ms - 86_400_000),
        "__v": 0,
    }
}

/// Scripted Helix answers, in order; every request is recorded. A request with no answer left
/// gets a 599 and is counted as unexpected.
#[derive(Clone, Default)]
pub struct Script(pub Arc<Mutex<VecDeque<MockResponse>>>);

impl Script {
    pub fn push(&self, response: MockResponse) {
        self.0.lock().expect("script").push_back(response);
    }

    pub fn remaining(&self) -> usize {
        self.0.lock().expect("script").len()
    }
}

pub async fn twitch_mock(script: Script) -> Result<MockServer> {
    let server = MockServer::start().await?;
    server.fallback(move |request: &RecordedRequest| {
        if request.path() == "/oauth2/token" {
            return MockResponse::json(500, r#"{"message":"no token requests expected"}"#);
        }
        script
            .0
            .lock()
            .expect("script")
            .pop_front()
            .unwrap_or_else(|| MockResponse::json(599, r#"{"message":"unexpected request"}"#))
    });
    Ok(server)
}

/// A Twitch handle on the test stores and the mock (its keys under a prefix of their own).
pub fn twitch(env: &Env, server: &MockServer) -> Result<(Twitch, Shutdown)> {
    let mut config = TwitchConfig::new(CLIENT_ID, SecretString::from("test-client-secret"));
    let base = env.stores.keys.as_str().trim_end_matches("r:");
    config.keys = KeySpace::prefixed(format!("{base}tw:"));
    config.timings = Timings {
        store_deadline: Duration::from_secs(30),
        ..Timings::reference()
    };
    let helix: Provider = server.provider(dima_twitch::helix_provider(CLIENT_ID))?;
    let oauth: Provider = server.provider(dima_twitch::oauth_provider())?;
    let shutdown = Shutdown::new();
    let clock = env.clock();
    let http = HttpClient::builder()
        .shutdown(shutdown.clone())
        .clock(Arc::clone(&clock))
        .build()?;
    let exchange_http =
        dima_twitch::exchange_client(HttpClient::builder().clock(Arc::clone(&clock)))?;
    let twitch = Twitch::new(
        config,
        TwitchDeps {
            http,
            exchange_http,
            helix,
            oauth,
            mongo: env.stores.mongo.clone(),
            dragonfly: env.stores.dragonfly.clone(),
            cipher: cipher(),
            clock,
            random: Arc::new(SystemRandom),
            events: Arc::new(RecordingEvents::default()),
            shutdown: shutdown.clone(),
        },
    );
    Ok((twitch, shutdown))
}
