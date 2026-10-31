#![cfg(feature = "ast-bot-runtime")]
//! Keyword ingress contract. Service-backed tests require isolated resources.
use std::{collections::HashMap, sync::{Arc, Mutex as StdMutex}};
use dima_rust::utils::{
    ast_evaluator::{json_stringify, JsValue},
    ast_runtime::{AstBodyParser, AstRuntimeError, BoxFuture, ChatSender, SendResult, SpecialParserContext, SpecialParserResult, command::CommandStore},
    commands::CommandGetResponse,
    keywords::{compile_keyword_index, KeywordEntry, KeywordIndex, KeywordMatchMode},
    keyword_ingress::{handle_keywords, KeywordChatEvent, KeywordIngressCache},
};
use serde_json::{json, Value};

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The JSON text of a runtime value, exactly as `JSON.stringify` would write it.
fn js_json(value: &JsValue) -> Value {
    match json_stringify(value) {
        Ok(Some(text)) => serde_json::from_str(&text.to_utf8().unwrap_or_default()).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// One observed command handoff: the facts the TypeScript recorder captures
/// when `handleKeywords` calls `executeCustomCommand`.
#[derive(Clone, Debug, PartialEq)]
struct Handoff {
    channel: String,
    body: Option<String>,
    name: Option<String>,
    argument: String,
    authorization: Value,
}

struct Cache { bodies: HashMap<String, Value>, index_mode: KeywordMatchMode, requested: StdMutex<Vec<String>> }
impl KeywordIngressCache for Cache {
    fn index<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Arc<KeywordIndex>, AstRuntimeError>> {
        let mode = self.index_mode;
        Box::pin(async { Ok(Arc::new(compile_keyword_index(["missing", "disabled", "stale", "good"].into_iter().map(|id| KeywordEntry { id: id.into(), text: "hello".into(), match_mode: mode })))) })
    }
    fn body<'a>(&'a self, _: &'a str, id: &'a str) -> BoxFuture<'a, Result<Option<Value>, AstRuntimeError>> {
        let requested = &self.requested;
        let id = id.to_owned();
        Box::pin(async move {
            lock(requested).push(id.clone());
            Ok(self.bodies.get(&id).cloned())
        })
    }
}
impl Cache {
    /// The ids whose body was requested, in request order.
    fn requested(&self) -> Vec<String> {
        lock(&self.requested).clone()
    }
}
#[derive(Default)]
struct Store { lookups: usize, fresh: usize, allow: bool, keyword_disabled: bool, handoffs: Vec<Handoff> }
impl CommandStore for Store {
    fn lookup<'a>(&'a mut self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<CommandGetResponse, AstRuntimeError>> { self.lookups += 1; Box::pin(async { Err(AstRuntimeError::Host("unexpected lookup".into())) }) }
    fn acquire<'a>(&'a mut self, _: &'a str, _: u64) -> BoxFuture<'a, Result<bool, AstRuntimeError>> { Box::pin(async move { Ok(self.allow) }) }
    fn update_count<'a>(&'a mut self, _: &'a str, _: &'a str, _: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>> { Box::pin(async { Ok(()) }) }
    fn keyword_plan<'a>(&'a mut self, _: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>> { Box::pin(async { Ok(None) }) }
    fn keyword_state<'a>(&'a mut self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Option<(bool, f64)>, AstRuntimeError>> { self.fresh += 1; Box::pin(async { Ok(if self.keyword_disabled { None } else { Some((true, 7.0)) }) }) }
    fn update_keyword_count<'a>(&'a mut self, _: &'a str, _: &'a str, _: f64) -> BoxFuture<'a, Result<(), AstRuntimeError>> { Box::pin(async { Ok(()) }) }
    /// The handoff seam: fires before every gate, exactly where the
    /// TypeScript calls `executeCustomCommand`.
    fn handoff(&mut self, request: &dima_rust::utils::ast_evaluator::CommandReference, body: &dima_rust::utils::lossless_json::JsonValue) {
        let parsed: Value = serde_json::from_str(&body.to_json_string()).unwrap_or(Value::Null);
        self.handoffs.push(Handoff {
            channel: request.channel_id.clone(),
            body: parsed.get("_id").and_then(|value| value.as_str()).map(str::to_owned),
            name: parsed.get("cmd").and_then(|value| value.as_str()).map(str::to_owned),
            argument: request.argument.to_utf8().unwrap_or_default(),
            authorization: js_json(&request.authorization),
        });
    }
}
#[derive(Default)]
struct Parser { calls: Vec<(String, SpecialParserContext)> }
impl AstBodyParser for Parser {
    fn parse<'a>(&'a mut self, text: &'a str, context: SpecialParserContext) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>> {
        self.calls.push((text.into(), context)); Box::pin(async { Ok(SpecialParserResult { parsed_text: "sent".into(), ..Default::default() }) })
    }
}
#[derive(Default)]
struct Sender(Vec<String>);
impl ChatSender for Sender {
    fn send<'a>(&'a mut self, _: &'a str, text: &'a str) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> { self.0.push(text.into()); Box::pin(async { Ok(SendResult::ok("ok")) }) }
}
fn cache() -> Cache {
    Cache { bodies: bodies("success"), index_mode: KeywordMatchMode::Start, requested: StdMutex::new(Vec::new()) }
}

/// The keyword bodies for one scenario, mirroring the source fixture exactly.
fn bodies(variant: &str) -> HashMap<String, Value> {
    let mut bodies = HashMap::from([
        ("disabled".into(), json!({"enabled":false,"cmd":"hello"})),
        ("stale".into(), json!({"enabled":true,"cmd":"other"})),
        ("good".into(), json!({"_id":"good","enabled":true,"activation":"keyword","cmd":"hello","message":"by-id","count":99,"userLevel":1})),
    ]);
    let good = bodies.get_mut("good").expect("the good body");
    let object = good.as_object_mut().expect("the good body is an object");
    match variant {
        "non_boolean_enabled" => { object.insert("enabled".into(), json!("yes")); }
        "missing_cmd" => { object.remove("cmd"); }
        "missing_message" => { object.remove("message"); }
        "non_string_message" => { object.insert("message".into(), json!(42)); }
        "unknown_mode" | "unknown_mode_anywhere" => { object.insert("keywordSettings".into(), json!({"matchMode":"unknown"})); }
        _ => {}
    }
    bodies
}
#[tokio::test]
async fn filters_and_hands_off_full_message() {
    let cache = cache(); let mut store = Store { allow: true, ..Default::default() }; let mut parser = Parser::default(); let mut sender = Sender::default();
    let event = KeywordChatEvent { chatter_user_id: "user", text: "hello world", event_data: JsValue::object(vec![]) };
    let identity = JsValue::object(vec![("level".into(), JsValue::Number(1.0)), ("tags".into(), JsValue::array(vec![]))]);
    assert!(handle_keywords("channel", &event, "bot", &identity, None, &cache, &mut store, &mut parser, &mut sender, None).await.is_ok());
    assert_eq!(store.lookups, 0); assert_eq!(store.fresh, 1);
    assert_eq!(parser.calls.len(), 1); assert_eq!(parser.calls[0].0, "by-id");
    assert_eq!(parser.calls[0].1.argument.as_deref(), Some("hello world")); assert_eq!(parser.calls[0].1.count, Some(7.0));
    assert_eq!(sender.0, ["sent"]);
}
#[tokio::test]
async fn bot_and_cooldown_do_not_deliver() {
    let cache = cache(); let mut store = Store::default(); let mut parser = Parser::default(); let mut sender = Sender::default();
    let identity = JsValue::object(vec![("level".into(), JsValue::Number(1.0)), ("tags".into(), JsValue::array(vec![]))]);
    for chatter in ["bot", "user"] {
        let event = KeywordChatEvent { chatter_user_id: chatter, text: "hello world", event_data: JsValue::object(vec![]) };
        assert!(handle_keywords("channel", &event, "bot", &identity, None, &cache, &mut store, &mut parser, &mut sender, None).await.is_ok());
    }
    assert_eq!(store.fresh, 0); assert!(parser.calls.is_empty()); assert!(sender.0.is_empty());
}

/// Requires a coordinator-provisioned, task-owned loopback MongoDB and a
/// unique `AST_INGRESS_TEST_DB` beginning with `ast_ingress_test_`.
/// Run only under the isolated execution lease; cleanup is the fixture owner's.
#[tokio::test]
#[ignore = "requires isolated private MongoDB and execution lease"]
async fn private_mongo_legacy_tombstone_and_duplicate_retry() {
    use dima_rust::utils::{ast_runtime::{AstScope, AstVariableStore, variables::MongoAstVariableStore}, mongo::get_mongo_client};
    use mongodb::{bson::{doc, DateTime, oid::ObjectId}, IndexModel};
    let uri = std::env::var("MONGO_URI").expect("private MONGO_URI required");
    assert!(uri.starts_with("mongodb://127.0.0.1:") || uri.starts_with("mongodb://localhost:"), "loopback MongoDB required");
    let name = std::env::var("AST_INGRESS_TEST_DB").expect("task-owned database required");
    assert!(name.starts_with("ast_ingress_test_") && name.len() > "ast_ingress_test_".len());
    let client = get_mongo_client().await.expect("private MongoDB connection");
    let collection = client.database(&name).collection::<mongodb::bson::Document>("astvariables");
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0, "database must be empty");
    let old = ObjectId::new(); let new = ObjectId::new();
    collection.insert_many([
        doc! {"_id": old, "channelID":"c", "scopeType":"command", "scopeName":"old", "userId":"", "userLogin":"", "variables":{"x":"old"}, "updatedAt":DateTime::from_millis(2)},
        doc! {"_id": new, "channelID":"c", "scopeType":"command", "scopeName":"new", "userId":"", "userLogin":"", "variables":{"x":"new"}, "updatedAt":DateTime::from_millis(2)},
        doc! {"channelID":"c", "scopeType":"global", "scopeName":"global", "userId":"", "userLogin":"", "variables":{}},
    ]).await.expect("legacy fixtures");
    let store = MongoAstVariableStore::new().with_database(&name); let channel = AstScope::new("c");
    assert_eq!(store.load_channel_variable(&channel, "x").await.expect("read"), "new");
    store.delete_channel_variable(&channel, "x").await.expect("delete");
    let global = collection.find_one(doc! {"channelID":"c", "scopeType":"global", "scopeName":"global"}).await.expect("global query").expect("tombstone document");
    assert_eq!(global.get_document("variables").expect("variables").get_str("x"), Ok(""));
    assert_eq!(store.load_channel_variable(&channel, "x").await.expect("tombstone read"), "");
    collection.create_index(IndexModel::builder().keys(doc! {"channelID":1,"scopeType":1,"scopeName":1,"userLogin":1}).options(mongodb::options::IndexOptions::builder().unique(true).build()).build()).await.expect("unique login index");
    collection.insert_one(doc! {"channelID":"u", "scopeType":"global", "scopeName":"global", "userId":"old-id", "userLogin":"alice", "variables":{}}).await.expect("login fixture");
    let user = AstScope::new("u").with_user("new-id", "alice");
    store.save_user_variable(&user, "x", "retried", None).await.expect("save");
    let existing = collection.find_one(doc! {"channelID":"u", "userLogin":"alice"}).await.expect("query").expect("existing document");
    assert_eq!(existing.get_document("variables").expect("variables").get_str("x"), Ok("retried"));
    assert_eq!(collection.count_documents(doc! {"channelID":"u"}).await.expect("count"), 1);
}

#[tokio::test]
#[ignore = "requires isolated private MongoDB and Redis and execution lease"]
async fn private_keyword_counter_reaches_cache() {
    use dima_rust::utils::{keywords::native::{MongoRedisKeywordStorage, NativeKeywordCache}, mongo::get_mongo_client};
    use mongodb::bson::{doc, oid::ObjectId};
    let mongo_uri = std::env::var("MONGO_URI").expect("private MongoDB URI required");
    assert!(mongo_uri.starts_with("mongodb://127.0.0.1:") || mongo_uri.starts_with("mongodb://localhost:"));
    let redis_uri = std::env::var("AST_INGRESS_TEST_REDIS_URI").expect("private Redis URI required");
    assert!(redis_uri.starts_with("redis://127.0.0.1:") || redis_uri.starts_with("redis://localhost:"));
    let name = std::env::var("AST_INGRESS_TEST_DB").expect("task-owned database required");
    assert!(name.starts_with("ast_ingress_test_") && name.len() > "ast_ingress_test_".len());
    let database = get_mongo_client().await.expect("MongoDB").database(&name);
    let collection = database.collection::<mongodb::bson::Document>("commands");
    assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
    let id = ObjectId::new();
    collection.insert_one(doc! {"_id":id, "channelID":"c", "activation":"keyword", "enabled":true, "cmd":"hello", "count":1}).await.expect("keyword");
    let redis_client = redis::Client::open(redis_uri.as_str()).expect("Redis client");
    let connection = redis::aio::ConnectionManager::new(redis_client.clone()).await.expect("Redis connection");
    let cache = NativeKeywordCache::new(MongoRedisKeywordStorage::with_namespace(&database, connection, &format!("{name}:")), redis_client);
    let id = id.to_hex();
    assert!(cache.body("c", &id).await.expect("initial read").is_some());
    cache.save_count("c", &id, 42.0).await.expect("save count");
    let body = cache.body("c", &id).await.expect("refreshed read").expect("body");
    assert_eq!(body.get("count").and_then(|value| value.as_f64()), Some(42.0));
}

#[tokio::test]
async fn chat_authorization_enforces_chatter_permission() {
    let mut cache = cache();
    cache.bodies.get_mut("good").expect("fixture")["userLevel"] = json!(10);
    let mut store = Store { allow: true, ..Default::default() }; let mut parser = Parser::default(); let mut sender = Sender::default();
    let event = KeywordChatEvent { chatter_user_id: "user", text: "hello world", event_data: JsValue::object(vec![]) };
    let identity = JsValue::object(vec![("level".into(), JsValue::Number(1.0)), ("tags".into(), JsValue::array(vec![]))]);
    assert!(handle_keywords("channel", &event, "bot", &identity, None, &cache, &mut store, &mut parser, &mut sender, None).await.is_ok());
    assert!(parser.calls.is_empty()); assert!(sender.0.is_empty()); assert_eq!(store.fresh, 0);
}

/// Run one ingress scenario and serialize what it observed, in the exact shape
/// the source fixture writes: `{bodies, executions, delivered}`.
///
/// `bodies` are the keyword ids whose body was requested, `executions` are the
/// observed command handoffs and `delivered` are the messages that reached the
/// chat sender. The source fixture records the same three facts at the same
/// three points, so the two documents are directly comparable.
async fn observe(chatter: &str, variant: &str) -> Value {
    // The discriminating scenario uses an `anywhere` index and a message that
    // does not start with the keyword, so a port that maps an unknown match
    // mode to `start` would skip it and diverge from the source.
    let anywhere = variant == "unknown_mode_anywhere";
    let cache = Cache {
        bodies: bodies(variant),
        index_mode: if anywhere { KeywordMatchMode::Anywhere } else { KeywordMatchMode::Start },
        requested: StdMutex::new(Vec::new()),
    };
    let mut store = Store { allow: true, keyword_disabled: variant == "error", ..Default::default() };
    let mut parser = Parser::default();
    let mut sender = Sender::default();
    let text = if anywhere { "say hello there" } else { "hello world" };
    let event = KeywordChatEvent { chatter_user_id: chatter, text, event_data: JsValue::object(vec![]) };
    let identity = JsValue::object(vec![("level".into(), JsValue::Number(1.0)), ("tags".into(), JsValue::array(vec![]))]);
    handle_keywords("channel", &event, "bot", &identity, None, &cache, &mut store, &mut parser, &mut sender, None)
        .await
        .expect("the ingress completes");
    let executions: Vec<Value> = store.handoffs.iter().map(|handoff| json!({
        "channel": handoff.channel,
        "body": handoff.body,
        "name": handoff.name,
        "argument": handoff.argument,
        "authorization": handoff.authorization,
    })).collect();
    json!({
        "bodies": cache.requested(),
        "executions": executions,
        "delivered": sender.0,
    })
}

/// The native observation document, in the source fixture's shape.
async fn native_observations() -> Value {
    json!({
        "schema": 1,
        "cases": {
            "success": observe("user", "success").await,
            "error": observe("user", "error").await,
            "bot": observe("bot", "success").await,
            "non_boolean_enabled": observe("user", "non_boolean_enabled").await,
            "missing_cmd": observe("user", "missing_cmd").await,
            "missing_message": observe("user", "missing_message").await,
            "non_string_message": observe("user", "non_string_message").await,
            "unknown_mode": observe("user", "unknown_mode").await,
            "unknown_mode_anywhere": observe("user", "unknown_mode_anywhere").await,
        }
    })
}

/// Compare the **native** observations against the **actual source** oracle.
///
/// The fixture is generated by the integration runner from the real
/// TypeScript sources. This test serializes what the native ingress observed
/// into the same document shape and compares the two field by field, so a
/// divergence on either side fails here. It is deliberately not a hardcoded
/// expectation.
#[tokio::test]
#[ignore = "requires actual-source oracle generated under the execution lease"]
async fn native_observations_match_the_actual_source_oracle() {
    let path = std::env::var("AST_KEYWORD_ORACLE").expect("oracle path required");
    let text = std::fs::read_to_string(path).expect("oracle file");
    let oracle: Value = serde_json::from_str(&text).expect("oracle JSON");
    let native = native_observations().await;
    let cases = native["cases"].as_object().expect("the native cases");
    assert_eq!(
        cases.keys().collect::<Vec<_>>(),
        oracle["cases"].as_object().expect("the source cases").keys().collect::<Vec<_>>(),
        "the native and the source must observe the same scenarios"
    );
    for (name, observed) in cases {
        let source = &oracle["cases"][name];
        assert_eq!(observed["bodies"], source["bodies"], "{name}: the requested keyword bodies must match the source");
        assert_eq!(observed["executions"], source["executions"], "{name}: the observed command handoffs must match the source");
        assert_eq!(observed["delivered"], source["delivered"], "{name}: the delivered messages must match the source");
    }
    // The one deliberate divergence, pinned rather than hidden: the source
    // throws out of `handleKeywords` when a keyword body has no `cmd`, because
    // it calls `normalizeKeyword(undefined)`. The native skips that malformed
    // keyword and keeps going, so it never throws and it still requests the
    // same bodies. The schema declares `cmd` as a string, so this only differs
    // for a malformed document.
    assert!(
        oracle["cases"]["missing_cmd"].get("thrown").is_some(),
        "the source must throw for a keyword body without a cmd"
    );
    assert!(
        native["cases"]["missing_cmd"].get("thrown").is_none(),
        "the native ingress must not throw for a malformed keyword body"
    );
    assert_eq!(native["cases"]["missing_cmd"]["bodies"], oracle["cases"]["missing_cmd"]["bodies"]);
    assert_eq!(native["cases"]["missing_cmd"]["delivered"], json!([]));
}

/// The integration runner generates the oracle in a task-owned directory and
/// supplies this path. It is intentionally not regenerated by a Rust test.
/// This checks the **fixture's** own shape, not the native behaviour; the
/// native-vs-source comparison is the test above.
#[test]
#[ignore = "requires actual-source oracle generated under the execution lease"]
fn actual_source_oracle_contract() {
    let path = std::env::var("AST_KEYWORD_ORACLE").expect("oracle path required");
    let text = std::fs::read_to_string(path).expect("oracle file");
    let oracle: Value = serde_json::from_str(&text).expect("oracle JSON");
    assert_eq!(oracle["cases"]["success"]["bodies"], json!(["missing", "disabled", "stale", "good"]));
    assert_eq!(oracle["cases"]["success"]["executions"], json!([{"channel":"channel","body":"good","name":"hello","argument":"hello world","authorization":{"origin":"chat","identity":{"level":1,"tags":[]}}}]));
    assert_eq!(oracle["cases"]["success"]["delivered"], json!(["sent"]));
    assert_eq!(oracle["cases"]["error"]["delivered"], json!([]));
    assert_eq!(oracle["cases"]["bot"]["bodies"], json!([]));
}

/// Exercise Redis itself only against the runner's disposable loopback service.
#[tokio::test]
#[ignore = "requires task-owned loopback Redis and execution lease"]
async fn private_cooldown_lock_contention_and_expiry() {
    use dima_rust::utils::ast_runtime::command::{cooldown_key, execution_cooldown};
    use std::time::{Duration, Instant};
    let uri = std::env::var("AST_INGRESS_TEST_REDIS_URI").expect("private Redis URI required");
    assert!(uri.starts_with("redis://127.0.0.1:") || uri.starts_with("redis://localhost:"), "loopback Redis required");
    let channel = format!("ast_cooldown_test_{}", uuid::Uuid::new_v4().simple());
    let key = cooldown_key(&channel, "keyword:fixture");
    assert_eq!(key, format!("command:execution:cooldown:{channel}:keyword:fixture"));
    for (plan, floor) in [(Some("pro"), 1.0), (Some("premium"), 3.0), (Some("free"), 5.0), (None, 5.0)] {
        assert_eq!(execution_cooldown(0.0, true, plan), floor);
        assert_eq!(execution_cooldown(0.0, false, plan), 0.0);
        assert_eq!(execution_cooldown(9.0, true, plan), 9.0);
    }
    let client = redis::Client::open(uri.as_str()).expect("Redis client");
    let mut connection = redis::aio::ConnectionManager::new(client).await.expect("Redis connection");
    async fn acquire(connection: &mut redis::aio::ConnectionManager, key: &str) -> bool {
        let result: Option<String> = redis::cmd("SET").arg(key).arg("1").arg("NX").arg("PX").arg(200_u64)
            .query_async(connection).await.expect("SET NX PX");
        result.is_some()
    }
    // Cleanup runs before assertions, including when an observed result is wrong.
    let first = acquire(&mut connection, &key).await;
    let contended = acquire(&mut connection, &key).await;
    let deadline = Instant::now() + Duration::from_secs(2);
    let expired = loop {
        tokio::time::sleep(Duration::from_millis(25)).await;
        if acquire(&mut connection, &key).await { break true; }
        if Instant::now() >= deadline { break false; }
    };
    let _: i64 = redis::cmd("DEL").arg(&key).query_async(&mut connection).await.expect("delete owned key");
    assert!(first, "first acquisition must succeed");
    assert!(!contended, "second acquisition must be contended");
    assert!(expired, "key must expire before deadline");
}

#[tokio::test]
async fn malformed_keyword_body_native_observations() {
    let identity = JsValue::object(vec![("level".into(), JsValue::Number(1.0)), ("tags".into(), JsValue::array(vec![]))]);
    let event = KeywordChatEvent { chatter_user_id: "user", text: "hello world", event_data: JsValue::object(vec![]) };
    for (variant, expected_calls, expected_text) in [
        // A non-boolean `enabled` is truthy in JavaScript, so the source still
        // runs the command; the native must agree.
        ("non_boolean_enabled", 1, "by-id"),
        // A body without a `cmd` makes the source throw; the native skips it.
        ("missing_cmd", 0, ""),
        ("missing_message", 1, ""), ("non_string_message", 1, ""), ("unknown_mode", 1, "by-id"),
    ] {
        let mut cache = cache();
        let body = cache.bodies.get_mut("good").expect("fixture");
        match variant {
            "non_boolean_enabled" => body["enabled"] = json!("yes"),
            "missing_cmd" => { body.as_object_mut().expect("object").remove("cmd"); },
            "missing_message" => { body.as_object_mut().expect("object").remove("message"); },
            "non_string_message" => body["message"] = json!(42),
            "unknown_mode" => body["keywordSettings"] = json!({"matchMode":"unknown"}),
            _ => unreachable!(),
        }
        let mut store = Store { allow: true, ..Default::default() };
        let mut parser = Parser::default(); let mut sender = Sender::default();
        handle_keywords("channel", &event, "bot", &identity, None, &cache, &mut store, &mut parser, &mut sender, None).await.expect("native ingress");
        assert_eq!(parser.calls.len(), expected_calls, "{variant}");
        if expected_calls != 0 { assert_eq!(parser.calls[0].0, expected_text, "{variant}"); }
    }
}
