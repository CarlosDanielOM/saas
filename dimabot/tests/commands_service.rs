#![cfg(feature = "commands-service")]
//! Concrete verification for `classes/command.class.rs` (exported as
//! `utils::commands`).
//!
//! Every case in `commands_service_reference.json` was produced by the actual
//! TypeScript class plus the actual (archived, byte-exact) cooldown helper, with
//! only its storage, directory, cache and logger boundaries doubled. Native
//! replay uses the real schema repository, a task-private MongoDB, a real
//! Dragonfly connection and the real native `TwitchStreamers` directory/cache.
//! Storage doubles never replace those concrete dependencies here.

use std::{
    collections::BTreeSet,
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex},
};

use dima_rust::{
    schemas::commands,
    utils::{
        bson_js_json::bson_js_json_string,
        command_cooldown::{
            CooldownStore, ZERO_SLOT_LEASE_SECONDS, command_write_key, write_command_with_cooldown,
        },
        commands::{
            CACHE_TTL_SECONDS, CommandCreateResponse, CommandDeleteResponse, CommandExistsResponse,
            CommandGetResponse, CommandUpdateResponse, Commands, CommandsError,
        },
        logger::{
            ConsoleRecord, ConsoleSink, Logger, LoggerConfig, MetadataCollector, SinkFuture,
            SinkHandles, SystemClock, UuidSource,
        },
        lossless_json::JsonValue,
        plan_cache_fence::account_cache_key,
        twitch_streamers::{
            DirectoryConfig, DirectoryError, DirectoryFuture, MongoStreamerStore,
            RedisStreamerCache, StreamerCredentials, TwitchStreamers,
        },
        twitch_tokens::{CachedAccount, SystemTokenClock},
    },
};
use futures_util::{FutureExt, TryStreamExt};
use mongodb::{
    Client, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
};
use redis::aio::ConnectionManager;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const REFERENCE_SHA256: &str = "56e47403518407842412ffe53a698f6994b798c4c92b3b0f98ca2d9a9dba1d59";
const OWNER: &str = "dimabot-migration";

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Default)]
struct ConsoleCapture(Mutex<Vec<Value>>);

impl ConsoleCapture {
    fn drain(&self) -> Vec<Value> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl ConsoleSink for ConsoleCapture {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            let entry: Value = serde_json::from_str(&record.json).unwrap();
            self.0.lock().unwrap().push(entry["data"].clone());
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// Task-private fixture wiring.
// ---------------------------------------------------------------------------

struct Fixture {
    client: Client,
    database: Database,
    database_name: String,
    redis: ConnectionManager,
    namespace: String,
    token: String,
}

struct FixtureCredentials {
    redis: ConnectionManager,
    namespace: String,
}

impl StreamerCredentials for FixtureCredentials {
    fn snapshot<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, CachedAccount> {
        Box::pin(async move {
            let key = format!("{}{}", self.namespace, account_cache_key(id));
            let mut connection = self.redis.clone();
            redis::cmd("HSET")
                .arg(&key)
                .arg("access_token")
                .arg("fixture-access")
                .arg("refresh_token")
                .arg("fixture-refresh")
                .arg("expires_at")
                .arg("0")
                .arg("has_permissions")
                .arg("true")
                .arg("up_to_date_permissions")
                .arg("true")
                .query_async::<i64>(&mut connection)
                .await
                .map_err(|_| DirectoryError::CacheUnavailable {
                    write_outcome_unknown: false,
                })?;
            Ok(CachedAccount {
                id: id.to_owned(),
                access_token: "fixture-access".into(),
                refresh_token: "fixture-refresh".into(),
                expires_at: "0".into(),
                has_permissions: true,
                up_to_date_permissions: true,
            })
        })
    }

    fn token<'a>(
        &'a self,
        _id: &'a str,
    ) -> DirectoryFuture<'a, dima_rust::utils::twitch::AccessToken> {
        Box::pin(async { Err(DirectoryError::Missing) })
    }
}

fn directory(
    database: &Database,
    connection: &ConnectionManager,
    namespace: &str,
) -> TwitchStreamers {
    let clock = Arc::new(SystemTokenClock::default());
    TwitchStreamers::new(
        Arc::new(MongoStreamerStore::new(database)),
        Arc::new(RedisStreamerCache::with_namespace(
            connection.clone(),
            namespace,
        )),
        Arc::new(FixtureCredentials {
            redis: connection.clone(),
            namespace: namespace.to_owned(),
        }),
        clock,
        DirectoryConfig::default(),
    )
    .unwrap()
}

async fn fixture() -> Fixture {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok(OWNER)
    );
    let mongo_uri = std::env::var("KEYWORD_FIXTURE_MONGO_URI").expect("explicit fixture URI");
    assert_eq!(mongo_uri, "mongodb://keyword-mongo:27017");
    let redis_url = std::env::var("KEYWORD_FIXTURE_REDIS_URL").expect("explicit fixture URL");
    assert_eq!(redis_url, "redis://keyword-redis:6379/");
    let namespace = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("fixture namespace");
    let token = namespace
        .strip_prefix("keyword-fixture-")
        .and_then(|value| value.strip_suffix(':'))
        .expect("keyword-fixture-<hex>:");
    assert_eq!(token.len(), 12, "{namespace}");
    assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let database_name = format!("rust_commands_service_{token}");
    assert!(!database_name.contains("prod"));
    let client = Client::with_uri_str(&mongo_uri).await.unwrap();
    let database = client.database(&database_name);
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fixture database must be new"
    );
    let redis = redis::Client::open(redis_url).unwrap();
    let redis = ConnectionManager::new(redis).await.unwrap();
    let mut check_connection = redis.clone();
    let acl_user = format!("commands_fixture_{token}");
    let existing: redis::Value = redis::cmd("ACL")
        .arg("GETUSER")
        .arg(&acl_user)
        .query_async(&mut check_connection)
        .await
        .unwrap();
    assert!(
        matches!(existing, redis::Value::Nil),
        "fixture ACL user must not exist"
    );
    for pattern in [
        format!("cmd-svc-{token}-*"),
        format!("commands-svc-{token}-*"),
        format!("command-cooldown-write:cmd-svc-{token}-*"),
        format!("command-cooldown-write:commands-svc-{token}-*"),
        format!("{namespace}commands-service:*"),
    ] {
        assert!(
            scan(&redis, &pattern).await.is_empty(),
            "fixture Redis namespace must be empty"
        );
    }
    database.collection::<Document>("__fixture_owner").insert_one(doc! {"_id": "owner", "owner": OWNER, "namespace": &namespace, "database": &database_name}).await.unwrap();
    Fixture {
        client,
        database,
        database_name,
        redis,
        namespace: format!("{namespace}commands-service:"),
        token: token.to_owned(),
    }
}

async fn scan(connection: &ConnectionManager, pattern: &str) -> Vec<String> {
    let mut connection = connection.clone();
    let mut cursor = 0u64;
    let mut keys = BTreeSet::new();
    for _ in 0..4096 {
        let (next, page): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(128)
            .query_async(&mut connection)
            .await
            .unwrap();
        for key in page {
            keys.insert(key);
        }
        assert!(keys.len() <= 8192, "fixture cleanup must remain bounded");
        cursor = next;
        if cursor == 0 {
            return keys.into_iter().collect();
        }
    }
    panic!("fixture SCAN exceeded page bound")
}

async fn cleanup(fixture: &Fixture) {
    let owner = fixture
        .database
        .collection::<Document>("__fixture_owner")
        .find_one(doc! {"_id": "owner"})
        .await
        .unwrap()
        .expect("owner marker");
    assert_eq!(owner.get_str("owner").unwrap(), OWNER);
    assert_eq!(
        owner.get_str("namespace").unwrap(),
        format!("keyword-fixture-{}:", fixture.token)
    );
    assert_eq!(owner.get_str("database").unwrap(), fixture.database_name);
    let short = format!("cmd-svc-{}-", fixture.token);
    let long = format!("commands-svc-{}-", fixture.token);
    let patterns = [
        format!("{short}*"),
        format!("{long}*"),
        format!("command-cooldown-write:{short}*"),
        format!("command-cooldown-write:{long}*"),
        format!("{}*", fixture.namespace),
    ];
    for pattern in patterns {
        let keys = scan(&fixture.redis, &pattern).await;
        if !keys.is_empty() {
            let mut connection = fixture.redis.clone();
            let mut command = redis::cmd("DEL");
            for key in &keys {
                command.arg(key);
            }
            let _: i64 = command.query_async(&mut connection).await.unwrap();
        }
    }
    let mut connection = fixture.redis.clone();
    let _: i64 = redis::cmd("ACL")
        .arg("DELUSER")
        .arg(format!("commands_fixture_{}", fixture.token))
        .query_async(&mut connection)
        .await
        .unwrap();
    fixture
        .client
        .database(&fixture.database_name)
        .drop()
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// Source-reference normalization and comparison.
// ---------------------------------------------------------------------------

fn json_value(value: &JsonValue) -> Value {
    serde_json::from_str(&value.to_json_string()).expect("wire JSON")
}

fn scalar_equal(expected: &Value, native: &Value) -> bool {
    match (expected, native) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::String(left), Value::String(right)) => left == right,
        _ => false,
    }
}

/// Expected objects are source-subset projections; native Mongoose-equivalent
/// defaults may add fields that the source double did not model.
fn contains(expected: &Value, native: &Value) -> bool {
    match expected {
        Value::Object(fields) => fields.iter().all(|(key, value)| {
            native
                .get(key)
                .is_some_and(|candidate| contains(value, candidate))
        }),
        Value::Array(items) => native.as_array().is_some_and(|values| {
            values.len() == items.len()
                && items
                    .iter()
                    .zip(values)
                    .all(|(expected, native)| contains(expected, native))
        }),
        _ => scalar_equal(expected, native),
    }
}

fn create_json(response: &CommandCreateResponse) -> Value {
    let mut fields = Map::new();
    fields.insert("error".into(), json!(response.error));
    if let Some(created) = response.created {
        fields.insert("created".into(), json!(created));
    }
    if let Some(command) = &response.command {
        fields.insert("command".into(), json_value(command));
    }
    fields.insert("message".into(), json!(response.message));
    fields.insert("status".into(), json!(response.status));
    fields.insert("type".into(), json!(response.type_name));
    Value::Object(fields)
}

fn delete_json(response: &CommandDeleteResponse) -> Value {
    let mut fields = Map::new();
    fields.insert("error".into(), json!(response.error));
    if let Some(deleted) = response.deleted {
        fields.insert("deleted".into(), json!(deleted));
    }
    if let Some(command) = &response.command {
        fields.insert("command".into(), json_value(command));
    }
    fields.insert("message".into(), json!(response.message));
    fields.insert("status".into(), json!(response.status));
    fields.insert("type".into(), json!(response.type_name));
    Value::Object(fields)
}

fn get_json(response: &CommandGetResponse) -> Value {
    let mut fields = Map::new();
    fields.insert("error".into(), json!(response.error));
    if let Some(command) = &response.command {
        fields.insert("command".into(), json_value(command));
    }
    fields.insert("message".into(), json!(response.message));
    fields.insert("status".into(), json!(response.status));
    fields.insert("type".into(), json!(response.type_name));
    Value::Object(fields)
}

fn exists_json(response: &CommandExistsResponse) -> Value {
    let mut fields = Map::new();
    fields.insert("error".into(), json!(response.error));
    if let Some(command) = &response.command {
        fields.insert("command".into(), json_value(command));
    }
    fields.insert("message".into(), json!(response.message));
    fields.insert("status".into(), json!(response.status));
    fields.insert("type".into(), json!(response.type_name));
    Value::Object(fields)
}

fn update_json(response: &CommandUpdateResponse) -> Value {
    json!({
        "error": response.error,
        "message": response.message,
        "status": response.status,
        "type": response.type_name,
    })
}

fn doc_key(value: &Value) -> String {
    format!(
        "{}|{}|{}",
        value.get("cmd").and_then(Value::as_str).unwrap_or(""),
        value
            .get("activation")
            .and_then(Value::as_str)
            .unwrap_or(""),
        value.get("message").and_then(Value::as_str).unwrap_or("")
    )
}

fn input_document(value: &Value) -> Document {
    mongodb::bson::serialize_to_document(value).expect("fixture JSON document")
}

fn input_object(document: &Document) -> Value {
    let text = bson_js_json_string(&Bson::Document(document.clone())).unwrap();
    serde_json::from_str(&text).unwrap()
}

// ---------------------------------------------------------------------------
// Scenario replay.
// ---------------------------------------------------------------------------

async fn run_all(fixture: &Fixture) {
    let path = std::env::var("COMMANDS_SERVICE_ORACLE").expect("external source oracle");
    let expected =
        std::env::var("COMMANDS_SERVICE_ORACLE_SHA256").expect("independent oracle hash");
    assert_eq!(expected, REFERENCE_SHA256);
    let reference = std::fs::read_to_string(&path).expect("external source oracle");
    assert_eq!(sha256_hex(reference.as_bytes()), expected);
    for (path, hash) in [
        (
            "src/classes/command.class.ts",
            "60d7d36129e28605d18273013fdc1b277f363aadced7fafe68f9bd0d4226371c",
        ),
        (
            "src/utils/command_cooldown_write.ts",
            "efbcf9f1a83b32022b521a46c109acb13b0e4da68cb26970e3d2c15a21d39586",
        ),
    ] {
        let source =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(sha256_hex(&source), hash, "{path}");
    }
    let archive =
        std::fs::read(std::env::var("COMMANDS_SERVICE_ARCHIVED_COOLDOWN").unwrap()).unwrap();
    assert_eq!(
        sha256_hex(&archive),
        "a884a2dfb8072ba1b0419bb3fd90380257c834f8526dd7309ffa67f6489e3a2b"
    );
    let reference = reference.replace("cmd-svc-", &format!("cmd-svc-{}-", fixture.token));
    let cases: Value = serde_json::from_str(&reference).unwrap();
    assert_eq!(cases["version"].as_u64(), Some(1));
    let cases = cases["cases"].as_array().unwrap();

    let collector = Arc::new(MetadataCollector::new(4096).unwrap());
    let console = Arc::new(ConsoleCapture::default());
    let logger = Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            metadata: Some(collector.clone()),
            console: Some(console.clone()),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .unwrap();
    let directory = Arc::new(directory(
        &fixture.database,
        &fixture.redis,
        &fixture.namespace,
    ));
    let service = Commands::with_redis(
        commands::repository(&fixture.database),
        directory,
        fixture.redis.clone(),
        logger,
    );

    // One account per plan-bearing channel; absence stays absence.
    let users = fixture.database.collection::<Document>("users");
    for case in cases {
        let Some(plan) = case["plan"].as_str() else {
            continue;
        };
        let channel = case["channel"].as_str().unwrap();
        users
            .insert_one(doc! {
                "_id": ObjectId::new(),
                "accounts": [{
                    "type": "twitch",
                    "id": channel,
                    "name": format!("name-{channel}"),
                    "email": format!("{channel}@fixture.invalid"),
                    "actived": true,
                    "chat_enabled": true,
                }],
                "plan_tier": plan,
                "plan_tier_until": Bson::Null,
                "polar_sh_customer_id": "",
                "polar_plan_event_at": Bson::Null,
                "polar_plan_event_key": "",
            })
            .await
            .unwrap();
    }

    for case in cases {
        let channel = case["channel"].as_str().unwrap();
        if case.get("native").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        if let Some(documents) = case["inputDocs"].as_array() {
            for value in documents {
                let mut document = input_document(value);
                if let Some(Bson::String(id)) = document.get("_id").cloned() {
                    document.insert("_id", ObjectId::parse_str(&id).unwrap());
                }
                if !document.contains_key("_id") {
                    document.insert("_id", ObjectId::new());
                }
                if !document.contains_key("channelID") {
                    document.insert("channelID", channel);
                }
                fixture
                    .database
                    .collection::<Document>("commands")
                    .insert_one(&document)
                    .await
                    .unwrap();
            }
        }
        if let Some(entries) = case["cache"].as_array() {
            let mut connection = fixture.redis.clone();
            for entry in entries {
                let key = entry[0].as_str().unwrap();
                let value = entry[1].as_str().unwrap();
                redis::cmd("SET")
                    .arg(key)
                    .arg(value)
                    .arg("EX")
                    .arg(CACHE_TTL_SECONDS)
                    .query_async::<()>(&mut connection)
                    .await
                    .unwrap();
            }
        }
        collector.drain();
        console.drain();
        let mut responses = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            let args = step["args"].as_array().unwrap();
            let method = step["method"].as_str().unwrap();
            responses.push(match method {
                "createCommand" => create_json(
                    &service
                        .create_command(channel, input_document(&args[1]))
                        .await,
                ),
                "deleteCommand" => delete_json(
                    &service
                        .delete_command(channel, args[1].as_str().unwrap())
                        .await,
                ),
                "getCommandFromDB" => get_json(
                    &service
                        .get_command_from_db(channel, args[1].as_str().unwrap())
                        .await,
                ),
                "getReservedCommandFromDB" => get_json(
                    &service
                        .get_reserved_command_from_db(channel, args[1].as_str().unwrap())
                        .await,
                ),
                "checkIfCommandExists" => exists_json(
                    &service
                        .check_if_command_exists(channel, args[1].as_str().unwrap())
                        .await,
                ),
                "checkIfReservedCommandExists" => exists_json(
                    &service
                        .check_if_reserved_command_exists(channel, args[1].as_str().unwrap())
                        .await,
                ),
                "updateCommandInDB" => update_json(
                    &service
                        .update_command_in_db(
                            channel,
                            args[1].as_str().unwrap(),
                            input_document(&args[2]),
                        )
                        .await,
                ),
                "updateCountableCommandInDB" => update_json(
                    &service
                        .update_countable_command_in_db(
                            channel,
                            args[1].as_str().unwrap(),
                            args[2].as_f64().unwrap(),
                        )
                        .await,
                ),
                "updateCommandAvailability" => update_json(
                    &service
                        .update_command_availability(
                            channel,
                            args[1].as_str().unwrap(),
                            args[2].as_bool().unwrap(),
                        )
                        .await,
                ),
                other => panic!("unknown fixture method {other}"),
            });
        }

        let expected_responses = case["responses"].as_array().unwrap();
        assert_eq!(
            expected_responses.len(),
            responses.len(),
            "{} response count",
            case["id"]
        );
        for (expected, native) in expected_responses.iter().zip(&responses) {
            let source_keys: BTreeSet<_> = expected.as_object().unwrap().keys().collect();
            let native_keys: BTreeSet<_> = native.as_object().unwrap().keys().collect();
            assert_eq!(source_keys, native_keys, "{} response fields", case["id"]);
            assert!(
                contains(expected, native),
                "{} response\nsource: {expected}\nnative: {native}",
                case["id"]
            );
        }

        let expected_docs = case["docs"].as_array().unwrap();
        let native_docs = {
            let mut cursor = fixture
                .database
                .collection::<Document>("commands")
                .find(doc! {"channelID": channel})
                .await
                .unwrap();
            let mut documents = Vec::new();
            while let Some(document) = cursor.try_next().await.unwrap() {
                documents.push(input_object(&document));
            }
            documents.sort_by_key(doc_key);
            documents
        };
        assert_eq!(
            expected_docs.len(),
            native_docs.len(),
            "{} document count",
            case["id"]
        );
        for (expected, native) in expected_docs.iter().zip(&native_docs) {
            assert!(
                contains(expected, native),
                "{} document\nsource: {expected}\nnative: {native}",
                case["id"]
            );
        }

        let prefix = format!("{channel}:commands:");
        let expected_keys: Vec<String> = case["cacheKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        let native_keys = scan(&fixture.redis, &format!("{prefix}*")).await;
        assert_eq!(expected_keys, native_keys, "{} cache keys", case["id"]);
        let mut connection = fixture.redis.clone();
        for key in &native_keys {
            let ttl: i64 = redis::cmd("PTTL")
                .arg(key)
                .query_async(&mut connection)
                .await
                .unwrap();
            assert!(
                ttl > 0 && ttl <= i64::try_from(CACHE_TTL_SECONDS * 1000).unwrap(),
                "{} cache ttl for {key}: {ttl}",
                case["id"]
            );
        }

        let lease_key = command_write_key(channel);
        let mut connection = fixture.redis.clone();
        let lease: i64 = redis::cmd("EXISTS")
            .arg(&lease_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            case["lease"].as_str().unwrap(),
            if lease == 1 { "present" } else { "absent" },
            "{} lease",
            case["id"]
        );

        let expected_logs = case["logs"].as_array().unwrap();
        let logs = console.drain();
        assert_eq!(expected_logs.len(), logs.len(), "{} log count", case["id"]);
        for (expected, native) in expected_logs.iter().zip(&logs) {
            assert!(
                contains(expected, native),
                "{} log\nsource: {expected}\nnative: {native}",
                case["id"]
            );
        }
    }

    legacy_read_defaults(&service, fixture).await;
    source_wire_minimization(&service, fixture).await;
    blocks_projection_and_availability(&service, fixture).await;
    zero_slot_race(&service, &fixture.database, &fixture.token).await;
    cancelled_uncertain_write_has_no_replay(
        &service,
        &fixture.database,
        &fixture.redis,
        &fixture.token,
    )
    .await;
    concrete_cooldown_and_error_probes(&service, fixture, &collector, &console).await;
    redis_denied_write_probes(fixture, &collector).await;
}

async fn source_wire_minimization(service: &Commands, fixture: &Fixture) {
    let channel = format!("commands-svc-{}-wire", fixture.token);
    let result = service.create_command(&channel, doc! {"channelID": &channel, "cmd": "wire", "cooldown": 10, "variables": {}, "permissions": {}}).await;
    assert!(!result.error, "{}", result.message);
    let command = json_value(&result.command.unwrap());
    assert_eq!(command.get("variables"), Some(&json!({})));
    assert!(command.get("permissions").is_none());
    assert_eq!(command.get("blocks"), Some(&Value::Null));
    let key = format!("{channel}:commands:wire");
    let mut redis = fixture.redis.clone();
    let cached: String = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut redis)
        .await
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&cached).unwrap(), command);
    redis::cmd("DEL")
        .arg(&key)
        .query_async::<i64>(&mut redis)
        .await
        .unwrap();
    fixture
        .database
        .collection::<Document>("commands")
        .update_one(
            doc! {"channelID": &channel, "cmd": "wire"},
            doc! {"$set": {
                "permissions": {"one": {}, "two": {"v": 1}, "items": [{}]},
                "permissionExpression": {"nodes": {}}, "blocks": {"broken": {}}
            }},
        )
        .await
        .unwrap();
    let response = service.get_command_from_db(&channel, "wire").await;
    assert!(!response.error, "{}", response.message);
    let command = json_value(&response.command.unwrap());
    assert_eq!(command.get("variables"), Some(&json!({})));
    assert_eq!(
        command.get("permissions"),
        Some(&json!({"two": {"v": 1}, "items": [{}]}))
    );
    assert!(command.get("permissionExpression").is_none());
    assert!(command.get("blocks").is_none());
    let raw = fixture
        .database
        .collection::<Document>("commands")
        .find_one(doc! {"channelID": &channel, "cmd": "wire"})
        .await
        .unwrap()
        .unwrap();
    assert!(
        raw.get_document("permissionExpression")
            .unwrap()
            .contains_key("nodes")
    );
    assert!(raw.get_document("blocks").unwrap().contains_key("broken"));
}

async fn redis_denied_write_probes(fixture: &Fixture, collector: &Arc<MetadataCollector>) {
    let user = format!("commands_fixture_{}", fixture.token);
    let mut admin = fixture.redis.clone();
    redis::cmd("ACL")
        .arg("SETUSER")
        .arg(&user)
        .arg("on")
        .arg(">fixturepass")
        .arg("~*")
        .arg("+@all")
        .arg("-set")
        .arg("-del")
        .query_async::<()>(&mut admin)
        .await
        .unwrap();
    let client =
        redis::Client::open(format!("redis://{user}:fixturepass@keyword-redis:6379/")).unwrap();
    let restricted = ConnectionManager::new(client).await.unwrap();
    let logger = Logger::new(
        LoggerConfig::default(),
        SinkHandles {
            metadata: Some(collector.clone()),
            ..SinkHandles::default()
        },
        Arc::new(SystemClock),
        Arc::new(UuidSource),
    )
    .unwrap();
    let directory = Arc::new(directory(
        &fixture.database,
        &fixture.redis,
        &fixture.namespace,
    ));
    let service = Commands::with_redis(
        commands::repository(&fixture.database),
        directory,
        restricted,
        logger,
    );
    let channel = format!("commands-svc-{}-denied", fixture.token);
    fixture
        .database
        .collection::<Document>("commands")
        .insert_one(
            doc! {"_id": ObjectId::new(), "channelID": &channel, "cmd": "edit", "cooldown": 10},
        )
        .await
        .unwrap();
    let cache_key = format!("{channel}:commands:edit");
    redis::cmd("SET")
        .arg(&cache_key)
        .arg("stale")
        .arg("EX")
        .arg(60)
        .query_async::<()>(&mut admin)
        .await
        .unwrap();
    collector.drain();
    let updated = service
        .update_countable_command_in_db(&channel, "edit", 4.0)
        .await;
    assert!(
        !updated.error,
        "invalidation errors are logged and swallowed"
    );
    let raw = fixture
        .database
        .collection::<Document>("commands")
        .find_one(doc! {"channelID": &channel, "cmd": "edit"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raw.get_i32("count").unwrap(), 4);
    let cached: String = redis::cmd("GET")
        .arg(&cache_key)
        .query_async(&mut admin)
        .await
        .unwrap();
    assert_eq!(cached, "stale");
    assert!(collector.drain().iter().any(|record| record.fields.get("function") == Some(&json!("Commands.invalidateCache"))));

    collector.drain();
    let created = service
        .create_command(
            &channel,
            doc! {"channelID": &channel, "cmd": "saved-before-cache-error", "cooldown": 10},
        )
        .await;
    assert!(created.error);
    assert_eq!(created.type_name, "error_creating_command");
    assert_eq!(
        fixture
            .database
            .collection::<Document>("commands")
            .count_documents(doc! {"channelID": &channel, "cmd": "saved-before-cache-error"})
            .await
            .unwrap(),
        1
    );
    assert!(
        collector
            .drain()
            .iter()
            .any(|record| record.fields.get("function") == Some(&json!("Commands.createCommand")))
    );
}

async fn concrete_cooldown_and_error_probes(
    service: &Commands,
    fixture: &Fixture,
    collector: &MetadataCollector,
    console: &ConsoleCapture,
) {
    let channel = format!("commands-svc-{}-adapter", fixture.token);
    fixture.database.collection::<Document>("users").insert_one(doc! {
        "_id": ObjectId::new(), "accounts": [{"type": "twitch", "id": &channel,
            "name": "adapter", "email": "adapter@fixture.invalid", "actived": true,
            "chat_enabled": true}], "plan_tier": "premium", "plan_tier_until": Bson::Null,
        "polar_sh_customer_id": "", "polar_plan_event_at": Bson::Null, "polar_plan_event_key": ""
    }).await.unwrap();
    assert_eq!(
        service.owner_plan(&channel).await.unwrap().as_deref(),
        Some("premium")
    );
    assert!(
        commands::schema()
            .hydrate(
                &doc! {"cmd": "missing-channel", "cooldown": 2},
                DateTime::now()
            )
            .is_ok()
    );
    console.drain();
    let invalid = service
        .create_command(&channel, doc! {"cmd": "missing-channel", "cooldown": 2})
        .await;
    assert!(invalid.error);
    assert_eq!(
        invalid.type_name,
        "invalid_cooldown",
        "logs: {:?}",
        console.drain()
    );
    assert_eq!(
        invalid.message,
        "Command cooldown must be 0 or at least 3 seconds"
    );
    let invalid_other = service
        .create_command(
            &channel,
            doc! {"channelID": &channel, "cmd": "invalid-count", "cooldown": 2, "count": "bad"},
        )
        .await;
    assert_eq!(invalid_other.type_name, "invalid_cooldown");
    let invalid_saved = service
        .create_command(
            &channel,
            doc! {"channelID": &channel, "cmd": "invalid-count", "cooldown": 5, "count": "bad"},
        )
        .await;
    assert_eq!(invalid_saved.type_name, "error_creating_command");
    let invalid_cooldown_cast = service
        .create_command(
            &channel,
            doc! {"channelID": &channel, "cmd": "invalid-cooldown-cast", "cooldown": "bad"},
        )
        .await;
    assert_eq!(invalid_cooldown_cast.type_name, "error_creating_command");
    let id = ObjectId::new();
    fixture
        .database
        .collection::<Document>("commands")
        .insert_one(doc! {
            "_id": id, "channelID": &channel, "cmd": "zero", "cooldown": 0, "reserved": false
        })
        .await
        .unwrap();
    assert!(service.editable_zero_exists(&channel, None).await.unwrap());
    assert!(
        !service
            .editable_zero_exists(&channel, Some(&id.to_hex()))
            .await
            .unwrap()
    );
    assert!(
        service
            .editable_zero_exists(&channel, Some(&ObjectId::new().to_hex()))
            .await
            .unwrap()
    );

    let key = command_write_key(&channel);
    assert!(
        service
            .acquire_lease(&key, "owner-a", ZERO_SLOT_LEASE_SECONDS)
            .await
            .unwrap()
    );
    assert!(
        !service
            .acquire_lease(&key, "owner-b", ZERO_SLOT_LEASE_SECONDS)
            .await
            .unwrap()
    );
    let mut redis = fixture.redis.clone();
    let ttl: i64 = redis::cmd("TTL")
        .arg(&key)
        .query_async(&mut redis)
        .await
        .unwrap();
    assert!(ttl > 0 && ttl <= 60);
    redis::cmd("SET")
        .arg(&key)
        .arg("owner-b")
        .arg("EX")
        .arg(60)
        .query_async::<()>(&mut redis)
        .await
        .unwrap();
    service.release_lease(&key, "owner-a").await.unwrap();
    let held: String = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut redis)
        .await
        .unwrap();
    assert_eq!(held, "owner-b");
    service.release_lease(&key, "owner-b").await.unwrap();
    let held: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut redis)
        .await
        .unwrap();
    assert!(held.is_none());

    // Real Redis GET failure must be surfaced in the source response and log.
    let cache_key = format!("{channel}:commands:broken");
    redis::cmd("LPUSH")
        .arg(&cache_key)
        .arg("not-a-string")
        .query_async::<i64>(&mut redis)
        .await
        .unwrap();
    collector.drain();
    let response = service.get_command_from_db(&channel, "broken").await;
    assert!(response.error);
    assert_eq!(response.status, 500);
    assert_eq!(response.type_name, "error_retrieving_command");
    assert!(
        collector
            .drain()
            .iter()
            .any(|event| event.fields.get("function") == Some(&json!("Commands.getCommandFromDB")))
    );

    // A real duplicate _id fails the insert after the existence lookup.
    collector.drain();
    let duplicate = service
        .create_command(
            &channel,
            doc! {"_id": id, "channelID": &channel, "cmd": "duplicate-id", "cooldown": 10},
        )
        .await;
    assert!(duplicate.error);
    assert_eq!(duplicate.type_name, "error_creating_command");
    assert!(
        collector
            .drain()
            .iter()
            .any(|event| event.fields.get("function") == Some(&json!("Commands.createCommand")))
    );
    // Invalid numeric query casts fail the real repository update without a write.
    collector.drain();
    let invalid_update = service
        .update_command_in_db(&channel, "zero", doc! {"count": "not-a-number"})
        .await;
    assert!(invalid_update.error);
    assert_eq!(invalid_update.type_name, "error_updating_command");
    assert!(collector.drain().iter().any(|event| event.fields.get("function") == Some(&json!("Commands.updateCommandInDB"))));

    // A failed release supersedes an earlier write error, matching JS finally.
    let zero = json!(0);
    let release_key = command_write_key(&format!("commands-svc-{}-release", fixture.token));
    let release_channel = format!("commands-svc-{}-release", fixture.token);
    let mut replacement = fixture.redis.clone();
    let result =
        write_command_with_cooldown(service, &release_channel, Some(&zero), None, || async {
            redis::cmd("DEL")
                .arg(&release_key)
                .query_async::<i64>(&mut replacement)
                .await
                .unwrap();
            redis::cmd("LPUSH")
                .arg(&release_key)
                .arg("wrong-type")
                .query_async::<i64>(&mut replacement)
                .await
                .unwrap();
            Err::<(), _>(CommandsError::InvalidData("original write error"))
        })
        .await;
    assert!(matches!(
        result,
        Err(dima_rust::utils::command_cooldown::CooldownError::Storage(
            CommandsError::Redis(_)
        ))
    ));
}

/// Hydrated Mongoose reads fill later-added defaults for legacy documents
/// without persisting them.
async fn legacy_read_defaults(service: &Commands, fixture: &Fixture) {
    let channel = &format!("commands-svc-{}-legacy", fixture.token);
    fixture
        .database
        .collection::<Document>("commands")
        .insert_one(doc! {
            "_id": ObjectId::new(),
            "channelID": channel,
            "cmd": "legacy",
            "name": "legacy",
            "func": "legacy",
            "message": "legacy message",
            "cooldown": 5.0,
        })
        .await
        .unwrap();
    let response = service.get_command_from_db(channel, "legacy").await;
    assert!(!response.error, "{}", response.message);
    let command = response.command.expect("command");
    for (key, expected) in [
        ("activation", json!("command")),
        ("authoring", json!("text")),
        ("count", json!(0)),
        ("enabled", json!(true)),
        ("description", json!("No description provided.")),
        ("responses", json!([])),
        ("variables", json!({})),
        ("type", json!("command")),
        ("platform", json!("twitch")),
    ] {
        assert!(
            contains(&expected, &json_value(command.get(key).unwrap())),
            "legacy default {key}"
        );
    }
    assert!(
        command.get("blocks").is_none(),
        "hidden field must stay projected out"
    );
    // Read defaults are not written back.
    let stored = fixture
        .database
        .collection::<Document>("commands")
        .find_one(doc! {"channelID": channel, "cmd": "legacy"})
        .await
        .unwrap()
        .unwrap();
    assert!(!stored.contains_key("activation"));
    assert!(!stored.contains_key("authoring"));

    // Ordinary query updates do not run enum validators. Hydration must not
    // reject a stored value simply because a later schema declares an enum.
    let raw_id = ObjectId::new();
    fixture
        .database
        .collection::<Document>("commands")
        .insert_one(doc! {
            "_id": raw_id, "channelID": channel, "cmd": "old-mode",
            "activation": "legacy-mode", "keywordSettings": {"matchMode": "legacy"},
            "blocks": {"malformed": true}, "permissionExpression": {"bad": true}
        })
        .await
        .unwrap();
    let result = service.get_command_from_db(channel, "old-mode").await;
    assert!(!result.error, "{}", result.message);
    let command = result.command.unwrap();
    assert_eq!(
        json_value(command.get("activation").unwrap()),
        json!("legacy-mode")
    );
    assert!(command.get("blocks").is_none());
    assert!(command.get("permissionExpression").is_some());
    let unchanged = fixture
        .database
        .collection::<Document>("commands")
        .find_one(doc! {"_id": raw_id})
        .await
        .unwrap()
        .unwrap();
    assert!(!unchanged.contains_key("authoring"));
    assert_eq!(unchanged.get_str("activation").unwrap(), "legacy-mode");
}

async fn blocks_projection_and_availability(service: &Commands, fixture: &Fixture) {
    let channel = &format!("commands-svc-{}-blocks", fixture.token);
    let blocks = doc! {"version": 1, "nodes": []};
    fixture
        .database
        .collection::<Document>("commands")
        .insert_one(doc! {
            "_id": ObjectId::new(),
            "channelID": channel,
            "cmd": "blocks",
            "activation": "command",
            "authoring": "blocks",
            "func": "blocks",
            "message": "compiled",
            "blocks": blocks.clone(),
            "cooldown": 5.0,
            "reserved": false,
            "enabled": true,
            "responses": [],
            "variables": {},
            "count": 0,
        })
        .await
        .unwrap();
    let response = service.get_command_from_db(channel, "blocks").await;
    assert!(!response.error);
    assert!(response.command.unwrap().get("blocks").is_none());
    let repository = service.repository();
    let hidden = repository
        .find_one_with_hidden(doc! {"channelID": channel, "cmd": "blocks"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hidden.get_document("blocks").unwrap(), &blocks);

    let first = service
        .update_command_availability(channel, "blocks", false)
        .await;
    assert!(!first.error);
    let after_disable = repository
        .find_one_with_hidden(doc! {"channelID": channel, "cmd": "blocks"})
        .await
        .unwrap()
        .unwrap();
    let first_state = after_disable.get_document("availability").unwrap().clone();
    assert!(!first_state.get_bool("previousEnabled").unwrap());

    let second = service
        .update_command_availability(channel, "blocks", true)
        .await;
    assert!(!second.error);
    let after_enable = repository
        .find_one_with_hidden(doc! {"channelID": channel, "cmd": "blocks"})
        .await
        .unwrap()
        .unwrap();
    let second_state = after_enable.get_document("availability").unwrap();
    assert!(second_state.get_bool("previousEnabled").unwrap());
    assert_ne!(
        first_state.get_str("token").unwrap(),
        second_state.get_str("token").unwrap(),
        "ordinary enabled edits replace the schedule"
    );
}

async fn zero_slot_race(service: &Commands, database: &Database, token: &str) {
    let channel = &format!("commands-svc-{token}-race");
    let command = |cmd: &str| {
        doc! {
            "name": cmd,
            "cmd": cmd,
            "activation": "command",
            "func": cmd,
            "message": cmd,
            "channel": channel,
            "channelID": channel,
            "cooldown": 0.0,
        }
    };
    let (left, right) = tokio::join!(
        service.create_command(channel, command("left")),
        service.create_command(channel, command("right")),
    );
    let created = [!left.error, !right.error]
        .into_iter()
        .filter(|created| *created)
        .count();
    assert_eq!(created, 1, "exactly one zero-slot create may win");
    for response in [&left, &right] {
        if response.error {
            assert!(
                matches!(
                    response.message.as_str(),
                    "Only one editable command per channel can have a 0-second cooldown."
                        | "Another command is being saved. Please retry."
                ),
                "{}",
                response.message
            );
        }
    }
    let zero_count = database
        .collection::<Document>("commands")
        .count_documents(doc! {"channelID": channel, "cooldown": 0.0, "reserved": {"$ne": true}})
        .await
        .unwrap();
    assert_eq!(zero_count, 1);
}

async fn cancelled_uncertain_write_has_no_replay(
    service: &Commands,
    database: &Database,
    redis: &ConnectionManager,
    token: &str,
) {
    let channel = &format!("commands-svc-{token}-cancel");
    let now = DateTime::now();
    let prepared = service
        .repository()
        .schema()
        .prepare_insert(
            doc! {
                "name": "cancel",
                "cmd": "cancel",
                "activation": "command",
                "func": "cancel",
                "message": "cancel",
                "channel": channel,
                "channelID": channel,
                "cooldown": 0.0,
            },
            now,
        )
        .unwrap();
    let zero = json!(0);
    let (committed_tx, committed_rx) = tokio::sync::oneshot::channel();
    let mut future = Box::pin(write_command_with_cooldown(
        service,
        channel,
        Some(&zero),
        None,
        move || async move {
            service
                .repository()
                .insert(prepared, now)
                .await
                .map_err(CommandsError::Storage)?;
            committed_tx.send(()).unwrap();
            std::future::pending::<()>().await;
            Ok::<(), CommandsError>(())
        },
    ));
    tokio::select! {
        result = &mut future => panic!("cancelled write completed unexpectedly: {result:?}"),
        committed = committed_rx => committed.unwrap(),
    }
    drop(future);

    let docs = database
        .collection::<Document>("commands")
        .count_documents(doc! {"channelID": channel})
        .await
        .unwrap();
    assert_eq!(docs, 1, "the committed mutation must not be replayed");
    let lease_key = command_write_key(channel);
    let mut connection = redis.clone();
    let ttl: i64 = redis::cmd("PTTL")
        .arg(&lease_key)
        .query_async(&mut connection)
        .await
        .unwrap();
    assert!(
        ttl > 0 && ttl <= i64::try_from(ZERO_SLOT_LEASE_SECONDS * 1000).unwrap(),
        "lease expires naturally after cancellation: {ttl}"
    );
    let _: i64 = redis::cmd("DEL")
        .arg(&lease_key)
        .query_async(&mut connection)
        .await
        .unwrap();
    let replay = service
        .create_command(
            channel,
            doc! {
                "name": "cancel",
                "cmd": "cancel",
                "activation": "command",
                "func": "cancel",
                "message": "cancel",
                "channel": channel,
                "channelID": channel,
                "cooldown": 0.0,
            },
        )
        .await;
    assert!(replay.error);
    assert_eq!(replay.message, "Command already exists");
    assert_eq!(
        database
            .collection::<Document>("commands")
            .count_documents(doc! {"channelID": channel})
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[ignore = "requires the task-owned keyword-mongo and keyword-redis fixtures"]
async fn commands_service_concrete_fixture() {
    let fixture = fixture().await;
    let outcome = AssertUnwindSafe(run_all(&fixture)).catch_unwind().await;
    cleanup(&fixture).await;
    if let Err(payload) = outcome {
        std::panic::resume_unwind(payload);
    }
}
