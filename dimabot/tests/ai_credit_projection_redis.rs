#![cfg(feature = "ai-credit-projection")]
#[path = "ai_credit_projection_support/mod.rs"]
mod support;
use dima_rust::utils::{
    ai_credit_projection::{self as p, AiCreditProjection},
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::BufReader,
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use support::Endpoint;
const WAIT: Duration = Duration::from_secs(5);
fn now() -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(1767323045000)
}
async fn manager(url: &str) -> ConnectionManager {
    redis::Client::open(url)
        .unwrap()
        .get_connection_manager_with_config(
            ConnectionManagerConfig::new().set_response_timeout(None),
        )
        .await
        .unwrap()
}
struct Owned {
    url: String,
    token: String,
    claim: String,
    keys: BTreeSet<String>,
    counter: usize,
}
impl Owned {
    async fn new(url: String, redis: &mut ConnectionManager) -> Self {
        let token = format!(
            "projection-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let claim = format!("dima:test:ai-projection:{token}:owner");
        let acquired: Option<String> = redis::cmd("SET")
            .arg(&claim)
            .arg(&token)
            .arg("NX")
            .arg("EX")
            .arg(600)
            .query_async(redis)
            .await
            .unwrap();
        assert_eq!(acquired.as_deref(), Some("OK"));
        Self {
            url,
            token,
            claim,
            keys: BTreeSet::new(),
            counter: 0,
        }
    }
    async fn channel(&mut self, redis: &mut ConnectionManager, ids: &[&str]) -> JsString {
        self.counter += 1;
        let channel = format!("{}-{}", self.token, self.counter);
        let mut keys = vec![
            format!("twitch:{channel}:ai:credits"),
            format!("twitch:{channel}:ai:exhaust"),
            format!("{channel}:ai:exhaust"),
            format!("twitch:{channel}:ai:usage-local:untracked"),
        ];
        keys.extend(ids.iter().map(|id| {
            format!(
                "twitch:{channel}:ai:usage-local:{:x}",
                Sha256::digest(id.as_bytes())
            )
        }));
        for key in &keys {
            let exists: i64 = redis::cmd("EXISTS")
                .arg(key)
                .query_async(&mut *redis)
                .await
                .unwrap();
            assert_eq!(exists, 0, "refuse pre-existing key");
        }
        self.keys.extend(keys);
        channel.into()
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // Synchronous bounded cleanup also runs during unwinding/cancellation.
        // Claim guards ownership; no scan, wildcard delete, FLUSHDB or prune.
        let cleanup = || -> redis::RedisResult<()> {
            let client = redis::Client::open(self.url.as_str())?;
            let mut c = client.get_connection_with_timeout(Duration::from_secs(2))?;
            c.set_read_timeout(Some(Duration::from_secs(2)))?;
            c.set_write_timeout(Some(Duration::from_secs(2)))?;
            let owner: Option<String> = redis::cmd("GET").arg(&self.claim).query(&mut c)?;
            if owner.as_deref() != Some(self.token.as_str()) {
                return Ok(());
            }
            for key in &self.keys {
                let _: i64 = redis::cmd("DEL").arg(key).query(&mut c)?;
            }
            let _: i64 = redis::cmd("DEL").arg(&self.claim).query(&mut c)?;
            Ok(())
        };
        if let Err(e) = cleanup() {
            eprintln!("task-owned projection cleanup failed: {e}");
        }
    }
}
fn keys(channel: &JsString) -> [String; 3] {
    let c = channel.to_utf8_lossy();
    [
        format!("twitch:{c}:ai:credits"),
        format!("twitch:{c}:ai:exhaust"),
        format!("{c}:ai:exhaust"),
    ]
}
async fn set(redis: &mut ConnectionManager, key: &str, value: &str) {
    let _: () = redis::cmd("SET")
        .arg(key)
        .arg(value)
        .query_async(redis)
        .await
        .unwrap();
}
async fn get(redis: &mut ConnectionManager, key: &str) -> Option<String> {
    redis::cmd("GET").arg(key).query_async(redis).await.unwrap()
}
async fn ttl(redis: &mut ConnectionManager, key: &str) -> i64 {
    redis::cmd("TTL").arg(key).query_async(redis).await.unwrap()
}
fn num(v: &JsonValue, k: &str) -> f64 {
    if let Some(JsonValue::Number(n)) = v.get(k) {
        *n
    } else {
        panic!("numeric {k}")
    }
}
async fn snapshot(redis: &mut ConnectionManager, key: &str) -> JsonValue {
    parse_json(&get(redis, key).await.unwrap()).unwrap()
}
async fn eval(
    redis: &mut ConnectionManager,
    channel: &JsString,
    credits: &str,
    id: Option<&str>,
) -> redis::RedisResult<i64> {
    let id = id.map(JsString::from);
    let request = p::record_command_at(channel, 1.0, id.as_ref(), now())
        .unwrap()
        .unwrap();
    let mut args = request.arguments;
    args[0] = credits.into();
    redis::cmd("EVAL")
        .arg(p::APPLY_AI_CREDIT_USAGE_SCRIPT)
        .arg(4)
        .arg(&request.keys)
        .arg(&args)
        .query_async(redis)
        .await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn real_lua_branch_ttl_coercion_and_concurrent_matrix() {
    let (url, _, _) = support::fixture_url();
    let mut redis = manager(&url).await;
    let mut owned = Owned::new(url, &mut redis).await;
    let adapter = AiCreditProjection::new(redis.clone(), Duration::from_secs(2));
    let seeds = [
        (None, None),
        (Some("{"), None),
        (Some(r#"{"version":2,"used":0,"balance":10}"#), None),
        (
            Some(r#"{"version":3,"available":false,"used":0,"balance":10}"#),
            None,
        ),
        (
            Some(r#"{"version":"3","used":"2","balance":"5","extra":{"x":1}}"#),
            Some((4.0, 3.0)),
        ),
        (
            Some(r#"{"version":3,"used":"bad","balance":"bad","available":null}"#),
            Some((2.0, -2.0)),
        ),
        (
            Some(r#"{"version":3,"used":-10,"balance":4}"#),
            Some((0.0, 2.0)),
        ),
        (
            Some(r#"{"version":3,"used":1.5,"balance":2.5,"available":true}"#),
            Some((3.5, 0.5)),
        ),
        (
            Some(r#"{"version":3,"used":true,"balance":false}"#),
            Some((2.0, -2.0)),
        ),
        (
            Some(r#"{"version":3,"used":"0x10","balance":"0x20"}"#),
            Some((18.0, 30.0)),
        ),
        (Some(r#"{"version":null,"used":1,"balance":3}"#), None),
        (Some("[]"), None),
        (Some(r#""primitive""#), None),
        (
            Some(r#"{"version":3,"used":0,"balance":2,"extra":"keep"}"#),
            Some((2.0, 0.0)),
        ),
    ];
    for (seed, expected) in seeds {
        let channel = owned.channel(&mut redis, &["id"]).await;
        let [credit, canonical, legacy] = keys(&channel);
        if let Some(seed) = seed {
            set(&mut redis, &credit, seed).await;
        }
        let result = eval(&mut redis, &channel, "1.1", Some("id")).await.unwrap();
        let request = p::record_command_at(&channel, 1.1, Some(&"id".into()), now())
            .unwrap()
            .unwrap();
        let marker = &request.keys[3];
        assert!(
            (p::LOCAL_USAGE_TTL_SECONDS as i64 - 10..=p::LOCAL_USAGE_TTL_SECONDS as i64)
                .contains(&ttl(&mut redis, marker).await)
        );
        assert_eq!(
            eval(&mut redis, &channel, "1.1", Some("id")).await.unwrap(),
            2
        );
        if let Some((used, balance)) = expected {
            let data = snapshot(&mut redis, &credit).await;
            assert_eq!(num(&data, "used"), used);
            assert_eq!(num(&data, "balance"), balance);
            assert_eq!(result, i64::from(balance <= 0.0));
            assert_eq!(
                data.get("updatedAt"),
                Some(&JsonValue::String("2026-01-02T03:04:05.000Z".into()))
            );
            assert!((2678390..=2678400).contains(&ttl(&mut redis, &credit).await));
            if balance <= 0.0 {
                for key in [&canonical, &legacy] {
                    assert_eq!(get(&mut redis, key).await.as_deref(), Some("true"));
                    assert_eq!(ttl(&mut redis, key).await, -1);
                }
            }
            if let Some(seed) = seed {
                let original = parse_json(seed).unwrap();
                if let Some(extra) = original.get("extra") {
                    assert_eq!(data.get("extra"), Some(extra));
                }
            }
        } else {
            assert_eq!(result, 0);
            assert_eq!(get(&mut redis, &credit).await.as_deref(), seed);
        }
    }
    for primitive in ["null", "true", "false", "1"] {
        let c = owned.channel(&mut redis, &["id"]).await;
        let key = keys(&c)[0].clone();
        set(&mut redis, &key, primitive).await;
        assert!(eval(&mut redis, &c, "1", Some("id")).await.is_err());
        assert_eq!(eval(&mut redis, &c, "1", Some("id")).await.unwrap(), 2);
    }
    // Marker is already written when GET fails on a hash; Lua does not roll back.
    let c = owned.channel(&mut redis, &["id"]).await;
    let key = keys(&c)[0].clone();
    let _: i64 = redis::cmd("HSET")
        .arg(&key)
        .arg("x")
        .arg("y")
        .query_async(&mut redis)
        .await
        .unwrap();
    assert!(eval(&mut redis, &c, "1", Some("id")).await.is_err());
    assert_eq!(eval(&mut redis, &c, "1", Some("id")).await.unwrap(), 2);
    // Invalid/zero/negative consumed values skip after consuming the marker.
    for credits in ["0", "-1", "not-a-number"] {
        let c = owned.channel(&mut redis, &["id"]).await;
        let key = keys(&c)[0].clone();
        let seed = r#"{"version":3,"used":0,"balance":10}"#;
        set(&mut redis, &key, seed).await;
        assert_eq!(eval(&mut redis, &c, credits, Some("id")).await.unwrap(), 0);
        assert_eq!(get(&mut redis, &key).await.as_deref(), Some(seed));
        assert_eq!(eval(&mut redis, &c, "1", Some("id")).await.unwrap(), 2);
    }
    let same = owned.channel(&mut redis, &["same"]).await;
    let key = keys(&same)[0].clone();
    set(&mut redis, &key, r#"{"version":3,"used":0,"balance":1000}"#).await;
    let barrier = Arc::new(tokio::sync::Barrier::new(33));
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let (adapter, c, b) = (adapter.clone(), same.clone(), barrier.clone());
        tasks.push(tokio::spawn(async move {
            tokio::time::timeout(WAIT, b.wait()).await.unwrap();
            adapter
                .record_ai_credit_usage_at(&c, 1.1, Some(&"same".into()), now())
                .await
                .unwrap()
                .unwrap()
        }));
    }
    tokio::time::timeout(WAIT, barrier.wait()).await.unwrap();
    let mut codes = Vec::new();
    for task in tasks {
        codes.push(tokio::time::timeout(WAIT, task).await.unwrap().unwrap());
    }
    assert_eq!(codes.iter().filter(|&&n| n == 0).count(), 1);
    assert_eq!(codes.iter().filter(|&&n| n == 2).count(), 31);
    assert_eq!(num(&snapshot(&mut redis, &key).await, "used"), 2.0);
    let ids: Vec<_> = (0..32).map(|i| format!("distinct-{i}")).collect();
    let refs: Vec<_> = ids.iter().map(String::as_str).collect();
    let distinct = owned.channel(&mut redis, &refs).await;
    let key = keys(&distinct)[0].clone();
    set(&mut redis, &key, r#"{"version":3,"used":0,"balance":1000}"#).await;
    let mut tasks = Vec::new();
    for id in ids {
        let (a, c) = (adapter.clone(), distinct.clone());
        tasks.push(tokio::spawn(async move {
            a.record_ai_credit_usage_at(&c, 1.1, Some(&id.into()), now())
                .await
                .unwrap()
        }));
    }
    for task in tasks {
        tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    }
    assert_eq!(num(&snapshot(&mut redis, &key).await, "used"), 64.0);
    // Absent and empty IDs are untracked: each call debits, marker is never SET.
    for id in [None, Some(JsString::from(""))] {
        adapter
            .record_ai_credit_usage_at(&distinct, 1.0, id.as_ref(), now())
            .await
            .unwrap();
    }
    assert_eq!(num(&snapshot(&mut redis, &key).await, "used"), 66.0);
    assert_eq!(
        ttl(
            &mut redis,
            &format!(
                "twitch:{}:ai:usage-local:untracked",
                distinct.to_utf8_lossy()
            )
        )
        .await,
        -2
    );
    for id in [
        JsString::from("😀"),
        JsString::from_units(vec![0xd800]),
        JsString::from_units(vec![0xdc00]),
    ] {
        let encoded = id.to_utf8_lossy();
        let c = owned.channel(&mut redis, &[&encoded]).await;
        let key = keys(&c)[0].clone();
        set(&mut redis, &key, r#"{"version":3,"used":0,"balance":10}"#).await;
        assert_eq!(
            adapter
                .record_ai_credit_usage_at(&c, 1.0, Some(&id), now())
                .await
                .unwrap(),
            Some(0)
        );
        let marker = p::record_command_at(&c, 1.0, Some(&id), now())
            .unwrap()
            .unwrap()
            .keys[3]
            .clone();
        assert!(ttl(&mut redis, &marker).await > 2678390);
    }
}
#[tokio::test]
#[ignore = "task-owned disposable Dragonfly only"]
async fn real_exhaustion_flags_cache_types_and_repairs() {
    let (url, _, _) = support::fixture_url();
    let mut redis = manager(&url).await;
    let mut owned = Owned::new(url, &mut redis).await;
    let adapter = AiCreditProjection::new(redis.clone(), Duration::from_secs(2));
    for (canonical, legacy) in [(false, false), (true, false), (false, true), (true, true)] {
        let channel = owned.channel(&mut redis, &[]).await;
        let [credit, c, l] = keys(&channel);
        // EXISTS cares about presence even for false text, lists and hashes.
        if canonical {
            set(&mut redis, &c, "false").await;
        }
        if legacy {
            let _: i64 = redis::cmd("HSET")
                .arg(&l)
                .arg("x")
                .arg("y")
                .query_async(&mut redis)
                .await
                .unwrap();
        }
        for key in [&c, &l] {
            let _: i64 = redis::cmd("EXPIRE")
                .arg(key)
                .arg(60)
                .query_async(&mut redis)
                .await
                .unwrap();
        }
        assert_eq!(
            adapter.is_ai_credits_exhausted(&channel).await.unwrap(),
            canonical || legacy
        );
        if canonical ^ legacy {
            for key in [&c, &l] {
                assert_eq!(get(&mut redis, key).await.as_deref(), Some("true"));
                assert_eq!(ttl(&mut redis, key).await, -1);
            }
        }
        if canonical && legacy {
            for key in [&c, &l] {
                assert!((1..=60).contains(&ttl(&mut redis, key).await));
            }
            assert_eq!(get(&mut redis, &c).await.as_deref(), Some("false"));
        }
        assert_eq!(get(&mut redis, &credit).await, None);
    }
    let caches = [
        ("", false),
        ("{", false),
        ("null", false),
        ("[]", false),
        ("[1]", false),
        ("true", false),
        ("0", false),
        (r#""exhausted""#, false),
        (r#"{"status":"exhausted"}"#, true),
        (r#"{"status":"exhausted","available":false}"#, true),
        (r#"{"available":true,"balance":0}"#, true),
        (r#"{"available":true,"balance":-0}"#, true),
        (r#"{"available":true,"balance":-1}"#, true),
        (r#"{"available":true,"balance":1}"#, false),
        (r#"{"available":true,"balance":"0"}"#, false),
        (r#"{"available":true,"balance":null}"#, false),
        (r#"{"available":1,"balance":-1}"#, false),
        (r#"{"available":true,"balance":-1e999}"#, true),
    ];
    for (raw, want) in caches {
        let channel = owned.channel(&mut redis, &[]).await;
        let [credit, c, l] = keys(&channel);
        set(&mut redis, &credit, raw).await;
        assert_eq!(
            adapter.is_ai_credits_exhausted(&channel).await.unwrap(),
            want,
            "{raw}"
        );
        for key in [&c, &l] {
            assert_eq!(ttl(&mut redis, key).await, if want { -1 } else { -2 });
        }
    }
    let channel = owned.channel(&mut redis, &[]).await;
    let key = keys(&channel)[0].clone();
    let _: i64 = redis::cmd("HSET")
        .arg(key)
        .arg("x")
        .arg("y")
        .query_async(&mut redis)
        .await
        .unwrap();
    assert!(adapter.is_ai_credits_exhausted(&channel).await.is_err()); // GET is outside try.
}
// Forwards commands to the explicitly allowlisted disposable server. EVAL's
// response is held only AFTER the upstream server has executed and replied.
// An independent native connection observes the mutation before release.
fn held_proxy(
    url: &str,
    close: bool,
) -> (
    Endpoint,
    tokio::sync::oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
    Arc<AtomicUsize>,
) {
    let info = redis::Client::open(url)
        .unwrap()
        .get_connection_info()
        .clone();
    let (host, port) = match info.addr().clone() {
        redis::ConnectionAddr::Tcp(host, port) => (host, port),
        _ => panic!("plain TCP fixture"),
    };
    let upstream = TcpStream::connect((host.as_str(), port)).unwrap();
    upstream.set_read_timeout(Some(WAIT)).unwrap();
    upstream.set_write_timeout(Some(WAIT)).unwrap();
    let reader = BufReader::new(upstream.try_clone().unwrap());
    let upstream = Mutex::new((upstream, reader));
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let entered_tx = Mutex::new(Some(entered_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let ep = Endpoint::new(move |args| {
        let reply = {
            let mut io = upstream.lock().unwrap();
            support::write_command(&mut io.0, args).unwrap();
            support::read_reply(&mut io.1).unwrap()
        };
        if args[0] == "EVAL" {
            counter.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = entered_tx.lock().unwrap().take() {
                let _ = tx.send(());
                let _ = release_rx.lock().unwrap().recv_timeout(WAIT);
                if close {
                    return Vec::new();
                }
            }
        }
        reply
    });
    (ep, entered_rx, release_tx, count)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "task-owned disposable Dragonfly only"]
async fn real_execution_held_response_abort_deadline_close_never_replays() {
    let (url, _, _) = support::fixture_url();
    let mut redis = manager(&url).await;
    let mut owned = Owned::new(url.clone(), &mut redis).await;
    for mode in ["abort", "deadline", "close"] {
        let channel = owned.channel(&mut redis, &["once"]).await;
        let key = keys(&channel)[0].clone();
        set(&mut redis, &key, r#"{"version":3,"used":0,"balance":10}"#).await;
        let (ep, entered, release, count) = held_proxy(&url, mode == "close");
        let connection = ep.manager().await;
        let adapter = AiCreditProjection::new(
            connection.clone(),
            if mode == "deadline" {
                Duration::from_millis(100)
            } else {
                WAIT
            },
        );
        let c = channel.clone();
        let task = tokio::spawn(async move {
            adapter
                .record_ai_credit_usage_at(&c, 1.0, Some(&"once".into()), now())
                .await
        });
        tokio::time::timeout(WAIT, entered).await.unwrap().unwrap();
        assert_eq!(num(&snapshot(&mut redis, &key).await, "used"), 1.0);
        let marker = p::record_command_at(&channel, 1.0, Some(&"once".into()), now())
            .unwrap()
            .unwrap()
            .keys[3]
            .clone();
        assert!(ttl(&mut redis, &marker).await > 2678390);
        if mode == "abort" {
            task.abort();
            assert!(
                tokio::time::timeout(WAIT, task)
                    .await
                    .unwrap()
                    .unwrap_err()
                    .is_cancelled()
            );
            release.send(()).unwrap();
        } else if mode == "deadline" {
            let error = tokio::time::timeout(WAIT, task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(error.contains("deadline"));
            release.send(()).unwrap();
        } else {
            release.send(()).unwrap();
            let error = tokio::time::timeout(WAIT, task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(!error.contains("deadline"), "expected disconnect: {error}");
        }
        // A subsequent independent command drains the socket and establishes a
        // causal barrier; no wall-clock sleep is used to infer absence of retry.
        let _: String = tokio::time::timeout(
            WAIT,
            redis::cmd("PING").query_async(&mut connection.clone()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(num(&snapshot(&mut redis, &key).await, "used"), 1.0);
    }
}
#[tokio::test]
async fn concrete_resp_fault_boundaries_and_clone_socket() {
    // Loopback-only endpoint: not a policy adapter. Native Redis sees ERR frames.
    for (existing, fail_command, fail_key, want_error, want) in [
        (false, "EXISTS", "twitch:x:ai:exhaust", true, false),
        (false, "EXISTS", "x:ai:exhaust", true, false),
        (false, "GET", "twitch:x:ai:credits", true, false),
        (true, "SET", "x:ai:exhaust", true, false),
        (true, "SET", "twitch:x:ai:exhaust", true, false),
        (false, "SET", "x:ai:exhaust", false, false),
        (false, "SET", "twitch:x:ai:exhaust", false, false),
        (false, "NONE", "", false, true),
    ] {
        let ep = Endpoint::new(move |args| {
            if args[0] == fail_command && args.get(1).map(String::as_str) == Some(fail_key) {
                return b"-ERR targeted fixture failure\r\n".to_vec();
            }
            match args[0].as_str() {
                "PING" => b"+PONG\r\n".to_vec(),
                "EXISTS" => {
                    if existing && args[1].starts_with("twitch:") {
                        b":1\r\n".to_vec()
                    } else {
                        b":0\r\n".to_vec()
                    }
                }
                "GET" => support::bulk(Some(r#"{"status":"exhausted"}"#)),
                "SET" => b"+OK\r\n".to_vec(),
                _ => b"-ERR fixture\r\n".to_vec(),
            }
        });
        let mut connection = ep.manager().await;
        let adapter = AiCreditProjection::new(connection.clone(), Duration::from_secs(1));
        let result = adapter.clone().is_ai_credits_exhausted(&"x".into()).await;
        if want_error {
            assert!(result.unwrap_err().contains("targeted fixture failure"));
        } else {
            assert_eq!(result.unwrap(), want);
        }
        let _: String = redis::cmd("PING")
            .query_async(&mut connection)
            .await
            .unwrap();
        let calls = ep.calls.lock().unwrap().clone();
        assert_eq!(calls.iter().filter(|c| c[0] == "EXISTS").count(), 2);
        if fail_command == "SET" {
            assert_eq!(calls.iter().filter(|c| c[0] == "SET").count(), 2);
        }
    }
    // Shared concrete manager is verified by a native RESP server-side socket
    // counter, with no policy mock and two concurrently active clones.
    let ep = Endpoint::new(|args| match args[0].as_str() {
        "PING" => b"+PONG\r\n".to_vec(),
        "EVAL" => b":0\r\n".to_vec(),
        _ => b"-ERR fixture\r\n".to_vec(),
    });
    let connection = ep.manager().await;
    let adapter = AiCreditProjection::new(connection, WAIT);
    assert!(ep.calls.lock().unwrap().is_empty()); // construction performs no IO
    let other = adapter.clone();
    let ca = JsString::from("a");
    let cb = JsString::from("b");
    let (a, b) = tokio::join!(
        adapter.record_ai_credit_usage_at(&ca, 1.0, None, now()),
        other.record_ai_credit_usage_at(&cb, 1.0, None, now())
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        ep.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c[0] == "EVAL")
            .count(),
        2
    );
    assert_eq!(ep.connections.load(Ordering::SeqCst), 1);
}
// The executable's ignored child is the only process using the native global
// cell. Parent Command.env sets private values before process creation; neither
// test ever calls unsafe set_var/remove_var or reads .env.
#[test]
#[ignore = "subprocess entry only"]
fn projection_default_child() {
    if std::env::var("DIMA_PROJECTION_CHILD").as_deref() != Ok("1") {
        return;
    }
    let (_, host, port) = support::fixture_url();
    assert_eq!(std::env::var("DRAGONFLY_HOST").unwrap(), host);
    assert_eq!(std::env::var("DRAGONFLY_PORT").unwrap(), port.to_string());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let deadline = Duration::from_millis(200);
        // Guards never acquire even while fixture PING is configured to fail.
        p::record_ai_credit_usage_default(&"".into(), 1.0, None, deadline).await;
        p::record_ai_credit_usage_default(&"guard".into(), f64::NAN, None, deadline).await;
        assert!(
            !p::is_ai_credits_exhausted_default(&"".into(), deadline)
                .await
                .unwrap()
        );
        p::record_ai_credit_usage_default(&JsString::from_units(vec![0xd800]), 1.0, None, deadline)
            .await;
        assert!(
            p::is_ai_credits_exhausted_default(&"child".into(), deadline)
                .await
                .is_err()
        );
        // Endpoint deliberately rejects its first two PINGs; failed OnceCell
        // initialization is retryable, then all default calls share one socket.
        assert!(
            !p::is_ai_credits_exhausted_default(&"child".into(), deadline)
                .await
                .unwrap()
        );
        let c = dima_rust::utils::redis::get_redis_client().await.unwrap();
        p::record_ai_credit_usage_default(&JsString::from_units(vec![0xd800]), 1.0, None, deadline)
            .await;
        p::record_ai_credit_usage_default(&"child".into(), 1.0, None, deadline).await;
        assert!(
            !p::is_ai_credits_exhausted_default(&"child".into(), deadline)
                .await
                .unwrap()
        );
        let _: String = redis::cmd("PING")
            .query_async(&mut c.clone())
            .await
            .unwrap();
    });
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit disposable fixture ownership; child-only global acquisition"]
async fn native_default_acquisition_failure_retry_reuse_and_stderr() {
    let _ = support::fixture_url(); // requires explicit parent-owned resource intent
    let pings = Arc::new(AtomicUsize::new(0));
    let counter = pings.clone();
    let evals = AtomicUsize::new(0);
    let ep = Endpoint::new(move |args| match args[0].as_str() {
        "PING" => {
            if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                b"-ERR fixture acquisition failure\r\n".to_vec()
            } else {
                b"+PONG\r\n".to_vec()
            }
        }
        "EXISTS" => b":0\r\n".to_vec(),
        "GET" => b"$-1\r\n".to_vec(),
        "EVAL" => {
            if evals.fetch_add(1, Ordering::SeqCst) == 0 {
                b"-ERR fixture command failure\r\n".to_vec()
            } else {
                b":0\r\n".to_vec()
            }
        }
        _ => b"-ERR fixture command\r\n".to_vec(),
    });
    let (host, port) = support::parse_fixture_url(&ep.url);
    // Host/port originate from a bound loopback listener, never production env.
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "projection_default_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env("DIMA_PROJECTION_CHILD", "1")
        .env("DRAGONFLY_HOST", host)
        .env("DRAGONFLY_PORT", port.to_string())
        .env("DIMA_TEST_REDIS_URL", &ep.url)
        .env("DIMA_RUST_TEST_RESOURCE_OWNER", "dimabot-migration")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let result =
        tokio::task::spawn_blocking(move || support::child_output(child, Duration::from_secs(15)))
            .await
            .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let stderr = String::from_utf8(result.stderr).unwrap();
    let lines: Vec<_> = stderr
        .lines()
        .filter(|s| s.starts_with(p::RECORD_ERROR_PREFIX))
        .collect();
    assert_eq!(lines.len(), 2);
    for (line, message) in lines
        .iter()
        .zip(["fixture acquisition failure", "fixture command failure"])
    {
        let payload =
            parse_json(line.strip_prefix(p::RECORD_ERROR_PREFIX).unwrap().trim()).unwrap();
        assert_eq!(
            payload.get("channelID"),
            Some(&JsonValue::String(JsString::from_units(vec![0xd800])))
        );
        let Some(JsonValue::String(error)) = payload.get("error") else {
            panic!("error string")
        };
        assert!(error.to_utf8_lossy().contains(message));
    }
    assert_eq!(pings.load(Ordering::SeqCst), 4); // 2 failures, one cached init, final explicit PING
    assert_eq!(ep.connections.load(Ordering::SeqCst), 3); // failed init sockets + one reused manager
    let calls = ep.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| c[0] == "EVAL").count(), 2);
    assert_eq!(calls.iter().filter(|c| c[0] == "GET").count(), 2);
}
#[tokio::test]
#[ignore = "task-owned disposable Dragonfly only"]
async fn owned_cleanup_survives_unwind_and_preserves_other_owned_namespace() {
    let (url, _, _) = support::fixture_url();
    let mut redis = manager(&url).await;
    let mut survivor = Owned::new(url.clone(), &mut redis).await;
    let other = survivor.channel(&mut redis, &[]).await;
    let sentinel = keys(&other)[0].clone();
    set(&mut redis, &sentinel, "survive").await;
    let mut doomed = Owned::new(url, &mut redis).await;
    let channel = doomed.channel(&mut redis, &["id"]).await;
    let exact: Vec<_> = doomed
        .keys
        .iter()
        .cloned()
        .chain(std::iter::once(doomed.claim.clone()))
        .collect();
    for key in &keys(&channel) {
        set(&mut redis, key, "owned").await;
    }
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _guard = doomed;
        panic!("intentional cleanup fixture unwind");
    }));
    assert!(panic.is_err());
    for key in exact {
        let exists: i64 = redis::cmd("EXISTS")
            .arg(key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(exists, 0);
    }
    assert_eq!(get(&mut redis, &sentinel).await.as_deref(), Some("survive"));
}
