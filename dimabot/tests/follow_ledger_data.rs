#![cfg(feature = "follow-ledger-data")]
//! Native parity tests for `src/schemas/follow_relationship_ledger.schema.ts`,
//! `src/utils/follow_ledger.ts` and `src/utils/follow_ledger_queue.ts`.
//!
//! The pure tests need no service, no environment value and no network. The
//! `#[ignore]` suites require lead-owned, disposable infrastructure and never
//! contact Twitch or a production service:
//!
//! ```text
//! FOLLOW_LEDGER_TEST_MONGO_URI=mongodb://127.0.0.1:27017
//! FOLLOW_LEDGER_TEST_MONGO_DATABASE=rust_follow_ledger_fixture_<unique>
//! FOLLOW_LEDGER_TEST_MONGO_ACK=disposable
//! FOLLOW_LEDGER_TEST_REDIS_URI=redis://127.0.0.1:6379/0
//! FOLLOW_LEDGER_TEST_REDIS_ACK=disposable
//! ```
//!
//! `..._MONGO_DATABASE` must start with `rust_follow_ledger_fixture_` and must be
//! empty; the suite drops that database at the end. The Helix side is the local
//! loopback recorder from `src/utils/test_http.rs`, so no Twitch endpoint, token
//! or route is involved. The Redis suite removes only the exact queue payload it
//! enqueued plus the follow-ledger dedupe key it created; the instance must
//! still be disposable because `cron:jobs:queue` is shared with the cron
//! transport.
//!
//! ## Follow-start transaction suite (replica set required)
//!
//! `recordFollowLedgerStart` is transactional on a replica set and falls back to
//! the source's session-less branch on a standalone server. The standalone
//! fallback is covered by `collector_sync_and_follow_start_against_disposable_mongo`
//! (any plain `mongod` works). The transactional branch needs a single-node
//! replica set:
//!
//! ```text
//! FOLLOW_LEDGER_TEST_RS_MONGO_URI=mongodb://127.0.0.1:27018/?directConnection=true
//! FOLLOW_LEDGER_TEST_RS_MONGO_DATABASE=rust_follow_ledger_rs_fixture_<unique>
//! FOLLOW_LEDGER_TEST_RS_ACK=replica-set
//! ```
//!
//! Ordering before the test runs: start `mongod --replSet rs0 --port 27018
//! --dbpath <private>`, run `rs.initiate()` once, and wait until
//! `db.hello().isWritablePrimary` is true. The test does not assume the topology:
//! it reads `hello.setName` and fails loudly when the fixture is standalone.
//! `directConnection=true` keeps the driver on that single node. The database
//! name must start with `rust_follow_ledger_rs_fixture_`, must be empty, and is
//! dropped by the suite; no other cleanup is required.

#[path = "../src/utils/test_http.rs"]
mod test_http;

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use dima_rust::{
    schemas::{
        Field, FieldDefault as D, FieldType as T, SchemaDefinition,
        follow_relationship_ledger::{self as ledger_schema, EndedReason, FollowPlatform, FollowStatus},
    },
    utils::{
        cron_queue::{
            CRON_JOBS_QUEUE_KEY, CronQueueClock, CronQueueConfig, RedisCronQueue,
            serialize_cron_queue_job,
        },
        credential_crypto::CredentialCipher,
        follow_ledger::{
            DEFAULT_BATCH_SIZE, DEFAULT_PLATFORM, FollowLedgerDate, FollowLedgerFuture,
            FollowLedgerService, FollowLedgerStreamer, FollowLedgerStreamerDirectory,
            FollowLedgerSyncOptions, FollowLedgerSyncStats, FollowStartWriteMode,
            FOLLOW_START_MAX_ATTEMPTS, HELIX_PAGE_SIZE, INVALID_CHANNEL_MESSAGE, PLATFORM_TWITCH,
            RecordFollowLedgerStartInput, SYNC_COMPLETE_MESSAGE, SharedTwitchTokens,
            followed_params, followers_params, form_encode, next_cursor,
        },
        follow_ledger_queue::{
            FOLLOW_LEDGER_DEFAULT_REASON, FOLLOW_LEDGER_JOB_NAME,
            FOLLOW_LEDGER_QUEUE_DEDUPE_ENV, FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX, SystemQueueClock,
            enqueue_follow_ledger_sync_job_with_defaults, follow_ledger_queue_dedupe_seconds,
            follow_ledger_queue_dedupe_seconds_from, get_follow_ledger_dedupe_key,
            javascript_iso_millis, normalize_value,
        },
        twitch::{
            AccessToken, OAuthFailure, OAuthTokens, RefreshFailureKind, RefreshPolicy, TokenFuture,
            TokenSource, TwitchAuth, TwitchClient, TwitchEndpoints,
        },
        twitch_streamers::StreamerCredentials,
        twitch_tokens::{
            CachedAccount, CredentialStore, OAuthExchange, StorageFuture, StoredAccount, TokenCache,
            TokenClock, TokenStorageError, TwitchTokenStorage,
        },
    },
};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Value, json};
use test_http::{CannedResponse, RecordedRequest, Recorder};

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

fn field<'a>(definition: &'a SchemaDefinition, name: &str) -> &'a Field {
    definition
        .fields
        .iter()
        .find(|field| field.name == name)
        .unwrap_or_else(|| panic!("schema field {name}"))
}

#[test]
fn schema_matches_source_model_fields_defaults_and_indexes() {
    let definition = ledger_schema::schema();
    assert_eq!(definition.model, "follow_relationship_ledger");
    // Mongoose pluralises the model name; the follow-defense projector already
    // reads `follow_relationship_ledgers`.
    assert_eq!(definition.collection, "follow_relationship_ledgers");
    assert!(!definition.string_id);
    assert!(definition.version_key);
    assert!(!definition.write_concern_journaled);
    assert_eq!(definition.timestamps, Some(("created_at", "updated_at")));
    assert_eq!(definition.save_clock_field, None);

    let names: Vec<&str> = definition.fields.iter().map(|field| field.name).collect();
    assert_eq!(
        names,
        vec![
            "platform",
            "follower_id",
            "follower_login",
            "follower_name",
            "followed_id",
            "followed_login",
            "followed_name",
            "mutual",
            "status",
            "followed_at",
            "ended_at",
            "ended_reason",
            "last_event_at",
        ]
    );

    let platform = field(definition, "platform");
    assert!(matches!(platform.kind, T::String));
    assert!(platform.required);
    assert!(matches!(platform.default, D::String("twitch")));
    assert_eq!(platform.enum_values, &["twitch"][..]);

    for name in ["follower_id", "followed_id"] {
        let required = field(definition, name);
        assert!(matches!(required.kind, T::String), "{name}");
        assert!(required.required, "{name}");
        assert!(matches!(required.default, D::Missing), "{name}");
    }

    for name in [
        "follower_login",
        "follower_name",
        "followed_login",
        "followed_name",
    ] {
        let text = field(definition, name);
        assert!(matches!(text.kind, T::String), "{name}");
        assert!(!text.required, "{name}");
        assert!(matches!(text.default, D::String("")), "{name}");
    }

    let mutual = field(definition, "mutual");
    assert!(matches!(mutual.kind, T::Boolean));
    assert!(matches!(mutual.default, D::Boolean(false)));
    assert!(!mutual.required);

    let status = field(definition, "status");
    assert!(matches!(status.kind, T::String));
    assert!(matches!(status.default, D::String("active")));
    assert_eq!(status.enum_values, &["active", "ended"][..]);

    let followed_at = field(definition, "followed_at");
    assert!(matches!(followed_at.kind, T::Date));
    assert!(followed_at.required);
    assert!(matches!(followed_at.default, D::Now));

    let ended_at = field(definition, "ended_at");
    assert!(matches!(ended_at.kind, T::Date));
    assert!(!ended_at.required);
    assert!(matches!(ended_at.default, D::Null));

    let ended_reason = field(definition, "ended_reason");
    assert!(matches!(ended_reason.kind, T::String));
    assert!(!ended_reason.required);
    assert!(matches!(ended_reason.default, D::Null));
    assert_eq!(
        ended_reason.enum_values,
        &[
            "missing_in_followers_scan",
            "missing_in_following_scan",
            "event_unfollow",
            "unknown",
        ][..]
    );

    let last_event_at = field(definition, "last_event_at");
    assert!(matches!(last_event_at.kind, T::Date));
    assert!(last_event_at.required);
    assert!(matches!(last_event_at.default, D::Now));

    // Ten indexes: the six `index: true` path options plus four composites.
    assert_eq!(definition.indexes.len(), 10);
    for keys in [
        doc! {"platform":1},
        doc! {"follower_id":1},
        doc! {"followed_id":1},
        doc! {"mutual":1},
        doc! {"status":1},
        doc! {"last_event_at":1},
        doc! {"followed_id":1,"status":1},
        doc! {"followed_id":1,"mutual":1,"status":1},
        doc! {"follower_id":1,"status":1},
    ] {
        assert!(
            definition
                .indexes
                .iter()
                .any(|index| index.keys == keys && !index.unique && !index.sparse),
            "missing index {keys:?}"
        );
    }
    let unique = definition
        .indexes
        .iter()
        .find(|index| index.unique)
        .expect("one unique index");
    assert_eq!(
        unique.keys,
        doc! {"platform":1,"follower_id":1,"followed_id":1,"status":1}
    );
    assert_eq!(unique.partial, Some(doc! {"status":"active"}));
    assert!(!unique.sparse);
    // The source schema declares no TTL index.
    assert!(definition.indexes.iter().all(|index| index.ttl.is_none()));
}

#[test]
fn construct_applies_source_defaults_and_validation() {
    let now = DateTime::from_millis(1_900_000_000_000);
    let document = ledger_schema::schema()
        .prepare_insert(doc! {"follower_id":" 1 ","followed_id":"2"}, now)
        .expect("minimal follow start is valid");
    assert_eq!(document.get_str("platform").expect("platform"), "twitch");
    assert_eq!(document.get_str("follower_id").expect("id"), " 1 ");
    assert_eq!(document.get_str("status").expect("status"), "active");
    assert!(!document.get_bool("mutual").expect("mutual"));
    assert_eq!(document.get_str("follower_login").expect("login"), "");
    assert_eq!(document.get("ended_at"), Some(&Bson::Null));
    assert_eq!(document.get("ended_reason"), Some(&Bson::Null));
    assert_eq!(
        document.get_datetime("followed_at").expect("followed_at"),
        &now
    );
    assert_eq!(document.get_datetime("created_at").expect("created_at"), &now);
    assert_eq!(document.get_datetime("updated_at").expect("updated_at"), &now);
    assert_eq!(document.get_i32("__v").expect("version key"), 0);
    assert!(document.get_object_id("_id").is_ok());

    assert!(
        ledger_schema::schema()
            .prepare_insert(doc! {"followed_id":"2"}, now)
            .is_err(),
        "follower_id is required"
    );
    assert!(
        ledger_schema::schema()
            .prepare_insert(doc! {"follower_id":"1","platform":"kick"}, now)
            .is_err(),
        "platform enum rejects non-Twitch values"
    );
    assert!(
        ledger_schema::schema()
            .prepare_insert(doc! {"follower_id":"1","status":"pending"}, now)
            .is_err(),
        "status enum rejects unknown values"
    );
    assert!(
        ledger_schema::schema()
            .prepare_insert(doc! {"follower_id":"1","ended_reason":"other"}, now)
            .is_err(),
        "ended_reason enum rejects unknown values"
    );
}

#[test]
fn schema_value_enums_round_trip() {
    assert_eq!(FollowPlatform::Twitch.as_str(), "twitch");
    assert_eq!(FollowPlatform::parse("twitch"), Some(FollowPlatform::Twitch));
    assert_eq!(FollowPlatform::parse("kick"), None);
    assert_eq!(FollowStatus::Active.as_str(), "active");
    assert_eq!(FollowStatus::Ended.as_str(), "ended");
    assert_eq!(FollowStatus::parse("ended"), Some(FollowStatus::Ended));
    assert_eq!(
        EndedReason::MissingInFollowersScan.as_str(),
        "missing_in_followers_scan"
    );
    assert_eq!(
        EndedReason::parse("missing_in_following_scan"),
        Some(EndedReason::MissingInFollowingScan)
    );
    assert_eq!(EndedReason::Unknown.as_str(), "unknown");
    assert_eq!(
        EndedReason::parse("event_unfollow"),
        Some(EndedReason::EventUnfollow)
    );
}

#[test]
fn dedupe_key_and_value_normalisation_match_source() {
    assert_eq!(FOLLOW_LEDGER_JOB_NAME, "follow-ledger-sync");
    assert_eq!(FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX, "follow-ledger-sync");
    assert_eq!(FOLLOW_LEDGER_DEFAULT_REASON, "manual_request");
    assert_eq!(
        get_follow_ledger_dedupe_key("  123 "),
        "cron:jobs:dedupe:follow-ledger-sync:123"
    );
    assert_eq!(
        get_follow_ledger_dedupe_key(""),
        "cron:jobs:dedupe:follow-ledger-sync:"
    );
    // Source `trim()` is the JavaScript one, not `str::trim`.
    assert_eq!(normalize_value(Some("\u{feff} name \u{00a0}")), "name");
    assert_eq!(normalize_value(Some("   ")), "");
    assert_eq!(normalize_value(None), "");
}

#[test]
fn dedupe_seconds_floor_override_and_call_time_read() {
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(None), 900.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some("")), 900.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some("0")), 60.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some("30")), 60.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some("60")), 60.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some("1800")), 1800.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some(" 900 ")), 900.0);
    assert_eq!(follow_ledger_queue_dedupe_seconds_from(Some("1e3")), 1000.0);
    assert!(follow_ledger_queue_dedupe_seconds_from(Some("abc")).is_nan());
    // The environment is read per call, so the value tracks the current process
    // environment instead of an import-time snapshot.
    let expected = follow_ledger_queue_dedupe_seconds_from(
        std::env::var(FOLLOW_LEDGER_QUEUE_DEDUPE_ENV).ok().as_deref(),
    );
    assert_eq!(
        follow_ledger_queue_dedupe_seconds().to_bits(),
        expected.to_bits()
    );
}

#[test]
fn followed_at_accepts_a_date_or_an_iso_string() {
    let now = DateTime::from_millis(1_900_000_000_000);
    let at = DateTime::from_millis(1_700_000_000_123);
    assert_eq!(FollowLedgerDate::Date(at).resolve(now), at);
    assert_eq!(
        FollowLedgerDate::Text("2023-11-14T22:13:20.123Z".into()).resolve(now),
        at
    );
    assert_eq!(
        FollowLedgerDate::Text("  2023-11-14T22:13:20.123Z  ".into()).resolve(now),
        at
    );
    // Source `toDate`: blank and unparsable values fall back to "now".
    assert_eq!(FollowLedgerDate::Text("   ".into()).resolve(now), now);
    assert_eq!(FollowLedgerDate::Text("not-a-date".into()).resolve(now), now);
}

#[test]
fn pagination_and_cursor_helpers_match_url_search_params() {
    assert_eq!(HELIX_PAGE_SIZE, 100);
    assert_eq!(followers_params("123", None), "broadcaster_id=123&first=100");
    assert_eq!(followed_params("123", None), "user_id=123&first=100");
    assert_eq!(
        followers_params("123", Some("eyJvZmZzZXQiOjJ9")),
        "broadcaster_id=123&first=100&after=eyJvZmZzZXQiOjJ9"
    );
    assert_eq!(
        followed_params("123", Some("a=b")),
        "user_id=123&first=100&after=a%3Db"
    );
    assert_eq!(form_encode("a b=c&d"), "a+b%3Dc%26d");
    assert_eq!(form_encode("*-._~"), "*-._%7E");

    assert_eq!(
        next_cursor(&json!({"pagination":{"cursor":"abc"}})),
        Some("abc".to_owned())
    );
    // Source `page.nextCursor || null`: an empty cursor ends the scan.
    assert_eq!(next_cursor(&json!({"pagination":{"cursor":""}})), None);
    assert_eq!(next_cursor(&json!({"data":[]})), None);
}

#[test]
fn constants_and_messages_match_source() {
    assert_eq!(DEFAULT_BATCH_SIZE, 250);
    assert_eq!(FOLLOW_START_MAX_ATTEMPTS, 3);
    assert_eq!(DEFAULT_PLATFORM, "twitch");
    assert_eq!(PLATFORM_TWITCH, "twitch");
    assert_eq!(INVALID_CHANNEL_MESSAGE, "Invalid channel ID");
    assert_eq!(SYNC_COMPLETE_MESSAGE, "Follow ledger sync completed");
}

#[test]
fn sync_stats_merge_sums_every_field() {
    let left = FollowLedgerSyncStats {
        total_from_api: 10.0,
        requests: 1,
        pages: 1,
        active_upserts: 4,
        ended_count: 2,
    };
    let right = FollowLedgerSyncStats {
        total_from_api: 5.0,
        requests: 2,
        pages: 2,
        active_upserts: 3,
        ended_count: 1,
    };
    let merged = left.merge(right);
    assert_eq!(merged.total_from_api, 15.0);
    assert_eq!(merged.requests, 3);
    assert_eq!(merged.pages, 3);
    assert_eq!(merged.active_upserts, 7);
    assert_eq!(merged.ended_count, 3);
    assert_eq!(left.merge(FollowLedgerSyncStats::default()), left);
}

#[test]
fn queue_clock_is_utc_iso_with_millis() {
    assert_eq!(javascript_iso_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        javascript_iso_millis(1_700_000_000_123),
        "2023-11-14T22:13:20.123Z"
    );
    assert_eq!(javascript_iso_millis(-1), "1969-12-31T23:59:59.999Z");
    let now = SystemQueueClock.now_iso();
    assert_eq!(now.len(), 24, "{now}");
    assert!(now.ends_with('Z'), "{now}");
    assert_eq!(&now[4..5], "-");
    assert_eq!(&now[10..11], "T");
}

// ---------------------------------------------------------------------------
// Fixture-gated integration suites
// ---------------------------------------------------------------------------

const MONGO_DATABASE_PREFIX: &str = "rust_follow_ledger_fixture_";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn check(condition: bool, message: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(std::io::Error::other(message.to_owned()).into())
    }
}

/// Scripted loopback Helix: a request pops the first reply whose path key is a
/// prefix of the recorded path, so concurrent scans stay deterministic.
struct Script {
    replies: Mutex<VecDeque<(&'static str, CannedResponse)>>,
}

impl Script {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(VecDeque::new()),
        })
    }

    fn push(&self, key: &'static str, body: Value) {
        self.replies
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push_back((key, CannedResponse::json(200, &body.to_string())));
    }

    fn respond(&self, request: &RecordedRequest) -> CannedResponse {
        let mut replies = self
            .replies
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let index = replies
            .iter()
            .position(|(key, _)| request.path.starts_with(*key))
            .unwrap_or(0);
        match replies.remove(index) {
            Some((_, response)) => response,
            None => CannedResponse::json(500, r#"{"message":"unscripted fixture request"}"#),
        }
    }
}

struct FixtureTokens;

impl TokenSource for FixtureTokens {
    fn token<'a>(&'a self, auth: &'a TwitchAuth) -> TokenFuture<'a> {
        let subject = auth.user_id().unwrap_or_default().to_owned();
        Box::pin(async move { Ok(AccessToken::user("fixture-token", subject)) })
    }
}

struct FixtureDirectory {
    streamer: Option<FollowLedgerStreamer>,
}

impl FollowLedgerStreamerDirectory for FixtureDirectory {
    fn streamer<'a>(
        &'a self,
        _channel_id: &'a str,
    ) -> FollowLedgerFuture<'a, Option<FollowLedgerStreamer>> {
        let streamer = self.streamer.clone();
        Box::pin(async move { streamer })
    }
}

fn follower(user_id: &str, followed_at: &str) -> Value {
    json!({
        "user_id": user_id,
        "user_login": format!("{user_id}-login"),
        "user_name": format!("{user_id}-name"),
        "followed_at": followed_at,
    })
}

fn followed(broadcaster_id: &str, followed_at: &str) -> Value {
    json!({
        "broadcaster_id": broadcaster_id,
        "broadcaster_login": format!("{broadcaster_id}-login"),
        "broadcaster_name": format!("{broadcaster_id}-name"),
        "followed_at": followed_at,
    })
}

fn twitch_client(helix_base: &str) -> TestResult<TwitchClient> {
    let endpoints = TwitchEndpoints::new(
        &format!("{helix_base}/helix/"),
        &format!("{helix_base}/oauth2/"),
    )?;
    Ok(TwitchClient::new(
        "fixture-client-id",
        endpoints,
        Some(Duration::from_secs(10)),
    )?)
}

fn service_with(
    database: &mongodb::Database,
    helix_base: &str,
    streamer: Option<FollowLedgerStreamer>,
) -> TestResult<FollowLedgerService> {
    Ok(FollowLedgerService::new(
        database.clone(),
        twitch_client(helix_base)?,
        Arc::new(FixtureTokens),
        Arc::new(FixtureDirectory { streamer }),
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires lead-owned disposable MongoDB plus a loopback Helix recorder"]
async fn collector_sync_and_follow_start_against_disposable_mongo() -> TestResult {
    assert_eq!(
        std::env::var("FOLLOW_LEDGER_TEST_MONGO_ACK").as_deref(),
        Ok("disposable"),
        "explicit disposable-fixture acknowledgement required"
    );
    let uri = std::env::var("FOLLOW_LEDGER_TEST_MONGO_URI")
        .expect("explicit task-owned MongoDB URI required");
    let database_name = std::env::var("FOLLOW_LEDGER_TEST_MONGO_DATABASE")
        .expect("explicit task-owned MongoDB database required");
    assert!(
        database_name.starts_with(MONGO_DATABASE_PREFIX),
        "task database must use the fixture prefix"
    );

    let client = mongodb::Client::with_uri_str(&uri).await?;
    let database = client.database(&database_name);
    assert!(
        database.list_collection_names().await?.is_empty(),
        "task database must be fresh"
    );
    ledger_schema::install_indexes(&database).await?;

    let channel = format!("fixture-channel-{}", uuid::Uuid::new_v4());
    database
        .collection::<Document>("users")
        .insert_one(doc! {
            "name": "Fixture Streamer",
            "accounts": [{
                "type": "twitch",
                "id": &channel,
                "name": "Fixture Streamer",
                "refresh_token": {"iv": "00", "content": "encrypted"},
                "actived": true,
                "has_permissions": true,
            }],
        })
        .await?;

    let script = Script::new();
    script.push(
        "/helix/channels/followers",
        json!({
            "data": [
                follower("u1", "2024-01-02T03:04:05Z"),
                follower("u2", "2024-01-03T03:04:05Z"),
            ],
            "total": 3,
            "pagination": {"cursor": "c1"},
        }),
    );
    script.push(
        "/helix/channels/followers",
        json!({"data": [follower("u3", "2024-01-04T03:04:05Z")], "total": 3}),
    );
    script.push(
        "/helix/channels/followed",
        json!({"data": [followed("u1", "2024-02-02T03:04:05Z")], "total": 1}),
    );

    let recorder = {
        let script = Arc::clone(&script);
        Recorder::start(move |request: &RecordedRequest| script.respond(request))
    };
    let helix_base = recorder.base_url.clone();

    let outcome = tokio::time::timeout(
        Duration::from_secs(45),
        run_collector_scenarios(&database, &helix_base, &script, &channel),
    )
    .await;
    // Always drop the task-owned database, even when a scenario failed.
    database.drop().await.ok();
    outcome.expect("collector scenarios exceeded 45 seconds")
}

async fn run_collector_scenarios(
    database: &mongodb::Database,
    helix_base: &str,
    script: &Script,
    channel: &str,
) -> TestResult {
    let service = service_with(
        database,
        helix_base,
        Some(FollowLedgerStreamer {
            login: "fixturestreamer".into(),
            has_permissions: "true".into(),
        }),
    )?;

    // The channel list reads active Twitch accounts with a refresh token.
    let channels = service.get_follow_ledger_sync_channel_ids().await?;
    check(channels == vec![channel.to_owned()], "single sync channel")?;

    let result = service
        .sync_follow_ledger_for_channel(channel, &FollowLedgerSyncOptions::default())
        .await;
    check(!result.error, "first sync must succeed")?;
    check(result.message == SYNC_COMPLETE_MESSAGE, "sync message")?;
    check(
        result.channel_id.as_deref() == Some(channel),
        "sync channel id",
    )?;
    check(result.requests == 3, "two follower pages and one followed page")?;
    check(result.pages == 3, "pages")?;
    check(
        result.active_upserts == 4,
        "three incoming upserts and one outgoing upsert",
    )?;
    check(result.ended_count == 0, "nothing ended on the first scan")?;
    check(result.total_from_api == 4.0, "max(3, 3) followers plus 1 followed")?;

    let ledger = service.ledger();
    let mutual_incoming = ledger
        .find_one(doc! {
            "platform": "twitch", "status": "active",
            "follower_id": "u1", "followed_id": channel,
        })
        .await?
        .expect("u1 follows the channel");
    check(
        mutual_incoming.get_bool("mutual")?,
        "u1 is mutual after reconcile",
    )?;
    let outgoing = ledger
        .find_one(doc! {
            "platform": "twitch", "status": "active",
            "follower_id": channel, "followed_id": "u1",
        })
        .await?
        .expect("the channel follows u1");
    check(outgoing.get_bool("mutual")?, "outgoing edge is mutual")?;
    check(
        outgoing.get_str("follower_login")? == "fixturestreamer",
        "outgoing follower_login is the streamer login",
    )?;
    check(
        outgoing.get_str("followed_login")? == "u1-login",
        "outgoing followed_login comes from the page",
    )?;
    let non_mutual = ledger
        .find_one(doc! {
            "platform": "twitch", "status": "active",
            "follower_id": "u2", "followed_id": channel,
        })
        .await?
        .expect("u2 follows the channel");
    check(!non_mutual.get_bool("mutual")?, "u2 is not mutual")?;

    // recordFollowLedgerStart: the first write creates an active row, the second
    // ends it with reason `unknown` and creates a new active row.
    let mut input = RecordFollowLedgerStartInput::new("u9", channel);
    input.followed_at = Some(FollowLedgerDate::Text("2024-03-01T00:00:00Z".into()));
    service.record_follow_ledger_start(&input).await?;
    service.record_follow_ledger_start(&input).await?;
    let active = ledger
        .find_one(doc! {
            "platform": "twitch", "status": "active",
            "follower_id": "u9", "followed_id": channel,
        })
        .await?
        .expect("one active u9 row");
    check(
        active.get_datetime("followed_at")?.timestamp_millis() == 1_709_251_200_000,
        "followed_at kept the supplied instant",
    )?;
    let ended = ledger
        .find_one(doc! {
            "platform": "twitch", "status": "ended",
            "follower_id": "u9", "followed_id": channel,
        })
        .await?
        .expect("the previous active u9 row is ended");
    check(
        ended.get_str("ended_reason")? == "unknown",
        "ended_reason is `unknown`",
    )?;
    // A plain standalone `mongod` cannot run transactions, so the source's
    // non-transactional fallback must be the branch that committed here.
    check(
        service.last_follow_start_mode() == Some(FollowStartWriteMode::StandaloneFallback),
        "standalone fixture uses the non-transactional fallback",
    )?;

    // Second scan: u2 disappears from the followers page.
    script.push(
        "/helix/channels/followers",
        json!({
            "data": [
                follower("u1", "2024-01-02T03:04:05Z"),
                follower("u3", "2024-01-04T03:04:05Z"),
            ],
            "total": 2,
        }),
    );
    script.push(
        "/helix/channels/followed",
        json!({"data": [followed("u1", "2024-02-02T03:04:05Z")], "total": 1}),
    );
    let second = service
        .sync_follow_ledger_for_channel(channel, &FollowLedgerSyncOptions::default())
        .await;
    check(!second.error, "second sync must succeed")?;
    check(second.ended_count >= 2, "u2 and u9 leave the active set")?;
    let missing = ledger
        .find_one(doc! {
            "platform": "twitch", "status": "ended",
            "follower_id": "u2", "followed_id": channel,
        })
        .await?
        .expect("u2 is ended after it disappears");
    check(
        missing.get_str("ended_reason")? == "missing_in_followers_scan",
        "ended_reason is `missing_in_followers_scan`",
    )?;
    check(!missing.get_bool("mutual")?, "an ended row is never mutual")?;

    // The requested blank channel is rejected without a scan.
    let rejected = service
        .sync_follow_ledger_for_channel("   ", &FollowLedgerSyncOptions::default())
        .await;
    check(rejected.error, "blank channel is rejected")?;
    check(
        rejected.message == INVALID_CHANNEL_MESSAGE,
        "blank channel message",
    )?;
    check(
        rejected.channel_id.as_deref() == Some("   "),
        "the source echoes the raw channel id",
    )?;

    // A directory miss and a missing permission flag use the native header
    // helper messages, before any Helix request.
    let not_found = service_with(database, helix_base, None)?
        .sync_follow_ledger_for_channel(channel, &FollowLedgerSyncOptions::default())
        .await;
    check(not_found.error, "missing streamer is reported")?;
    check(
        not_found.message.contains("Streamer not found for ID"),
        "streamer-not-found message",
    )?;
    let no_permissions = service_with(
        database,
        helix_base,
        Some(FollowLedgerStreamer {
            login: "fixturestreamer".into(),
            has_permissions: "false".into(),
        }),
    )?
    .sync_follow_ledger_for_channel(channel, &FollowLedgerSyncOptions::default())
    .await;
    check(no_permissions.error, "missing permissions is reported")?;
    check(
        no_permissions
            .message
            .contains("does not have valid permissions"),
        "permissions message",
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires lead-owned disposable Redis"]
async fn queue_enqueue_deduplicates_against_disposable_redis() -> TestResult {
    assert_eq!(
        std::env::var("FOLLOW_LEDGER_TEST_REDIS_ACK").as_deref(),
        Ok("disposable"),
        "explicit disposable-fixture acknowledgement required"
    );
    let uri = std::env::var("FOLLOW_LEDGER_TEST_REDIS_URI")
        .expect("explicit task-owned Redis URI required");
    let client = redis::Client::open(uri.as_str())?;
    let connection = tokio::time::timeout(Duration::from_secs(8), client.get_connection_manager())
        .await
        .expect("fixture connection timeout")?;
    let mut queue = RedisCronQueue::new(connection.clone(), CronQueueConfig::default());
    let channel = format!("fixture-ledger-{}", uuid::Uuid::new_v4());

    let first =
        enqueue_follow_ledger_sync_job_with_defaults(&mut queue, &channel, None, Some("fixture"))
            .await?;
    let second =
        enqueue_follow_ledger_sync_job_with_defaults(&mut queue, &channel, Some("   "), None)
            .await?;
    let blank = enqueue_follow_ledger_sync_job_with_defaults(&mut queue, "   ", None, None).await?;

    // Remove only this run's payload and dedupe marker, even on a failed check.
    let cleanup = async {
        let mut connection = connection.clone();
        if let Some(job) = &first.job {
            let payload = serialize_cron_queue_job(job)?;
            let _: i64 = redis::cmd("LREM")
                .arg(CRON_JOBS_QUEUE_KEY)
                .arg(0)
                .arg(payload)
                .query_async(&mut connection)
                .await?;
        }
        let _: i64 = redis::cmd("DEL")
            .arg(get_follow_ledger_dedupe_key(&channel))
            .query_async(&mut connection)
            .await?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    }
    .await;

    check(first.enqueued, "first enqueue is accepted")?;
    check(first.message == "Cron job queued", "first enqueue message")?;
    check(
        first.dedupe_key
            == format!(
                "cron:jobs:dedupe:{FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX}:{channel}"
            ),
        "dedupe key",
    )?;
    let job = first.job.as_ref().expect("accepted job payload");
    check(job.job == FOLLOW_LEDGER_JOB_NAME, "job name")?;
    check(
        job.channel_id.as_deref() == Some(channel.as_str()),
        "channelID",
    )?;
    check(
        job.account_id.as_deref() == Some(channel.as_str()),
        "accountID",
    )?;
    let data = job.data.as_ref().expect("job data");
    check(
        data["reason"] == json!(FOLLOW_LEDGER_DEFAULT_REASON),
        "default reason is manual_request",
    )?;
    check(data["type"] == json!(FOLLOW_LEDGER_JOB_NAME), "data type")?;

    check(!second.enqueued, "the second enqueue is deduplicated")?;
    check(
        second.message == "Cron job already queued recently",
        "dedupe message",
    )?;
    check(second.dedupe_key == first.dedupe_key, "dedupe key is stable")?;
    check(
        second
            .job
            .as_ref()
            .and_then(|job| job.data.as_ref())
            .and_then(|data| data.get("reason"))
            .is_some_and(|reason| reason.as_str() == Some(FOLLOW_LEDGER_DEFAULT_REASON)),
        "a blank reason normalises to manual_request",
    )?;

    check(!blank.enqueued, "blank channel is rejected")?;
    check(blank.message == INVALID_CHANNEL_MESSAGE, "blank message")?;
    check(
        blank.dedupe_key.is_empty(),
        "blank channel has no dedupe key",
    )?;
    check(blank.job.is_none(), "blank channel has no job")?;

    cleanup
}

// ---------------------------------------------------------------------------
// Follow-start transaction path (replica set) and the standalone fallback
// ---------------------------------------------------------------------------

const RS_DATABASE_PREFIX: &str = "rust_follow_ledger_rs_fixture_";

/// Detects a real replica set instead of assuming one. `hello.setName` exists
/// only on a replica-set member; a standalone `mongod` omits it.
async fn require_replica_set(client: &mongodb::Client) -> TestResult<String> {
    let hello = client
        .database("admin")
        .run_command(doc! {"hello": 1})
        .await?;
    let name = hello
        .get_str("setName")
        .map_err(|_| "fixture is not a replica set: hello.setName is missing")?;
    Ok(name.to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a lead-owned single-node replica set (FOLLOW_LEDGER_TEST_RS_*)"]
async fn follow_start_commits_in_a_transaction_on_a_replica_set() -> TestResult {
    assert_eq!(
        std::env::var("FOLLOW_LEDGER_TEST_RS_ACK").as_deref(),
        Ok("replica-set"),
        "explicit replica-set fixture acknowledgement required"
    );
    let uri = std::env::var("FOLLOW_LEDGER_TEST_RS_MONGO_URI")
        .expect("explicit task-owned replica-set URI required");
    let database_name = std::env::var("FOLLOW_LEDGER_TEST_RS_MONGO_DATABASE")
        .expect("explicit task-owned replica-set database required");
    assert!(
        database_name.starts_with(RS_DATABASE_PREFIX),
        "replica-set database must use the fixture prefix"
    );

    let client = mongodb::Client::with_uri_str(&uri).await?;
    let _set_name = require_replica_set(&client).await?;
    let database = client.database(&database_name);
    assert!(
        database.list_collection_names().await?.is_empty(),
        "replica-set database must be fresh"
    );
    ledger_schema::install_indexes(&database).await?;

    let service = service_with(
        &database,
        "http://127.0.0.1:1",
        Some(FollowLedgerStreamer {
            login: "fixturestreamer".into(),
            has_permissions: "true".into(),
        }),
    )?;
    let ledger = service.ledger();
    let channel = format!("rs-channel-{}", uuid::Uuid::new_v4());

    // A reverse active edge makes the transactional body touch all four
    // operations: reverse read, forward end, insert and reverse promotion.
    let mut reverse = RecordFollowLedgerStartInput::new(channel.as_str(), "rs-user-a");
    reverse.followed_at = Some(FollowLedgerDate::Text("2024-03-01T00:00:00Z".into()));
    service.record_follow_ledger_start(&reverse).await?;
    assert_eq!(
        service.last_follow_start_mode(),
        Some(FollowStartWriteMode::Transactional),
        "a replica set must commit through the transaction branch"
    );

    let mut forward = RecordFollowLedgerStartInput::new("rs-user-a", channel.as_str());
    forward.followed_at = Some(FollowLedgerDate::Text("2024-03-02T00:00:00Z".into()));
    service.record_follow_ledger_start(&forward).await?;
    assert_eq!(
        service.last_follow_start_mode(),
        Some(FollowStartWriteMode::Transactional)
    );

    let reverse_row = ledger
        .find_one(doc! {"follower_id": &channel, "followed_id": "rs-user-a", "status": "active"})
        .await?
        .expect("reverse active edge");
    check(
        reverse_row.get_bool("mutual")?,
        "the reverse edge is promoted to mutual inside the transaction",
    )?;
    let forward_row = ledger
        .find_one(doc! {"follower_id": "rs-user-a", "followed_id": &channel, "status": "active"})
        .await?
        .expect("forward active edge");
    check(
        forward_row.get_bool("mutual")?,
        "the forward edge was inserted with the reverse edge already active",
    )?;

    // A rejected platform aborts the transaction: the insert fails validation
    // inside the transactional section, so the session is aborted and the
    // ledger keeps exactly the two rows above.
    let mut invalid = RecordFollowLedgerStartInput::new("rs-user-b", channel.as_str());
    invalid.platform = Some("kick".into());
    let error = service
        .record_follow_ledger_start(&invalid)
        .await
        .expect_err("the schema enum rejects a non-Twitch platform");
    check(
        matches!(
            error,
            dima_rust::utils::follow_ledger::FollowLedgerError::Validation(_)
        ),
        "an invalid platform is a validation failure, not a transaction error",
    )?;
    check(
        service.last_follow_start_mode() == Some(FollowStartWriteMode::Transactional),
        "a failed attempt does not record a new mode",
    )?;
    check(
        ledger.count_documents(doc! {}).await? == 2,
        "only the two committed rows exist",
    )?;

    database.drop().await.ok();
    Ok(())
}

// ---------------------------------------------------------------------------
// One shared TwitchTokenStorage for both roles
// ---------------------------------------------------------------------------

struct TokenState {
    stored: Option<StoredAccount>,
    cached: Option<CachedAccount>,
    exchanges: usize,
    now_seconds: i64,
    lease: Option<String>,
}

/// In-memory `CredentialStore` + `TokenCache` + `OAuthExchange` + `TokenClock`
/// so the sharing proof needs no MongoDB, Redis or network.
#[derive(Clone)]
struct TokenFixture(Arc<Mutex<TokenState>>);

impl TokenFixture {
    fn new(id: &str) -> Self {
        let cipher = test_cipher();
        let stored = StoredAccount {
            id: id.into(),
            access_token: Some(cipher.encrypt_with_iv("old-access", [1; 16]).unwrap()),
            refresh_token: Some(cipher.encrypt_with_iv("old-refresh", [2; 16]).unwrap()),
            expires_at: Some(1_000.0),
            has_permissions: true,
            up_to_date_permissions: true,
        };
        Self(Arc::new(Mutex::new(TokenState {
            cached: Some(CachedAccount {
                id: id.into(),
                access_token: "old-access".into(),
                refresh_token: "old-refresh".into(),
                expires_at: "1000".into(),
                has_permissions: true,
                up_to_date_permissions: true,
            }),
            stored: Some(stored),
            exchanges: 0,
            now_seconds: 1_000_000,
            lease: None,
        })))
    }

    fn exchanges(&self) -> usize {
        self.0.lock().unwrap().exchanges
    }

    fn manager(&self) -> TwitchTokenStorage {
        TwitchTokenStorage::new(
            Arc::new(self.clone()),
            Arc::new(self.clone()),
            Arc::new(self.clone()),
            Arc::new(self.clone()),
            test_cipher(),
        )
    }
}

fn test_cipher() -> CredentialCipher {
    CredentialCipher::new("fixture").unwrap()
}

impl CredentialStore for TokenFixture {
    fn load<'a>(
        &'a self,
        _: &'a str,
    ) -> StorageFuture<'a, Result<Option<StoredAccount>, TokenStorageError>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().stored.clone()) })
    }

    fn replace<'a>(
        &'a self,
        expected: &'a StoredAccount,
        replacement: &'a StoredAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.stored.as_ref().map(|value| (&value.id, &value.refresh_token))
                != Some((&expected.id, &expected.refresh_token))
            {
                return Ok(false);
            }
            state.stored = Some(replacement.clone());
            Ok(true)
        })
    }
}

impl TokenCache for TokenFixture {
    fn account<'a>(
        &'a self,
        _: &'a str,
    ) -> StorageFuture<'a, Result<Option<CachedAccount>, TokenStorageError>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().cached.clone()) })
    }

    fn put_account<'a>(
        &'a self,
        account: &'a CachedAccount,
        expected: Option<&'a CachedAccount>,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.cached.as_ref() != expected {
                return Ok(false);
            }
            state.cached = Some(account.clone());
            Ok(true)
        })
    }

    fn invalidate<'a>(
        &'a self,
        expected: &'a CachedAccount,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.cached.as_ref().is_some_and(|value| value != expected) {
                return Ok(false);
            }
            state.cached = Some(CachedAccount {
                id: expected.id.clone(),
                ..CachedAccount::default()
            });
            Ok(true)
        })
    }

    fn acquire<'a>(
        &'a self,
        _: &'a str,
        owner: &'a str,
        _: u64,
    ) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.lease.is_some() {
                return Ok(false);
            }
            state.lease = Some(owner.to_owned());
            Ok(true)
        })
    }

    fn held<'a>(&'a self, _: &'a str) -> StorageFuture<'a, Result<bool, TokenStorageError>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().lease.is_some()) })
    }

    fn release<'a>(
        &'a self,
        _: &'a str,
        owner: &'a str,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if state.lease.as_deref() == Some(owner) {
                state.lease = None;
            }
            Ok(())
        })
    }

    fn app<'a>(&'a self) -> StorageFuture<'a, Result<Option<String>, TokenStorageError>> {
        Box::pin(async { Ok(None) })
    }

    fn put_app<'a>(
        &'a self,
        _: &'a str,
        _: u64,
    ) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async { Ok(()) })
    }

    fn put_bot<'a>(&'a self, _: &'a str) -> StorageFuture<'a, Result<(), TokenStorageError>> {
        Box::pin(async { Ok(()) })
    }
}

impl TokenClock for TokenFixture {
    fn now_seconds(&self) -> i64 {
        self.0.lock().unwrap().now_seconds
    }

    fn monotonic_millis(&self) -> u64 {
        0
    }

    fn sleep(&self, _: Duration) -> StorageFuture<'_, ()> {
        Box::pin(async { () })
    }
}

impl OAuthExchange for TokenFixture {
    fn refresh<'a>(
        &'a self,
        refresh: &'a str,
        id: &'a str,
        _: &'a RefreshPolicy,
    ) -> StorageFuture<'a, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async move {
            let mut state = self.0.lock().unwrap();
            if refresh != "old-refresh" {
                return Err(OAuthFailure {
                    kind: RefreshFailureKind::Permanent,
                    status: Some(400),
                    message: "unexpected refresh secret".into(),
                    attempts: 1,
                });
            }
            state.exchanges += 1;
            Ok(OAuthTokens {
                access_token: AccessToken::user("new-access", id),
                refresh_token: Some("new-refresh".into()),
                expires_in: 3600.0,
            })
        })
    }

    fn app_token(&self) -> StorageFuture<'_, Result<OAuthTokens, OAuthFailure>> {
        Box::pin(async {
            Err(OAuthFailure {
                kind: RefreshFailureKind::Permanent,
                status: Some(400),
                message: "app token is not used by this fixture".into(),
                attempts: 1,
            })
        })
    }
}

#[tokio::test]
async fn shared_token_storage_is_observed_by_both_roles() {
    let id = "shared-user";
    let fixture = TokenFixture::new(id);
    let storage = fixture
        .manager()
        .with_refresh_guard(Duration::from_secs(30), Duration::from_secs(25))
        .expect("refresh guard");
    let shared = Arc::new(SharedTwitchTokens::new(storage));
    // Exactly one storage instance sits behind the handle; there is no second
    // copy for the other role.
    assert_eq!(Arc::strong_count(shared.storage()), 1);

    let helix: Arc<dyn TokenSource> = shared.clone();
    let directory: Arc<dyn StreamerCredentials> = shared.clone();

    // The directory role refreshes the expired credential.
    let refreshed = directory.token(id).await.expect("directory role acquires");
    assert_eq!(refreshed.expose_secret(), "new-access");
    assert_eq!(fixture.exchanges(), 1);

    // The Helix role observes the credential published by that refresh and must
    // not perform a second OAuth exchange.
    let observed = helix
        .token(&TwitchAuth::Streamer(id.to_owned()))
        .await
        .expect("helix role acquires");
    assert_eq!(observed.expose_secret(), "new-access");
    assert_eq!(fixture.exchanges(), 1, "one shared storage, one refresh");
}
