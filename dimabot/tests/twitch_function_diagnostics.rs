#![cfg(feature = "twitch-functions")]
//! Diagnostics exercised only with explicit, private fixtures; never application clients.
#[path = "../src/utils/test_http.rs"]
mod test_http;

use dima_rust::{
    functions::{
        CacheCommand, CacheValue, DetailedRequestFailure, FunctionAuth, FunctionCache,
        FunctionFailure, FunctionFuture, NativeFunctionAuth, RequestCancellation, TwitchFunctions,
    },
    utils::{
        credential_crypto::CredentialCipher,
        logger::{
            CacheRecord, CacheSink, ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture,
            SinkHandles, SystemClock, UuidSource,
        },
        twitch::{
            AccessToken, OAuthFailure, OAuthTokens, RefreshPolicy, TWITCH_BOT_ACCOUNT_ID,
            TwitchAuth, TwitchClient, TwitchEndpoints, TwitchError,
        },
        twitch_streamers::{
            DirectoryConfig, MongoStreamerStore, NativeCredentials, RedisStreamerCache,
            TwitchStreamers,
        },
        twitch_tokens::{
            MongoCredentialStore, OAuthExchange, RedisTokenCache, StorageFuture, SystemTokenClock,
            TwitchTokenStorage,
        },
    },
};
use futures_util::FutureExt;
use redis::aio::ConnectionManager;
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use test_http::{CannedResponse, Recorder};

#[derive(Default)]
struct Records {
    cache: Mutex<Vec<String>>,
    console: Mutex<Vec<String>>,
}
impl CacheSink for Records {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.cache.lock().unwrap().push(record.json.to_string());
            Ok(())
        })
    }
}
impl ConsoleSink for Records {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.console.lock().unwrap().push(record.json.to_string());
            Ok(())
        })
    }
}
fn logger(records: &Arc<Records>) -> Arc<Logger> {
    Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                cache: Some(records.clone()),
                console: Some(records.clone()),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    )
}
struct NoCache;
impl FunctionCache for NoCache {
    fn execute<'a>(
        &'a self,
        _: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async { panic!("unexpected function cache access") })
    }
}
struct Bot;
impl FunctionAuth for Bot {
    fn acquire<'a>(
        &'a self,
        _: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async { Ok(AccessToken::user("fixture-token", TWITCH_BOT_ACCOUNT_ID)) })
    }
}
struct NoOAuth;
impl OAuthExchange for NoOAuth {
    fn refresh<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async { panic!("unexpected refresh") })
    }
    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async { panic!("unexpected app token") })
    }
}
fn client(base: &str) -> TwitchClient {
    TwitchClient::new(
        "fixture-client",
        TwitchEndpoints::new(base, base).unwrap(),
        Some(Duration::from_secs(2)),
    )
    .unwrap()
}
fn service(base: &str, auth: Arc<dyn FunctionAuth>, logger: Arc<Logger>) -> TwitchFunctions {
    TwitchFunctions::with_adapters(client(base), auth, Arc::new(NoCache), None, Some(logger))
}

#[tokio::test]
async fn detailed_request_and_delete_diagnostics_are_redacted() {
    let records = Arc::new(Records::default());
    let recorder = Recorder::start(|_| CannedResponse::json(400, "{secret-body"));
    let service = service(&recorder.base_url, Arc::new(Bot), logger(&records));
    let result = service
        .delete_message("message", "channel", "actor")
        .await
        .unwrap();
    assert_eq!(
        result.to_json_string(),
        "{\"error\":true,\"message\":\"Internal server error\",\"status\":500,\"type\":\"error\"}"
    );
    let log = records.console.lock().unwrap().join("\n");
    assert!(log.contains("Invalid JSON response body"));
    assert!(log.contains("stack"));
    assert!(!log.contains("secret-body"));
    let cancelled = RequestCancellation::new();
    cancelled.cancel();
    assert!(matches!(
        service
            .request_detailed(
                TwitchAuth::Bot,
                reqwest::Method::GET,
                "users",
                None,
                None,
                Some(&cancelled)
            )
            .await,
        Err(DetailedRequestFailure::Cancelled)
    ));
    assert!(matches!(
        service
            .request_detailed(
                TwitchAuth::Bot,
                reqwest::Method::GET,
                "/secret-url",
                None,
                None,
                None
            )
            .await,
        Err(DetailedRequestFailure::Twitch(TwitchError::InvalidEndpoint))
    ));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let unreachable = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let unreachable_service = self::service(&unreachable, Arc::new(Bot), logger(&records));
    assert!(matches!(
        unreachable_service
            .request_detailed(
                TwitchAuth::Bot,
                reqwest::Method::GET,
                "users",
                None,
                None,
                None
            )
            .await,
        Err(DetailedRequestFailure::Twitch(TwitchError::Transport))
    ));
    let _ = unreachable_service
        .delete_message("message", "channel", "actor")
        .await
        .unwrap();
    let log = records.console.lock().unwrap().join("\n");
    assert!(log.contains("Twitch connection interrupted"));
    assert!(!log.contains(&unreachable));
    // Advertise a longer body than is delivered, then disconnect after headers.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let disconnected = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
        }
        stream.write_all(b"HTTP/1.1 400 Broken\r\nContent-Length: 100\r\nConnection: close\r\n\r\nsecret-body").unwrap();
    });
    let disconnected_service = self::service(&disconnected, Arc::new(Bot), logger(&records));
    let result = disconnected_service
        .delete_message("message", "channel", "actor")
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(
        result.to_json_string(),
        "{\"error\":true,\"message\":\"Internal server error\",\"status\":500,\"type\":\"error\"}"
    );
    let log = records.console.lock().unwrap().join("\n");
    assert!(log.contains("Twitch response body could not be read"));
    assert!(
        !log.contains("secret-body")
            && !log.contains(&disconnected)
            && !log.contains("fixture-token")
    );
}

async fn owned_keys(connection: &mut ConnectionManager, namespace: &str) -> Vec<String> {
    let mut cursor = 0u64;
    let mut keys = Vec::new();
    for _ in 0..4096 {
        let (next, page): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("{namespace}*"))
            .arg("COUNT")
            .arg(128)
            .query_async(connection)
            .await
            .unwrap();
        assert!(page.iter().all(|key| key.starts_with(namespace)));
        keys.extend(page);
        assert!(keys.len() <= 8192);
        cursor = next;
        if cursor == 0 {
            return keys;
        }
    }
    panic!("fixture scan exceeded limit")
}
fn hset_calls(info: &str) -> u64 {
    info.lines()
        .find_map(|line| line.strip_prefix("cmdstat_hset:calls="))
        .and_then(|line| line.split(',').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

#[tokio::test]
#[ignore = "requires owner-labelled private keyword-mongo and keyword-redis fixtures"]
async fn native_bot_auth_diagnostics_and_mirror() {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("twitch-function-diagnostics")
    );
    assert_eq!(
        std::env::var("TWITCH_DIAGNOSTICS_MONGO_URI").as_deref(),
        Ok("mongodb://keyword-mongo:27017")
    );
    assert_eq!(
        std::env::var("TWITCH_DIAGNOSTICS_REDIS_URL").as_deref(),
        Ok("redis://keyword-redis:6379/")
    );
    let namespace = std::env::var("TWITCH_DIAGNOSTICS_NAMESPACE").expect("unique namespace");
    let token = namespace
        .strip_prefix("twitch-diagnostics-")
        .and_then(|s| s.strip_suffix(':'))
        .expect("fixture namespace shape");
    assert!((6..=32).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric()));
    let database_name = format!("twitch_diagnostics_{token}");
    let mongo = mongodb::Client::with_uri_str("mongodb://keyword-mongo:27017")
        .await
        .unwrap();
    let database = mongo.database(&database_name);
    assert!(database.list_collection_names().await.unwrap().is_empty());
    let redis = redis::Client::open("redis://keyword-redis:6379/").unwrap();
    let connection = ConnectionManager::new(redis).await.unwrap();
    let mut raw = connection.clone();
    assert!(owned_keys(&mut raw, &namespace).await.is_empty());
    let result = AssertUnwindSafe(async {
        let clock = Arc::new(SystemTokenClock::default());
        let make_storage = || TwitchTokenStorage::new(Arc::new(MongoCredentialStore::new(&database)), Arc::new(RedisTokenCache::with_namespace(connection.clone(), &namespace)), Arc::new(NoOAuth), clock.clone(), CredentialCipher::new("diagnostic-fixture").unwrap());
        let tokens = Arc::new(make_storage());
        let directory = Arc::new(TwitchStreamers::new(Arc::new(MongoStreamerStore::new(&database)), Arc::new(RedisStreamerCache::with_namespace(connection.clone(), &namespace)), Arc::new(NativeCredentials::new(make_storage()).unwrap()), clock, DirectoryConfig::default()).unwrap());
        let records = Arc::new(Records::default());
        let requests = Arc::new(AtomicUsize::new(0));
        let request_count = requests.clone();
        let recorder = Recorder::start(move |_| { request_count.fetch_add(1, Ordering::SeqCst); CannedResponse::json(204, "") });
        let service = service(&recorder.base_url, Arc::new(NativeFunctionAuth::new(tokens, directory, logger(&records))), logger(&records));
        let missing = service.delete_message("message", "channel", "actor").await.unwrap();
        assert_eq!(missing.to_json_string(), "{\"error\":true,\"message\":\"Bot's account does not have the permissions required\",\"status\":403,\"type\":\"error\"}");
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        let logs = records.cache.lock().unwrap().join("\n");
        assert!(logs.contains("bot_token_unavailable") && logs.contains(TWITCH_BOT_ACCOUNT_ID));
        assert!(records.console.lock().unwrap().join("\n").contains("bot_token_unavailable"));
        let account = format!("{namespace}accounts:twitch:{TWITCH_BOT_ACCOUNT_ID}:data");
        let mirror = format!("{namespace}app:twitch:bot");
        let _: i64 = redis::cmd("HSET").arg(&account).arg("access_token").arg("fixture-token").arg("refresh_token").arg("fixture-refresh").arg("expires_at").arg("4102444800").arg("has_permissions").arg("true").arg("up_to_date_permissions").arg("true").query_async(&mut raw).await.unwrap();
        let before: String = redis::cmd("INFO").arg("commandstats").query_async(&mut raw).await.unwrap();
        let ok = service.delete_message("message", "channel", "actor").await.unwrap();
        assert_eq!(ok.to_json_string(), "{\"error\":false,\"message\":\"Message deleted\"}");
        let after: String = redis::cmd("INFO").arg("commandstats").query_async(&mut raw).await.unwrap();
        assert_eq!(hset_calls(&after) - hset_calls(&before), 1, "one mirror HSET on the private Redis instance");
        let value: String = redis::cmd("HGET").arg(&mirror).arg("access_token").query_async(&mut raw).await.unwrap();
        assert_eq!(value, "fixture-token");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let _: i64 = redis::cmd("DEL").arg(&mirror).query_async(&mut raw).await.unwrap();
        let _: String = redis::cmd("SET").arg(&mirror).arg("wrong-type").query_async(&mut raw).await.unwrap();
        let failed = service.delete_message("message", "channel", "actor").await.unwrap();
        assert_eq!(failed.to_json_string(), "{\"error\":true,\"message\":\"Bot's account does not have the permissions required\",\"status\":403,\"type\":\"error\"}");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let logs = records.cache.lock().unwrap().join("\n");
        assert!(logs.contains("bot_token_exception") && logs.contains("CacheUnavailable"));
        assert!(!logs.contains("fixture-token") && !logs.contains("WRONGTYPE"));
    }).catch_unwind().await;
    let keys = owned_keys(&mut raw, &namespace).await;
    if !keys.is_empty() {
        let _: i64 = redis::cmd("DEL")
            .arg(keys)
            .query_async(&mut raw)
            .await
            .unwrap();
    }
    database.drop().await.unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[path = "support/sha256.rs"]
mod digest;
#[tokio::test]
#[ignore = "requires independently generated external TypeScript source-policy oracle"]
async fn actual_source_bot_wrapper_policy_oracle() {
    let path = std::path::PathBuf::from(
        std::env::var("TWITCH_DIAGNOSTICS_ORACLE").expect("oracle fixture path"),
    );
    assert!(path.is_absolute() && std::fs::canonicalize(&path).unwrap() == path);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .unwrap();
    assert!(!path.starts_with(root.parent().unwrap()));
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        digest::sha256_hex(&bytes),
        std::env::var("TWITCH_DIAGNOSTICS_ORACLE_SHA256").unwrap()
    );
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["schema"], 1);
    assert_eq!(
        fixture["versions"],
        serde_json::json!({"node":"24.22.1","v8":"13.6.233.17-node.58","icu":"78.3","unicode":"17.0","typescript":"5.9.3"})
    );
    assert_eq!(
        fixture["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(
        fixture["boundary"],
        "actual declarations with mocked class, cache, logger and notification boundaries; class-throw is synthetic because the real class catches lookup errors"
    );
    let files = [
        "src/utils/tokens.ts",
        "src/utils/header.ts",
        "src/functions/chats/delete_message.chat.ts",
        "src/functions/mod.rs",
        "src/utils/tokens.rs",
        "src/functions/chats/delete_message.chat.rs",
        "src/utils/test_http.rs",
        "tests/twitch_function_diagnostics.rs",
        "tests/support/sha256.rs",
        "tests/fixtures/twitch_function_diagnostics_reference.cjs",
        "tests/fixtures/twitch_functions_cases.json",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "package.json",
        "package-lock.json",
    ];
    assert_eq!(fixture["hashes"].as_object().unwrap().len(), files.len());
    for file in files {
        assert_eq!(
            fixture["hashes"][file].as_str().unwrap(),
            digest::sha256_hex(&std::fs::read(root.join(file)).unwrap())
        );
    }
    let account = serde_json::json!(["account", "698614112", "twitch"]);
    let notify = serde_json::json!([
        "notify",
        "Bot does not have valid authentication. Please authorize the bot account.",
        "error"
    ]);
    let denied = serde_json::json!({"error":true,"message":"Bot's account does not have the permissions required"});
    let options = serde_json::json!({"channelId":"698614112","destination":"both"});
    let missing_log = serde_json::json!(["log", {"function":"getBotToken","userId":"698614112","action":"bot_token_unavailable","reason":"getAccountTokenById returned null for the bot account; bot-executed features (moderation, clips, shoutouts) will fail until the bot reauthorizes"}, options]);
    let exception_log = |reason: &str| serde_json::json!(["log", {"function":"getBotToken","userId":"698614112","action":"bot_token_exception","reason":reason}, {"channelId":"698614112","destination":"both"}]);
    let client = serde_json::json!(["client", "Tokens"]);
    let mirror = serde_json::json!(["hSet", "app:twitch:bot", "access_token", "fixture-token"]);
    let expected = serde_json::json!([
        {"mode":"missing","response":denied,"calls":[account,missing_log,notify]},
        {"mode":"success","response":{"error":false,"message":"Success","header":{"Client-Id":"fixture-client","Authorization":"Bearer fixture-token","Content-Type":"application/json"}},"calls":[account,client,mirror]},
        {"mode":"mirror-throw","response":denied,"calls":[account,client,mirror,exception_log("fixture mirror error"),notify]},
        {"mode":"class-throw","response":denied,"calls":[account,exception_log("fixture class error"),notify]}
    ]);
    assert_eq!(fixture["cases"], expected);
}
