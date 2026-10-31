#![cfg(feature = "temporary-role-announcements")]
//! Native parity tests for `src/utils/temporary_roles_announcements.ts`.
//!
//! Pure tests need no services. The ignored suites require the lead's isolated
//! disposable Redis and loopback-only Helix recorder; they never contact Twitch
//! or a production cache. The oracle replay additionally requires the external
//! `temporary_roles_announcements_cases.json` written by the pinned Node/TS
//! fixture in `tests/fixtures/temporary_roles_announcements_reference.cjs`.
//!
//! Redis fixture contract:
//!   TEMPORARY_ROLES_ANNOUNCEMENTS_REDIS_URI=redis://fixture-redis:6379/0
//!   TEMPORARY_ROLES_ANNOUNCEMENTS_REDIS_ACK=disposable
//! Only exact keys derived from this run's unique channel markers are ever
//! deleted. Cleanup runs after a panicking test body as well as a passing one.

#[path = "support/sha256.rs"]
mod digest;
#[path = "../src/utils/test_http.rs"]
mod test_http;

use dima_rust::{
    functions::{
        CacheCommand, CacheValue, FunctionAuth, FunctionCache, FunctionFailure, FunctionFuture,
        RequestCancellation, TwitchFunctions,
        chats::send_message_plain::{CANCELLED_REASON, SEND_FAILURE, TOKEN_FAILURE},
    },
    utils::{
        logger::{
            ConsoleRecord, ConsoleSink, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
            UuidSource,
        },
        temporary_roles_announcements::{
            AnnouncementClock, BatchPlan, COMPRESSION_THRESHOLD, FlushError, PENDING_TTL_SECONDS,
            PendingAnnouncementPayload, TemporaryRole, TemporaryRoleAnnouncements, batch_plan,
            compressed_removal_message, group_pending_announcements, normalize_login,
            pending_announcements_key, single_removal_message,
        },
        twitch::{AccessToken, TWITCH_BOT_ACCOUNT_ID, TwitchAuth, TwitchClient, TwitchEndpoints},
    },
};
use redis::aio::ConnectionManager;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, VecDeque},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use test_http::{CannedResponse, RecordedRequest, Recorder};

const FIXED_NOW: &str = "2026-10-31T00:00:00.000Z";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn check(condition: bool, message: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(std::io::Error::other(message.to_owned()).into())
    }
}

// ---------------------------------------------------------------------------
// Pure source-behavior tests (no Redis, no HTTP, no environment).
// ---------------------------------------------------------------------------

#[test]
fn normalize_login_matches_source_rules() {
    assert_eq!(normalize_login("  @@SomeUser "), "someuser");
    assert_eq!(normalize_login("@"), "");
    assert_eq!(normalize_login("@@@"), "");
    assert_eq!(normalize_login(""), "");
    assert_eq!(normalize_login("\u{feff}@Name\u{00a0}"), "name");
    assert_eq!(normalize_login("mixed@Case"), "mixed@case");
}

#[test]
fn single_and_compressed_messages_match_source_text() {
    assert_eq!(
        single_removal_message(TemporaryRole::Vip, "@Alice"),
        "@alice has been removed from VIP"
    );
    assert_eq!(
        single_removal_message(TemporaryRole::Moderator, "Bob"),
        "@bob has been removed from moderator"
    );
    assert_eq!(
        single_removal_message(TemporaryRole::Vip, "   "),
        "User has been removed from VIP"
    );
    assert_eq!(
        single_removal_message(TemporaryRole::Moderator, "@@@"),
        "User has been removed from moderator"
    );
    assert_eq!(
        compressed_removal_message(TemporaryRole::Vip, 6),
        "6 users were removed from VIP"
    );
    assert_eq!(
        compressed_removal_message(TemporaryRole::Moderator, 7),
        "7 users were removed from moderator"
    );
}

#[test]
fn pending_payload_has_source_key_order_and_normalization() {
    let payload =
        PendingAnnouncementPayload::new(TemporaryRole::Vip, "  @@Alice ", "  12345  ", FIXED_NOW);
    assert_eq!(
        serde_json::to_string(&payload).unwrap(),
        format!(
            r#"{{"role":"vip","username":"alice","userID":"12345","removedAt":"{FIXED_NOW}"}}"#
        )
    );
    assert_eq!(
        pending_announcements_key("42"),
        "twitch:temporary-roles:pending-announcements:42"
    );
}

#[test]
fn grouping_skips_malformed_and_non_role_entries() {
    let items = vec![
        "not json".to_owned(),
        "null".to_owned(),
        "5".to_owned(),
        r#"{"role":"admin","username":"x"}"#.to_owned(),
        r#"{"role":1,"username":"x"}"#.to_owned(),
        r#"{"role":"vip","username":"","userID":""}"#.to_owned(),
        r#"{"role":"vip","username":"  @@Real  ","userID":"ignored"}"#.to_owned(),
        r#"{"role":"vip","username":"","userID":"  @@@Fallback_User  "}"#.to_owned(),
        r#"{"role":"moderator","username":"ModOne"}"#.to_owned(),
    ];
    let grouped = group_pending_announcements(&items);
    assert_eq!(grouped.vip, vec!["real", "fallback_user"]);
    assert_eq!(grouped.moderator, vec!["modone"]);
}

#[test]
fn grouping_dedupes_in_insertion_order_per_role() {
    let items = vec![
        r#"{"role":"moderator","username":"First"}"#.to_owned(),
        r#"{"role":"vip","username":"@@Alice"}"#.to_owned(),
        r#"{"role":"moderator","username":"@first"}"#.to_owned(),
        r#"{"role":"vip","username":"alice"}"#.to_owned(),
        r#"{"role":"vip","username":"Bob"}"#.to_owned(),
    ];
    let grouped = group_pending_announcements(&items);
    assert_eq!(grouped.vip, vec!["alice", "bob"]);
    assert_eq!(grouped.moderator, vec!["first"]);
}

#[test]
fn compression_starts_above_five_and_keeps_sequential_order() {
    let five: Vec<String> = (1..=5).map(|index| format!("user{index}")).collect();
    match batch_plan(TemporaryRole::Vip, &five) {
        BatchPlan::Individual(messages) => {
            assert_eq!(messages.len(), 5);
            assert_eq!(messages[0], "@user1 has been removed from VIP");
            assert_eq!(messages[4], "@user5 has been removed from VIP");
        }
        other => panic!("expected five individual messages, got {other:?}"),
    }
    let six: Vec<String> = (1..=6).map(|index| format!("user{index}")).collect();
    assert_eq!(
        batch_plan(TemporaryRole::Vip, &six),
        BatchPlan::Compressed("6 users were removed from VIP".into())
    );
    assert_eq!(batch_plan(TemporaryRole::Moderator, &[]), BatchPlan::Empty);
    assert_eq!(COMPRESSION_THRESHOLD, 5);
    assert_eq!(PENDING_TTL_SECONDS, 14 * 24 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Test adapters.
// ---------------------------------------------------------------------------

struct AppAuth(Arc<AtomicUsize>);

impl FunctionAuth for AppAuth {
    fn acquire<'a>(
        &'a self,
        auth: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move {
            assert_eq!(auth, &TwitchAuth::App, "plain sends use the app token");
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(AccessToken::app("fixture-app-token"))
        })
    }
}

struct TokenFailure;

impl FunctionAuth for TokenFailure {
    fn acquire<'a>(
        &'a self,
        _: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async { Err(FunctionFailure::Internal) })
    }
}

struct PanicAuth;

impl FunctionAuth for PanicAuth {
    fn acquire<'a>(
        &'a self,
        _: &'a TwitchAuth,
    ) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async { panic!("a blank message must not acquire a token") })
    }
}

/// The plain sender and the announcement queue never use `TwitchFunctions`'
/// Redis cache adapter; the queue owns its own injected Redis manager.
struct PanicCache;

impl FunctionCache for PanicCache {
    fn execute<'a>(
        &'a self,
        _: CacheCommand,
    ) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async { panic!("native Twitch function cache was unexpectedly used") })
    }
}

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<ConsoleRecord>>>);

impl ConsoleSink for Capture {
    fn write(&self, record: ConsoleRecord) -> SinkFuture<'_> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(record);
            Ok(())
        })
    }
}

fn logger_with(capture: Capture) -> Arc<Logger> {
    Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                console: Some(Arc::new(capture)),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .unwrap(),
    )
}

fn log_functions(capture: &Capture) -> Vec<String> {
    capture
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .map(|record| {
            let entry: Value = serde_json::from_str(&record.json).unwrap();
            entry
                .get("data")
                .and_then(|data| data.get("function"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

fn log_entry(capture: &Capture, index: usize) -> Value {
    let record = capture
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(index)
        .cloned()
        .expect("expected a captured console record");
    serde_json::from_str(&record.json).unwrap()
}

struct Responses {
    queue: Arc<Mutex<VecDeque<(u16, String)>>>,
    count: Arc<AtomicUsize>,
}

impl Responses {
    fn new(items: Vec<(u16, String)>) -> Self {
        Self {
            queue: Arc::new(Mutex::new(items.into_iter().collect())),
            count: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn from_static(items: &[(u16, &str)]) -> Self {
        Self::new(
            items
                .iter()
                .map(|(status, body)| (*status, (*body).to_owned()))
                .collect(),
        )
    }

    fn recorder(&self) -> Recorder {
        let queue = self.queue.clone();
        let count = self.count.clone();
        Recorder::start(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            let (status, body) = queue
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pop_front()
                .unwrap_or((500, r#"{"error":"unscripted"}"#.to_owned()));
            CannedResponse::json(status, &body)
        })
    }

    fn requests(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}

fn functions_for(
    base_url: &str,
    auth: Arc<dyn FunctionAuth>,
    logger: Option<Arc<Logger>>,
) -> TwitchFunctions {
    let endpoints = TwitchEndpoints::new(base_url, &format!("{base_url}/oauth/")).unwrap();
    let client =
        TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(5))).unwrap();
    TwitchFunctions::with_adapters(client, auth, Arc::new(PanicCache), None, logger)
}

fn functions_at(
    recorder: &Recorder,
    auth: Arc<dyn FunctionAuth>,
    logger: Option<Arc<Logger>>,
) -> TwitchFunctions {
    functions_for(&recorder.base_url, auth, logger)
}

struct FixedClock;

impl AnnouncementClock for FixedClock {
    fn now_iso8601(&self) -> String {
        FIXED_NOW.to_owned()
    }
}

fn payload(role: &str, username: &str, user_id: &str) -> String {
    json!({
        "role": role,
        "username": username,
        "userID": user_id,
        "removedAt": FIXED_NOW,
    })
    .to_string()
}

fn body_json(request: &RecordedRequest) -> TestResult<Value> {
    Ok(serde_json::from_slice(&request.body)?)
}

const SUCCESS_BODY: &str = r#"{"data":[{"is_sent":true,"message_id":"m1"}]}"#;
const HELD_BODY: &str = r#"{"data":[{"is_sent":false,"message_id":"m2"}]}"#;

// ---------------------------------------------------------------------------
// Private Redis fixture with panic-safe exact-key cleanup.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct RedisFixture {
    manager: ConnectionManager,
    owned: Arc<Mutex<BTreeSet<String>>>,
    run: String,
}

impl RedisFixture {
    async fn connect() -> TestResult<Self> {
        let uri = std::env::var("TEMPORARY_ROLES_ANNOUNCEMENTS_REDIS_URI")?;
        check(
            std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER")?.as_str() == "dimabot-migration",
            "private resource owner",
        )?;
        let url = reqwest::Url::parse(&uri)?;
        check(
            url.scheme() == "redis"
                && url.host_str() == Some("keyword-redis")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port() == Some(6379)
                && url.path() == "/0",
            "driver-owned disposable Redis alias and DB 0 required",
        )?;
        if std::env::var("TEMPORARY_ROLES_ANNOUNCEMENTS_REDIS_ACK")? != "disposable" {
            return Err(std::io::Error::other(
                "the Redis fixture must be explicitly acknowledged as disposable",
            )
            .into());
        }
        let client = redis::Client::open(uri)?;
        let manager = ConnectionManager::new(client).await?;
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        Ok(Self {
            manager,
            owned: Arc::new(Mutex::new(BTreeSet::new())),
            run: format!("{}-{nanos}", std::process::id()),
        })
    }

    fn channel(&self, label: &str) -> String {
        format!("fixture-{}-{label}", self.run)
    }

    fn register(&self, key: &str) {
        self.owned
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.to_owned());
    }

    async fn push(&self, key: &str, items: &[String]) -> TestResult {
        self.register(key);
        let mut connection = self.manager.clone();
        for item in items {
            let _: i64 = redis::cmd("RPUSH")
                .arg(key)
                .arg(item.as_str())
                .query_async(&mut connection)
                .await?;
        }
        Ok(())
    }

    async fn raw_strings(&self, key: &str) -> TestResult<Vec<String>> {
        let mut connection = self.manager.clone();
        let raw: Vec<Vec<u8>> = redis::cmd("LRANGE")
            .arg(key)
            .arg(0)
            .arg(-1)
            .query_async(&mut connection)
            .await?;
        Ok(raw
            .into_iter()
            .map(|item| String::from_utf8_lossy(&item).into_owned())
            .collect())
    }

    async fn ttl(&self, key: &str) -> TestResult<i64> {
        let mut connection = self.manager.clone();
        Ok(redis::cmd("TTL")
            .arg(key)
            .query_async(&mut connection)
            .await?)
    }

    async fn exists(&self, key: &str) -> TestResult<bool> {
        let mut connection = self.manager.clone();
        Ok(redis::cmd("EXISTS")
            .arg(key)
            .query_async::<i64>(&mut connection)
            .await?
            == 1)
    }

    async fn cleanup(&self) -> TestResult {
        let keys: Vec<String> = self
            .owned
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .cloned()
            .collect();
        let mut connection = self.manager.clone();
        for key in keys {
            let _: i64 = redis::cmd("DEL")
                .arg(key.as_str())
                .query_async(&mut connection)
                .await?;
        }
        self.owned
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        Ok(())
    }
}

/// Run a test body and always clean up this run's exact keys, even on panic.
async fn guarded<F, Fut>(fixture: RedisFixture, body: F) -> TestResult
where
    F: FnOnce(RedisFixture) -> Fut,
    Fut: Future<Output = TestResult>,
{
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    let outcome = AssertUnwindSafe(body(fixture.clone())).catch_unwind().await;
    let cleanup = fixture.cleanup().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
            Ok(())
        }
        Err(payload) => {
            let _ = cleanup;
            std::panic::resume_unwind(payload)
        }
    }
}

// ---------------------------------------------------------------------------
// Plain sender: no service needed for the blank branch.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn blank_plain_message_returns_ast_success_without_auth_or_request() {
    let service = functions_for("http://127.0.0.1:9", Arc::new(PanicAuth), None);
    let response = service.send_message_plain("channel", " \u{feff}\t").await;
    assert_eq!(
        response.to_json(),
        json!({
            "error": false,
            "message": "AST message delivered",
            "status": 200,
            "type": "success",
        })
    );
}

// ---------------------------------------------------------------------------
// Private Redis + loopback Helix integration cases.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn enqueue_pushes_source_payload_and_sets_fourteen_day_ttl() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let channel = fixture.channel("enqueue");
        let key = pending_announcements_key(&channel);
        fixture.register(&key);
        let responses = Responses::new(Vec::new());
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );

        queue
            .enqueue(&channel, TemporaryRole::Vip, "  @@Alice ", "  12345  ")
            .await?;

        let items = fixture.raw_strings(&key).await?;
        check(items.len() == 1, "exactly one queued payload")?;
        check(
            items[0]
                == format!(
                    r#"{{"role":"vip","username":"alice","userID":"12345","removedAt":"{FIXED_NOW}"}}"#
                ),
            "payload bytes",
        )?;
        let ttl = fixture.ttl(&key).await?;
        check(
            ttl > PENDING_TTL_SECONDS as i64 - 30 && ttl <= PENDING_TTL_SECONDS as i64,
            "TTL is fourteen days",
        )?;
        check(responses.requests() == 0, "enqueue sends no chat message")?;
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn flush_compresses_more_than_five_and_deletes() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let channel = fixture.channel("compressed");
        let key = pending_announcements_key(&channel);
        let items: Vec<String> = (1..=6)
            .map(|index| payload("vip", &format!("user{index}"), "ignored"))
            .collect();
        fixture.push(&key, &items).await?;
        let responses = Responses::from_static(&[(200, SUCCESS_BODY)]);
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );

        let result = queue.flush(&channel).await?;
        check(result.sent == 6, "sent counts unique logins")?;
        check(
            !fixture.exists(&key).await?,
            "successful flush deletes the key",
        )?;
        check(responses.requests() == 1, "one compressed message")?;
        let request = recorder.next(Duration::from_secs(5));
        check(request.path == "/chat/messages", "Helix chat path")?;
        check(
            request.header("authorization") == Some("Bearer fixture-app-token"),
            "app token identity",
        )?;
        check(
            request.header("client-id") == Some("fixture-client"),
            "client id",
        )?;
        let body = body_json(&request)?;
        check(
            body == json!({
                "broadcaster_id": channel,
                "sender_id": TWITCH_BOT_ACCOUNT_ID,
                "message": "6 users were removed from VIP",
                "for_source_only": true,
            }),
            "compressed body",
        )?;
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn flush_sends_individuals_in_vip_then_moderator_order() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let channel = fixture.channel("ordered");
        let key = pending_announcements_key(&channel);
        let items = vec![
            payload("moderator", "@Carol", "ignored"),
            payload("vip", "@@Alice", "ignored"),
            payload("vip", "alice", "ignored"),
            payload("vip", "Bob", "ignored"),
        ];
        fixture.push(&key, &items).await?;
        let responses = Responses::from_static(&[
            (200, SUCCESS_BODY),
            (200, SUCCESS_BODY),
            (200, SUCCESS_BODY),
        ]);
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );

        let result = queue.flush(&channel).await?;
        check(result.sent == 3, "deduplicated sent count")?;
        check(!fixture.exists(&key).await?, "successful flush deletes")?;
        check(responses.requests() == 3, "three individual messages")?;
        for expected in [
            "@alice has been removed from VIP",
            "@bob has been removed from VIP",
            "@carol has been removed from moderator",
        ] {
            let request = recorder.next(Duration::from_secs(5));
            let body = body_json(&request)?;
            check(body["message"] == expected, "sequential body order")?;
            check(body["for_source_only"] == Value::Bool(true), "source only")?;
        }
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn flush_all_invalid_items_deletes_without_sending() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let channel = fixture.channel("invalid");
        let key = pending_announcements_key(&channel);
        let items = vec![
            "not json".to_owned(),
            "null".to_owned(),
            payload("admin", "x", "y"),
            payload("vip", "", ""),
        ];
        fixture.push(&key, &items).await?;
        let responses = Responses::new(Vec::new());
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );

        let result = queue.flush(&channel).await?;
        check(result.sent == 0, "no usable logins")?;
        check(responses.requests() == 0, "no chat messages")?;
        check(
            !fixture.exists(&key).await?,
            "source deletes after empty groups",
        )?;
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn flush_empty_queue_returns_zero_without_writes() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let channel = fixture.channel("empty");
        let key = pending_announcements_key(&channel);
        fixture.register(&key);
        let responses = Responses::new(Vec::new());
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );

        let result = queue.flush(&channel).await?;
        check(result.sent == 0, "empty sent count")?;
        check(responses.requests() == 0, "no chat messages")?;
        check(!fixture.exists(&key).await?, "empty queue remains absent")?;
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn flush_stops_on_first_rejected_message_and_retains_queue() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let channel = fixture.channel("rejected");
        let key = pending_announcements_key(&channel);
        let items = vec![
            payload("vip", "alice", "ignored"),
            payload("vip", "bob", "ignored"),
            payload("vip", "carol", "ignored"),
        ];
        fixture.push(&key, &items).await?;
        let responses = Responses::from_static(&[
            (200, SUCCESS_BODY),
            (400, r#"{"error":"BadRequest","message":"second failed"}"#),
        ]);
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );

        let result = queue.flush(&channel).await;
        match result {
            Err(FlushError::Send(message)) => check(message == "second failed", "remote message")?,
            other => return Err(format!("expected a send failure, got {other:?}").into()),
        }
        check(responses.requests() == 2, "stops after the first failure")?;
        check(fixture.exists(&key).await?, "failed flush retains the key")?;
        check(
            fixture.raw_strings(&key).await? == items,
            "retains every entry",
        )?;
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires an isolated disposable Redis fixture"]
async fn flush_default_messages_and_held_moderation_retain_queue() -> TestResult {
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        // Individual default message when the remote body has no `message`.
        let channel = fixture.channel("default-individual");
        let key = pending_announcements_key(&channel);
        let items = vec![payload("vip", "alice", "ignored")];
        fixture.push(&key, &items).await?;
        let responses = Responses::from_static(&[(500, "{}")]);
        let service = functions_at(
            &responses.recorder(),
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );
        match queue.flush(&channel).await {
            Err(FlushError::Send(message)) => check(
                message == "Failed sending role removal message",
                "individual default",
            )?,
            other => return Err(format!("expected an individual failure, got {other:?}").into()),
        }
        check(fixture.exists(&key).await?, "individual failure retains")?;

        // Compressed default message.
        let channel = fixture.channel("default-compressed");
        let key = pending_announcements_key(&channel);
        let items: Vec<String> = (1..=6)
            .map(|index| payload("vip", &format!("user{index}"), "ignored"))
            .collect();
        fixture.push(&key, &items).await?;
        let responses = Responses::from_static(&[(500, "{}")]);
        let service = functions_at(
            &responses.recorder(),
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );
        match queue.flush(&channel).await {
            Err(FlushError::Send(message)) => check(
                message == "Failed sending compressed role removal message",
                "compressed default",
            )?,
            other => return Err(format!("expected a compressed failure, got {other:?}").into()),
        }
        check(fixture.exists(&key).await?, "compressed failure retains")?;

        // is_sent=false is a failure and must retain the queue.
        let channel = fixture.channel("held");
        let key = pending_announcements_key(&channel);
        let items: Vec<String> = (1..=6)
            .map(|index| payload("moderator", &format!("user{index}"), "ignored"))
            .collect();
        fixture.push(&key, &items).await?;
        let responses = Responses::from_static(&[(200, HELD_BODY)]);
        let service = functions_at(
            &responses.recorder(),
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let queue = TemporaryRoleAnnouncements::with_clock(
            fixture.manager.clone(),
            service,
            Arc::new(FixedClock),
        );
        match queue.flush(&channel).await {
            Err(FlushError::Send(message)) => check(
                message == "Message held for moderation review by Twitch",
                "held message",
            )?,
            other => return Err(format!("expected a held failure, got {other:?}").into()),
        }
        check(fixture.exists(&key).await?, "held message retains")?;
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Plain sender integration cases (loopback Helix only).
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires disposable Redis/Mongo handles and loopback OAuth/Helix"]
async fn plain_send_uses_app_token_and_exact_body() -> TestResult {
    let responses = Responses::from_static(&[(200, SUCCESS_BODY)]);
    let recorder = responses.recorder();
    let auth = Arc::new(AppAuth(Arc::new(AtomicUsize::new(0))));
    let service = functions_at(&recorder, auth.clone(), None);

    let response = service.send_message_plain("channel-1", "hello world").await;
    check(!response.error, "successful send")?;
    check(
        response.to_json()
            == json!({
                "error": false,
                "message": "Message sent",
                "status": 200,
                "type": "success",
                "data": {"is_sent": true, "message_id": "m1"},
            }),
        "success shape",
    )?;
    check(
        auth.0.load(Ordering::SeqCst) == 1,
        "one app token acquisition",
    )?;
    check(responses.requests() == 1, "single request")?;
    let request = recorder.next(Duration::from_secs(5));
    check(request.method == "POST", "POST")?;
    check(request.path == "/chat/messages", "chat path")?;
    check(
        request.header("authorization") == Some("Bearer fixture-app-token"),
        "app token",
    )?;
    check(
        request.header("client-id") == Some("fixture-client"),
        "client id",
    )?;
    check(
        body_json(&request)?
            == json!({
                "broadcaster_id": "channel-1",
                "sender_id": TWITCH_BOT_ACCOUNT_ID,
                "message": "hello world",
                "for_source_only": true,
            }),
        "request body",
    )?;
    native_app_cache_and_queue_round_trip().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires only loopback; retained as a scoped integration case"]
async fn plain_send_rejected_status_is_not_replayed() -> TestResult {
    let responses =
        Responses::from_static(&[(401, r#"{"error":"Unauthorized","message":"nope"}"#)]);
    let recorder = responses.recorder();
    let service = functions_at(
        &recorder,
        Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
        None,
    );
    let response = service.send_message_plain("channel-1", "hello").await;
    check(
        response.to_json()
            == json!({
                "error": true,
                "message": "nope",
                "status": 401,
                "type": "Unauthorized",
            }),
        "status error shape",
    )?;
    check(responses.requests() == 1, "mutation is not replayed")?;
    let _ = recorder.next(Duration::from_secs(5));
    Ok(())
}

#[tokio::test]
#[ignore = "requires only loopback; retained as a scoped integration case"]
async fn plain_send_held_moderation_shape_and_log() -> TestResult {
    let responses = Responses::from_static(&[(200, HELD_BODY)]);
    let recorder = responses.recorder();
    let capture = Capture::default();
    let service = functions_at(
        &recorder,
        Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
        Some(logger_with(capture.clone())),
    );
    let response = service.send_message_plain("channel-1", "hello").await;
    let expected = json!({
        "error": true,
        "message": "Message held for moderation review by Twitch",
        "status": 200,
        "type": "held_for_moderation",
        "reason": "Twitch held the message for moderator review (is_sent=false). Bot account may be unverified, new, or triggering AutoMod holds in this channel.",
        "data": {"is_sent": false, "message_id": "m2"},
    });
    check(response.to_json() == expected, "held shape")?;
    check(
        log_functions(&capture) == vec!["sendTwitchChatMessage.heldForModeration".to_owned()],
        "held log function",
    )?;
    let entry = log_entry(&capture, 0);
    check(entry["data"]["channelID"] == "channel-1", "log channel")?;
    check(
        entry["data"]["twitchIsSent"] == Value::Bool(false),
        "log is_sent",
    )?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires only loopback (the token path sends no request)"]
async fn plain_send_missing_token_returns_source_500_without_request() -> TestResult {
    let responses = Responses::new(Vec::new());
    let recorder = responses.recorder();
    let capture = Capture::default();
    let service = functions_at(
        &recorder,
        Arc::new(TokenFailure),
        Some(logger_with(capture.clone())),
    );
    let response = service.send_message_plain("channel-1", "hello").await;
    check(
        response.to_json()
            == json!({
                "error": true,
                "message": TOKEN_FAILURE,
                "status": 500,
                "type": "error",
                "reason": TOKEN_FAILURE,
            }),
        "token failure shape",
    )?;
    check(responses.requests() == 0, "no HTTP without an app token")?;
    check(
        log_functions(&capture) == vec!["sendTwitchChatMessage.getAppToken".to_owned()],
        "token log function",
    )?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires only loopback; retained as a scoped integration case"]
async fn plain_send_invalid_json_and_missing_data_are_caught() -> TestResult {
    let responses = Responses::from_static(&[(200, r#"{"data":[]}"#)]);
    let recorder = responses.recorder();
    let service = functions_at(
        &recorder,
        Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
        None,
    );
    check(
        service
            .send_message_plain("channel-1", "hello")
            .await
            .to_json()
            == json!({"error":false,"message":"Message sent","status":200,"type":"success"}),
        "empty source data array succeeds with omitted undefined data",
    )?;
    check(responses.requests() == 1, "empty array uses one attempt")?;
    for (body, expected_reason) in [
        ("invalid", None),
        (
            "{}",
            Some("Cannot read properties of undefined (reading '0')"),
        ),
        (
            r#"{"data":null}"#,
            Some("Cannot read properties of null (reading '0')"),
        ),
    ] {
        let responses = Responses::from_static(&[(200, body)]);
        let recorder = responses.recorder();
        let service = functions_at(
            &recorder,
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let response = service.send_message_plain("channel-1", "hello").await;
        check(response.error, "caught failure")?;
        check(
            response.message.as_ref().and_then(Value::as_str) == Some(SEND_FAILURE),
            "catch message",
        )?;
        check(response.status == 500, "catch status")?;
        check(
            response.kind.as_ref().and_then(Value::as_str) == Some("error"),
            "catch type",
        )?;
        if let Some(reason) = expected_reason {
            check(
                response.reason.as_deref() == Some(reason),
                "source-equivalent reason",
            )?;
        } else {
            check(response.reason.is_some(), "parse diagnostic present")?;
        }
        check(responses.requests() == 1, "one attempt")?;
    }
    plain_transport_disconnects_are_caught().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires only loopback (cancellation sends no request)"]
async fn plain_send_cancelled_before_http() -> TestResult {
    let responses = Responses::new(Vec::new());
    let recorder = responses.recorder();
    let auth = Arc::new(AppAuth(Arc::new(AtomicUsize::new(0))));
    let service = functions_at(&recorder, auth.clone(), None);
    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    let response = service
        .send_message_plain_with_cancellation("channel-1", "hello", Some(&cancellation))
        .await;
    check(response.error, "cancelled is an error")?;
    check(response.status == 500, "cancelled status")?;
    check(
        response.reason.as_deref() == Some(CANCELLED_REASON),
        "cancelled reason",
    )?;
    check(
        auth.0.load(Ordering::SeqCst) == 1,
        "token acquisition attempted",
    )?;
    check(responses.requests() == 0, "no late HTTP request")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Actual-source oracle replay (externally generated fixture).
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires the external source oracle fixture, pinned toolchain files, and an isolated disposable Redis"]
async fn actual_source_oracle_replay() -> TestResult {
    let path = std::path::PathBuf::from(std::env::var("TEMPORARY_ROLES_ANNOUNCEMENTS_FIXTURE")?);
    check(path.is_absolute(), "fixture path is absolute")?;
    check(
        std::fs::canonicalize(&path)? == path,
        "fixture path is canonical",
    )?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).canonicalize()?;
    check(
        !path.starts_with(root.parent().unwrap()),
        "fixture must be outside the checkout",
    )?;
    let bytes = std::fs::read(&path)?;
    check(
        digest::sha256_hex(&bytes)
            == std::env::var("TEMPORARY_ROLES_ANNOUNCEMENTS_FIXTURE_SHA256")?,
        "fixture SHA-256",
    )?;
    let oracle: Value = serde_json::from_slice(&bytes)?;
    check(oracle["schema"].as_u64() == Some(1), "fixture schema")?;
    check(
        oracle["constants"]["fixedNow"].as_str() == Some(FIXED_NOW),
        "fixed clock",
    )?;
    check(
        oracle["constants"]["ttlSeconds"].as_u64() == Some(PENDING_TTL_SECONDS),
        "TTL constant",
    )?;
    check(
        oracle["constants"]["threshold"].as_u64() == Some(COMPRESSION_THRESHOLD as u64),
        "threshold constant",
    )?;

    check(
        oracle["provenance"]["node"] == "v24.22.1"
            && oracle["provenance"]["v8"] == "13.6.233.17-node.58"
            && oracle["provenance"]["typescript"] == "5.9.3",
        "pinned oracle versions",
    )?;
    let expected_enqueue = ["enqueue-vip", "enqueue-moderator"];
    let actual_enqueue: Vec<_> = oracle["enqueue"]
        .as_array()
        .ok_or("enqueue cases array")?
        .iter()
        .map(|case| case["id"].as_str().unwrap_or_default())
        .collect();
    check(
        actual_enqueue == expected_enqueue,
        "exact nonempty enqueue case set",
    )?;
    let expected_flush = [
        "flush-empty",
        "flush-single-vip",
        "flush-userid-fallback",
        "flush-five-individual",
        "flush-six-compressed",
        "flush-mixed-order",
        "flush-dedupe",
        "flush-malformed",
        "flush-all-invalid",
        "flush-rejected",
        "flush-status-default",
        "flush-compressed-default",
        "flush-held",
        "flush-invalid-json",
        "flush-success-without-data",
    ];
    let actual_flush: Vec<_> = oracle["flush"]
        .as_array()
        .ok_or("flush cases array")?
        .iter()
        .map(|case| case["id"].as_str().unwrap_or_default())
        .collect();
    check(
        actual_flush == expected_flush,
        "exact nonempty flush case set",
    )?;
    let expected_plain = [
        "plain-empty-data",
        "plain-null-data",
        "plain-success",
        "plain-held",
        "plain-status",
        "plain-token-missing",
        "plain-blank",
        "plain-invalid-json",
        "plain-no-data",
    ];
    let actual_plain: Vec<_> = oracle["plain"]
        .as_array()
        .ok_or("plain cases array")?
        .iter()
        .map(|case| case["id"].as_str().unwrap_or_default())
        .collect();
    check(
        actual_plain == expected_plain,
        "exact nonempty plain case set",
    )?;
    let hashes = &oracle["provenance"]["hashes"];
    for (key, relative) in [
        ("helper", "src/utils/temporary_roles_announcements.ts"),
        ("chat", "src/functions/chats/send_message.chat.ts"),
        ("tokens", "src/utils/tokens.ts"),
        ("tsLogger", "src/utils/logger.ts"),
        (
            "links",
            "../archives/dimabot-typescript/2026-10-28/src/utils/links.ts",
        ),
        ("astDelivery", "src/utils/ast_command_delivery.ts"),
        ("specialParser", "src/handlers/special_parser.handler.ts"),
        ("dragonflyTs", "src/utils/databases/dragonfly.database.ts"),
        (
            "oracle",
            "tests/fixtures/temporary_roles_announcements_reference.cjs",
        ),
        ("package", "package.json"),
        ("lock", "package-lock.json"),
        (
            "nativeAnnouncements",
            "src/utils/temporary_roles_announcements.rs",
        ),
        ("nativePlain", "src/functions/chats/send_message_plain.rs"),
        ("nativeTest", "tests/temporary_roles_announcements.rs"),
        ("chatsModule", "src/functions/chats/mod.rs"),
        ("utilsModule", "src/utils/mod.rs"),
        ("cargoManifest", "Cargo.toml"),
        ("auth", "src/functions/mod.rs"),
        ("transport", "src/utils/twitch.rs"),
        ("nativeLogger", "src/utils/logger.rs"),
        ("jsCompat", "src/utils/js_compat.rs"),
        ("number", "src/utils/json_number.rs"),
        ("dragonfly", "src/utils/databases/dragonfly.database.rs"),
        ("testDigest", "tests/support/sha256.rs"),
        ("lib", "src/lib.rs"),
    ] {
        let content = std::fs::read(root.join(relative))?;
        let expected = hashes.get(key).and_then(Value::as_str).unwrap_or_default();
        check(digest::sha256_hex(&content) == expected, relative)?;
    }
    for (key, variable) in [
        ("node", "TEMPORARY_ROLES_ANNOUNCEMENTS_NODE_BINARY"),
        ("typescript", "TEMPORARY_ROLES_ANNOUNCEMENTS_TYPESCRIPT_JS"),
        (
            "typescriptPackage",
            "TEMPORARY_ROLES_ANNOUNCEMENTS_TYPESCRIPT_PACKAGE",
        ),
    ] {
        let content = std::fs::read(std::env::var(variable)?)?;
        let expected = hashes.get(key).and_then(Value::as_str).unwrap_or_default();
        check(digest::sha256_hex(&content) == expected, variable)?;
    }

    let redis = RedisFixture::connect().await?;
    guarded(redis, move |redis| async move {
        for case in oracle["enqueue"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let channel = redis.channel(&format!("oracle-enqueue-{id}"));
            let key = pending_announcements_key(&channel);
            redis.register(&key);
            let responses = Responses::new(Vec::new());
            let recorder = responses.recorder();
            let service = functions_at(
                &recorder,
                Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
                None,
            );
            let queue = TemporaryRoleAnnouncements::with_clock(
                redis.manager.clone(),
                service,
                Arc::new(FixedClock),
            );
            queue
                .enqueue(
                    &channel,
                    TemporaryRole::parse(case["role"].as_str().unwrap()).unwrap(),
                    case["username"].as_str().unwrap(),
                    case["userID"].as_str().unwrap(),
                )
                .await?;
            let items = redis.raw_strings(&key).await?;
            check(items.len() == 1, "oracle enqueue payload count")?;
            check(
                items[0] == case["payload"].as_str().unwrap(),
                "oracle enqueue payload bytes",
            )?;
            let ttl = redis.ttl(&key).await?;
            check(
                ttl > PENDING_TTL_SECONDS as i64 - 30 && ttl <= PENDING_TTL_SECONDS as i64,
                "oracle enqueue TTL",
            )?;
            check(responses.requests() == 0, "oracle enqueue sends no chat")?;
        }

        for case in oracle["flush"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let channel = redis.channel(&format!("oracle-flush-{id}"));
            let key = pending_announcements_key(&channel);
            let items: Vec<String> = case["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item.as_str().unwrap().to_owned())
                .collect();
            redis.push(&key, &items).await?;
            let script: Vec<(u16, String)> = case["responses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|response| {
                    (
                        response["status"].as_u64().unwrap() as u16,
                        response["body"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let responses = Responses::new(script);
            let recorder = responses.recorder();
            let capture = Capture::default();
            let service = functions_at(
                &recorder,
                Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
                Some(logger_with(capture.clone())),
            );
            let queue = TemporaryRoleAnnouncements::with_clock(
                redis.manager.clone(),
                service,
                Arc::new(FixedClock),
            );
            let expected = &case["expected"];
            match (expected["thrown"].as_str(), queue.flush(&channel).await) {
                (None, Ok(result)) => check(
                    result.sent == expected["sent"].as_u64().unwrap() as usize,
                    "oracle sent count",
                )?,
                (Some(thrown), Err(FlushError::Send(message))) => {
                    check(message == thrown, "oracle thrown message")?
                }
                (Some(thrown), other) => {
                    return Err(format!("{id}: expected throw {thrown:?}, got {other:?}").into());
                }
                (None, Err(error)) => {
                    return Err(format!("{id}: unexpected flush error {error}").into());
                }
            }
            let sends: Vec<&str> = expected["sends"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message.as_str().unwrap())
                .collect();
            check(
                responses.requests() == sends.len(),
                "oracle flush request count",
            )?;
            for message in sends {
                let request = recorder.next(Duration::from_secs(5));
                check(request.path == "/chat/messages", "oracle chat path")?;
                check(
                    request.header("authorization") == Some("Bearer fixture-app-token"),
                    "oracle token identity",
                )?;
                check(
                    request.header("client-id") == Some("fixture-client"),
                    "oracle client id",
                )?;
                let body = body_json(&request)?;
                check(body["message"] == message, "oracle message body")?;
                check(
                    body["for_source_only"] == Value::Bool(true),
                    "oracle source only",
                )?;
                check(
                    body["sender_id"] == TWITCH_BOT_ACCOUNT_ID,
                    "oracle bot sender",
                )?;
            }
            let logs: Vec<String> = expected["logs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|function| function.as_str().unwrap().to_owned())
                .collect();
            check(
                log_functions(&capture) == logs,
                "oracle flush log functions",
            )?;
            if let Some(retained) = expected["retained"].as_bool() {
                check(
                    redis.exists(&key).await? == retained,
                    "oracle queue retention",
                )?;
                if retained {
                    check(
                        redis.raw_strings(&key).await? == items,
                        "oracle retained bytes",
                    )?;
                }
            }
        }

        for case in oracle["plain"].as_array().unwrap() {
            // The oracle sends from its fixed `fixture-channel`; plain sends do
            // not touch Redis, so the same channel keeps the body comparison
            // exact without sharing any queue key.
            let channel = "fixture-channel";
            let script: Vec<(u16, String)> = case["responses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|response| {
                    (
                        response["status"].as_u64().unwrap() as u16,
                        response["body"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let responses = Responses::new(script);
            let recorder = responses.recorder();
            let capture = Capture::default();
            let auth: Arc<dyn FunctionAuth> = if case["tokenMissing"].as_bool().unwrap_or(false) {
                Arc::new(TokenFailure)
            } else {
                Arc::new(AppAuth(Arc::new(AtomicUsize::new(0))))
            };
            let service = functions_at(&recorder, auth, Some(logger_with(capture.clone())));
            let response = service
                .send_message_plain(channel, case["message"].as_str().unwrap())
                .await;
            let mut actual = response.to_json();
            let mut expected = case["expected"]["json"].clone();
            if case["ignoreReason"].as_bool().unwrap_or(false) {
                actual.as_object_mut().unwrap().remove("reason");
                expected.as_object_mut().unwrap().remove("reason");
            }
            check(actual == expected, "oracle plain response")?;
            let expected_requests = case["expected"]["requests"].as_array().unwrap();
            check(
                responses.requests() == expected_requests.len(),
                "oracle plain request count",
            )?;
            for expected_request in expected_requests {
                let request = recorder.next(Duration::from_secs(5));
                check(request.path == "/chat/messages", "oracle plain path")?;
                check(
                    request.header("authorization") == expected_request["authorization"].as_str(),
                    "oracle plain token",
                )?;
                check(
                    request.header("client-id") == expected_request["clientId"].as_str(),
                    "oracle plain client id",
                )?;
                check(
                    body_json(&request)? == expected_request["body"],
                    "oracle plain body",
                )?;
            }
            let logs: Vec<String> = case["expected"]["logs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|function| function.as_str().unwrap().to_owned())
                .collect();
            check(
                log_functions(&capture) == logs,
                "oracle plain log functions",
            )?;
        }
        Ok(())
    })
    .await
}

// The existing source-parity cases intentionally inject token outcomes. This
// additional round trip exercises application wiring with real native adapters.
async fn native_app_cache_and_queue_round_trip() -> TestResult {
    use dima_rust::utils::{
        credential_crypto::CredentialCipher,
        twitch::{TwitchCredentials, TwitchOAuthClient},
        twitch_streamers::{
            DirectoryConfig, MongoStreamerStore, NativeCredentials, RedisStreamerCache,
            TwitchStreamers,
        },
        twitch_tokens::{
            MongoCredentialStore, RedisTokenCache, SystemTokenClock, TwitchTokenStorage,
        },
    };
    let fixture = RedisFixture::connect().await?;
    guarded(fixture, |fixture| async move {
        let namespace = format!("{}:native:", fixture.channel("credentials"));
        let token_key = format!("{namespace}app:twitch:token");
        fixture.register(&token_key);
        let mongo_uri = std::env::var("DIMA_TEST_MONGO_URI")?;
        check(mongo_uri == "mongodb://keyword-mongo:27017", "driver-owned Mongo alias")?;
        let mongo = mongodb::Client::with_uri_str(&mongo_uri).await?;
        let database = mongo.database(&format!("announcement_native_{}", std::process::id()));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let recorder = Recorder::start(move |request| {
            recorded.lock().unwrap().push(request.clone());
            if request.path == "/oauth/token" {
                CannedResponse::json(200, r#"{"access_token":"native-app-token","expires_in":3600,"token_type":"bearer"}"#)
            } else {
                CannedResponse::json(200, SUCCESS_BODY)
            }
        });
        let endpoints = TwitchEndpoints::new(&recorder.base_url, &format!("{}/oauth/", recorder.base_url))?;
        let oauth = Arc::new(TwitchOAuthClient::new(TwitchCredentials::new("native-client", "fixture-secret")?, endpoints.clone(), Some(Duration::from_secs(5)))?);
        let clock = Arc::new(SystemTokenClock::default());
        let storage = || TwitchTokenStorage::new(
            Arc::new(MongoCredentialStore::new(&database)),
            Arc::new(RedisTokenCache::with_namespace(fixture.manager.clone(), &namespace)),
            oauth.clone(), clock.clone(), CredentialCipher::new("announcement-native-fixture").unwrap(),
        );
        let logger = logger_with(Capture::default());
        let directory = Arc::new(TwitchStreamers::new(
            Arc::new(MongoStreamerStore::new(&database)),
            Arc::new(RedisStreamerCache::with_namespace(fixture.manager.clone(), &namespace)),
            Arc::new(NativeCredentials::new(storage())?), clock.clone(), DirectoryConfig::default(),
        )?);
        let service = TwitchFunctions::native(
            TwitchClient::new("native-client", endpoints, Some(Duration::from_secs(5)))?,
            Arc::new(storage()), directory,
            redis::Client::open(std::env::var("TEMPORARY_ROLES_ANNOUNCEMENTS_REDIS_URI")?)?, database.clone(), logger,
        );
        check(!service.send_message_plain("native-channel", "cold token").await.error, "native cold OAuth send")?;
        let mut connection = fixture.manager.clone();
        let cached: String = redis::cmd("GET").arg(&token_key).query_async(&mut connection).await?;
        check(cached == "native-app-token", "native OAuth token published into actual Redis")?;
        check(fixture.ttl(&token_key).await? > 0, "app token cache has TTL")?;
        let channel = fixture.channel("native-queue");
        fixture.register(&pending_announcements_key(&channel));
        let queue = TemporaryRoleAnnouncements::with_clock(fixture.manager.clone(), service, Arc::new(FixedClock));
        queue.enqueue(&channel, TemporaryRole::Vip, "@@Native", "123").await?;
        check(queue.flush(&channel).await?.sent == 1, "queue uses native warm token")?;
        check(!fixture.exists(&pending_announcements_key(&channel)).await?, "native flush clears queue")?;
        let requests = calls.lock().unwrap();
        check(requests.len() == 3, "one OAuth exchange and two Helix messages")?;
        check(requests[0].method == "POST" && requests[0].path == "/oauth/token", "native OAuth endpoint")?;
        let form = String::from_utf8_lossy(&requests[0].body);
        check(form.contains("grant_type=client_credentials") && form.contains("client_id=native-client"), "actual OAuth grant")?;
        for request in &requests[1..] {
            check(request.path == "/chat/messages" && request.header("authorization") == Some("Bearer native-app-token") && request.header("client-id") == Some("native-client"), "native cached app identity")?;
        }
        check(body_json(&requests[2])?["message"] == "@native has been removed from VIP", "native queue message")?;
        Ok(())
    }).await
}

async fn plain_transport_disconnects_are_caught() -> TestResult {
    use std::io::{Read, Write};
    for partial_body in [false, true] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> std::io::Result<()> {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::yield_now()
                    }
                    Err(error) => return Err(error),
                }
            };
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            let mut request = [0; 4096];
            let _ = stream.read(&mut request)?;
            if partial_body {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"data\":")?;
            }
            Ok(())
        });
        let service = functions_for(
            &format!("http://{address}"),
            Arc::new(AppAuth(Arc::new(AtomicUsize::new(0)))),
            None,
        );
        let response = service.send_message_plain("disconnect", "hello").await;
        server.join().map_err(|_| "fixture server panicked")??;
        check(
            response.error
                && response.status == 500
                && response.message == Some(Value::String(SEND_FAILURE.into())),
            "real transport failure response",
        )?;
        check(
            response
                .reason
                .as_ref()
                .is_some_and(|value| !value.is_empty()),
            "native transport diagnostic present",
        )?;
    }
    Ok(())
}
