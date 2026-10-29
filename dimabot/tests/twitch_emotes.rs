#![cfg(feature = "twitch-emotes")]
//! External source replay and concrete native adapters; ignored unless disposable
//! Redis and Mongo plus an external, pinned-Node-generated corpus are provided.

#[path = "../src/utils/test_http.rs"]
mod test_http;

use dima_rust::utils::{
    credential_crypto::CredentialCipher,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    twitch::{
        OAuthFailure, OAuthTokens, RefreshPolicy, TwitchCredentials, TwitchEndpoints,
        TwitchOAuthClient,
    },
    twitch_emotes::{CatalogStatus, EmoteClock, TwitchEmoteCatalog},
    twitch_tokens::{
        MongoCredentialStore, OAuthExchange, RedisTokenCache, StorageFuture, SystemTokenClock,
        TwitchTokenStorage,
    },
};
use futures_util::FutureExt;
use redis::aio::ConnectionManager;
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    panic::AssertUnwindSafe,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use test_http::{CannedResponse, Recorder};

struct Clock(AtomicI64);
impl EmoteClock for Clock {
    fn now_millis(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
fn field<'a>(v: &'a JsonValue, key: &str) -> &'a JsonValue {
    v.get(key).unwrap_or_else(|| panic!("missing {key}"))
}
fn array(v: &JsonValue) -> &[JsonValue] {
    match v {
        JsonValue::Array(a) => a,
        _ => panic!("expected array"),
    }
}
fn string(v: &JsonValue) -> &JsString {
    match v {
        JsonValue::String(s) => s,
        _ => panic!("expected string"),
    }
}
fn text(v: &JsonValue) -> &str {
    string(v).as_str().expect("expected valid UTF-8")
}
fn boolean(v: Option<&JsonValue>) -> bool {
    matches!(v, Some(JsonValue::Bool(true)))
}

struct SlowOAuth(TwitchOAuthClient);
impl OAuthExchange for SlowOAuth {
    fn refresh<'a>(
        &'a self,
        token: &'a str,
        id: &'a str,
        policy: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(self.0.refresh(token, id, policy))
    }
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            self.0.app_token().await
        })
    }
}

// Minimal RESP2 error endpoint, used only to induce native Redis command errors.
// It does not emulate catalog policy and never connects to any external service.
fn redis_fault_endpoint(
    fail_get: bool,
    fail_set: bool,
) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut head = String::new();
            if reader.read_line(&mut head).unwrap_or(0) == 0 {
                break;
            }
            let Some(count) = head
                .trim()
                .strip_prefix('*')
                .and_then(|n| n.parse::<usize>().ok())
            else {
                break;
            };
            let mut args = Vec::new();
            for _ in 0..count {
                let mut length = String::new();
                if reader.read_line(&mut length).unwrap_or(0) == 0 {
                    return;
                }
                let Some(length) = length
                    .trim()
                    .strip_prefix('$')
                    .and_then(|n| n.parse::<usize>().ok())
                else {
                    return;
                };
                let mut bytes = vec![0; length + 2];
                if reader.read_exact(&mut bytes).is_err() {
                    return;
                }
                bytes.truncate(length);
                args.push(String::from_utf8_lossy(&bytes).into_owned());
            }
            let command = args
                .first()
                .map(|s| s.to_ascii_uppercase())
                .unwrap_or_default();
            let _ = tx.send(command.clone());
            let response = match command.as_str() {
                "GET" if fail_get => "-ERR fixture GET rejection\r\n",
                "GET" => "$-1\r\n",
                "SET" if fail_set => "-ERR fixture SET rejection\r\n",
                "SET" | "CLIENT" => "+OK\r\n",
                "PING" => "+PONG\r\n",
                _ => "-ERR unsupported fixture command\r\n",
            };
            if stream.write_all(response.as_bytes()).is_err() {
                break;
            }
        }
    });
    (format!("redis://{address}/"), rx)
}

fn held_body_endpoint() -> (
    String,
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut input = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            if input.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
        }
        let _ =
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\nconnection: close\r\n\r\n");
        let _ = entered_tx.send(());
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
        let _ = stream.write_all(b"{\"data\":[]}");
    });
    (format!("http://{address}/"), entered_rx, release_tx)
}

fn pooled_endpoint() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let count = connections.clone();
    std::thread::spawn(move || {
        let requests = Arc::new(AtomicUsize::new(0));
        let end = Instant::now() + Duration::from_secs(5);
        while requests.load(Ordering::SeqCst) < 2 && Instant::now() < end {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    count.fetch_add(1, Ordering::SeqCst);
                    let requests = requests.clone();
                    std::thread::spawn(move || {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        loop {
                            let mut first = String::new();
                            if reader.read_line(&mut first).unwrap_or(0) == 0 {
                                break;
                            }
                            loop {
                                let mut line = String::new();
                                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                                    break;
                                }
                            }
                            requests.fetch_add(1, Ordering::SeqCst);
                            let body = b"{\"data\":[{\"id\":\"x\",\"name\":\"pool\"}]}";
                            let header = format!(
                                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: keep-alive\r\n\r\n",
                                body.len()
                            );
                            if stream
                                .write_all(header.as_bytes())
                                .and_then(|_| stream.write_all(body))
                                .is_err()
                            {
                                break;
                            }
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });
    (format!("http://{address}/"), connections)
}
fn fixture_url(name: &str, hosts: &[&str]) -> String {
    let raw = std::env::var(name).expect("explicit disposable fixture URL required");
    let url = reqwest::Url::parse(&raw).expect("valid fixture URL");
    assert!(
        hosts.contains(&url.host_str().expect("fixture host")),
        "fixture host is not allowlisted"
    );
    assert!(
        url.username().is_empty() && url.password().is_none(),
        "fixture credentials forbidden"
    );
    raw
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned source corpus and explicit disposable Redis/Mongo fixtures"]
async fn actual_source_replay_with_native_adapters() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration"),
        "explicit task-owned resource guard"
    );
    let dir =
        std::env::var("DIMA_TWITCH_EMOTES_FIXTURE_DIR").expect("external source corpus directory");
    let raw_corpus =
        std::fs::read_to_string(std::path::Path::new(&dir).join("twitch_emotes_cases.json"))
            .expect("source corpus");
    let corpus = parse_json(&raw_corpus).expect("lossless source corpus");
    let cases = array(field(&corpus, "cases"));
    assert!(!cases.is_empty(), "source corpus must be nonempty");
    let now = match field(&corpus, "fixedNowMillis") {
        JsonValue::Number(n) => *n as i64,
        _ => panic!("fixed clock"),
    };
    let mongo_uri = fixture_url(
        "DIMA_TEST_MONGO_URI",
        &[
            "127.0.0.1",
            "localhost",
            "::1",
            "keyword-mongo",
            "mongo-fixture",
            "mongo",
        ],
    );
    let redis_url = fixture_url(
        "DIMA_TEST_REDIS_URL",
        &[
            "127.0.0.1",
            "localhost",
            "::1",
            "keyword-redis",
            "redis-fixture",
        ],
    );
    let namespace =
        std::env::var("DIMA_TWITCH_EMOTES_NAMESPACE").expect("unique fixture namespace");
    let suffix = namespace
        .strip_prefix("emotes-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .expect("namespace shape");
    assert!((8..=32).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric()));
    let database_name = format!("emotes_fixture_{suffix}");
    let mongo = mongodb::Client::with_uri_str(mongo_uri).await.unwrap();
    let database = mongo.database(&database_name);
    assert!(
        database.list_collection_names().await.unwrap().is_empty(),
        "fixture database must be empty"
    );
    let manager = ConnectionManager::new(redis::Client::open(redis_url).unwrap())
        .await
        .unwrap();
    let mut connection = manager.clone();
    let mut owned = BTreeSet::new();
    owned.insert("twitch:global:tts:emotes".to_owned());
    for channel in [
        "9876543212345",
        "9876543212346",
        "9876543212347",
        "9876543212348",
        "9876543212349",
        "9876543212350",
        "9876543212352",
        "9876543212353",
        "9876543212354",
        "9876543212355",
    ] {
        owned.insert(format!("twitch:{channel}:emote-catalog:v1"));
    }
    for case in cases {
        if let Some(calls) = case.get("calls") {
            for call in array(calls) {
                let call = array(call);
                if matches!(text(&call[0]), "get" | "set") {
                    owned.insert(text(&call[1]).to_owned());
                }
            }
        }
    }
    let token_key = format!("{namespace}app:twitch:token");
    owned.insert(token_key.clone());
    let slow_namespace = format!("{namespace}slow:");
    owned.insert(format!("{slow_namespace}app:twitch:token"));
    let denied_namespace = format!("{namespace}denied:");
    owned.insert(format!("{denied_namespace}app:twitch:token"));
    let owned: Vec<String> = owned.into_iter().collect();
    let exists: i64 = redis::cmd("EXISTS")
        .arg(&owned)
        .query_async(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        exists, 0,
        "all exact source cache keys and token key must be unused in the disposable fixture"
    );
    let state = Arc::new(Mutex::new((JsonValue::Null, Vec::<String>::new())));
    let responder = state.clone();
    let gate: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>> = Arc::new(Mutex::new(None));
    let server_gate = gate.clone();
    let raw_body: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let server_raw_body = raw_body.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let server = Recorder::start(move |request| {
        if request.path.starts_with("/oauth/token") {
            return CannedResponse::json(
                200,
                r#"{"access_token":"fixture-app","expires_in":3600,"token_type":"bearer"}"#,
            );
        }
        if let Some(wait) = server_gate.lock().unwrap().take() {
            entered_tx.send(()).unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(5));
        }
        let mut state = responder.lock().unwrap();
        state.1.push(request.path.clone());
        assert_eq!(request.header("client-id"), Some("fixture-client"));
        assert_eq!(request.header("authorization"), Some("Bearer fixture-app"));
        let status = if matches!(state.0.get("ok"), Some(JsonValue::Bool(false))) {
            503
        } else {
            200
        };
        let body = server_raw_body.lock().unwrap().take().unwrap_or_else(|| {
            state
                .0
                .get("body")
                .map(JsonValue::to_json_string)
                .unwrap_or_else(|| "{\"data\":[]}".to_owned())
        });
        CannedResponse::json(status, &body)
    });
    let endpoints = TwitchEndpoints::new(
        &format!("{}/", server.base_url),
        &format!("{}/oauth/", server.base_url),
    )
    .unwrap();
    let oauth = TwitchOAuthClient::new(
        TwitchCredentials::new("fixture-client", "fixture-secret").unwrap(),
        endpoints.clone(),
        None,
    )
    .unwrap();
    let slow_storage = Arc::new(TwitchTokenStorage::new(
        Arc::new(MongoCredentialStore::new(&database)),
        Arc::new(RedisTokenCache::with_namespace(
            manager.clone(),
            &slow_namespace,
        )),
        Arc::new(SlowOAuth(oauth.clone())),
        Arc::new(SystemTokenClock::default()),
        CredentialCipher::new("fixture-only-key").unwrap(),
    ));
    let storage = Arc::new(TwitchTokenStorage::new(
        Arc::new(MongoCredentialStore::new(&database)),
        Arc::new(RedisTokenCache::with_namespace(manager.clone(), &namespace)),
        Arc::new(oauth),
        Arc::new(SystemTokenClock::default()),
        CredentialCipher::new("fixture-only-key").unwrap(),
    ));
    let clock = Arc::new(Clock(AtomicI64::new(now)));
    let http = reqwest::Client::new();
    let short_service = Arc::new(
        TwitchEmoteCatalog::new(
            "fixture-client",
            endpoints.clone(),
            http.clone(),
            storage.clone(),
            manager.clone(),
        )
        .with_clock(clock.clone())
        .with_request_timeout(Duration::from_millis(150)),
    );
    let slow_service = TwitchEmoteCatalog::new(
        "fixture-client",
        endpoints.clone(),
        http.clone(),
        slow_storage,
        manager.clone(),
    )
    .with_clock(clock.clone())
    .with_request_timeout(Duration::from_millis(150));
    let fault_endpoints = endpoints.clone();
    let fault_storage = storage.clone();
    let service = Arc::new(
        TwitchEmoteCatalog::new("fixture-client", endpoints, http, storage, manager.clone())
            .with_clock(clock.clone()),
    );
    let result = AssertUnwindSafe(async {
        let mut replayed = 0;
        for case in cases {
            let id = text(field(case, "id"));
            if id == "singleflight-cleanup" {
                continue;
            }
            let spec = field(case, "spec");
            if [
                "connectFail",
                "getFail",
                "setFail",
                "fetchFail",
                "headerFail",
                "jsonFail",
            ]
            .iter()
            .any(|k| boolean(spec.get(k)))
            {
                continue;
            }
            let non_token_keys: Vec<&String> = owned.iter().filter(|k| *k != &token_key).collect();
            let _: i64 = redis::cmd("DEL")
                .arg(&non_token_keys)
                .query_async(&mut connection)
                .await
                .unwrap();
            if let Some(JsonValue::Object(entries)) = spec.get("cache") {
                for (key, value) in entries {
                    let _: String = redis::cmd("SET")
                        .arg(key.as_str().unwrap())
                        .arg(text(value))
                        .query_async(&mut connection)
                        .await
                        .unwrap();
                }
            }
            *state.lock().unwrap() = (spec.clone(), Vec::new());
            let argument = string(field(case, "argument"));
            let actual = if text(field(case, "operation")) == "channel" {
                service
                    .get_channel_emote_catalog(argument)
                    .await
                    .to_json_string()
            } else {
                JsonValue::Array(
                    service
                        .get_tts_emote_names(argument)
                        .await
                        .into_iter()
                        .map(JsonValue::String)
                        .collect(),
                )
                .to_json_string()
            };
            assert_eq!(
                actual,
                field(case, "result").to_json_string(),
                "result and property order: {id}"
            );
            let calls = array(field(case, "calls"));
            for call in calls {
                let call = array(call);
                if text(&call[0]) == "set" {
                    let key = text(&call[1]);
                    let bytes: String = redis::cmd("GET")
                        .arg(key)
                        .query_async(&mut connection)
                        .await
                        .unwrap();
                    assert_eq!(bytes, text(&call[2]), "SET wire bytes for {id}");
                    let ttl: i64 = redis::cmd("TTL")
                        .arg(key)
                        .query_async(&mut connection)
                        .await
                        .unwrap();
                    let expected = match &call[3] {
                        JsonValue::Number(n) => *n as i64,
                        _ => panic!("ttl"),
                    };
                    assert!(
                        ttl > 0 && ttl <= expected && ttl >= expected - 2,
                        "SET TTL {id}: {ttl} vs {expected}"
                    );
                }
            }
            let mut expected_fetches: Vec<&str> = calls
                .iter()
                .map(array)
                .filter(|c| text(&c[0]) == "fetch")
                .map(|c| text(&c[1]).strip_prefix("https://fixture.invalid").unwrap())
                .collect();
            let observed = state.lock().unwrap();
            let mut actual_fetches: Vec<&str> = observed
                .1
                .iter()
                .filter(|s| !s.starts_with("/oauth/token"))
                .map(String::as_str)
                .collect();
            if text(field(case, "operation")) == "names" {
                // Promise.all preserves result order, not TCP arrival order.
                expected_fetches.sort_unstable();
                actual_fetches.sort_unstable();
            }
            assert_eq!(actual_fetches, expected_fetches, "HTTP calls {id}");
            replayed += 1;
        }
        assert!(
            replayed >= 35,
            "source replay must exercise a substantive corpus; replayed {replayed}"
        );

        // Hold one provider response until all callers are queued. Aborting the
        // first waiter must not cancel the shared operation or leak its entry.
        *state.lock().unwrap() = (
            parse_json(r#"{"body":{"data":[{"id":"one","name":"One"}]}}"#).unwrap(),
            Vec::new(),
        );
        let (release, waiting) = std::sync::mpsc::channel();
        *gate.lock().unwrap() = Some(waiting);
        let channel = JsString::from("9876543212345");
        let first_service = service.clone();
        let first_channel = channel.clone();
        let first = tokio::spawn(async move {
            first_service
                .get_channel_emote_catalog(&first_channel)
                .await
        });
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("provider request reached gate");
        let mut followers = Vec::new();
        let queued = Arc::new(AtomicUsize::new(0));
        for _ in 0..12 {
            let service = service.clone();
            let channel = channel.clone();
            let queued = queued.clone();
            followers.push(tokio::spawn(async move {
                queued.fetch_add(1, Ordering::SeqCst);
                service.get_channel_emote_catalog(&channel).await
            }));
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while queued.load(Ordering::SeqCst) != 12 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("followers queued before release");
        first.abort();
        release.send(()).unwrap();
        for follower in followers {
            let row = follower.await.unwrap();
            assert_eq!(row.emotes.len(), 1);
            assert_eq!(row.emotes[0].name, JsString::from("One"));
        }
        assert_eq!(
            state.lock().unwrap().1.len(),
            1,
            "one provider call for a shared request"
        );

        // Failed attempts write a one-minute retry marker; advancing the injected
        // wall clock permits an actual retry, while earlier calls stay cached.
        let retry_channel = JsString::from("9876543212346");
        *state.lock().unwrap() = (
            parse_json(r#"{"ok":false,"body":{"data":[]}}"#).unwrap(),
            Vec::new(),
        );
        assert!(
            service
                .get_channel_emote_catalog(&retry_channel)
                .await
                .emotes
                .is_empty()
        );
        *state.lock().unwrap() = (
            parse_json(r#"{"body":{"data":[{"id":"x","name":"retry"}]}}"#).unwrap(),
            Vec::new(),
        );
        assert!(
            service
                .get_channel_emote_catalog(&retry_channel)
                .await
                .emotes
                .is_empty()
        );
        assert!(state.lock().unwrap().1.is_empty());
        clock.0.fetch_add(60_001, Ordering::SeqCst);
        assert_eq!(
            service
                .get_channel_emote_catalog(&retry_channel)
                .await
                .emotes[0]
                .name,
            JsString::from("retry")
        );
        assert_eq!(state.lock().unwrap().1.len(), 1);

        // The bound applies to response headers too. Release the server only
        // after the call has observed its deadline, so this is deterministic.
        let (release, waiting) = std::sync::mpsc::channel();
        *gate.lock().unwrap() = Some(waiting);
        let timeout_service = short_service.clone();
        let timed = tokio::spawn(async move {
            timeout_service
                .get_channel_emote_catalog(&JsString::from("9876543212347"))
                .await
        });
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("held headers");
        let row = tokio::time::timeout(Duration::from_secs(2), timed)
            .await
            .expect("HTTP deadline")
            .unwrap();
        assert_eq!(row.status, CatalogStatus::Unavailable);
        release.send(()).unwrap();

        let (body_url, body_entered, body_release) = held_body_endpoint();
        let body_endpoints = TwitchEndpoints::new(&body_url, &body_url).unwrap();
        let body_service = TwitchEmoteCatalog::new(
            "fixture-client",
            body_endpoints,
            reqwest::Client::new(),
            fault_storage.clone(),
            manager.clone(),
        )
        .with_clock(clock.clone())
        .with_request_timeout(Duration::from_millis(150));
        let body_task = tokio::spawn(async move {
            body_service
                .get_channel_emote_catalog(&JsString::from("9876543212352"))
                .await
        });
        body_entered
            .recv_timeout(Duration::from_secs(2))
            .expect("response headers sent");
        let row = tokio::time::timeout(Duration::from_secs(2), body_task)
            .await
            .expect("body deadline")
            .unwrap();
        assert_eq!(row.status, CatalogStatus::Unavailable);
        body_release.send(()).unwrap();

        // Explicit native improvement: oversized responses fail closed.
        let huge = "x".repeat(16 * 1024 * 1024 + 1);
        *state.lock().unwrap() = (
            JsonValue::Object(vec![(
                JsString::from("body"),
                JsonValue::Object(vec![
                    (JsString::from("data"), JsonValue::Array(vec![])),
                    (
                        JsString::from("padding"),
                        JsonValue::String(JsString::from(huge)),
                    ),
                ]),
            )]),
            Vec::new(),
        );
        let row = service
            .get_channel_emote_catalog(&JsString::from("9876543212348"))
            .await;
        assert_eq!(row.status, CatalogStatus::Unavailable);

        // Deep JSON is separately rejected, even when the catalog array itself
        // is valid and the excessive depth is confined to an unused property.
        let deep = format!(
            "{{\"data\":[],\"padding\":{}0{}}}",
            "[".repeat(130),
            "]".repeat(130)
        );
        // Preserve the actual deep response as bytes, without parsing it through
        // the lossless fixture parser's intentional depth bound.
        *raw_body.lock().unwrap() = Some(deep);
        let row = service
            .get_channel_emote_catalog(&JsString::from("9876543212349"))
            .await;
        assert_eq!(row.status, CatalogStatus::Unavailable);

        // A slow token exchange happens before the emote request's 150 ms
        // deadline, so a successful exchange taking 300 ms must still succeed.
        *state.lock().unwrap() = (
            parse_json(r#"{"body":{"data":[{"id":"x","name":"slow-auth"}]}}"#).unwrap(),
            Vec::new(),
        );
        let row = slow_service
            .get_channel_emote_catalog(&JsString::from("9876543212350"))
            .await;
        assert_eq!(row.emotes[0].name, JsString::from("slow-auth"));

        // RESP fault endpoints test actual Redis driver errors. They are not
        // a claim that the dedicated Redis fixture itself produced errors.
        for (get_error, set_error) in [(true, false), (false, true)] {
            let (url, commands) = redis_fault_endpoint(get_error, set_error);
            let faulty = ConnectionManager::new(redis::Client::open(url).unwrap())
                .await
                .unwrap();
            let fault_service = TwitchEmoteCatalog::new(
                "fixture-client",
                fault_endpoints.clone(),
                reqwest::Client::new(),
                fault_storage.clone(),
                faulty,
            )
            .with_clock(clock.clone());
            let row = fault_service
                .get_channel_emote_catalog(&JsString::from("9876543212351"))
                .await;
            if get_error {
                assert_eq!(row.emotes[0].name, JsString::from("slow-auth"));
            } else {
                assert_eq!(row.status, CatalogStatus::Unavailable);
            }
            let seen: Vec<_> = commands.try_iter().collect();
            assert!(seen.iter().any(|c| c == "GET"));
            assert!(seen.iter().any(|c| c == "SET"));

            *state.lock().unwrap() = (
                parse_json(r#"{"body":{"data":[{"id":"x","name":"slow-auth"}]}}"#).unwrap(),
                Vec::new(),
            );
            let names = fault_service.get_tts_emote_names(&JsString::from("")).await;
            let oracle_id = if get_error {
                "global-get-fail"
            } else {
                "global-set-fail"
            };
            let oracle = cases
                .iter()
                .find(|case| text(field(case, "id")) == oracle_id)
                .expect("global fault source case");
            assert_eq!(
                JsonValue::Array(names.into_iter().map(JsonValue::String).collect())
                    .to_json_string(),
                field(oracle, "result").to_json_string()
            );
            let seen: Vec<_> = commands.try_iter().collect();
            let expected = if get_error {
                vec!["GET"]
            } else {
                vec!["GET", "SET"]
            };
            assert_eq!(
                seen.iter().map(String::as_str).collect::<Vec<_>>(),
                expected,
                "global GET/SET failure command boundary"
            );
            let observed = state.lock().unwrap();
            if get_error {
                assert!(observed.1.is_empty(), "global GET failure must not fetch");
            } else {
                assert_eq!(
                    observed.1.iter().map(String::as_str).collect::<Vec<_>>(),
                    ["/chat/emotes/global"],
                    "global SET failure follows one fetch"
                );
            }
        }

        let (pool_url, connections) = pooled_endpoint();
        let pool_endpoints = TwitchEndpoints::new(&pool_url, &pool_url).unwrap();
        let pooled = TwitchEmoteCatalog::new(
            "fixture-client",
            pool_endpoints,
            reqwest::Client::new(),
            fault_storage.clone(),
            manager.clone(),
        )
        .with_clock(clock.clone());
        for channel in ["9876543212353", "9876543212354"] {
            assert_eq!(
                pooled
                    .get_channel_emote_catalog(&JsString::from(channel))
                    .await
                    .emotes[0]
                    .name,
                JsString::from("pool")
            );
        }
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "two sequential requests reuse one HTTP connection"
        );

        // A closed connection without an HTTP response exercises the source's
        // fetch failure branch through the real native HTTP client.
        clock.0.store(now, Ordering::SeqCst);
        let closed_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_url = format!("http://{}/", closed_listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let _ = closed_listener.accept();
        });
        let closed_endpoints = TwitchEndpoints::new(&closed_url, &closed_url).unwrap();
        let closed_service = TwitchEmoteCatalog::new(
            "fixture-client",
            closed_endpoints,
            reqwest::Client::new(),
            fault_storage.clone(),
            manager.clone(),
        )
        .with_clock(clock.clone());
        let fetch_case = cases
            .iter()
            .find(|case| text(field(case, "id")) == "fetchFail")
            .expect("fetch failure source case");
        let row = closed_service
            .get_channel_emote_catalog(&JsString::from("9876543212355"))
            .await;
        assert_eq!(
            row.to_json_string(),
            field(fetch_case, "result").to_json_string()
        );
        let expected_set = array(field(fetch_case, "calls"))
            .iter()
            .map(array)
            .find(|call| text(&call[0]) == "set")
            .expect("source fetch failure SET");
        let closed_key = "twitch:9876543212355:emote-catalog:v1";
        let bytes: String = redis::cmd("GET")
            .arg(closed_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            bytes,
            text(&expected_set[2]),
            "source fetch failure fallback bytes"
        );
        let ttl: i64 = redis::cmd("TTL")
            .arg(closed_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert!(
            (86_398..=86_400).contains(&ttl),
            "fetch failure fallback TTL: {ttl}"
        );

        // Native OAuth failure travels through the real token storage and
        // cache adapters; no Helix request may be sent with missing headers.
        clock.0.store(now, Ordering::SeqCst);
        let denied_paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_denied = denied_paths.clone();
        let denied_server = Recorder::start(move |request| {
            observed_denied.lock().unwrap().push(request.path.clone());
            CannedResponse::json(400, r#"{"error":"invalid_client"}"#)
        });
        let denied_endpoints = TwitchEndpoints::new(
            &format!("{}/", denied_server.base_url),
            &format!("{}/oauth/", denied_server.base_url),
        )
        .unwrap();
        let denied_oauth = TwitchOAuthClient::new(
            TwitchCredentials::new("fixture-client", "fixture-secret").unwrap(),
            denied_endpoints.clone(),
            None,
        )
        .unwrap();
        let denied_storage = Arc::new(TwitchTokenStorage::new(
            Arc::new(MongoCredentialStore::new(&database)),
            Arc::new(RedisTokenCache::with_namespace(
                manager.clone(),
                &denied_namespace,
            )),
            Arc::new(denied_oauth),
            Arc::new(SystemTokenClock::default()),
            CredentialCipher::new("fixture-only-key").unwrap(),
        ));
        let denied = TwitchEmoteCatalog::new(
            "fixture-client",
            denied_endpoints,
            reqwest::Client::new(),
            denied_storage,
            manager.clone(),
        )
        .with_clock(clock.clone());
        let channel_key = "twitch:123:emote-catalog:v1";
        let global_key = "twitch:global:tts:emotes";
        let _: i64 = redis::cmd("DEL")
            .arg(&[channel_key, global_key])
            .query_async(&mut connection)
            .await
            .unwrap();
        let header_case = cases
            .iter()
            .find(|case| text(field(case, "id")) == "headerFail")
            .expect("channel header failure source case");
        let row = denied
            .get_channel_emote_catalog(&JsString::from("123"))
            .await;
        assert_eq!(
            row.to_json_string(),
            field(header_case, "result").to_json_string()
        );
        let expected_set = array(field(header_case, "calls"))
            .iter()
            .map(array)
            .find(|call| text(&call[0]) == "set")
            .expect("source fallback SET");
        let bytes: String = redis::cmd("GET")
            .arg(channel_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            bytes,
            text(&expected_set[2]),
            "source header failure fallback bytes"
        );
        let ttl: i64 = redis::cmd("TTL")
            .arg(channel_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert!(
            (86_398..=86_400).contains(&ttl),
            "channel fallback TTL: {ttl}"
        );
        assert!(
            denied
                .get_tts_emote_names(&JsString::from(""))
                .await
                .is_empty()
        );
        let bytes: String = redis::cmd("GET")
            .arg(global_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert_eq!(bytes, "[]");
        let ttl: i64 = redis::cmd("TTL")
            .arg(global_key)
            .query_async(&mut connection)
            .await
            .unwrap();
        assert!((58..=60).contains(&ttl), "global fallback TTL: {ttl}");
        let denied_token: i64 = redis::cmd("EXISTS")
            .arg(format!("{denied_namespace}app:twitch:token"))
            .query_async(&mut connection)
            .await
            .unwrap();
        assert_eq!(denied_token, 0);
        assert_eq!(
            denied_paths
                .lock()
                .unwrap()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["/oauth/token", "/oauth/token"],
            "only the two denied OAuth requests were made"
        );
        replayed
    })
    .catch_unwind()
    .await;
    let _: i64 = redis::cmd("DEL")
        .arg(&owned)
        .query_async(&mut connection)
        .await
        .unwrap();
    database.drop().await.unwrap();
    let replayed = match result {
        Ok(replayed) => replayed,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    println!(
        "TWITCH_EMOTES_METRICS source_replayed={replayed} source_skipped={} followers=12 shared_http_requests=1 pool_requests=2 pool_connections=1 auth_delay_ms=300 http_deadline_ms=150",
        cases.len() - replayed
    );
}
