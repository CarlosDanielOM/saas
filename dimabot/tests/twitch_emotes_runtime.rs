#![cfg(feature = "twitch-emotes")]
//! Run only with the parent's task-owned, empty Redis/Mongo fixtures and source corpus.
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
    twitch_emotes::TwitchEmoteRuntime,
    twitch_tokens::{
        MongoCredentialStore, OAuthExchange, RedisTokenCache, StorageFuture, SystemTokenClock,
        TwitchTokenStorage,
    },
};
use futures_util::FutureExt;
use redis::aio::ConnectionManager;
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use test_http::{CannedResponse, Recorder};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
};

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

fn fixture_url(name: &str, hosts: &[&str]) -> String {
    let raw = std::env::var(name).expect("explicit disposable fixture URL required");
    let url = reqwest::Url::parse(&raw).expect("valid fixture URL");
    assert!(hosts.contains(&url.host_str().expect("fixture host")));
    assert!(url.username().is_empty() && url.password().is_none());
    raw
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires task-owned Redis, Mongo and actual-source corpus"]
async fn lazy_connection_failure_retry_and_shared_catalog() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration")
    );
    let dir = std::env::var("DIMA_TWITCH_EMOTES_FIXTURE_DIR").expect("source corpus directory");
    let corpus = parse_json(
        &std::fs::read_to_string(std::path::Path::new(&dir).join("twitch_emotes_cases.json"))
            .expect("source corpus"),
    )
    .unwrap();
    let cases = match corpus.get("cases").expect("source cases") {
        JsonValue::Array(cases) if !cases.is_empty() => cases,
        _ => panic!("empty source corpus"),
    };
    let oracle = cases.iter().find(|case| matches!(case.get("id"), Some(JsonValue::String(id)) if id.as_str() == Some("connectFail"))).expect("source connection failure case");
    let expected = oracle
        .get("result")
        .expect("source result")
        .to_json_string();
    let global_oracle = cases.iter().find(|case| matches!(case.get("id"), Some(JsonValue::String(id)) if id.as_str() == Some("global-connect-fail"))).expect("source global connection failure case");
    let expected_names = global_oracle
        .get("result")
        .expect("source names result")
        .to_json_string();
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
    let namespace = std::env::var("DIMA_TWITCH_EMOTES_NAMESPACE").expect("unique namespace");
    let suffix = namespace
        .strip_prefix("emotes-fixture-")
        .and_then(|s| s.strip_suffix(':'))
        .expect("namespace shape");
    assert!((8..=32).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric()));
    let namespace = format!("{namespace}runtime:");
    let channel = "9876543212361";
    let keys = [
        format!("twitch:{channel}:emote-catalog:v1"),
        "twitch:9876543212362:emote-catalog:v1".to_owned(),
        "twitch:global:tts:emotes".to_owned(),
        format!("{namespace}app:twitch:token"),
    ];
    let client = redis::Client::open(redis_url.clone()).unwrap();
    let mut cache = ConnectionManager::new(client).await.unwrap();
    let count: i64 = redis::cmd("EXISTS")
        .arg(&keys)
        .query_async(&mut cache)
        .await
        .unwrap();
    assert_eq!(count, 0, "only unused task-owned keys may be touched");
    let mongo = mongodb::Client::with_uri_str(mongo_uri).await.unwrap();
    let database = mongo.database(&format!("emotes_runtime_{suffix}"));
    assert!(database.list_collection_names().await.unwrap().is_empty());

    let http_calls = Arc::new(AtomicUsize::new(0));
    let seen_http = http_calls.clone();
    let hold: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>> = Arc::new(Mutex::new(None));
    let http_hold = hold.clone();
    let http_entered = Arc::new(Notify::new());
    let signal_http = http_entered.clone();
    let server = Recorder::start(move |request| {
        seen_http.fetch_add(1, Ordering::SeqCst);
        if request.path.starts_with("/oauth/token") {
            CannedResponse::json(
                200,
                r#"{"access_token":"fixture-app","expires_in":3600,"token_type":"bearer"}"#,
            )
        } else {
            if let Some(wait) = http_hold.lock().unwrap().take() {
                signal_http.notify_one();
                wait.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            CannedResponse::json(200, r#"{"data":[{"id":"x","name":"Wave"}]}"#)
        }
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
    let storage = Arc::new(TwitchTokenStorage::new(
        Arc::new(MongoCredentialStore::new(&database)),
        Arc::new(RedisTokenCache::with_namespace(cache.clone(), &namespace)),
        Arc::new(SlowOAuth(oauth)),
        Arc::new(SystemTokenClock::default()),
        CredentialCipher::new("fixture-only-key").unwrap(),
    ));
    // The proxy holds the handshake without touching Redis. Opening the gate
    // lets the same runtime retry against the real disposable service.
    let target = reqwest::Url::parse(&redis_url).unwrap();
    let target = format!(
        "{}:{}",
        target.host_str().unwrap(),
        target.port_or_known_default().unwrap_or(6379)
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let open = Arc::new(AtomicBool::new(false));
    let accepted = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Notify::new());
    let gate = Arc::new(Notify::new());
    let (proxy_open, proxy_count, proxy_entered, proxy_gate) = (
        open.clone(),
        accepted.clone(),
        entered.clone(),
        gate.clone(),
    );
    let proxy = tokio::spawn(async move {
        while let Ok((mut incoming, _)) = listener.accept().await {
            proxy_count.fetch_add(1, Ordering::SeqCst);
            proxy_entered.notify_one();
            let (open, gate, target) = (proxy_open.clone(), proxy_gate.clone(), target.clone());
            tokio::spawn(async move {
                loop {
                    let notified = gate.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if open.load(Ordering::SeqCst) {
                        break;
                    }
                    notified.await;
                }
                if let Ok(mut outgoing) = TcpStream::connect(target).await {
                    let _ = tokio::io::copy_bidirectional(&mut incoming, &mut outgoing).await;
                }
            });
        }
    });
    let runtime = TwitchEmoteRuntime::new(
        "fixture-client",
        endpoints,
        reqwest::Client::new(),
        storage,
        redis::Client::open(format!("redis://{addr}/")).unwrap(),
    )
    .with_connect_timeout(Duration::from_millis(200))
    .with_request_timeout(Duration::from_millis(150));
    let outcome = AssertUnwindSafe(async {
        let id = JsString::from(channel);
        let first_runtime = runtime.clone();
        let first_id = id.clone();
        let first =
            tokio::spawn(async move { first_runtime.get_channel_emote_catalog(&first_id).await });
        entered.notified().await;
        let follower_runtime = runtime.clone();
        let follower_id = id.clone();
        let follower = tokio::spawn(async move {
            follower_runtime
                .get_channel_emote_catalog(&follower_id)
                .await
        });
        first.abort();
        assert_eq!(follower.await.unwrap().to_json_string(), expected);
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            1,
            "one shared initialization"
        );
        assert_eq!(http_calls.load(Ordering::SeqCst), 0);
        let unavailable_names = runtime.get_tts_emote_names(&JsString::from("")).await;
        assert_eq!(
            JsonValue::Array(
                unavailable_names
                    .into_iter()
                    .map(JsonValue::String)
                    .collect()
            )
            .to_json_string(),
            expected_names
        );
        assert_eq!(http_calls.load(Ordering::SeqCst), 0);
        open.store(true, Ordering::SeqCst);
        gate.notify_waiters();
        let result = runtime.get_channel_emote_catalog(&id).await;
        assert_eq!(
            result.emotes.len(),
            1,
            "retry and slow app header must succeed independently of HTTP timeout"
        );
        let connections = accepted.load(Ordering::SeqCst);
        let cloned = runtime.clone();
        let (a, b) = tokio::join!(
            runtime.get_channel_emote_catalog(&id),
            cloned.get_channel_emote_catalog(&id)
        );
        assert_eq!(a.to_json_string(), b.to_json_string());
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            connections,
            "successful catalog is reused"
        );
        assert_eq!(
            http_calls.load(Ordering::SeqCst),
            2,
            "one OAuth and one catalog request"
        );
        let names = runtime.get_tts_emote_names(&id).await;
        assert_eq!(names, vec![JsString::from("Wave")]);
        let (release, receiver) = std::sync::mpsc::channel();
        *hold.lock().unwrap() = Some(receiver);
        let other = JsString::from("9876543212362");
        let leader_runtime = runtime.clone();
        let leader_id = other.clone();
        let leader =
            tokio::spawn(async move { leader_runtime.get_channel_emote_catalog(&leader_id).await });
        http_entered.notified().await;
        let follower_runtime = runtime.clone();
        let follower_id = other.clone();
        let follower = spawn_catalog(follower_runtime, follower_id);
        tokio::task::yield_now().await;
        leader.abort();
        release.send(()).unwrap();
        assert_eq!(follower.await.unwrap().emotes.len(), 1);
        assert_eq!(
            http_calls.load(Ordering::SeqCst),
            4,
            "one OAuth, global, and one request per channel"
        );
    })
    .catch_unwind()
    .await;
    let _: i64 = redis::cmd("DEL")
        .arg(&keys)
        .query_async(&mut cache)
        .await
        .unwrap();
    database.drop().await.unwrap();
    proxy.abort();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}

fn spawn_catalog(
    runtime: TwitchEmoteRuntime,
    id: JsString,
) -> tokio::task::JoinHandle<dima_rust::utils::twitch_emotes::ChannelEmoteCatalog> {
    tokio::spawn(async move { runtime.get_channel_emote_catalog(&id).await })
}
