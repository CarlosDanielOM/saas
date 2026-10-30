#![cfg(feature = "ai-credit-reader")]

//! Private real-service protocol tests. One serial test owns the entire fixture,
//! including the Mongo failpoint. The loopback peer uses explicit response gates.
use dima_rust::utils::{
    ai_credit_projection::PlanTier,
    ai_credit_reader::{AiCreditReader, CreditOwner},
    lossless_json::JsonValue,
    plan_cache_fence::{credits_cache_key, exhaustion_cache_keys, plan_cache_fence_key},
    polar::{PolarClient, PolarConfig, PolarPolicy},
};
use futures_util::FutureExt;
use mongodb::{
    Client,
    bson::{DateTime, Document, doc},
    options::ClientOptions,
};
use redis::aio::ConnectionManager;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

const MONGO: &str = "mongodb://keyword-mongo:27017";
const REDIS: &str = "redis://keyword-redis:6379/";
const BODY: &str = r#"{"active_meters":[{"meter_id":"5103e79b-fd74-4ba8-a287-f95574f9addf","consumed_units":42}]}"#;
const OLD: &str = "0000000000001:event";
const NEW: &str = "0000000000002:event";

#[derive(Clone, Copy)]
enum Reply {
    Ok,
    Fail,
    HoldBody,
}
struct Request {
    connection: usize,
    wire: String,
}
struct Peer {
    base: String,
    requests: mpsc::Receiver<Request>,
    replies: mpsc::Sender<Reply>,
    headers: mpsc::Receiver<()>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Peer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, requests) = mpsc::channel();
        let (replies, reply_rx) = mpsc::channel();
        let (header_tx, headers) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            let mut connections = 0;
            while !stopping.load(Ordering::SeqCst) {
                let (mut socket, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::park_timeout(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                connections += 1;
                socket
                    .set_read_timeout(Some(Duration::from_millis(50)))
                    .unwrap();
                let mut pending = Vec::new();
                while !stopping.load(Ordering::SeqCst) {
                    let mut buf = [0; 1024];
                    match socket.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => pending.extend_from_slice(&buf[..n]),
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) =>
                        {
                            continue;
                        }
                        Err(_) => break,
                    }
                    let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let wire = String::from_utf8(pending.drain(..end + 4).collect()).unwrap();
                    if request_tx
                        .send(Request {
                            connection: connections,
                            wire,
                        })
                        .is_err()
                    {
                        break;
                    }
                    let reply = loop {
                        match reply_rx.recv_timeout(Duration::from_millis(50)) {
                            Ok(reply) => break reply,
                            Err(mpsc::RecvTimeoutError::Timeout)
                                if !stopping.load(Ordering::SeqCst) =>
                            {
                                continue;
                            }
                            _ => return,
                        }
                    };
                    let (status, body) = match reply {
                        Reply::Fail => ("503 Service Unavailable", "{}"),
                        _ => ("200 OK", BODY),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                        body.len()
                    );
                    if socket.write_all(head.as_bytes()).is_err() {
                        break;
                    }
                    if matches!(reply, Reply::HoldBody) {
                        let _ = header_tx.send(());
                        // A second command releases the already-sent headers' body.
                        loop {
                            match reply_rx.recv_timeout(Duration::from_millis(50)) {
                                Ok(_) => break,
                                Err(mpsc::RecvTimeoutError::Timeout)
                                    if !stopping.load(Ordering::SeqCst) =>
                                {
                                    continue;
                                }
                                _ => return,
                            }
                        }
                    }
                    if socket.write_all(body.as_bytes()).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            base,
            requests,
            replies,
            headers,
            stop,
            thread: Some(thread),
        }
    }
    fn request(&self) -> Request {
        self.requests
            .recv_timeout(Duration::from_secs(5))
            .expect("provider request")
    }
    fn reply(&self, reply: Reply) {
        self.replies.send(reply).unwrap();
    }
    fn headers_sent(&self) {
        self.headers
            .recv_timeout(Duration::from_secs(5))
            .expect("body gate headers");
    }
    fn no_request(&self) {
        assert!(matches!(
            self.requests.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            thread.join().unwrap();
        }
    }
}
fn owner() -> CreditOwner {
    CreditOwner {
        tier: Some(PlanTier::Premium),
        customer_id: Some("customer".into()),
    }
}
fn status(value: &JsonValue, expected: &str) {
    assert_eq!(
        value.get("status"),
        Some(&JsonValue::String(expected.into()))
    );
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
async fn clear(redis: &mut ConnectionManager, keys: &[String; 4]) {
    let _: usize = redis::cmd("DEL")
        .arg(keys)
        .query_async(redis)
        .await
        .unwrap();
}
fn start_read(
    reader: AiCreditReader,
    channel: String,
    tasks: &mut Vec<tokio::task::AbortHandle>,
) -> tokio::task::JoinHandle<Result<JsonValue, String>> {
    let task = tokio::spawn(async move { reader.get_ai_credits(&owner(), &channel, true).await });
    tasks.push(task.abort_handle());
    task
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a fresh private Mongo with enableTestCommands and private Redis"]
async fn private_reader_protocol_and_races() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
        Ok(MONGO)
    );
    assert_eq!(
        std::env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
        Ok(REDIS)
    );
    let ns = std::env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
    let tail = ns
        .strip_prefix("keyword-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .unwrap();
    assert!(
        tail.len() == 12
            && tail
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    let channel = format!("{ns}credit-reader");
    let [canonical, legacy] = exhaustion_cache_keys(&channel);
    let keys = [
        credits_cache_key(&channel),
        plan_cache_fence_key(&channel),
        canonical,
        legacy,
    ];
    let mut options = ClientOptions::parse(MONGO).await.unwrap();
    options.direct_connection = Some(true);
    options.retry_reads = Some(false);
    options.retry_writes = Some(false);
    let control = Client::with_options(options.clone()).unwrap();
    let app = format!("credit-reader-{tail}");
    options.app_name = Some(app.clone());
    let client = Client::with_options(options).unwrap();
    let db = client.database(&format!("keyword_fixture_{tail}_credit_reader"));
    assert!(
        db.list_collection_names().await.unwrap().is_empty(),
        "fresh database required"
    );
    let marker = db.collection::<Document>("_owner");
    let mut redis = ConnectionManager::new(redis::Client::open(REDIS).unwrap())
        .await
        .unwrap();
    // Refuse to overwrite pre-existing task keys, even in a supposedly private fixture.
    for key in &keys {
        let n: i64 = redis::cmd("EXISTS")
            .arg(key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
    let peer = Peer::start();
    let polar = PolarClient::new(
        PolarConfig::new(&peer.base, "private-fixture-token").unwrap(),
        PolarPolicy::Billing,
    )
    .unwrap();
    let reader =
        AiCreditReader::new(redis.clone(), db.clone(), polar, Duration::from_secs(4)).unwrap();
    let users = db.collection::<Document>("users");
    let admin = control.database("admin");
    let mut tasks = Vec::new();
    marker
        .insert_one(doc! {"_id":"owner", "namespace": &ns, "owner":"dimabot-migration"})
        .await
        .unwrap();
    let outcome = std::panic::AssertUnwindSafe(async {
        // A fetched payload for the old plan must not publish after a newer fence.
        set(&mut redis, &keys[1], OLD).await;
        set(&mut redis, &keys[2], "canonical-before").await;
        set(&mut redis, &keys[3], "legacy-before").await;
        users.insert_one(doc! {"accounts":[{"type":"twitch","id":&channel}],"plan_tier":"premium","polar_sh_customer_id":"customer","polar_plan_event_at":DateTime::from_millis(1),"polar_plan_event_key":"event"}).await.unwrap();
        let task = start_read(reader.clone(), channel.clone(), &mut tasks);
        let request = peer.request();
        assert!(request.wire.starts_with("GET /v1/customers/customer/state HTTP/1.1\r\n"));
        assert!(request.wire.to_ascii_lowercase().contains("authorization: bearer private-fixture-token\r\n"));
        set(&mut redis, &keys[1], NEW).await;
        peer.reply(Reply::Ok);
        status(&task.await.unwrap().unwrap(), "unavailable");
        assert_eq!(get(&mut redis, &keys[0]).await, None);
        assert_eq!(get(&mut redis, &keys[1]).await.as_deref(), Some(NEW));
        assert_eq!(get(&mut redis, &keys[2]).await.as_deref(), Some("canonical-before"));
        assert_eq!(get(&mut redis, &keys[3]).await.as_deref(), Some("legacy-before"));

        // No Twitch owner, wrong platform, exact-customer mismatch, and a stale
        // Mongo version must all stop before the provider can be contacted.
        for accounts in [doc! {"type":"kick","id":&channel}, doc! {"type":"twitch","id":"different"}] {
            users.update_one(doc! {}, doc! {"$set":{"accounts":[accounts]}}).await.unwrap();
            status(&reader.get_ai_credits(&owner(), &channel, true).await.unwrap(), "unavailable");
            peer.no_request();
        }
        users.update_one(doc! {}, doc! {"$set":{"accounts":[{"type":"twitch","id":&channel}],"polar_sh_customer_id":"customer-extra"}}).await.unwrap();
        status(&reader.get_ai_credits(&owner(), &channel, true).await.unwrap(), "unavailable");
        peer.no_request();
        users.update_one(doc! {}, doc! {"$set":{"polar_sh_customer_id":"customer"}}).await.unwrap();
        status(&reader.get_ai_credits(&owner(), &channel, true).await.unwrap(), "unavailable");
        peer.no_request();

        // Current Mongo tier controls the projection once a matching fence exists.
        set(&mut redis, &keys[1], OLD).await;
        for (tier, limit) in [("free", 25000.0), ("pro", 800000.0)] {
            users.update_one(doc! {}, doc! {"$set":{"plan_tier":tier}}).await.unwrap();
            let task = start_read(reader.clone(), channel.clone(), &mut tasks);
            peer.request(); peer.reply(Reply::Ok);
            let value = task.await.unwrap().unwrap();
            assert_eq!(value.get("used"), Some(&JsonValue::Number(42.0)));
            assert_eq!(value.get("limit"), Some(&JsonValue::Number(limit)));
            let _: usize = redis::cmd("DEL").arg(&keys[0]).query_async(&mut redis).await.unwrap();
        }

        // The initial cache GET is outside the catch. An error reading the fence
        // inside it returns free unavailable, never a paid fallback.
        clear(&mut redis, &keys).await;
        let _: i64 = redis::cmd("HSET").arg(&keys[0]).arg("x").arg("y").query_async(&mut redis).await.unwrap();
        assert!(reader.get_ai_credits(&owner(), &channel, true).await.is_err());
        clear(&mut redis, &keys).await;
        let _: i64 = redis::cmd("HSET").arg(&keys[1]).arg("x").arg("y").query_async(&mut redis).await.unwrap();
        let value = reader.get_ai_credits(&owner(), &channel, true).await.unwrap();
        status(&value, "unavailable"); assert_eq!(value.get("limit"), Some(&JsonValue::Number(25000.0)));
        peer.no_request();
        clear(&mut redis, &keys).await;
        set(&mut redis, &keys[1], OLD).await;
        admin.run_command(doc! {"configureFailPoint":"failCommand","mode":{"times":1},"data":{"failCommands":["find"],"errorCode":12345,"appName":&app}}).await.unwrap();
        let value = reader.get_ai_credits(&owner(), &channel, true).await.unwrap();
        status(&value, "unavailable"); assert_eq!(value.get("limit"), Some(&JsonValue::Number(25000.0)));
        peer.no_request();
        admin.run_command(doc! {"configureFailPoint":"failCommand","mode":"off"}).await.unwrap();

        // Fence appears while the provider is failing: fallback rechecks it and
        // leaves both existing flags untouched.
        clear(&mut redis, &keys).await;
        set(&mut redis, &keys[2], "c").await; set(&mut redis, &keys[3], "l").await;
        let task = start_read(reader.clone(), channel.clone(), &mut tasks); peer.request();
        set(&mut redis, &keys[1], NEW).await; peer.reply(Reply::Fail);
        let value = task.await.unwrap().unwrap(); status(&value, "unavailable");
        assert_eq!(value.get("limit"), Some(&JsonValue::Number(25000.0)));
        assert_eq!(get(&mut redis, &keys[0]).await, None);
        assert_eq!(get(&mut redis, &keys[2]).await.as_deref(), Some("c"));
        assert_eq!(get(&mut redis, &keys[3]).await.as_deref(), Some("l"));

        // Both header and body stalls consume the provider-only timeout. Drop
        // and overall deadline during the provider phase must not publish.
        for mode in 0..4 {
            clear(&mut redis, &keys).await;
            let timed = reader.clone().with_provider_timeout(Duration::from_millis(400)).unwrap();
            let timed = if mode == 3 { timed.with_overall_deadline(Duration::from_millis(60)).unwrap() } else { timed };
            let task = start_read(timed, channel.clone(), &mut tasks); peer.request();
            if mode == 1 { peer.reply(Reply::HoldBody); peer.headers_sent(); }
            if mode == 2 { task.abort(); assert!(task.await.unwrap_err().is_cancelled()); }
            else if mode == 3 { assert!(task.await.unwrap().unwrap_err().contains("overall deadline")); }
            else { let value = task.await.unwrap().unwrap(); status(&value, "unavailable"); assert_eq!(value.get("limit"), Some(&JsonValue::Number(200000.0))); }
            peer.reply(Reply::Ok);
            // Request ordering is synchronized with a new request below, rather
            // than an arbitrary sleep. The server must first finish this reply.
            assert_eq!(get(&mut redis, &keys[0]).await, None);
            assert_eq!(get(&mut redis, &keys[2]).await, None);
            assert_eq!(get(&mut redis, &keys[3]).await, None);
        }

        // Clones reuse one pool: two uncached reads return on the same live TCP
        // connection, with correct method, path, token and decoded meter.
        clear(&mut redis, &keys).await;
        let first = start_read(reader.clone(), channel.clone(), &mut tasks); let a = peer.request(); peer.reply(Reply::Ok);
        assert_eq!(first.await.unwrap().unwrap().get("used"), Some(&JsonValue::Number(42.0)));
        let _: usize = redis::cmd("DEL").arg(&keys[0]).query_async(&mut redis).await.unwrap();
        let second = start_read(reader.clone(), channel.clone(), &mut tasks); let b = peer.request(); peer.reply(Reply::Ok);
        assert_eq!(second.await.unwrap().unwrap().get("used"), Some(&JsonValue::Number(42.0)));
        assert_eq!(a.connection, b.connection);
        for wire in [a.wire, b.wire] {
            assert!(wire.starts_with("GET /v1/customers/customer/state HTTP/1.1\r\n"));
            assert!(wire.to_ascii_lowercase().contains("authorization: bearer private-fixture-token\r\n"));
        }
    }).catch_unwind().await;
    // A panic may interrupt a test while a reader task is in flight. Cancel and
    // join its completion before touching keys, so it cannot publish afterward.
    for task in &tasks {
        task.abort();
    }
    while tasks.iter().any(|task| !task.is_finished()) {
        tokio::task::yield_now().await;
    }
    drop(peer);
    // Reset the server-wide failpoint even on panic, then delete exactly the
    // four owned channel keys and only the fresh database carrying our marker.
    let off = admin
        .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
        .await;
    let deleted: redis::RedisResult<usize> =
        redis::cmd("DEL").arg(&keys).query_async(&mut redis).await;
    let marker_result = marker
        .find_one(doc! {"_id":"owner", "namespace":&ns, "owner":"dimabot-migration"})
        .await;
    let drop_result = if matches!(marker_result, Ok(Some(_))) {
        Some(db.drop().await)
    } else {
        None
    };
    off.unwrap();
    deleted.unwrap();
    drop_result
        .expect("refusing to drop database without ownership marker")
        .unwrap();
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
