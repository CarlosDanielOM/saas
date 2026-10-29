#![cfg(feature = "moderation-permit")]
//! Explicit task-owned private Dragonfly fixture only; no shared or production data.
#[path = "ai_credit_projection_support/mod.rs"]
mod support;
use dima_rust::utils::{js_string::JsString, moderation::permit::*, observability::Telemetry};
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
        .expect("fixture deadline")
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
    channel: JsString,
    keys: BTreeSet<String>,
}
impl Owned {
    async fn new(url: String, redis: &mut ConnectionManager) -> Self {
        let token = format!(
            "permit-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let claim = format!("dima:test:permit:{token}:owner");
        let acquired: Option<String> = bounded(
            redis::cmd("SET")
                .arg(&claim)
                .arg(&token)
                .arg("NX")
                .arg("EX")
                .arg(600)
                .query_async(redis),
        )
        .await
        .unwrap();
        assert_eq!(acquired.as_deref(), Some("OK"));
        Self {
            url,
            channel: JsString::from(token.as_str()),
            token,
            claim,
            keys: BTreeSet::new(),
        }
    }
    async fn own(&mut self, redis: &mut ConnectionManager, login: Option<&JsString>) -> String {
        let key = match login {
            Some(login) => permit_user_key(&self.channel, login),
            None => permit_channel_key(&self.channel),
        }
        .to_utf8_lossy();
        let exists: i64 = bounded(redis::cmd("EXISTS").arg(&key).query_async(redis))
            .await
            .unwrap();
        assert_eq!(exists, 0, "refuse pre-existing fixture key");
        assert!(self.keys.insert(key.clone()));
        key
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // Exact registered keys only, guarded by the task's unique claim.
        let cleanup = || -> redis::RedisResult<()> {
            let client = redis::Client::open(self.url.as_str())?;
            let mut connection = client.get_connection_with_timeout(Duration::from_secs(2))?;
            connection.set_read_timeout(Some(Duration::from_secs(2)))?;
            connection.set_write_timeout(Some(Duration::from_secs(2)))?;
            let owner: Option<String> =
                redis::cmd("GET").arg(&self.claim).query(&mut connection)?;
            if owner.as_deref() != Some(self.token.as_str()) {
                return Ok(());
            }
            for key in &self.keys {
                let _: i64 = redis::cmd("DEL").arg(key).query(&mut connection)?;
            }
            let _: i64 = redis::cmd("DEL").arg(&self.claim).query(&mut connection)?;
            Ok(())
        };
        if let Err(error) = cleanup() {
            eprintln!("owned permit cleanup failed: {error}");
        }
    }
}
async fn get(cache: &mut ConnectionManager, key: &str) -> Option<Vec<u8>> {
    bounded(redis::cmd("GET").arg(key).query_async(cache))
        .await
        .unwrap()
}

// The proxy forwards actual commands to the private fixture. SET modes hold or
// discard the real reply only after the real server has applied the write.
struct Proxy {
    endpoint: support::Endpoint,
    mode: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    applied: Arc<Notify>,
    released: Arc<Notify>,
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
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (m, w, a, r, g) = (
            mode.clone(),
            writes.clone(),
            applied.clone(),
            released.clone(),
            gate.clone(),
        );
        let endpoint = support::Endpoint::new(move |cmd| {
            let mut upstream = upstream.lock().unwrap();
            let (socket, reader) = &mut *upstream;
            support::write_command(socket, cmd).unwrap();
            let reply = support::read_reply(reader).unwrap();
            drop(upstream);
            if cmd[0] == "SET" {
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
                        .wait_timeout_while(lock.lock().unwrap(), LIMIT, |released| !*released)
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
async fn permit_real_transport_expiry_failures_and_uncertain_writes() {
    let (url, host, port) = support::fixture_url();
    let mut raw = manager(&url).await;
    let mut owned = Owned::new(url.clone(), &mut raw).await;
    let login = JsString::from("User");
    let user_key = owned.own(&mut raw, Some(&login)).await;
    let channel_key = owned.own(&mut raw, None).await;
    let cache = manager(&url).await;
    let store = PermitStore::new(cache.clone());
    assert!(
        !bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .unwrap()
    );
    bounded(store.grant_permit_at(&owned.channel, 5.0, Some(&login), 1_700_000_000_123.0))
        .await
        .unwrap();
    assert_eq!(
        get(&mut raw, &user_key).await,
        Some(b"1700000005123".to_vec())
    );
    let ttl: i64 = bounded(redis::cmd("TTL").arg(&user_key).query_async(&mut raw))
        .await
        .unwrap();
    assert!((1..=5).contains(&ttl));
    assert!(
        bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .unwrap()
    );
    let _: () = bounded(
        redis::cmd("SET")
            .arg(&user_key)
            .arg("")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    assert!(
        bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .unwrap()
    );
    let _: i64 = bounded(redis::cmd("DEL").arg(&user_key).query_async(&mut raw))
        .await
        .unwrap();
    bounded(store.grant_permit_at(&owned.channel, 1.0, None, 0.0))
        .await
        .unwrap();
    assert!(
        bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .unwrap()
    );
    bounded(async {
        loop {
            if get(&mut raw, &channel_key).await.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        !bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .unwrap()
    );
    let _: () = bounded(
        redis::cmd("SET")
            .arg(&user_key)
            .arg("present")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    let _: i64 = bounded(
        redis::cmd("LPUSH")
            .arg(&channel_key)
            .arg("wrongtype")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    // A channel GET error must propagate even when the user key is present.
    assert!(
        bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .is_err()
    );
    let _: i64 = bounded(redis::cmd("DEL").arg(&channel_key).query_async(&mut raw))
        .await
        .unwrap();
    let _: i64 = bounded(redis::cmd("DEL").arg(&user_key).query_async(&mut raw))
        .await
        .unwrap();
    let _: i64 = bounded(
        redis::cmd("LPUSH")
            .arg(&user_key)
            .arg("wrongtype")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    let _: () = bounded(
        redis::cmd("SET")
            .arg(&channel_key)
            .arg("present")
            .query_async(&mut raw),
    )
    .await
    .unwrap();
    assert!(
        bounded(store.has_active_permit(&owned.channel, &login))
            .await
            .is_err()
    );
    let _: i64 = bounded(redis::cmd("DEL").arg(&user_key).query_async(&mut raw))
        .await
        .unwrap();
    let _: i64 = bounded(redis::cmd("DEL").arg(&channel_key).query_async(&mut raw))
        .await
        .unwrap();
    assert!(
        bounded(store.grant_permit_at(&owned.channel, 0.0, None, 0.0))
            .await
            .is_err()
    );
    bounded(store.grant_permit_at(&owned.channel, 5.0, None, 0.0))
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..24 {
        let (store, channel, login) = (store.clone(), owned.channel.clone(), login.clone());
        tasks.push(tokio::spawn(async move {
            store.has_active_permit(&channel, &login).await
        }));
    }
    for task in tasks {
        assert!(bounded(task).await.unwrap().unwrap());
    }

    // Even a delayed telemetry tick has only a mock endpoint, never the real
    // fixture's shared telemetry inbox/overflow keys.
    let telemetry_endpoint = support::Endpoint::new(|_| b"+OK\r\n".to_vec());
    let telemetry = Telemetry::new(
        redis::Client::open(telemetry_endpoint.url.as_str()).unwrap(),
        "permit-test",
        true,
    );
    let telemetry_task = telemetry.start().unwrap();
    let measured = PermitStore::with_telemetry(cache, telemetry.clone());
    bounded(measured.has_active_permit(&owned.channel, &login))
        .await
        .unwrap();
    let metrics = telemetry.snapshot().metrics;
    assert!(
        metrics
            .iter()
            .any(|m| m.kind == "cache_lookup" && m.name == "get" && m.outcome == "hit")
    );
    assert!(
        metrics
            .iter()
            .any(|m| m.kind == "cache_lookup" && m.name == "get" && m.outcome == "miss")
    );
    drop(telemetry_task); // aborts the task without flushing to shared keys

    let proxy = Proxy::new(&host, port);
    let via = PermitStore::new(bounded(proxy.endpoint.manager()).await);
    assert!(
        bounded(via.has_active_permit(&owned.channel, &login))
            .await
            .unwrap()
    );
    let calls = proxy.endpoint.calls.lock().unwrap().clone();
    assert_eq!(calls.iter().filter(|c| c[0] == "GET").count(), 2);
    assert_eq!(
        proxy.endpoint.connections.load(Ordering::SeqCst),
        1,
        "clones share one socket"
    );
    proxy.arm(1);
    let task = tokio::spawn({
        let via = via.clone();
        let channel = owned.channel.clone();
        async move { via.grant_permit_at(&channel, 30.0, None, 11.0).await }
    });
    bounded(proxy.applied.notified()).await;
    assert_eq!(get(&mut raw, &channel_key).await, Some(b"30011".to_vec()));
    task.abort();
    let _ = task.await;
    proxy.release();
    bounded(proxy.released.notified()).await;
    assert_eq!(proxy.writes.load(Ordering::SeqCst), 1);
    proxy.arm(2);
    let failed = tokio::spawn({
        let via = via.clone();
        let channel = owned.channel.clone();
        async move { via.grant_permit_at(&channel, 30.0, None, 22.0).await }
    });
    bounded(proxy.applied.notified()).await;
    assert!(bounded(failed).await.unwrap().is_err());
    assert_eq!(get(&mut raw, &channel_key).await, Some(b"30022".to_vec()));
    assert_eq!(
        proxy.writes.load(Ordering::SeqCst),
        2,
        "no automatic replay of uncertain SET"
    );
}
