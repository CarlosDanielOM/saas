#![cfg(feature = "ai-usage-lock")]
//! Pure source/UTF-16 checks and explicitly ignored native protocol/Redis checks.
//! No fixture environment is optional: missing/empty/stale oracle files fail.
#[path = "ai_credit_projection_support/mod.rs"]
mod support;
use dima_rust::utils::{
    ai_usage_lock::{self as lock, AiUsageLock, AiUsageLockError},
    js_string::JsString,
    json_number::number_string,
};
use redis::{Value as RedisValue, aio::ConnectionManager};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{Command, Endpoint};

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn units(v: &Value) -> JsString {
    JsString::from_units(
        v["$utf16"]
            .as_array()
            .expect("UTF-16 tag")
            .iter()
            .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
fn text(v: &Value) -> String {
    units(v).as_str().expect("valid fixture text").to_owned()
}
fn field<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
    v["$object"]
        .as_array()
        .expect("encoded object")
        .iter()
        .find_map(|row| (units(&row[0]).as_str() == Some(name)).then_some(&row[1]))
}
fn array(v: &Value) -> &[Value] {
    v["$array"].as_array().expect("encoded array")
}
fn flag(v: &Value, name: &str) -> bool {
    field(v, name).and_then(Value::as_bool) == Some(true)
}
fn numeric(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v["$f64"].as_str().expect("f64 tag"), 16).unwrap())
}
fn undefined() -> Value {
    json!({"$undefined":true})
}
fn fixture() -> Value {
    let directory = std::env::var("DIMA_AI_LOCK_REFERENCE_DIR")
        .expect("required external actual-source oracle directory");
    let raw = std::fs::read_to_string(
        std::path::Path::new(&directory).join("ai_usage_lock_reference.json"),
    )
    .expect("required nonempty actual-source oracle file");
    assert!(!raw.trim().is_empty(), "empty source oracle");
    let root: Value = serde_json::from_str(&raw).expect("valid source oracle JSON");
    assert_eq!(root["metadata"]["total"], 291);
    assert_eq!(root["cases"].as_array().unwrap().len(), 291);
    root
}

#[test]
fn pinned_complete_export_and_key_oracle() {
    let root = fixture();
    let metadata = &root["metadata"];
    for (name, wanted) in [
        ("schema", json!(1)),
        ("node", json!("v24.22.1")),
        ("v8", json!("13.6.233.17-node.58")),
        ("typescript", json!("5.9.3")),
    ] {
        assert_eq!(metadata[name], wanted, "{name}");
    }
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (name, relative, pin) in [
        (
            "source",
            "src/utils/ai_usage_lock.ts",
            "c66763fc7ddc9ab1ab51f3d895c4ab20ef8b37ae62e59d799e960da972eda510",
        ),
        (
            "redisBootstrap",
            "src/utils/databases/dragonfly.database.ts",
            "0d08dd4cdb931633473227fb59f043251b7be59a09a034ef6f392e0f64aebe9c",
        ),
        (
            "package",
            "package.json",
            "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef",
        ),
        (
            "lock",
            "package-lock.json",
            "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7",
        ),
    ] {
        assert_eq!(metadata["hashes"][name], pin);
        assert_eq!(hash(std::fs::read(base.join(relative)).unwrap()), pin);
    }
    assert_eq!(
        metadata["hashes"]["oracle"],
        hash(std::fs::read(base.join("tests/fixtures/ai_usage_lock_reference.cjs")).unwrap())
    );
    let native = metadata["nativeHashes"]
        .as_object()
        .expect("native source/dependency provenance");
    assert_eq!(native.len(), 11);
    for (relative, digest) in native {
        assert_eq!(
            *digest,
            hash(std::fs::read(base.join(relative)).unwrap()),
            "native source drift: {relative}"
        );
    }
    for (name, env, pin) in [
        ("node", "DIMA_AI_LOCK_NODE_BINARY", None),
        (
            "typescript",
            "DIMA_AI_LOCK_TYPESCRIPT_IMPLEMENTATION",
            Some("3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675"),
        ),
        (
            "typescriptPackage",
            "DIMA_AI_LOCK_TYPESCRIPT_PACKAGE",
            Some("822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6"),
        ),
    ] {
        let digest = hash(std::fs::read(std::env::var(env).expect(env)).unwrap());
        assert_eq!(metadata["hashes"][name], digest);
        if let Some(pin) = pin {
            assert_eq!(digest, pin);
        }
    }
    let directory = std::env::var("DIMA_AI_LOCK_REFERENCE_DIR").unwrap();
    for (name, file) in [
        ("extractionSha256", "ai_usage_lock_extracted.ts"),
        ("typecheckSha256", "ai_usage_lock_typecheck.ts"),
        ("compiledSha256", "ai_usage_lock_compiled.cjs"),
    ] {
        let bytes = std::fs::read(std::path::Path::new(&directory).join(file)).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(metadata[name], hash(bytes));
    }
    let exports = metadata["exports"].as_array().unwrap();
    assert_eq!(exports.len(), 1);
    assert_eq!(exports[0]["name"], "withAiUsageLock");
    assert_eq!(
        exports[0]["signature"],
        "<T>(channelID: string, customerId: string, run: () => Promise<T>): Promise<T>"
    );
    assert_eq!(
        exports[0]["parameters"],
        json!([
        {"name":"channelID","type":"string"}, {"name":"customerId","type":"string"},
        {"name":"run","type":"() => Promise<T>"}])
    );
    assert_eq!(exports[0]["typeParameters"], json!(["T"]));
    assert_eq!(exports[0]["returnType"], "Promise<T>");
    let source = std::fs::read_to_string(base.join("src/utils/ai_usage_lock.ts")).unwrap();
    let start = exports[0]["startByte"].as_u64().unwrap() as usize;
    let end = exports[0]["endByte"].as_u64().unwrap() as usize;
    let extraction = format!("{}\n", &source[start..end]);
    assert_eq!(exports[0]["text"], extraction);
    assert_eq!(exports[0]["sha256"], hash(&extraction));
    assert_eq!(metadata["extractionSha256"], hash(&extraction));
    assert_eq!(metadata["imports"].as_array().unwrap().len(), 2);
    assert_eq!(
        metadata["dependencyProvenance"].as_array().unwrap().len(),
        5
    );
    assert_eq!(metadata["typeDiagnostics"], json!([]));
    let mut keys = 0;
    for case in root["cases"].as_array().unwrap() {
        if case["kind"] != "key" {
            continue;
        }
        let input = &case["input"];
        let channel = units(field(input, "channel").unwrap());
        let customer = units(field(input, "customer").unwrap());
        let call = case["expected"]["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["method"] == "set")
            .unwrap();
        assert_eq!(
            lock::account_key(&channel, &customer),
            text(&array(&call["args"])[0]),
            "{}",
            case["id"]
        );
        keys += 1;
    }
    assert_eq!(keys, 225);
}

#[test]
fn defaults_and_owner_fencing_are_the_source_policy() {
    assert_eq!(lock::ACQUIRE_WAIT, Duration::from_secs(10));
    assert_eq!(lock::CONTENTION_WAIT, Duration::from_millis(50));
    assert_eq!(lock::HEARTBEAT_WAIT, Duration::from_secs(30));
    assert_eq!(lock::LEASE_SECONDS, 120);
    assert_eq!(lock::BUSY_MESSAGE, "AI usage ledger busy; retry later");
    assert_eq!(
        lock::LEASE_LOST_MESSAGE,
        "AI usage ledger lease lost; retry required"
    );
    let root = fixture();
    let mut renewals = 0;
    let mut releases = 0;
    for case in root["cases"].as_array().unwrap() {
        for call in case["expected"]["calls"].as_array().unwrap() {
            match call["method"].as_str().unwrap() {
                "renew" => {
                    assert_eq!(text(&array(&call["args"])[0]), lock::RENEW_SCRIPT);
                    renewals += 1;
                }
                "release" => {
                    assert_eq!(text(&array(&call["args"])[0]), lock::RELEASE_SCRIPT);
                    releases += 1;
                }
                _ => {}
            }
        }
    }
    assert!(renewals >= 23 && releases >= 280);
    assert_ne!(
        lock::account_key(&"a|b".into(), &"c".into()),
        lock::account_key(&"a".into(), &"b|c".into())
    );
    assert_ne!(
        lock::account_key(&"é".into(), &"x".into()),
        lock::account_key(&"e\u{301}".into(), &"x".into())
    );
    assert_ne!(
        lock::account_key(&JsString::from_units(vec![0xd800]), &"x".into()),
        lock::account_key(&"�".into(), &"x".into())
    );
}

async fn bounded<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(8), future)
        .await
        .expect("bounded fixture operation")
}
#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    reply: Mutex<Option<Vec<u8>>>,
    changed: Condvar,
}
impl Gate {
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
    fn supply(&self, reply: Vec<u8>) {
        *self.reply.lock().unwrap() = Some(reply);
        self.release();
    }
    fn wait(&self) {
        let (_guard, result) = self
            .changed
            .wait_timeout_while(
                self.open.lock().unwrap(),
                Duration::from_secs(115),
                |open| !*open,
            )
            .unwrap();
        assert!(!result.timed_out(), "held fixture reply was not released");
    }
}
struct HeldEndpoint {
    endpoint: Endpoint,
    gate: Arc<Gate>,
}
impl Drop for HeldEndpoint {
    fn drop(&mut self) {
        self.gate.release();
    }
}
fn wire(value: &Value) -> Vec<u8> {
    if value.is_null() || value.get("$undefined").is_some() {
        return b"$-1\r\n".to_vec();
    }
    if let Some(value) = value.as_bool() {
        return if value {
            b"#t\r\n".to_vec()
        } else {
            b"#f\r\n".to_vec()
        };
    }
    if value.get("$f64").is_some() {
        let n = numeric(value);
        if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
            return format!(":{}\r\n", n as i64).into_bytes();
        }
        return support::bulk(Some(&number_string(n)));
    }
    if value.get("$utf16").is_some() {
        return support::bulk(Some(&text(value)));
    }
    if value.get("$array").is_some() {
        let mut out = format!("*{}\r\n", array(value).len()).into_bytes();
        for v in array(value) {
            out.extend(wire(v));
        }
        return out;
    }
    panic!("fixture reply outside ordinary Redis contract: {value}");
}
fn fixture_reply(
    spec: Option<&Value>,
    fallback: &[u8],
    gate: &Gate,
    held: &AtomicUsize,
) -> Vec<u8> {
    let Some(spec) = spec else {
        return fallback.to_vec();
    };
    // The source configuration can retain an own property set to undefined;
    // its `if (!spec)` reply adapter takes the same default as an absent spec.
    if spec.get("$undefined") == Some(&Value::Bool(true)) {
        return fallback.to_vec();
    }
    if let Some(error) = field(spec, "error") {
        return format!("-ERR {}\r\n", text(error)).into_bytes();
    }
    if flag(spec, "hold") {
        held.fetch_add(1, Ordering::SeqCst);
        gate.wait();
        return gate
            .reply
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| fallback.to_vec());
    }
    wire(field(spec, "value").unwrap())
}
fn expected_commands(case: &Value) -> Vec<Command> {
    case["expected"]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|call| {
            let args = array(&call["args"]);
            match call["method"].as_str().unwrap() {
                "set" => Some(vec![
                    "SET".into(),
                    text(&args[0]),
                    "$owner".into(),
                    "NX".into(),
                    "EX".into(),
                    "120".into(),
                ]),
                "renew" | "release" => {
                    let options = &args[1];
                    Some(vec![
                        "EVAL".into(),
                        text(&args[0]),
                        "1".into(),
                        text(&array(field(options, "keys").unwrap())[0]),
                        "$owner".into(),
                    ])
                }
                _ => None,
            }
        })
        .collect()
}
fn normalize(commands: &[Command]) -> Vec<Command> {
    let mut owner = None;
    commands
        .iter()
        .map(|command| {
            let mut command = command.clone();
            let index = if command[0] == "SET" { 2 } else { 4 };
            let actual = &command[index];
            let parsed = uuid::Uuid::parse_str(actual).expect("real UUID owner");
            assert_eq!(parsed.get_version_num(), 4);
            assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);
            if let Some(owner) = &owner {
                assert_eq!(actual, owner);
            } else {
                owner = Some(actual.clone());
            }
            command[index] = "$owner".into();
            command
        })
        .collect()
}
fn assert_outcome(
    case: &Value,
    outcome: Result<Arc<Value>, AiUsageLockError<Value>>,
    original: &Arc<Value>,
) {
    let expected = &case["expected"];
    if expected["status"] == "fulfilled" {
        let actual = outcome.unwrap_or_else(|error| panic!("{}: {error:?}", case["id"]));
        assert!(Arc::ptr_eq(&actual, original), "callback value identity");
        assert_eq!(*actual, expected["result"], "{}", case["id"]);
        return;
    }
    let expected_error = &expected["error"];
    match outcome.expect_err("source rejected") {
        AiUsageLockError::Callback(actual) => assert_eq!(actual, *expected_error, "{}", case["id"]),
        AiUsageLockError::Busy => {
            assert_eq!(expected_error["$error"]["message"], lock::BUSY_MESSAGE)
        }
        AiUsageLockError::LeaseLost => assert_eq!(
            expected_error["$error"]["message"],
            lock::LEASE_LOST_MESSAGE
        ),
        AiUsageLockError::Acquire(actual) | AiUsageLockError::Release(actual) => assert!(
            actual
                .to_string()
                .contains(expected_error["$error"]["message"].as_str().unwrap()),
            "{}: {actual}",
            case["id"]
        ),
    }
}
async fn replay(case: Value) {
    let input = case["input"].clone();
    assert!(
        !flag(&input, "acquireError"),
        "default bootstrap failure has its own child test"
    );
    let gate = Arc::new(Gate::default());
    let held = Arc::new(AtomicUsize::new(0));
    let (g, h, config) = (gate.clone(), held.clone(), input.clone());
    let sets = AtomicUsize::new(0);
    let renewals = AtomicUsize::new(0);
    let endpoint = Endpoint::new(move |command| match command[0].as_str() {
        "PING" => b"+PONG\r\n".to_vec(),
        "SET" => {
            let index = sets.fetch_add(1, Ordering::SeqCst);
            let spec = field(&config, "set").and_then(|v| array(v).get(index));
            fixture_reply(spec, b"+OK\r\n", &g, &h)
        }
        "EVAL" if command[1] == lock::RENEW_SCRIPT => {
            let index = renewals.fetch_add(1, Ordering::SeqCst);
            let spec = field(&config, "renew").and_then(|v| array(v).get(index));
            fixture_reply(spec, b":1\r\n", &g, &h)
        }
        "EVAL" if command[1] == lock::RELEASE_SCRIPT => {
            fixture_reply(field(&config, "release"), b":1\r\n", &g, &h)
        }
        other => panic!("unexpected {other}"),
    });
    let fixture = HeldEndpoint { endpoint, gate };
    let cache = fixture.endpoint.manager().await;
    let _keepalive = keepalive(cache.clone());
    let native = AiUsageLock::new(cache);
    let original = Arc::new(field(&input, "value").cloned().unwrap_or_else(undefined));
    let callback_value = original.clone();
    let callback_error = field(&input, "errorValue")
        .cloned()
        .unwrap_or_else(undefined);
    let callback_error = if flag(&input, "nonError") {
        callback_error
    } else {
        json!({"$error":{"name":"Error","message":"fixture callback failure"}})
    };
    let pending = flag(&input, "pending");
    let failure = flag(&input, "callbackError") || flag(&input, "syncError");
    let run_count = Arc::new(AtomicUsize::new(0));
    let count = run_count.clone();
    let (send, receive) = tokio::sync::oneshot::channel::<bool>();
    let channel = units(field(&input, "channel").unwrap());
    let customer = units(field(&input, "customer").unwrap());
    let start = std::time::Instant::now();
    let mut task = Task(tokio::spawn(async move {
        native
            .with(&channel, &customer, move || async move {
                count.fetch_add(1, Ordering::SeqCst);
                let fail = if pending {
                    receive.await.expect("callback completion supplied")
                } else {
                    failure
                };
                if fail {
                    Err(callback_error)
                } else {
                    Ok(callback_value)
                }
            })
            .await
    }));
    let mut send = Some(send);
    if pending {
        observed(&run_count, 1, Duration::from_secs(8)).await;
    } else if field(&input, "set")
        .is_some_and(|values| array(values).first().is_some_and(|spec| flag(spec, "hold")))
        || field(&input, "release").is_some_and(|spec| flag(spec, "hold"))
    {
        observed(&held, 1, Duration::from_secs(8)).await;
    }
    // Source time is virtual. Native timing is real; replies/commands add real
    // latency, so the busy-deadline attempt count is deliberately not fixed.
    if let Some(phases) = field(&input, "phases") {
        for phase in array(phases) {
            if let Some(ms) = field(phase, "advance") {
                let delay = numeric(ms) as u64;
                // Let acquisition finish and install the interval before the
                // source's virtual-time jump is translated to a real delay.
                tokio::time::sleep(Duration::from_millis(delay + 80)).await;
            }
            if flag(phase, "complete") || flag(phase, "reject") {
                send.take()
                    .expect("single callback completion")
                    .send(flag(phase, "reject"))
                    .unwrap();
            }
            if let Some(kind) = field(phase, "resolve") {
                assert_eq!(text(kind), "set");
                fixture.gate.supply(wire(field(phase, "value").unwrap()));
            }
            if field(phase, "rejectHeld").is_some() {
                fixture.gate.supply(
                    format!("-ERR {}\r\n", text(field(phase, "error").unwrap())).into_bytes(),
                );
            }
        }
    }
    fixture.gate.release();
    let outcome = tokio::time::timeout(Duration::from_secs(8), &mut task.0)
        .await
        .expect("native source case deadline")
        .unwrap();
    assert_outcome(&case, outcome, &original);
    let actual = normalize(&fixture.endpoint.calls.lock().unwrap());
    let expected = expected_commands(&case);
    if case["kind"] == "deadline" {
        assert!(start.elapsed() >= lock::ACQUIRE_WAIT);
        assert!(actual.len() > 1);
        assert!(actual.iter().all(|command| command == &expected[0]));
    } else {
        assert_eq!(actual, expected, "{}", case["id"]);
    }
    let expected_runs = case["expected"]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|call| call["method"] == "run")
        .count();
    assert_eq!(run_count.load(Ordering::SeqCst), expected_runs);
}
struct Task<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn keepalive(mut cache: ConnectionManager) -> Task<()> {
    // The reused RESP endpoint intentionally closes idle fixture sockets after
    // ten seconds. Keep the test transport open across real 30-second source
    // deadlines; PING is excluded from its command recorder. This task belongs
    // solely to the test guard and is aborted on normal exit or unwinding.
    Task(tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let reply = tokio::time::timeout(
                Duration::from_secs(2),
                redis::cmd("PING").query_async::<String>(&mut cache),
            )
            .await;
            // A deliberately held wire reply can also hold PING. Do not grow a
            // queue of keepalives, reconnect or panic outside the test owner.
            if !matches!(reply, Ok(Ok(_))) {
                break;
            }
        }
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit local RESP fixture sockets; actual-source oracle and up to 61 seconds of real lock timers"]
async fn native_source_protocol_matrix() {
    let root = fixture();
    let mut timed = tokio::task::JoinSet::new();
    let mut replayed = 0;
    let mut dedicated = Vec::new();
    for case in root["cases"].as_array().unwrap() {
        // Default acquisition requires a native bootstrap child; all other
        // cases use the concrete ConnectionManager against recorded replies.
        if case["id"] == "acquire-error" {
            dedicated.push(case["id"].as_str().unwrap());
            continue;
        }
        if field(&case["input"], "phases").is_some() {
            timed.spawn(replay(case.clone()));
        } else {
            replay(case.clone()).await;
        }
        replayed += 1;
    }
    assert_eq!(dedicated, ["acquire-error"]);
    assert_eq!(replayed, 290);
    while let Some(result) = timed.join_next().await {
        result.unwrap();
    }
}

// Real fixture guard: parent must provision a fresh Redis/Dragonfly, ownership
// token and marker. No production URLs, credentials or implicit environment.
// Cleanup checks the marker and compare-deletes only explicitly recorded keys
// whose current owner is one this test wrote/observed. It also runs on panic.
struct Owned {
    url: String,
    token: String,
    channel: JsString,
    customer: JsString,
    owners: Arc<Mutex<Vec<(String, String)>>>,
}
impl Owned {
    async fn new() -> (Self, ConnectionManager) {
        let (url, _, _) = support::fixture_url();
        let token =
            std::env::var("DIMA_AI_LOCK_FIXTURE_TOKEN").expect("explicit fixture ownership token");
        assert!(
            token.len() >= 24
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        );
        let cache = bounded(ConnectionManager::new(
            redis::Client::open(url.as_str()).unwrap(),
        ))
        .await
        .unwrap();
        let mut read = cache.clone();
        let marker: Option<String> = bounded(
            redis::cmd("GET")
                .arg("test:ai-usage-lock:owner")
                .query_async(&mut read),
        )
        .await
        .unwrap();
        assert_eq!(
            marker.as_deref(),
            Some(token.as_str()),
            "disposable Redis ownership marker"
        );
        let channel = format!("test:ai-usage-lock:{}", uuid::Uuid::new_v4()).into();
        let customer = format!("test:customer:{}", uuid::Uuid::new_v4()).into();
        (
            Self {
                url,
                token,
                channel,
                customer,
                owners: Arc::new(Mutex::new(Vec::new())),
            },
            cache,
        )
    }
    fn key(&self) -> String {
        lock::account_key(&self.channel, &self.customer)
    }
    fn remember(&self, key: &str, owner: &str) {
        self.owners.lock().unwrap().push((key.into(), owner.into()));
    }
    async fn owner(&self, cache: &mut ConnectionManager) -> Option<String> {
        bounded(redis::cmd("GET").arg(self.key()).query_async(cache))
            .await
            .unwrap()
    }
    async fn ttl(&self, cache: &mut ConnectionManager) -> i64 {
        bounded(redis::cmd("TTL").arg(self.key()).query_async(cache))
            .await
            .unwrap()
    }
    async fn occupy(&self, cache: &mut ConnectionManager, owner: &str, ttl: u64) {
        let reply: Option<String> = bounded(
            redis::cmd("SET")
                .arg(self.key())
                .arg(owner)
                .arg("NX")
                .arg("EX")
                .arg(ttl)
                .query_async(cache),
        )
        .await
        .unwrap();
        assert_eq!(reply.as_deref(), Some("OK"), "unique test key must be free");
        self.remember(&self.key(), owner);
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        let cleanup = || -> redis::RedisResult<()> {
            let mut cache = redis::Client::open(self.url.as_str())?
                .get_connection_with_timeout(Duration::from_secs(2))?;
            cache.set_read_timeout(Some(Duration::from_secs(2)))?;
            cache.set_write_timeout(Some(Duration::from_secs(2)))?;
            let marker: Option<String> = redis::cmd("GET")
                .arg("test:ai-usage-lock:owner")
                .query(&mut cache)?;
            if marker.as_deref() != Some(self.token.as_str()) {
                return Ok(());
            }
            let owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
            for (key, owner) in owners.iter() {
                let _: RedisValue = redis::cmd("EVAL")
                    .arg(lock::RELEASE_SCRIPT)
                    .arg(1)
                    .arg(key)
                    .arg(owner)
                    .query(&mut cache)?;
            }
            Ok(())
        };
        if let Err(error) = cleanup() {
            eprintln!("owned AI lock fixture cleanup failed: {error}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "fresh owned disposable Redis; races, genuine contention, owner safety"]
async fn real_redis_race_contention_and_owner_safety() {
    let (owned, mut cache) = Owned::new().await;
    let native = AiUsageLock::new(cache.clone());
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let (native, channel, customer, active, peak, owners, key) = (
            native.clone(),
            owned.channel.clone(),
            owned.customer.clone(),
            active.clone(),
            peak.clone(),
            owned.owners.clone(),
            owned.key(),
        );
        let mut read = cache.clone();
        tasks.spawn(async move {
            native
                .with(&channel, &customer, || async move {
                    let owner: String = bounded(redis::cmd("GET").arg(&key).query_async(&mut read))
                        .await
                        .unwrap();
                    owners.lock().unwrap().push((key, owner));
                    let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(n, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok::<_, &'static str>(())
                })
                .await
                .unwrap();
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
    assert_eq!(peak.load(Ordering::SeqCst), 1);
    assert_eq!(owned.owner(&mut cache).await, None);
    {
        let owners = owned.owners.lock().unwrap();
        let unique: std::collections::HashSet<_> =
            owners.iter().map(|(_, owner)| owner.clone()).collect();
        assert_eq!(unique.len(), 12, "one UUID per acquisition");
    }

    let ran = Arc::new(AtomicBool::new(false));
    let signal = ran.clone();
    let foreign = format!("fixture-{}", uuid::Uuid::new_v4());
    owned.occupy(&mut cache, &foreign, 2).await;
    let before = std::time::Instant::now();
    native
        .with(&owned.channel, &owned.customer, || async move {
            signal.store(true, Ordering::SeqCst);
            Ok::<_, &'static str>(())
        })
        .await
        .unwrap();
    assert!(ran.load(Ordering::SeqCst));
    assert!(
        before.elapsed() >= Duration::from_millis(1800),
        "genuine future lease wait"
    );
    assert_eq!(owned.owner(&mut cache).await, None);

    // A callback failure still releases; a successor owner cannot be deleted.
    let replacement = format!("fixture-{}", uuid::Uuid::new_v4());
    owned.remember(&owned.key(), &replacement);
    let mut change = cache.clone();
    let key = owned.key();
    let successor = replacement.clone();
    let result = native
        .with(&owned.channel, &owned.customer, || async move {
            let _: String = bounded(
                redis::cmd("SET")
                    .arg(key)
                    .arg(successor)
                    .arg("XX")
                    .arg("EX")
                    .arg(120)
                    .query_async(&mut change),
            )
            .await
            .unwrap();
            Err::<(), _>("callback failure")
        })
        .await;
    assert!(matches!(
        result,
        Err(AiUsageLockError::Callback("callback failure"))
    ));
    assert_eq!(
        owned.owner(&mut cache).await.as_deref(),
        Some(replacement.as_str())
    );
}

#[tokio::test]
#[ignore = "fresh owned disposable Redis; ten-second contention deadline"]
async fn real_redis_busy_deadline() {
    let (owned, mut cache) = Owned::new().await;
    let owner = format!("fixture-{}", uuid::Uuid::new_v4());
    owned.occupy(&mut cache, &owner, 120).await;
    let start = std::time::Instant::now();
    let ran = AtomicBool::new(false);
    let result = tokio::time::timeout(
        Duration::from_secs(13),
        AiUsageLock::new(cache.clone()).with(&owned.channel, &owned.customer, || async {
            ran.store(true, Ordering::SeqCst);
            Ok::<_, &'static str>(())
        }),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(AiUsageLockError::Busy)));
    assert!(
        !ran.load(Ordering::SeqCst),
        "contended callback must not run"
    );
    assert!(start.elapsed() >= Duration::from_secs(10));
    assert_eq!(
        owned.owner(&mut cache).await.as_deref(),
        Some(owner.as_str())
    );
    assert!((105..=120).contains(&owned.ttl(&mut cache).await));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "fresh owned disposable Redis; cancellation/panic retains TTL; no 120-second sleep"]
async fn real_redis_cancel_panic_and_finally() {
    let (owned, mut cache) = Owned::new().await;
    for panic_callback in [false, true] {
        let (entered, received) = tokio::sync::oneshot::channel();
        let (channel, customer, native) = (
            owned.channel.clone(),
            owned.customer.clone(),
            AiUsageLock::new(cache.clone()),
        );
        let mut task = Task(tokio::spawn(async move {
            native
                .with(&channel, &customer, || async move {
                    entered.send(()).unwrap();
                    if panic_callback {
                        panic!("intentional callback unwind");
                    }
                    std::future::pending::<()>().await;
                    Ok::<_, &'static str>(())
                })
                .await
        }));
        bounded(received).await.unwrap();
        let owner = owned.owner(&mut cache).await.unwrap();
        owned.remember(&owned.key(), &owner);
        if !panic_callback {
            task.0.abort();
        }
        let error = bounded(&mut task.0).await.unwrap_err();
        assert_eq!(error.is_panic(), panic_callback);
        assert_eq!(
            owned.owner(&mut cache).await.as_deref(),
            Some(owner.as_str())
        );
        assert!(
            (118..=120).contains(&owned.ttl(&mut cache).await),
            "cancellation stops renewal and retains finite lease"
        );
        let released: i64 = bounded(
            redis::cmd("EVAL")
                .arg(lock::RELEASE_SCRIPT)
                .arg(1)
                .arg(owned.key())
                .arg(&owner)
                .query_async(&mut cache),
        )
        .await
        .unwrap();
        assert_eq!(released, 1);
    }
    let result = AiUsageLock::new(cache.clone())
        .with(&owned.channel, &owned.customer, || async {
            Err::<(), _>("ordinary callback error")
        })
        .await;
    assert!(matches!(
        result,
        Err(AiUsageLockError::Callback("ordinary callback error"))
    ));
    assert_eq!(owned.owner(&mut cache).await, None);
    // Prove the test controller's cleanup also executes on its own unwind;
    // this is separate from the application's intentional retained-TTL policy.
    let key = owned.key();
    let test_owner = format!("fixture-{}", uuid::Uuid::new_v4());
    owned.occupy(&mut cache, &test_owner, 120).await;
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _cleanup = owned;
        panic!("intentional fixture controller unwind");
    }));
    assert!(panic.is_err());
    let remaining: Option<String> = bounded(redis::cmd("GET").arg(key).query_async(&mut cache))
        .await
        .unwrap();
    assert_eq!(remaining, None, "recorded test owner cleaned during unwind");
}

const HOLD_SET: usize = 1;
const HOLD_RENEW: usize = 2;
const HOLD_RELEASE: usize = 4;
const FAIL_RENEW: usize = 8;
const FAIL_RELEASE: usize = 16;
const EXPIRE_LEASE: usize = 32;
struct Proxy {
    fixture: HeldEndpoint,
    held: Arc<AtomicUsize>,
    renewals: Arc<AtomicUsize>,
}
fn redis_wire(value: RedisValue) -> Vec<u8> {
    match value {
        RedisValue::Nil => b"$-1\r\n".to_vec(),
        RedisValue::Okay => b"+OK\r\n".to_vec(),
        RedisValue::Int(value) => format!(":{value}\r\n").into_bytes(),
        RedisValue::SimpleString(value) => support::bulk(Some(&value)),
        RedisValue::BulkString(value) => {
            let mut wire = format!("${}\r\n", value.len()).into_bytes();
            wire.extend(value);
            wire.extend(b"\r\n");
            wire
        }
        other => panic!("unexpected real fixture reply: {other:?}"),
    }
}
impl Proxy {
    fn new(owned: &Owned, mode: usize) -> Self {
        let mut connection = redis::Client::open(owned.url.as_str())
            .unwrap()
            .get_connection_with_timeout(Duration::from_secs(2))
            .unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        connection
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let marker: Option<String> = redis::cmd("GET")
            .arg("test:ai-usage-lock:owner")
            .query(&mut connection)
            .unwrap();
        assert_eq!(marker.as_deref(), Some(owned.token.as_str()));
        let connection = Mutex::new(connection);
        let gate = Arc::new(Gate::default());
        let held = Arc::new(AtomicUsize::new(0));
        let renewals = Arc::new(AtomicUsize::new(0));
        let (g, h, renew) = (gate.clone(), held.clone(), renewals.clone());
        let endpoint = Endpoint::new(move |command| {
            let kind = if command[0] == "SET" {
                HOLD_SET
            } else if command[0] == "EVAL" && command[1] == lock::RENEW_SCRIPT {
                HOLD_RENEW
            } else if command[0] == "EVAL" && command[1] == lock::RELEASE_SCRIPT {
                HOLD_RELEASE
            } else {
                0
            };
            if kind == HOLD_RENEW {
                renew.fetch_add(1, Ordering::SeqCst);
            }
            if (kind == HOLD_RENEW && mode & FAIL_RENEW != 0)
                || (kind == HOLD_RELEASE && mode & FAIL_RELEASE != 0)
            {
                return b"-ERR fixture injected command failure\r\n".to_vec();
            }
            let reply = {
                let mut cache = connection.lock().unwrap();
                redis::cmd(&command[0])
                    .arg(&command[1..])
                    .query::<RedisValue>(&mut *cache)
            };
            let wire = reply
                .map(redis_wire)
                .unwrap_or_else(|_| b"-ERR fixture upstream failed\r\n".to_vec());
            if kind != 0 && mode & kind != 0 {
                h.fetch_add(1, Ordering::SeqCst);
                g.wait();
            }
            wire
        });
        Self {
            fixture: HeldEndpoint { endpoint, gate },
            held,
            renewals,
        }
    }
    async fn manager(&self) -> ConnectionManager {
        self.fixture.endpoint.manager().await
    }
}
async fn observed(counter: &AtomicUsize, wanted: usize, limit: Duration) {
    tokio::time::timeout(limit, async {
        while counter.load(Ordering::SeqCst) < wanted {
            // This wait protects an in-flight fixture event; no application
            // records or ready lock work are artificially paced.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("expected fixture command event");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "fresh owned disposable Redis; exact real Lua renewal/loss and finally error precedence; 31 seconds"]
async fn real_redis_renewal_loss_and_error_precedence() {
    let mut cycles = tokio::task::JoinSet::new();
    for (replace_owner, callback_error, mode) in [
        (false, false, 0),
        (true, false, 0),
        (true, true, 0),
        (false, false, EXPIRE_LEASE),
        (false, false, FAIL_RENEW),
        (false, true, FAIL_RENEW),
        (true, false, FAIL_RELEASE),
        (true, true, FAIL_RELEASE),
        (false, false, FAIL_RELEASE),
        (false, true, FAIL_RELEASE),
    ] {
        cycles.spawn(async move {
            let (owned, mut cache) = Owned::new().await;
            let proxy = Proxy::new(&owned, mode);
            let manager = proxy.manager().await;
            let mut ordered = manager.clone();
            let _keepalive = keepalive(manager.clone());
            let native = AiUsageLock::new(manager);
            let (entered, received) = tokio::sync::oneshot::channel();
            let (complete, completion) = tokio::sync::oneshot::channel();
            let (channel, customer) = (owned.channel.clone(), owned.customer.clone());
            let mut task = Task(tokio::spawn(async move {
                native
                    .with(&channel, &customer, || async move {
                        entered.send(()).unwrap();
                        completion.await.unwrap();
                        if callback_error {
                            Err("callback failure")
                        } else {
                            Ok(42)
                        }
                    })
                    .await
            }));
            bounded(received).await.unwrap();
            let original = owned.owner(&mut cache).await.unwrap();
            owned.remember(&owned.key(), &original);
            let replacement = format!("fixture-{}", uuid::Uuid::new_v4());
            if replace_owner {
                owned.remember(&owned.key(), &replacement);
                let _: String = bounded(
                    redis::cmd("SET")
                        .arg(owned.key())
                        .arg(&replacement)
                        .arg("XX")
                        .arg("EX")
                        .arg(120)
                        .query_async(&mut cache),
                )
                .await
                .unwrap();
            } else if mode & EXPIRE_LEASE != 0 {
                let _: i64 = bounded(
                    redis::cmd("EXPIRE")
                        .arg(owned.key())
                        .arg(1)
                        .query_async(&mut cache),
                )
                .await
                .unwrap();
            } else if mode & FAIL_RENEW == 0 {
                // Shorten only this disposable key. The default 120-second
                // policy is asserted independently; real Lua must restore it.
                let _: i64 = bounded(
                    redis::cmd("EXPIRE")
                        .arg(owned.key())
                        .arg(35)
                        .query_async(&mut cache),
                )
                .await
                .unwrap();
            }
            observed(&proxy.renewals, 1, Duration::from_secs(33)).await;
            // Synchronize the multiplexed reply queue, then yield to the owned
            // heartbeat so lease-loss is observed before callback completion.
            let _: String = bounded(redis::cmd("PING").query_async(&mut ordered))
                .await
                .unwrap();
            for _ in 0..32 {
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            if !replace_owner && mode & (FAIL_RENEW | EXPIRE_LEASE) == 0 {
                assert!(
                    (118..=120).contains(&owned.ttl(&mut cache).await),
                    "exact renewal restores EX120"
                );
            }
            complete.send(()).unwrap();
            let outcome = bounded(&mut task.0).await.unwrap();
            if mode & FAIL_RELEASE != 0 {
                assert!(matches!(outcome, Err(AiUsageLockError::Release(_))));
            } else if callback_error {
                assert!(matches!(
                    outcome,
                    Err(AiUsageLockError::Callback("callback failure"))
                ));
            } else if replace_owner || mode & (FAIL_RENEW | EXPIRE_LEASE) != 0 {
                assert!(matches!(outcome, Err(AiUsageLockError::LeaseLost)));
            } else {
                assert_eq!(outcome.unwrap(), 42);
            }
            if replace_owner {
                assert_eq!(
                    owned.owner(&mut cache).await.as_deref(),
                    Some(replacement.as_str())
                );
            } else if mode & FAIL_RELEASE == 0 {
                assert_eq!(owned.owner(&mut cache).await, None);
            }
            let calls = proxy.fixture.endpoint.calls.lock().unwrap();
            for command in calls.iter().filter(|command| command[0] == "EVAL") {
                assert!(command[1] == lock::RENEW_SCRIPT || command[1] == lock::RELEASE_SCRIPT);
                assert_eq!(
                    command[4], original,
                    "renew/release always use original owner"
                );
            }
        });
    }
    while let Some(cycle) = cycles.join_next().await {
        cycle.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "fresh owned disposable Redis; held acquisition/renewal/release cancellation; 61 seconds"]
async fn real_redis_held_reply_cancellation_has_no_background_renewal() {
    let mut cycles = tokio::task::JoinSet::new();
    for mode in [HOLD_SET, HOLD_RENEW, HOLD_RELEASE] {
        cycles.spawn(async move {
            let (owned, mut cache) = Owned::new().await;
            let proxy = Proxy::new(&owned, mode);
            let manager = proxy.manager().await;
            let _keepalive = keepalive(manager.clone());
            let native = AiUsageLock::new(manager);
            let (channel, customer) = (owned.channel.clone(), owned.customer.clone());
            let callback_runs = Arc::new(AtomicUsize::new(0));
            let count = callback_runs.clone();
            let mut task = Task(tokio::spawn(async move {
                native
                    .with(&channel, &customer, || async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        if mode == HOLD_RENEW {
                            std::future::pending::<()>().await;
                        }
                        Ok::<_, &'static str>(())
                    })
                    .await
            }));
            observed(&proxy.held, 1, Duration::from_secs(33)).await;
            let owner = owned.owner(&mut cache).await;
            if let Some(owner) = &owner {
                owned.remember(&owned.key(), owner);
            }
            if mode == HOLD_RELEASE {
                assert!(owner.is_none(), "atomic DEL happened before held reply");
            } else {
                assert!(owner.is_some());
                assert!((118..=120).contains(&owned.ttl(&mut cache).await));
            }
            task.0.abort();
            assert!(bounded(&mut task.0).await.unwrap_err().is_cancelled());
            proxy.fixture.gate.release();
            if mode == HOLD_SET {
                assert_eq!(callback_runs.load(Ordering::SeqCst), 0);
            }
            let count = proxy.renewals.load(Ordering::SeqCst);
            // One further genuine heartbeat deadline passes after cancellation.
            // No 120-second expiration sleep, and no shortened source policy.
            tokio::time::sleep(lock::HEARTBEAT_WAIT + Duration::from_millis(100)).await;
            assert_eq!(
                proxy.renewals.load(Ordering::SeqCst),
                count,
                "cancelled request has no heartbeat task"
            );
            assert_eq!(owned.owner(&mut cache).await, owner);
            if owner.is_some() {
                assert!((85..=91).contains(&owned.ttl(&mut cache).await));
            }
        });
    }
    while let Some(cycle) = cycles.join_next().await {
        cycle.unwrap();
    }
}

// Child-only test avoids modifying process-wide bootstrap environment while
// other integration tests run. Parent supplies only the isolated fixture URL.
#[test]
#[ignore = "child-only native default bootstrap, launched by native_default_bootstrap"]
fn native_default_child() {
    let mode = std::env::var("DIMA_AI_LOCK_DEFAULT_CHILD").expect("child-only fixture mode");
    assert!(["missing", "success"].contains(&mode.as_str()));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let _owned = if mode == "success" {
            let (owned, _cache) = Owned::new().await;
            let (_, host, port) = support::fixture_url();
            assert_eq!(std::env::var("DRAGONFLY_HOST").unwrap(), host);
            assert_eq!(std::env::var("DRAGONFLY_PORT").unwrap(), port.to_string());
            Some(owned)
        } else {
            assert!(std::env::var_os("DRAGONFLY_HOST").is_none());
            assert!(std::env::var_os("DRAGONFLY_PORT").is_none());
            None
        };
        let ran = Arc::new(AtomicBool::new(false));
        let signal = ran.clone();
        let channel: JsString = format!("test:ai-usage-lock:{}", uuid::Uuid::new_v4()).into();
        let result = lock::with_ai_usage_lock(&channel, &"child".into(), || async move {
            signal.store(true, Ordering::SeqCst);
            Ok::<_, &'static str>(42)
        })
        .await;
        if mode == "missing" {
            assert!(matches!(result, Err(AiUsageLockError::Acquire(_))));
            assert!(!ran.load(Ordering::SeqCst));
        } else {
            assert_eq!(result.unwrap(), 42);
            assert!(ran.load(Ordering::SeqCst));
        }
    });
}
#[tokio::test]
#[ignore = "fresh owned disposable Redis; native default success/failure in isolated children"]
async fn native_default_bootstrap() {
    let (owned, _cache) = Owned::new().await;
    let (_, host, port) = support::fixture_url();
    for mode in ["missing", "success"] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "native_default_child",
                "--nocapture",
            ])
            .env("DIMA_AI_LOCK_DEFAULT_CHILD", mode)
            .env_remove("DRAGONFLY_HOST")
            .env_remove("DRAGONFLY_PORT");
        if mode == "success" {
            command
                .env("DRAGONFLY_HOST", &host)
                .env("DRAGONFLY_PORT", port.to_string());
        }
        let output = support::child_output(
            command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
            Duration::from_secs(12),
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    drop(owned);
}
