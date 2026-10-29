#![cfg(feature = "moderation-offenses")]
//! Explicitly owned private Dragonfly fixture, never production or shared data.
#[path = "ai_credit_projection_support/mod.rs"]
mod support;
use dima_rust::utils::{
    js_string::JsString,
    moderation::offenses::*,
    observability::{Telemetry, TraceContext, with_telemetry_context},
};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use std::{
    collections::BTreeSet,
    io::BufReader,
    net::TcpStream,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;
const LIMIT: Duration = Duration::from_secs(10);
async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(LIMIT, future)
        .await
        .expect("private fixture deadline")
}
async fn manager(url: &str) -> ConnectionManager {
    bounded(
        redis::Client::open(url)
            .unwrap()
            .get_connection_manager_with_config(
                ConnectionManagerConfig::new().set_response_timeout(None),
            ),
    )
    .await
    .unwrap()
}
struct Owned {
    url: String,
    token: String,
    claim: String,
    keys: BTreeSet<String>,
}
impl Owned {
    async fn new(url: String, cache: &mut ConnectionManager) -> Self {
        let token = format!(
            "offense-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let claim = format!("dima:test:offense:{token}:owner");
        let accepted: Option<String> = bounded(
            redis::cmd("SET")
                .arg(&claim)
                .arg(&token)
                .arg("NX")
                .arg("EX")
                .arg(600)
                .query_async(cache),
        )
        .await
        .unwrap();
        assert_eq!(accepted.as_deref(), Some("OK"));
        Self {
            url,
            token,
            claim,
            keys: BTreeSet::new(),
        }
    }
    fn channel(&self) -> JsString {
        JsString::from(self.token.as_str())
    }
    fn decision(&self, suffix: &str) -> JsString {
        JsString::from(format!("{}-{suffix}", self.token))
    }
    async fn own(&mut self, cache: &mut ConnectionManager, key: JsString) -> String {
        let key = key.to_utf8_lossy();
        assert!(!self.keys.contains(&key));
        let count: i64 = bounded(redis::cmd("EXISTS").arg(&key).query_async(cache))
            .await
            .unwrap();
        assert_eq!(count, 0, "refuse pre-existing fixture key");
        self.keys.insert(key.clone());
        key
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        let cleanup = || -> redis::RedisResult<()> {
            let client = redis::Client::open(self.url.as_str())?;
            let mut conn = client.get_connection_with_timeout(Duration::from_secs(2))?;
            conn.set_read_timeout(Some(Duration::from_secs(2)))?;
            conn.set_write_timeout(Some(Duration::from_secs(2)))?;
            let owner: Option<String> = redis::cmd("GET").arg(&self.claim).query(&mut conn)?;
            if owner.as_deref() != Some(self.token.as_str()) {
                return Ok(());
            }
            for key in &self.keys {
                let _: i64 = redis::cmd("DEL").arg(key).query(&mut conn)?;
            }
            let _: i64 = redis::cmd("DEL").arg(&self.claim).query(&mut conn)?;
            Ok(())
        };
        if let Err(error) = cleanup() {
            eprintln!("owned offense cleanup failed: {error}");
        }
    }
}
async fn get(cache: &mut ConnectionManager, key: &str) -> Option<String> {
    bounded(redis::cmd("GET").arg(key).query_async(cache))
        .await
        .unwrap()
}
async fn ttl(cache: &mut ConnectionManager, key: &str) -> i64 {
    bounded(redis::cmd("PTTL").arg(key).query_async(cache))
        .await
        .unwrap()
}
async fn del(cache: &mut ConnectionManager, key: &str) {
    let _: i64 = bounded(redis::cmd("DEL").arg(key).query_async(cache))
        .await
        .unwrap();
}

// Forwards to the real private fixture; mode 1 holds and mode 2 drops an
// already-applied mutation reply. It never retries a mutation itself.
struct Proxy {
    endpoint: support::Endpoint,
    mode: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    applied: Arc<Notify>,
    released: Arc<Notify>,
    expired: Arc<Notify>,
    gate: Arc<(Mutex<bool>, Condvar)>,
}
impl Proxy {
    fn new(host: &str, port: u16) -> Self {
        let stream = TcpStream::connect((host, port)).unwrap();
        stream.set_read_timeout(Some(LIMIT)).unwrap();
        stream.set_write_timeout(Some(LIMIT)).unwrap();
        let upstream = Arc::new(Mutex::new((
            stream.try_clone().unwrap(),
            BufReader::new(stream),
        )));
        let mode = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let applied = Arc::new(Notify::new());
        let released = Arc::new(Notify::new());
        let expired = Arc::new(Notify::new());
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (m, w, a, r, e, g) = (
            mode.clone(),
            writes.clone(),
            applied.clone(),
            released.clone(),
            expired.clone(),
            gate.clone(),
        );
        let endpoint = support::Endpoint::new(move |cmd| {
            let mut connection = upstream.lock().unwrap();
            let (socket, reader) = &mut *connection;
            support::write_command(socket, cmd).unwrap();
            let reply = support::read_reply(reader).unwrap();
            drop(connection);
            if cmd[0] == "EXPIRE" {
                e.notify_one();
            }
            if matches!(cmd[0].as_str(), "INCR" | "EVAL") {
                w.fetch_add(1, Ordering::SeqCst);
                let selected = m.swap(0, Ordering::SeqCst);
                if selected != 0 {
                    a.notify_one();
                }
                if selected == 2 {
                    return Vec::new();
                }
                if selected == 1 {
                    let (lock, cv) = &*g;
                    let (released, _) = cv
                        .wait_timeout_while(lock.lock().unwrap(), LIMIT, |v| !*v)
                        .unwrap();
                    if !*released {
                        return Vec::new();
                    }
                    r.notify_one();
                }
            }
            reply
        });
        Self {
            endpoint,
            mode,
            writes,
            applied,
            released,
            expired,
            gate,
        }
    }
    fn arm(&self, mode: usize) {
        *self.gate.0.lock().unwrap() = false;
        self.mode.store(mode, Ordering::SeqCst);
    }
    fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.release();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly owned private Dragonfly fixture"]
async fn real_counter_receipts_expiry_errors_and_uncertain_writes() {
    let (url, host, port) = support::fixture_url();
    let mut raw = manager(&url).await;
    let mut owned = Owned::new(url, &mut raw).await;
    let channel = owned.channel();
    let rule = JsString::from("rule");
    let user = JsString::from("user");
    let counter = owned
        .own(&mut raw, offense_key(&channel, &rule, &user))
        .await;
    let d1 = owned.decision("one");
    let d2 = owned.decision("two");
    let d3 = owned.decision("three");
    let receipt1 = owned.own(&mut raw, offense_receipt_key(&d1)).await;
    let receipt2 = owned.own(&mut raw, offense_receipt_key(&d2)).await;
    let receipt3 = owned.own(&mut raw, offense_receipt_key(&d3)).await;
    let cache = manager(&owned.url).await;
    let store = OffenseStore::new(cache.clone());
    assert_eq!(
        bounded(store.record_offense(&channel, &rule, &user, 60.9, None))
            .await
            .unwrap(),
        1.0
    );
    let first_ttl = ttl(&mut raw, &counter).await;
    assert!((50_000..=60_000).contains(&first_ttl));
    let _: i64 = bounded(
        redis::cmd("PEXPIRE")
            .arg(&counter)
            .arg(5000)
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    assert_eq!(
        bounded(store.record_offense(&channel, &rule, &user, 600.0, None))
            .await
            .unwrap(),
        2.0
    );
    let next_ttl = ttl(&mut raw, &counter).await;
    assert!(
        (1..=5000).contains(&next_ttl),
        "later offenses do not refresh TTL"
    );
    let _: i64 = bounded(
        redis::cmd("PEXPIRE")
            .arg(&counter)
            .arg(200)
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    bounded(async {
        loop {
            if get(&mut raw, &counter).await.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!(
        bounded(store.record_offense(&channel, &rule, &user, 60.0, None))
            .await
            .unwrap(),
        1.0
    );
    del(&mut raw, &counter).await;
    let mut tasks = Vec::new();
    for _ in 0..24 {
        let (s, c, r, u, d) = (
            store.clone(),
            channel.clone(),
            rule.clone(),
            user.clone(),
            d1.clone(),
        );
        tasks.push(tokio::spawn(async move {
            s.record_offense(&c, &r, &u, 60.0, Some(&d)).await
        }));
    }
    for task in tasks {
        assert_eq!(bounded(task).await.unwrap().unwrap(), 1.0);
    }
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("1"));
    assert_eq!(get(&mut raw, &receipt1).await.as_deref(), Some("1"));
    assert!((86_390_000..=86_400_000).contains(&ttl(&mut raw, &receipt1).await));
    assert_eq!(
        bounded(store.record_offense(&channel, &rule, &user, 60.0, Some(&d2)))
            .await
            .unwrap(),
        2.0
    );
    assert_eq!(get(&mut raw, &receipt2).await.as_deref(), Some("2"));
    // Keep all telemetry flush traffic on an isolated mock endpoint, never on
    // the real fixture's shared telemetry inbox or overflow keys.
    let telemetry_endpoint = support::Endpoint::new(|_| b"+OK\r\n".to_vec());
    let telemetry = Telemetry::new(
        redis::Client::open(telemetry_endpoint.url.as_str()).unwrap(),
        "offense-test",
        true,
    );
    let telemetry_task = telemetry.start().unwrap();
    let measured = OffenseStore::with_telemetry(cache, telemetry.clone());
    let parent = TraceContext {
        trace_id: "0123456789abcdef0123456789abcdef".into(),
        span_id: "0123456789abcdef".into(),
        sampled: true,
        channel: "channel".into(),
        outcome: None,
    };
    assert_eq!(
        bounded(with_telemetry_context(
            parent,
            measured.record_offense(&channel, &rule, &user, 60.0, Some(&d1))
        ))
        .await
        .unwrap(),
        1.0
    );
    let snapshot = telemetry.snapshot();
    assert!(snapshot.spans.iter().any(|span| span.kind == "cache"
        && span.name == "eval"
        && span.context.trace_id == "0123456789abcdef0123456789abcdef"
        && span.parent_id.as_deref() == Some("0123456789abcdef")
        && span.context.channel == "channel"));
    drop(telemetry_task);
    let other = JsString::from("other-user");
    let otherkey = owned
        .own(&mut raw, offense_key(&channel, &rule, &other))
        .await;
    assert_eq!(
        bounded(store.record_offense(&channel, &rule, &other, 60.0, Some(&d1)))
            .await
            .unwrap(),
        1.0
    );
    assert_eq!(
        get(&mut raw, &otherkey).await,
        None,
        "receipt is global across counters"
    );
    let mut unique_tasks = Vec::new();
    for index in 0..8 {
        let decision = owned.decision(&format!("race-{index}"));
        let _ = owned.own(&mut raw, offense_receipt_key(&decision)).await;
        let (s, c, r, u) = (store.clone(), channel.clone(), rule.clone(), other.clone());
        unique_tasks.push(tokio::spawn(async move {
            s.record_offense(&c, &r, &u, 60.0, Some(&decision)).await
        }));
    }
    let mut counts = Vec::new();
    for task in unique_tasks {
        counts.push(bounded(task).await.unwrap().unwrap() as u32);
    }
    counts.sort_unstable();
    assert_eq!(counts, (1..=8).collect::<Vec<_>>());
    assert_eq!(get(&mut raw, &otherkey).await.as_deref(), Some("8"));
    let _: () = bounded(
        redis::cmd("SET")
            .arg(&receipt3)
            .arg("malformed")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    assert_eq!(
        bounded(store.record_offense(&channel, &rule, &user, 60.0, Some(&d3)))
            .await
            .unwrap(),
        0.0
    );
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("2"));
    del(&mut raw, &receipt3).await;
    let _: i64 = bounded(
        redis::cmd("LPUSH")
            .arg(&receipt3)
            .arg("wrongtype")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    assert!(
        bounded(store.record_offense(&channel, &rule, &user, 60.0, Some(&d3)))
            .await
            .is_err()
    );
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("2"));
    del(&mut raw, &receipt3).await;
    del(&mut raw, &counter).await;
    let _: i64 = bounded(
        redis::cmd("LPUSH")
            .arg(&counter)
            .arg("wrongtype")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    assert!(
        bounded(store.record_offense(&channel, &rule, &user, 60.0, Some(&d3)))
            .await
            .is_err()
    );
    assert_eq!(get(&mut raw, &receipt3).await, None);
    assert!(
        bounded(store.record_offense(&channel, &rule, &user, 60.0, None))
            .await
            .is_err()
    );
    del(&mut raw, &counter).await;
    // Redis Lua scripts are atomic against peers, but not rolled back on error.
    assert!(
        bounded(store.record_offense(&channel, &rule, &user, f64::NAN, Some(&d3)))
            .await
            .is_err()
    );
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("1"));
    assert_eq!(ttl(&mut raw, &counter).await, -1);
    assert_eq!(get(&mut raw, &receipt3).await, None);
    del(&mut raw, &counter).await;
    assert!(
        bounded(store.record_offense(&channel, &rule, &user, f64::NAN, None))
            .await
            .is_err()
    );
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("1"));
    assert_eq!(ttl(&mut raw, &counter).await, -1);
    del(&mut raw, &counter).await;

    let proxy = Proxy::new(&host, port);
    let via = OffenseStore::new(bounded(proxy.endpoint.manager()).await);
    // Abandon after the first INCR is applied; the owned operation still
    // receives its held reply and executes exactly one EXPIRE.
    proxy.arm(1);
    let deadline = tokio::spawn({
        let (s, c, r, u) = (via.clone(), channel.clone(), rule.clone(), user.clone());
        async move {
            tokio::time::timeout(
                Duration::from_millis(200),
                s.record_offense(&c, &r, &u, 60.0, None),
            )
            .await
        }
    });
    bounded(proxy.applied.notified()).await;
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("1"));
    assert!(bounded(deadline).await.unwrap().is_err());
    proxy.release();
    bounded(proxy.released.notified()).await;
    bounded(proxy.expired.notified()).await;
    assert!((50_000..=60_000).contains(&ttl(&mut raw, &counter).await));
    assert_eq!(proxy.writes.load(Ordering::SeqCst), 1);
    let commands = proxy.endpoint.calls.lock().unwrap().clone();
    assert_eq!(
        commands
            .iter()
            .filter(|command| command[0] == "INCR")
            .count(),
        1
    );
    assert_eq!(
        commands
            .iter()
            .filter(|command| command[0] == "EXPIRE")
            .count(),
        1
    );
    assert_eq!(
        proxy.endpoint.connections.load(Ordering::SeqCst),
        1,
        "cloned manager shares the same socket"
    );
    del(&mut raw, &counter).await;
    proxy.arm(1);
    let held = tokio::spawn({
        let (s, c, r, u, d) = (
            via.clone(),
            channel.clone(),
            rule.clone(),
            user.clone(),
            d3.clone(),
        );
        async move { s.record_offense(&c, &r, &u, 60.0, Some(&d)).await }
    });
    bounded(proxy.applied.notified()).await;
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("1"));
    assert_eq!(get(&mut raw, &receipt3).await.as_deref(), Some("1"));
    held.abort();
    let _ = held.await;
    proxy.release();
    bounded(proxy.released.notified()).await;
    assert_eq!(proxy.writes.load(Ordering::SeqCst), 2);
    del(&mut raw, &counter).await;
    del(&mut raw, &receipt3).await;
    proxy.arm(2);
    let lost = tokio::spawn({
        let (s, c, r, u, d) = (
            via.clone(),
            channel.clone(),
            rule.clone(),
            user.clone(),
            d3.clone(),
        );
        async move { s.record_offense(&c, &r, &u, 60.0, Some(&d)).await }
    });
    bounded(proxy.applied.notified()).await;
    assert!(bounded(lost).await.unwrap().is_err());
    assert_eq!(get(&mut raw, &counter).await.as_deref(), Some("1"));
    assert_eq!(get(&mut raw, &receipt3).await.as_deref(), Some("1"));
    assert_eq!(proxy.writes.load(Ordering::SeqCst), 3);
}
