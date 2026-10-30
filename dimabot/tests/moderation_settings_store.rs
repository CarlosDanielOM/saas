//! Source-differential and task-owned private-protocol tests.
#![cfg(feature = "moderation-settings-store")]
#[path = "support/moderation_leaf_source.rs"]
mod leaf;
#[path = "support/moderation_settings_store_protocol.rs"]
mod protocol;
use dima_rust::{
    moderation_settings_store::{
        CompiledBlacklistCache, ModerationSettingsStore, OperationControl, StoreError,
        moderation_settings_cache_key,
    },
    utils::{
        js_string::JsString,
        lossless_json::{JsonValue, parse_json},
    },
};
use mongodb::{
    Client, Database,
    bson::{DateTime, doc, oid::ObjectId},
    event::{EventHandler, command::CommandEvent},
    options::ClientOptions,
};
use protocol::{Action, Proxy};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{sync::watch, time::Instant};

fn oracle() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    let workspace = root.parent().unwrap();
    let dir = PathBuf::from(
        std::env::var_os("DIMA_SETTINGS_STORE_FIXTURE_DIR").expect("external fixture directory"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(!dir.starts_with(workspace));
    let expected = std::env::var("DIMA_SETTINGS_STORE_FIXTURE_SHA256")
        .expect("independently verified fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    );
    let file = dir.join("moderation-settings-store-reference.json");
    assert!(
        std::fs::symlink_metadata(&file)
            .unwrap()
            .file_type()
            .is_file()
    );
    let bytes = std::fs::read(file).unwrap();
    assert_eq!(leaf::digest::sha256_hex(&bytes), expected);
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    let meta = &fixture["metadata"];
    assert_eq!(
        meta["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (name, version) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
    ] {
        assert_eq!(meta["versions"][name], version);
    }
    assert_eq!(
        meta["driverSha"],
        "1880a069aa02d09798a3a082d77198aafa4a2d6a1c0315691f25820b58c025ea"
    );
    assert_eq!(
        meta["bsonSha"],
        "64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284"
    );
    let pins = [
        (
            "src/handlers/moderation.handler.ts",
            "2b57bbd962c25bd1f552a52c9d1d215bc052886ca0b1f0c88109383f988c8e52",
        ),
        (
            "src/utils/moderation/spam.ts",
            "eaa35698ebd7f7e2351e522ca4ece5a3d96b58a96acc41b162b6f22eb2adaaa8",
        ),
        (
            "src/schemas/channel_moderation_settings.schema.ts",
            "e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653",
        ),
        (
            "src/utils/moderation/rules/blacklist.rule.ts",
            "8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff",
        ),
        (
            "src/utils/moderation/normalize.ts",
            "07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab",
        ),
        (
            "src/utils/moderation/spam_categories.ts",
            "29dd0951ea0b89567c55b5dce4d2795a74c78e6064b32cbd26a3ecafaa435088",
        ),
    ];
    for (name, hash) in pins {
        let path = leaf::path(&root, name);
        assert_eq!(
            leaf::digest::sha256_hex(&std::fs::read(path).unwrap()),
            hash
        );
        assert_eq!(meta["pins"][name], hash);
    }
    for name in [
        "src/utils/moderation/normalize.ts",
        "src/utils/moderation/spam_categories.ts",
    ] {
        assert_eq!(
            meta["provenance"][name],
            format!("archives/dimabot-typescript/2026-10-28/{name}")
        );
    }
    assert_eq!(
        meta["pins"]["node_modules/typescript/lib/typescript.js"],
        "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675"
    );
    let native = [
        "src/handlers/moderation_settings_store.rs",
        "src/utils/bson_js_json.rs",
        "src/utils/lossless_json.rs",
        "src/utils/js_string.rs",
        "src/utils/moderation/blacklist.rs",
        "src/utils/moderation/spam.rs",
        "tests/support/moderation_settings_store_protocol.rs",
        "tests/moderation_settings_store.rs",
        "tests/fixtures/moderation_settings_store_reference.cjs",
        "tests/support/moderation_leaf_source.rs",
        "tests/support/sha256.rs",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
    ];
    assert_eq!(
        meta["nativeHashes"].as_object().unwrap().len(),
        native.len()
    );
    for name in native {
        assert_eq!(
            meta["nativeHashes"][name],
            leaf::digest::sha256_hex(&std::fs::read(root.join(name)).unwrap()),
            "native source {name}"
        );
    }
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").expect("fixture namespace");
    assert!(
        ns.starts_with("keyword-fixture-")
            && ns.ends_with(':')
            && (24..=50).contains(&ns.len())
            && ns
                .trim_end_matches(':')
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let channel = fixture["channel"].as_str().unwrap();
    assert!(
        channel
            .strip_prefix(&ns)
            .is_some_and(|s| s.starts_with("settings-") && !s.is_empty())
    );
    let cases = fixture["cases"].as_array().unwrap();
    let names: Vec<_> = cases.iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "missing",
            "sentinel",
            "empty",
            "malformed",
            "hit",
            "null",
            "zero",
            "db",
            "db-bson",
            "malformed-db",
            "nx-winner",
            "nx-malformed",
            "nx-missing",
            "nx-sentinel",
            "get-error",
            "mongo-error",
            "set-error",
            "db-set-error",
            "prime",
            "prime-error",
            "invalidate",
            "invalidate-error"
        ]
    );
    fixture
}
fn settings(s: &str) -> Arc<JsonValue> {
    Arc::new(parse_json(s).unwrap())
}
fn control(abort: &mut watch::Receiver<bool>) -> OperationControl<'_> {
    OperationControl {
        deadline: Instant::now() + Duration::from_secs(5),
        abort,
    }
}
fn wire(value: &JsonValue) -> Value {
    serde_json::from_str(&value.to_json_string()).unwrap()
}
fn source(p: Option<Arc<dima_rust::utils::moderation::blacklist::BlacklistPattern>>) -> Value {
    p.map_or(Value::Null, |p| {
        serde_json::from_str(&JsonValue::String(p.source().clone()).to_json_string()).unwrap()
    })
}
#[test]
fn compiled_cache_core_without_fixture() {
    let cache = CompiledBlacklistCache::default();
    let v = settings("{\"settingsVersion\":1}");
    let id = JsString::from("rule");
    let first = cache.pattern("c", &v, &id, Some(&["one".into()])).unwrap();
    let same = cache
        .clone()
        .pattern("c", &v, &id, Some(&["two".into()]))
        .unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    let changed = cache
        .pattern(
            "c",
            &settings("{\"settingsVersion\":\"1\"}"),
            &id,
            Some(&["two".into()]),
        )
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &changed));
    assert!(cache.pattern("c", &v, &"empty".into(), Some(&[])).is_none());
    assert!(
        cache
            .pattern("c", &v, &"empty".into(), Some(&["one".into()]))
            .is_none()
    );
    cache.remove_channel("c");
    assert!(
        cache
            .pattern("c", &v, &"empty".into(), Some(&["one".into()]))
            .is_some()
    );
}
#[test]
#[ignore = "requires independently hashed external actual-source fixture"]
fn compiled_cache_replays_actual_source_without_services() {
    let reference = oracle();
    let expected = reference["patterns"].as_array().unwrap();
    let cache = CompiledBlacklistCache::default();
    let id = JsString::from("𝄞");
    let versions = [
        "{}",
        "{\"settingsVersion\":1}",
        "{\"settingsVersion\":1}",
        "{\"settingsVersion\":\"1\"}",
        "{\"settingsVersion\":null}",
        "{\"settingsVersion\":0}",
        "{\"settingsVersion\":-0}",
        "{\"settingsVersion\":{\"x\":1}}",
        "{\"settingsVersion\":{\"x\":1}}",
    ];
    for (input, case) in versions.iter().zip(expected) {
        let v = settings(input);
        let first = cache.pattern("ordinary-channel", &v, &id, Some(&["one".into()]));
        let second = cache
            .clone()
            .pattern("ordinary-channel", &v, &id, Some(&["two".into()]));
        let same = match (&first, &second) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        let empty = cache.pattern("ordinary-channel", &v, &"null".into(), Some(&[]));
        let still = cache.pattern(
            "ordinary-channel",
            &v,
            &"null".into(),
            Some(&["two".into()]),
        );
        assert_eq!(
            json!({"first":source(first),"second":source(second),"same":same,"empty":source(empty),"still":source(still)}),
            *case
        );
    }
    let v = settings("{\"settingsVersion\":1}");
    let lone = JsString::from_units(vec![0xd800]);
    let first = cache
        .pattern("other", &v, &lone, Some(&["one".into()]))
        .unwrap();
    let second = cache
        .clone()
        .pattern("other", &v, &lone, Some(&["two".into()]))
        .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(
        json!({"first":source(Some(first.clone())),"second":source(Some(second.clone())),"same":Arc::ptr_eq(&first,&second)}),
        reference["lonePattern"]
    );
    cache.remove_channel("other");
    let third = cache
        .pattern("other", &v, &lone, Some(&["two".into()]))
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &third));
    cache.clear();
}
fn guard() -> String {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    assert!(
        ns.starts_with("keyword-fixture-")
            && ns.ends_with(':')
            && (24..=50).contains(&ns.len())
            && ns
                .trim_end_matches(':')
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let mem = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .unwrap()
        .trim()
        .parse::<u64>()
        .unwrap();
    assert!(mem > 0 && mem <= 4 * 1024 * 1024 * 1024);
    assert_eq!(
        std::fs::read_to_string("/sys/fs/cgroup/memory.swap.max")
            .unwrap()
            .trim(),
        "0"
    );
    let cpu = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").unwrap();
    let mut v = cpu.split_whitespace();
    let q = v.next().unwrap().parse::<u64>().unwrap();
    let p = v.next().unwrap().parse::<u64>().unwrap();
    assert!(q > 0 && p > 0 && q <= 6 * p);
    ns
}
async fn redis(url: &str) -> ConnectionManager {
    ConnectionManager::new_with_config(
        redis::Client::open(url).unwrap(),
        redis::aio::ConnectionManagerConfig::default().set_response_timeout(None),
    )
    .await
    .unwrap()
}
struct Cleanup {
    db: Database,
    redis: ConnectionManager,
    keys: Vec<String>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let db = self.db.clone();
        let mut redis = self.redis.clone();
        let keys = std::mem::take(&mut self.keys);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if !keys.is_empty() {
                    let _: redis::RedisResult<i64> =
                        redis::cmd("DEL").arg(keys).query_async(&mut redis).await;
                }
                let _ = db.drop().await;
            });
        }
    }
}
struct FailpointCleanup {
    admin: Database,
    armed: bool,
}
impl Drop for FailpointCleanup {
    fn drop(&mut self) {
        if self.armed {
            let admin = self.admin.clone();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _ = admin
                        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
                        .await;
                });
            }
        }
    }
}
fn normalized_log(requests: &[Vec<String>]) -> Value {
    Value::Array(
        requests
            .iter()
            .map(|args| match args[0].as_str() {
                "FIND" => json!(["findOne",{"channelID":args[1]}]),
                "GET" => json!(["get", args[1]]),
                "DEL" => json!(["del", args[1]]),
                "SET" => {
                    let mut opt = serde_json::Map::new();
                    let mut i = 3;
                    while i < args.len() {
                        if args[i].eq_ignore_ascii_case("EX") {
                            opt.insert("EX".into(), json!(args[i + 1].parse::<u64>().unwrap()));
                            i += 2;
                        } else if args[i].eq_ignore_ascii_case("NX") {
                            opt.insert("NX".into(), json!(true));
                            i += 1;
                        } else {
                            panic!("unexpected SET option");
                        }
                    }
                    json!(["set", args[1], args[2], opt])
                }
                _ => panic!("unexpected request"),
            })
            .collect(),
    )
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned keyword Mongo/Redis and capped private network only"]
async fn source_cases_replay_through_concrete_drivers() {
    let ns = guard();
    let expected = oracle();
    let channel = expected["channel"].as_str().unwrap().to_owned();
    assert!(channel.starts_with(&ns));
    let unique = ObjectId::new().to_hex();
    let key = moderation_settings_cache_key(&channel);
    let client = Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = client.database(&format!("{}_settings_{}", &ns[..20], unique).replace('-', "_"));
    let mut direct = redis("redis://keyword-redis:6379/").await;
    let _cleanup = Cleanup {
        db: db.clone(),
        redis: direct.clone(),
        keys: vec![key.clone()],
    };
    let collection = db.collection::<mongodb::bson::Document>("channel_moderation_settings");
    assert_eq!(
        moderation_settings_cache_key(&channel),
        expected["key"].as_str().unwrap()
    );
    for case in expected["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let _: i64 = redis::cmd("DEL")
            .arg(&key)
            .query_async(&mut direct)
            .await
            .unwrap();
        collection.delete_many(doc! {}).await.unwrap();
        if let Some(initial) = case["initial"]["cache"][&key].as_str() {
            let _: String = redis::cmd("SET")
                .arg(&key)
                .arg(initial)
                .query_async(&mut direct)
                .await
                .unwrap();
        }
        if case["initial"]["docs"].is_object() {
            let document = if name == "db-bson" {
                doc! {"_id":ObjectId::parse_str("00112233445566778899aabb").unwrap(),"channelID":&channel,"settingsVersion":7,"createdAt":DateTime::from_millis(0),"safe":42_i64,"large":9007199254740993_i64}
            } else {
                doc! {"_id":"fixed-source-id","channelID":&channel,"settingsVersion":7,"createdAt":DateTime::from_millis(0),"extra":42}
            };
            collection.insert_one(document).await.unwrap();
        }
        let action = match name {
            "nx-winner" | "nx-malformed" | "nx-sentinel" => Action::HoldBeforeNx,
            "nx-missing" => Action::HoldBothNx,
            "get-error" => Action::Error("GET"),
            "set-error" | "db-set-error" | "prime-error" => Action::Error("SET"),
            "invalidate-error" => Action::Error("DEL"),
            _ => Action::Pass,
        };
        let proxy = Proxy::start(action);
        let manager = redis(&proxy.url).await;
        let mut failpoint_guard = None;
        let app = format!("settings-store-{}", unique);
        let mut options = ClientOptions::parse("mongodb://keyword-mongo:27017")
            .await
            .unwrap();
        options.app_name = Some(app.clone());
        options.retry_reads = Some(false);
        options.retry_writes = Some(false);
        options.direct_connection = Some(true);
        let trace = proxy.trace();
        let trace_channel = channel.clone();
        options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
            if let CommandEvent::Started(event) = event
                && event.command_name == "find"
            {
                trace.find(&trace_channel);
            }
        }));
        let operation_client = Client::with_options(options).unwrap();
        if name == "mongo-error" {
            assert_eq!(
                std::env::var("DIMA_VARIATION_JOBS_FAILPOINT_OWNER").as_deref(),
                Ok(ns.as_str())
            );
            let admin = operation_client.database("admin");
            failpoint_guard = Some(FailpointCleanup {
                admin: admin.clone(),
                armed: true,
            });
            admin.run_command(doc!{"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["find"],"errorCode":12345,"appName":&app}}).await.unwrap();
        }
        let operation_db = operation_client.database(db.name());
        let store = ModerationSettingsStore::new(manager, operation_db);
        let version = settings("{\"settingsVersion\":1}");
        let id = JsString::from("rule");
        let before = if case["operation"] != "load" {
            store.blacklist_pattern(&channel, &version, &id, Some(&["one".into()]))
        } else {
            None
        };
        let (_, mut abort) = watch::channel(false);
        let (got, error) = if matches!(
            name,
            "nx-winner" | "nx-malformed" | "nx-sentinel" | "nx-missing"
        ) {
            let s = store.clone();
            let c = channel.clone();
            let task = tokio::spawn(async move {
                let (_, mut a) = watch::channel(false);
                s.load(&c, &mut control(&mut a)).await
            });
            proxy.wait_trigger();
            let winner = case["initial"]["race"].as_str().unwrap();
            let _: String = redis::cmd("SET")
                .arg(&key)
                .arg(winner)
                .query_async(&mut direct)
                .await
                .unwrap();
            proxy.release();
            if name == "nx-missing" {
                proxy.wait_applied();
                let _: i64 = redis::cmd("DEL")
                    .arg(&key)
                    .query_async(&mut direct)
                    .await
                    .unwrap();
                proxy.release_after();
            }
            match task.await.unwrap() {
                Ok(v) => (wire(&v.value), None),
                Err(e) => (Value::Null, Some(e)),
            }
        } else if case["operation"] == "load" {
            match store.load(&channel, &mut control(&mut abort)).await {
                Ok(v) => (wire(&v.value), None),
                Err(e) => (Value::Null, Some(e)),
            }
        } else if case["operation"] == "prime" {
            let v =
                parse_json(&json!({"channelID":channel,"settingsVersion":2}).to_string()).unwrap();
            (
                Value::Null,
                store
                    .prime(&channel, &v, &mut control(&mut abort))
                    .await
                    .err(),
            )
        } else {
            (
                Value::Null,
                store
                    .invalidate(&channel, &mut control(&mut abort))
                    .await
                    .err(),
            )
        };
        if let Some(mut guard) = failpoint_guard {
            guard
                .admin
                .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
                .await
                .unwrap();
            guard.armed = false;
        }
        match (case["error"].as_str(), error) {
            (None, None) => (),
            (Some("injected:findOne"), Some(StoreError::Mongo(_))) => (),
            (
                Some("injected:get" | "injected:set" | "injected:del"),
                Some(StoreError::Redis(_)),
            ) => (),
            (expected, actual) => {
                panic!("{name}: source error {expected:?}, native error {actual:?}")
            }
        }
        assert_eq!(got, case["result"], "{name} result");
        if let Some(before) = before {
            let after = store
                .blacklist_pattern(&channel, &version, &id, Some(&["two".into()]))
                .unwrap();
            assert_eq!(
                Arc::ptr_eq(&before, &after),
                case["retained"].as_bool().unwrap(),
                "{name} cache order"
            );
        }
        assert_eq!(
            normalized_log(&proxy.requests()),
            case["ioLog"],
            "{name} command order"
        );
        let actual: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut direct)
            .await
            .unwrap();
        assert_eq!(
            actual,
            case["cache"].as_str().map(str::to_owned),
            "{name} final Redis value"
        );
        if matches!(
            name,
            "missing" | "db" | "db-bson" | "malformed-db" | "prime"
        ) {
            let ttl: i64 = redis::cmd("TTL")
                .arg(&key)
                .query_async(&mut direct)
                .await
                .unwrap();
            assert!(
                (1..=300).contains(&ttl),
                "{name} preserves the 300-second TTL"
            );
        }
    }
    let _: i64 = redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut direct)
        .await
        .unwrap();
    db.drop().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned keyword Mongo/Redis and capped private network only"]
async fn uncertainty_deadline_abort_and_shared_socket() {
    let ns = guard();
    let unique = ObjectId::new().to_hex();
    let channel = format!("{ns}uncertain-{unique}");
    let key = moderation_settings_cache_key(&channel);
    let client = Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let db = client.database(&format!("{}_settings_{}", &ns[..20], unique).replace('-', "_"));
    let mut direct = redis("redis://keyword-redis:6379/").await;
    let _cleanup = Cleanup {
        db: db.clone(),
        redis: direct.clone(),
        keys: vec![key.clone()],
    };
    let payload = parse_json("{\"settingsVersion\":5}").unwrap();
    // Applied SET whose response disappears must never be retried by the adapter.
    {
        let proxy = Proxy::start(Action::DropAppliedSet);
        let store = ModerationSettingsStore::new(redis(&proxy.url).await, db.clone());
        let (_, mut abort) = watch::channel(false);
        let result = store
            .prime(&channel, &payload, &mut control(&mut abort))
            .await;
        assert!(
            matches!(result, Err(StoreError::Redis(_))),
            "unexpected lost-response result: {result:?}"
        );
        let actual: String = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut direct)
            .await
            .unwrap();
        assert_eq!(actual, payload.to_json_string());
        assert_eq!(
            proxy.requests().iter().filter(|x| x[0] == "SET").count(),
            1,
            "no replay of uncertain mutation"
        );
    }
    for cancelled in [false, true] {
        let proxy = Proxy::start(Action::HoldAfterSet);
        let store = ModerationSettingsStore::new(redis(&proxy.url).await, db.clone());
        let (send, mut abort) = watch::channel(false);
        let c = channel.clone();
        let value = payload.clone();
        let task = tokio::spawn(async move {
            let deadline = Instant::now()
                + if cancelled {
                    Duration::from_secs(5)
                } else {
                    Duration::from_secs(2)
                };
            let mut ctl = OperationControl {
                deadline,
                abort: &mut abort,
            };
            store.prime(&c, &value, &mut ctl).await
        });
        proxy.wait_applied();
        if cancelled {
            send.send(true).unwrap();
        }
        let result = task.await.unwrap();
        if cancelled {
            assert!(matches!(result, Err(StoreError::Cancelled)));
        } else {
            assert!(
                matches!(result, Err(StoreError::Deadline)),
                "unexpected held-response result: {result:?}"
            );
        }
        let actual: String = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut direct)
            .await
            .unwrap();
        assert_eq!(actual, payload.to_json_string());
        assert_eq!(proxy.requests().iter().filter(|x| x[0] == "SET").count(), 1);
        proxy.release();
    }
    {
        let proxy = Proxy::start(Action::Pass);
        let store = ModerationSettingsStore::new(redis(&proxy.url).await, db.clone());
        let mut tasks = vec![];
        for _ in 0..24 {
            let s = store.clone();
            let c = channel.clone();
            tasks.push(tokio::spawn(async move {
                let (_, mut a) = watch::channel(false);
                s.load(&c, &mut control(&mut a)).await.unwrap().value
            }));
        }
        for task in tasks {
            assert_eq!(wire(&task.await.unwrap()), json!({"settingsVersion":5}));
        }
        assert_eq!(
            proxy.requests().iter().filter(|x| x[0] == "GET").count(),
            24
        );
        assert_eq!(
            proxy.connections(),
            1,
            "cloned stores share one multiplexed socket"
        );
    }
    let (_, mut aborted) = watch::channel(true);
    let s = ModerationSettingsStore::new(direct.clone(), db.clone());
    assert!(matches!(
        s.load(&channel, &mut control(&mut aborted)).await,
        Err(StoreError::Cancelled)
    ));
    let (_, mut alive) = watch::channel(false);
    let mut ctl = OperationControl {
        deadline: Instant::now() - Duration::from_millis(1),
        abort: &mut alive,
    };
    assert!(matches!(
        s.load(&channel, &mut ctl).await,
        Err(StoreError::Deadline)
    ));
    let _: i64 = redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut direct)
        .await
        .unwrap();
    db.drop().await.unwrap();
}
