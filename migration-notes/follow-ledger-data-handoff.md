# Follow-ledger data port — integration handoff

**Scope:** native port of `src/schemas/follow_relationship_ledger.schema.ts`,
`src/utils/follow_ledger.ts` and `src/utils/follow_ledger_queue.ts`.
**Author:** DeepSeek V4.1 Flash via OpenCode. **Wave:** authoring only — nothing
here was compiled, formatted, executed or deployed, and no `cargo`, `rustfmt`,
`node` or container command was run (the wave forbids them).

This note lives at the repository-level `migration-notes/` directory, which is
the existing location for every other `*-handoff.md`; `dimabot/migration-notes/`
does not exist in this checkout.

Files added by this slice (nothing else was touched):

| File | Purpose |
| --- | --- |
| `dimabot/src/schemas/follow_relationship_ledger.schema.rs` | `follow_relationship_ledgers` schema definition |
| `dimabot/src/utils/follow_ledger.rs` | collector: follow-start write, channel list, Helix scan, mutual reconcile |
| `dimabot/src/utils/follow_ledger_queue.rs` | `follow-ledger-sync` cron job identity, dedupe window and enqueue |
| `dimabot/tests/follow_ledger_data.rs` | pure parity tests + `#[ignore]` disposable-fixture suites |
| `migration-notes/follow-ledger-data-handoff.md` | this file |

**Revision 2 (this delivery):** the internal cross-review returned four mandatory
gaps and they are closed here — the source's transaction branch is authored
against the pinned driver (§4.3), the replica-set fixture plan and the standalone
fallback coverage exist (§6a, §6b), the two token storages became one shared
`Arc<TwitchTokenStorage>` (§4.12), and `cacheOAuthAPIFailure` became a concrete
adapter plus a named transport contract instead of a "diagnostic only"
difference (§5.2). Only `follow_ledger.rs`, `follow_ledger_data.rs` and this note
changed; the schema and queue files are byte-identical to revision 1.

**Revision 3 (lead correction, no code change):** two central-patch hunk headers
in §1 were arithmetically corrupt for `git apply` — the `Cargo.toml` hunk
claimed 6 context lines against 5, and the `schemas/mod.rs` hunk claimed 6
against 4. Both are corrected here. Separately, slices 2a and 4a insert their
own `Cargo.toml` feature at the *same* anchor, so the per-slice diffs in all
three notes still conflict with each other in either order. The merged,
`git apply --check`-validated equivalent of slices 2a, 3 and 4a is published as
`ready/team2-api-data-central-20261031.patch`. No file in this slice changed
between revisions 2 and 3.

---

## 1. Central patches the integration team must apply

These are the **only** central edits required. Each hunk is against the current
`master` content of `/root/saas-rust`.

### 1.1 `dimabot/Cargo.toml` — one new feature

Insert one line after `follow-defense-schemas`. Every referenced feature already
exists in `Cargo.toml` today: `mongo` (17), `redis` (18), `application-schemas`
(74), `twitch-client` (122), `cron-queue` (155), `twitch-streamers` (161),
`twitch-headers` (163), `logger` (111), and the optional dependency
`serde_json` (declared `dep:serde_json` elsewhere).

```diff
@@ -74,6 +74,7 @@
 application-schemas = ["mongo", "js-date", "js-strings"]
 ordinary-application-schemas = ["application-schemas"]
 follow-defense-schemas = ["application-schemas"]
+follow-ledger-data = ["mongo", "redis", "twitch-streamers", "twitch-client", "twitch-headers", "cron-queue", "logger", "application-schemas", "dep:serde_json"]
 media-extension-schemas = ["application-schemas"]
 command-reward-schemas = ["application-schemas", "permissions", "ast-blocks", "keywords", "dep:uuid"]
 # Opt-in channel TTS schema; does not alter deployed profiles.
```

**Apply the merged patch instead of these per-slice diffs.** This hunk and the
sibling hunks in this note were corrected to count-correct headers, but slices
2a and 4a insert their own `Cargo.toml` feature at the *same* anchor, so the
per-slice diffs still conflict with each other. The integration-ready,
`git apply --check`-validated equivalent of all three slices is published as
`ready/team2-api-data-central-20261031.patch`.

Transitive closure (for the build-cap discussion): `twitch-streamers` →
`twitch-tokens` (`twitch-client`, `credential-crypto`, `mongo`, `redis`) +
`plan-cache` + `logger`; `twitch-client` → `http-client` (`reqwest`) + `tokio`;
`application-schemas` → `mongo`, `js-date`, `js-strings`; `cron-queue` →
`redis`, `serde`, `serde_json`, `uuid`. No new crate is added.

Optional narrower alternative (not used here, listed for completeness):
`twitch-headers` is only needed for the exact `getTwitchStreamerHeaderById`
message constants. Dropping it would require duplicating those three strings.

### 1.2 `dimabot/src/utils/mod.rs` — two module registrations

```diff
@@ -240,6 +240,10 @@
 #[cfg(feature = "cron-queue")]
 #[path = "cron_jobs_queue.rs"]
 pub mod cron_queue;
+#[cfg(feature = "follow-ledger-data")]
+pub mod follow_ledger;
+#[cfg(feature = "follow-ledger-data")]
+pub mod follow_ledger_queue;
 #[cfg(feature = "permissions")]
 #[path = "permissions/index.rs"]
 pub mod permissions;
```

### 1.3 `dimabot/src/schemas/mod.rs` — one schema registration

```diff
@@ -32,4 +32,7 @@
 #[cfg(feature = "follow-defense-schemas")]
 #[path = "follow_hate_raid_source.schema.rs"]
 pub mod follow_hate_raid_source;
+#[cfg(feature = "follow-ledger-data")]
+#[path = "follow_relationship_ledger.schema.rs"]
+pub mod follow_relationship_ledger;
 #[cfg(feature = "moderation-action-log-schema")]
 #[path = "moderation_action_log.schema.rs"]
 pub mod moderation_action_log;
```

### 1.4 `dimabot/src/lib.rs` — **no change required**

`pub mod schemas;` (gated on `application-schemas`) and `pub mod utils;` already
exist, and both new modules are registered as children of those modules. Nothing
in `lib.rs` re-exports individual utils or schemas, so a `lib.rs` entry would be
a duplicate registration. `follow-ledger-data` enables `application-schemas`, so
`dima_rust::schemas::follow_relationship_ledger` is reachable.

### 1.5 Tests — no `[[test]]` entry required

`dimabot/tests/follow_ledger_data.rs` begins with
`#![cfg(feature = "follow-ledger-data")]`, which is the convention used by the
other auto-discovered suites; it compiles to nothing without the feature. Add a
`[[test]]` block only if the team wants `required-features` enforcement.

Fixture suites (both `#[ignore]`, both named `*_against_disposable_*`):

```bash
cargo test --manifest-path dimabot/Cargo.toml --features follow-ledger-data \
  --test follow_ledger_data -- --ignored
```

Environment contract, documented in the file's doc comment as well:

```
FOLLOW_LEDGER_TEST_MONGO_URI / FOLLOW_LEDGER_TEST_MONGO_ACK=disposable
FOLLOW_LEDGER_TEST_MONGO_DATABASE=rust_follow_ledger_fixture_<unique>   # empty, dropped afterwards
FOLLOW_LEDGER_TEST_REDIS_URI / FOLLOW_LEDGER_TEST_REDIS_ACK=disposable
```

The Helix side needs no environment: the test starts the loopback `Recorder`
from `src/utils/test_http.rs` and serves `channels/followers` (two pages with a
cursor) and `channels/followed` (one page). The Redis suite removes only the
exact payload it enqueued (`LREM` by serialized value) and the dedupe key it
created (`DEL`).

`tests/support/schema_source.rs` pins **archived** TypeScript sources only. The
follow-ledger schema source is still live in this checkout, so no new pin and no
archive entry is needed. `tests/support/api_auth_support.rs` is unmodified and
unused by this suite (see §6). `tests/additional_schemas.rs` is driven by an
external fixture list; adding the new schema to that index matrix is optional and
outside this slice's ownership.

---

## 2. Public API surface (for team3-bot-ast)

### 2.1 `dima_rust::schemas::follow_relationship_ledger`

```rust
pub const MODEL_NAME: &str = "follow_relationship_ledger";
pub const COLLECTION_NAME: &str = "follow_relationship_ledgers";
pub const EXPORT_NAME: &str = "FollowRelationshipLedgerSchema";
pub const PLATFORMS: &[&str] = &["twitch"];
pub const STATUSES: &[&str] = &["active", "ended"];
pub const ENDED_REASONS: &[&str];       // 4 values, source order
pub type FollowRelationshipLedger = mongodb::bson::Document;

pub enum FollowPlatform { Twitch }                 // as_str / parse
pub enum FollowStatus { Active, Ended }            // as_str / parse
pub enum EndedReason { MissingInFollowersScan, MissingInFollowingScan, EventUnfollow, Unknown }

pub fn schema() -> &'static SchemaDefinition;      // the only schema source of truth
pub fn collection(database: &Database) -> Collection<Document>;
pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()>;
```

`install_indexes` is explicit only. The collector never installs indexes and the
worker must not rely on it doing so.

### 2.2 `dima_rust::utils::follow_ledger`

```rust
pub const DEFAULT_BATCH_SIZE: usize = 250;
pub const FOLLOW_START_MAX_ATTEMPTS: usize = 3;
pub const USERS_COLLECTION: &str = "users";
pub const PLATFORM_TWITCH: &str = "twitch";
pub const HELIX_PAGE_SIZE: u32 = 100;
pub const DEFAULT_PLATFORM: &str = "twitch";
pub const INVALID_CHANNEL_MESSAGE: &str = "Invalid channel ID";
pub const SYNC_COMPLETE_MESSAGE: &str = "Follow ledger sync completed";

pub enum FollowLedgerDate { Date(DateTime), Text(String) }
impl FollowLedgerDate { pub fn resolve(&self, now: DateTime) -> DateTime }

pub struct RecordFollowLedgerStartInput { /* 6 Option<String> + followed_at + platform */ }
impl RecordFollowLedgerStartInput { pub fn new(follower_id, followed_id) -> Self }

pub struct HelixFollowerItem { user_id, user_login, user_name, followed_at: String }
pub struct HelixFollowedItem { broadcaster_id, broadcaster_login, broadcaster_name, followed_at }

pub struct FollowLedgerSyncStats { total_from_api: f64, requests, pages, active_upserts, ended_count: usize }
impl FollowLedgerSyncStats { pub fn merge(self, other: Self) -> Self }

pub type FollowLedgerHookFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
pub type FollowLedgerHook = Arc<dyn Fn() -> FollowLedgerHookFuture<'static> + Send + Sync>;

pub struct FollowLedgerSyncOptions {
    pub write_batch_size: Option<usize>,
    pub before_request: Option<FollowLedgerHook>,
    pub before_followers_request: Option<FollowLedgerHook>,
    pub before_following_request: Option<FollowLedgerHook>,
}

pub struct FollowLedgerSyncResult {
    pub error: bool, pub message: String, pub channel_id: Option<String>,
    pub status: Option<u16>,                     // always None, see §4.7
    pub total_from_api: f64, pub requests: usize, pub pages: usize,
    pub active_upserts: usize, pub ended_count: usize,
}

pub struct FollowLedgerSyncOutcome { pub result: FollowLedgerSyncResult, pub failure: Option<FollowLedgerError> }

pub struct FollowLedgerStreamer { pub login: String, pub has_permissions: String }
pub type FollowLedgerFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub trait FollowLedgerStreamerDirectory: Send + Sync {
    fn streamer<'a>(&'a self, channel_id: &'a str) -> FollowLedgerFuture<'a, Option<FollowLedgerStreamer>>;
}
impl FollowLedgerStreamerDirectory for TwitchStreamers;   // account_by_id().ok()

pub enum FollowLedgerError {
    InvalidChannelId, StreamerNotFound { channel_id }, StreamerPermissions, StreamerToken,
    HelixResponse { message, status: Option<u16> }, Twitch(TwitchError), Mongo(MongoError),
    Redis(redis::RedisError), Directory(DirectoryError), Validation(ValidationErrors),
    Configuration(&'static str),
}
impl FollowLedgerError { pub fn status(&self) -> Option<u16> }   // Display + Error + From<...>

pub enum FollowStartWriteMode { Transactional, StandaloneFallback }   // + as_str()
pub const OAUTH_DIAGNOSTIC_WORKER: &str = "follow_ledger";

/// ONE TwitchTokenStorage for both roles (Helix TokenSource + directory
/// StreamerCredentials); mirrors `NativeFunctionAuth` in `functions/mod.rs`.
pub struct SharedTwitchTokens;   // Send + Sync
impl SharedTwitchTokens {
    pub fn new(storage: TwitchTokenStorage) -> Self;                 // no I/O
    pub fn from_shared(storage: Arc<TwitchTokenStorage>) -> Self;
    pub fn storage(&self) -> &Arc<TwitchTokenStorage>;
}
impl TokenSource for SharedTwitchTokens;            // delegates to the storage
impl StreamerCredentials for SharedTwitchTokens;    // snapshot/token/refresh_secret

pub struct OAuthApiFailureRecord<'a> { url, method, headers: &'a HeaderMap, status,
    body, worker, operation, channel_id: Option<&'a str>, context: Option<Value>,
    secrets: &'a [&'a str] }
pub enum OAuthFailureCacheError { Redis(redis::RedisError) }   // Display + Error + From
pub fn oauth_api_failure_payload(&OAuthApiFailureRecord, timestamp_ms: i64) -> Value;
pub async fn cache_oauth_api_failure(&mut ConnectionManager, &OAuthApiFailureRecord)
    -> Result<(), OAuthFailureCacheError>;   // SET oauth:failures:api:<ms> ... EX 86400

pub struct FollowLedgerService;   // Send + Sync, not Clone
impl FollowLedgerService {
    pub fn new(database: Database, twitch: TwitchClient,
               tokens: Arc<dyn TokenSource>,
               directory: Arc<dyn FollowLedgerStreamerDirectory>) -> Self;   // no I/O
    /// Composition root: one shared storage supplies BOTH roles.
    pub fn with_shared_tokens(database: Database, twitch: TwitchClient,
                              tokens: Arc<SharedTwitchTokens>,
                              store: Arc<dyn MetadataStore>,
                              cache: Arc<dyn DirectoryCache>,
                              clock: Arc<dyn TokenClock>,
                              config: DirectoryConfig) -> Result<Self, FollowLedgerError>;
    pub async fn from_runtime() -> Result<Self, FollowLedgerError>;          // explicit wiring only
    pub fn with_oauth_failure_cache(self, ConnectionManager) -> Self;
    pub fn with_logger(self, Arc<Logger>) -> Self;
    pub fn with_write_batch_size(self, usize) -> Self;
    pub fn with_retry_policy(self, HelixRetryPolicy) -> Self;
    pub fn last_follow_start_mode(&self) -> Option<FollowStartWriteMode>;
    pub fn ledger(&self) -> &Collection<Document>;
    pub fn users(&self) -> &Collection<Document>;
    pub fn ledger_collection_name(&self) -> &'static str;

    pub async fn record_follow_ledger_start(&self, &RecordFollowLedgerStartInput)
        -> Result<(), FollowLedgerError>;   // transactional, falls back on standalone
    pub async fn get_follow_ledger_sync_channel_ids(&self) -> Result<Vec<String>, FollowLedgerError>;
    pub async fn sync_follow_ledger_for_channel(&self, channel_id: &str, &FollowLedgerSyncOptions)
        -> FollowLedgerSyncResult;                     // source-shaped, never returns Err
    pub async fn sync_follow_ledger_for_channel_outcome(&self, channel_id: &str, &FollowLedgerSyncOptions)
        -> FollowLedgerSyncOutcome;                    // same flow + typed failure
}

// pure helpers, exported for diagnostics and tests
pub fn form_encode(text: &str) -> String;
pub fn followers_params(channel_id: &str, cursor: Option<&str>) -> String;
pub fn followed_params(channel_id: &str, cursor: Option<&str>) -> String;
pub fn next_cursor(payload: &serde_json::Value) -> Option<String>;
```

Worker shape for team3:

```rust
let service = FollowLedgerService::from_runtime().await?;   // once per process
let channels = service.get_follow_ledger_sync_channel_ids().await?;
for channel in channels {
    let outcome = service
        .sync_follow_ledger_for_channel_outcome(&channel, &FollowLedgerSyncOptions::default())
        .await;
    // outcome.result is the source result object; outcome.failure is typed.
}
```

### 2.3 `dima_rust::utils::follow_ledger_queue`

```rust
pub const FOLLOW_LEDGER_JOB_NAME: &str = "follow-ledger-sync";
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_PREFIX: &str = "follow-ledger-sync";
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_ENV: &str = "FOLLOW_LEDGER_QUEUE_DEDUPE_SECONDS";
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_DEFAULT_SECONDS: f64 = 900.0;
pub const FOLLOW_LEDGER_QUEUE_DEDUPE_MIN_SECONDS: f64 = 60.0;
pub const FOLLOW_LEDGER_DEFAULT_REASON: &str = "manual_request";
pub const INVALID_CHANNEL_MESSAGE: &str = "Invalid channel ID";

pub struct EnqueueFollowLedgerSyncJobResult {
    pub enqueued: bool, pub message: String, pub dedupe_key: String, pub job: Option<CronQueueJob>,
}

pub fn normalize_value(Option<&str>) -> &str;                       // JavaScript trim
pub fn get_follow_ledger_dedupe_key(channel_id: &str) -> String;
pub fn follow_ledger_queue_dedupe_seconds_from(Option<&str>) -> f64;   // pure
pub fn follow_ledger_queue_dedupe_seconds() -> f64;                    // reads env per call

pub async fn enqueue_follow_ledger_sync_job(
    queue: &mut RedisCronQueue,
    clock: &mut impl CronQueueClock,
    uuids: &mut impl CronQueueUuidSource,
    channel_id: &str, reason: Option<&str>, requested_by: Option<&str>,
) -> Result<EnqueueFollowLedgerSyncJobResult, FollowLedgerQueueError>;

pub async fn enqueue_follow_ledger_sync_job_with_defaults(
    queue: &mut RedisCronQueue, channel_id: &str, reason: Option<&str>, requested_by: Option<&str>,
) -> Result<EnqueueFollowLedgerSyncJobResult, FollowLedgerQueueError>;   // SystemQueueClock + RandomUuidSource

pub fn javascript_iso_millis(millis: i64) -> String;   // Date.toISOString
pub struct SystemQueueClock;                           // impl CronQueueClock

pub enum FollowLedgerQueueError {           // Display + Error + From<CronQueueError>
    Json(serde_json::Error),                // payload serialization
    Redis(redis::RedisError),               // transport / refusal
}
```

---

## 3. Source parity

### 3.1 Schema

| Field | BSON type | Default | Required | enum |
| --- | --- | --- | --- | --- |
| `platform` | String | `"twitch"` | yes | `twitch` |
| `follower_id` | String | — | yes | |
| `follower_login` | String | `""` | no | |
| `follower_name` | String | `""` | no | |
| `followed_id` | String | — | yes | |
| `followed_login` | String | `""` | no | |
| `followed_name` | String | `""` | no | |
| `mutual` | Boolean | `false` | no | |
| `status` | String | `"active"` | no | `active`, `ended` |
| `followed_at` | Date | `Date.now` | yes | |
| `ended_at` | Date | `null` | no | |
| `ended_reason` | String | `null` | no | 4 source values |
| `last_event_at` | Date | `Date.now` | yes | |

Model `follow_relationship_ledger`, collection `follow_relationship_ledgers`
(Mongoose pluralisation; already read by `utils::follow_defense_baseline`),
`_id: ObjectId`, `__v` version key, timestamps `created_at` / `updated_at`.

Indexes, in source order (10 total):
`{platform}`, `{follower_id}`, `{followed_id}`, `{mutual}`, `{status}`,
`{last_event_at}`, `{followed_id,status}`, `{followed_id,mutual,status}`,
`{follower_id,status}`, and
`{platform,follower_id,followed_id,status}` **unique**, partial filter
`{status:"active"}`. **No TTL index exists in the source**, so none is declared.

### 3.2 Collector

* `recordFollowLedgerStart`: trims both ids, returns without I/O when either is
  blank, one `toDate` conversion reused for `followed_at` / `ended_at` /
  `last_event_at`, reads the reverse active edge first, ends every active
  forward edge with `ended_reason: "unknown"` and `mutual: false`, inserts the
  new active edge with `mutual` = reverse-active-present, then promotes the
  reverse edge's `mutual` when it was still false. All four operations run in
  one transaction on a replica set; a deployment that rejects transactions runs
  the same four operations without a session (source fallback branch). Both
  paths share `FOLLOW_START_MAX_ATTEMPTS = 3` and the same retryable set.
* `getFollowLedgerSyncChannelIDs`: `accounts.$elemMatch{type:"twitch",
  actived:true, has_permissions:true}`, projection `accounts`, strict
  `type === 'twitch'`, JavaScript truthiness for `actived`,
  `has_permissions` and `refresh_token.content`, id trimmed and de-duplicated in
  first-seen order.
* `syncFollowLedgerForChannel`: blank-channel reject → directory lookup →
  `has_permissions === 'true'` → streamer token → concurrent incoming
  (`channels/followers`, `broadcaster_id`, `first=100`) and outgoing
  (`channels/followed`, `user_id`, `first=100`) scans.
* Per page: `stats.requests += 1`, then `stats.pages += 1`, `totalFromApi =
  max(totalFromApi, total)`, reverse active set lookup (only when ids exist),
  upserts on `{platform,follower_id,followed_id,status:"active"}` with
  `$setOnInsert.platform`, `upsert: true`, unordered bulk writes chunked by
  `max(1, writeBatchSize || 250)`, reverse `mutual: true` promotion, cursor
  continuation (`after=`).
* After the pages: active rows not seen in the scan are ended with
  `missing_in_followers_scan` / `missing_in_following_scan`, `mutual: false`,
  `last_event_at`; previously-mutual rows reset the reverse edge's `mutual`.
* `reconcileMutualForChannel` runs last: four `updateMany` calls in source order
  (outgoing mutual, outgoing non-mutual, incoming mutual, incoming non-mutual).
* Result statistics merge both halves; an incoming page error is reported before
  an outgoing page error; a thrown scan error or a reconcile error returns
  zeroed statistics, exactly like the source's `catch` branch.

### 3.3 Queue

* Job name and dedupe prefix are both `follow-ledger-sync`; the dedupe key is
  `cron:jobs:dedupe:follow-ledger-sync:<trimmed channelID>`.
* Window: `max(60, Number(FOLLOW_LEDGER_QUEUE_DEDUPE_SECONDS || 900))`, resolved
  **per call**. `NaN` (malformed text) is omitted so the cron queue's own default
  applies, matching the source's `NaN` falsiness.
* Payload: `channelID`, `accountID` (both the trimmed channel), optional
  `requestedBy` (trimmed downstream), `dedupeToken`
  `follow-ledger-sync:<channel>`, `data.reason` (default `manual_request`),
  `data.type` `follow-ledger-sync`.
* Blank channel returns `{enqueued:false, message:"Invalid channel ID",
  dedupeKey:"", job:undefined}` without touching Redis.

---

## 4. Deliberate deviations, with reasons

1. **`record_follow_ledger_start` returns `Result<(), FollowLedgerError>`.** The
   source returns `void` and only `console.error`s. Returning the typed error
   lets the worker decide; the original flow is reproduced by ignoring `Err`.
   The error is also logged at the source's only console site when a `Logger` is
   attached. Blank identifiers still return `Ok(())` without I/O.
2. **`get_follow_ledger_sync_channel_ids` returns `Result<_, _>`.** The source
   logs and returns `[]`. Returning the error prevents an infrastructure outage
   from looking like "no channels configured"; the caller can still map `Err` to
   `[]` for exact old behaviour.
3. **The follow-start write IS transactional; the standalone branch is the
   source's own fallback.** Implemented against the pinned driver:
   `Client::start_session` (`action/session.rs:17`), `ClientSession::
   start_transaction` (`action/transaction.rs:38`, executed at
   `client/session/action.rs:25`), `commit_transaction` (`action/transaction.rs:73`),
   `abort_transaction` (`action/transaction.rs:108`), and
   `.session(impl Into<&mut ClientSession>)` on every participating operation
   (`action/find.rs:175`, `action/update.rs:135`, `action/insert_one.rs:76`).
   All four source operations — reverse read, forward `updateMany`, `insertOne`
   and the reverse `mutual` promotion — are attached to the same session.
   Selection is typed: [`FollowStartWriteMode`] and
   `last_follow_start_mode()` report which path committed. The driver's
   convenience wrapper `StartTransaction::and_run2`
   (`client/session/action.rs:377`) is deliberately **not** used because its
   callback must return `mongodb::error::Error`, which would erase the typed
   validation/runtime distinction; commit/abort and the outer
   `FOLLOW_START_MAX_ATTEMPTS = 3` retry loop reproduce the same control flow.
   Deviation risk that remains and is accepted with the source: a commit that
   fails with `UnknownTransactionCommitResult` is retried as a whole
   transaction, so an actually-committed retry can leave one extra `ended` row
   (the TS `withTransaction` + outer loop behaves the same way).
4. **Retryable labels use the driver accessor.** Codes `11000, 112, 91, 189, 251`
   from `ErrorKind::Command`, `WriteFailure::WriteError` and
   `BulkWriteError.write_errors` are checked first, then
   `Error::contains_label(TRANSIENT_TRANSACTION_ERROR)` /
   `contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT)` (pinned
   `error.rs:267`, label constants `error.rs:47-52`). No rendered-text scanning
   remains.
5. **One directory read instead of two.** The source calls
   `getTwitchAccountById` for the login and then `getTwitchStreamerHeaderById`,
   which repeats the same cache-backed directory lookup. The native gate reads the
   directory once and uses both `name` and `has_permissions` from that record.
   Observable behaviour is unchanged; it removes one Redis round trip per sync.
6. **`TwitchHeaders` is not instantiated.** `TwitchHeaders::new` requires an
   `Arc<Logger>` plus a token-injection source owned by the application runtime,
   and the worker is expected to own that wiring. The collector therefore
   reproduces `getTwitchStreamerHeaderById`'s exact gate order and returns the
   module's own message constants (`STREAMER_PERMISSIONS_MESSAGE`,
   `STREAMER_TOKEN_MESSAGE`, `streamer_not_found_message`), so strings cannot
   drift. The Helix request itself is issued by `TwitchClient::request`, i.e. the
   same transport and 401 policy as the TS helper.
7. **`FollowLedgerSyncResult.status` is always `None`.** The source's
   `syncFollowLedgerForChannel` never populates it (page status is dropped inside
   the scan helpers). The page status is preserved on
   `FollowLedgerError::HelixResponse.status` and reachable through
   `FollowLedgerSyncOutcome::failure`.
8. **Mongoose timestamps are written explicitly.** `created_at` /
   `updated_at` are added to every `$setOnInsert` / `$set` the schema framework
   would have added implicitly, because the native driver has no timestamps
   plugin. One `DateTime::now()` per operation (and per inserted page item) is
   used instead of Mongoose's per-operation `Date.now()`; the values are
   operational metadata only.
9. **Unreadable Helix bodies use a static sanitized message.** Where the source
   surfaces the raw JSON/parse exception, the port reports
   `Twitch response body could not be read` plus the HTTP status, so no response
   body or header can leak into logs.
10. **`$in` ordering.** `Array.from(set)` order is preserved where it is
    observable, but a filter's `$in` array order has no effect on matching, so
    identical values may appear in a different order than the source's `Set`.
11. **`from_runtime` performs the native helper lookups.** `new()` is pure (no
    connect, no index install, no environment read). `from_runtime()` is the
    explicit wiring point: it resolves `get_mongo_client()` (which pings),
    `get_redis_client()`, `TwitchCredentials::from_env()`, `CredentialCipher`
    (`SECRET_KEY`) and `CLIENT_ID`, then builds the token storage and directory.
    It installs no index, spawns no task and caches nothing in a static. The
    Twitch client it builds has a 20-second request timeout; callers using
    `new()` choose their own.
12. **ONE shared `Arc<TwitchTokenStorage>` for both roles (was: two copies).**
    `SharedTwitchTokens` owns a single `Arc<TwitchTokenStorage>` and implements
    both `TokenSource` (Helix client) and `StreamerCredentials` (directory), so
    there is no second storage, no duplicated cipher/clock, and the refresh guard
    configured by the composition root applies to both roles. The composition
    root is `from_runtime`/`with_shared_tokens`, which passes the same
    `Arc<SharedTwitchTokens>` to `TwitchStreamers::new` and to the service. This
    mirrors `NativeFunctionAuth` (`functions/mod.rs`), which holds
    `tokens: Arc<TwitchTokenStorage>` beside `directory: Arc<TwitchStreamers>`.
    `FollowLedgerService::new` still accepts `Arc<dyn TokenSource>` so fixtures
    can inject a light source; the production constructors always share.
    `from_runtime` applies `with_refresh_guard(30s, 25s)` once (the guard the
    retired `NativeCredentials` adapter used to apply) instead of relying on a
    per-directory copy.
13. **`writeBatchSize` is `usize`.** JavaScript numbers (including fractions) are
    not reproduced; `Some(0)` falls back to `DEFAULT_BATCH_SIZE` as in
    `Math.max(1, x || 250)`.
14. **Enqueued job type is `CronQueueJob`**, which is a superset of the source's
    inline job object (it also carries `userID` when set). All source fields keep
    their names and values.
15. **Retry attempt logging stays in the transport; the OAuth failure cache is
    written by the collector.** The TS helper logs each intermediate retry; the
    native client owns those retries and logs nothing. The *terminal* 401 side
    effect (`cacheOAuthAPIFailure`) is a real side effect and is implemented here:
    the collector logs `Twitch 401 persisted after retries. Continuing workflow.`
    and writes `oauth:failures:api:<ms>` for its own exhausted 401s. See §5.2.

---

## 5. Contract for team3-bot-ast

### 5.1 Helix 401 retry mechanics (unchanged, covered)

`utils/twitch.rs` already covers `executeHelixStreamerRequestWith401Retry`. Do
not port `src/utils/twitch_helix_retry.ts` for this path.

* `HelixRetryPolicy::default()` = the TS `DEFAULT_RETRY_DELAYS_MS`
  `[1000, 3000, 5000]`: one initial attempt plus up to three retries, each after
  the corresponding delay.
* Every retry calls the injected `TokenSource::token` again before replaying, i.e.
  the same "refresh the streamer token, then retry" contract as the TS
  `onUnauthorized` hook. A failed reacquisition keeps the previous credential
  (TS also catches the refresh error and continues).
* Only `401` triggers a retry; transport errors, 429 and 5xx are returned
  without replay, and exhausted 401s are returned as a response (never a panic).
* `TwitchClient::request` rebuilds headers per attempt and rejects an identity
  mismatch before the first request (`TwitchAuth::Streamer(id)` requires the
  token subject to be `id`).
* Redirects are disabled. The TS helper inherits `fetch`'s redirect behaviour.
* Optional injection: `FollowLedgerService::with_retry_policy(...)` for tests
  (`HelixRetryPolicy::from_millis(&[0])` gives one immediate retry;
  `single_attempt()` disables retries).

### 5.2 OAuth failure debug cache — REQUIRED ADAPTER, author-facing

`cacheOAuthAPIFailure` is a **real side effect** of the source's OAuth failure
path (one Redis key per exhausted 401, 24 h TTL). It is **not** a diagnostic-only
difference. This slice supplies the concrete adapter and wires its own call site;
the transport-level hook is the remaining contract for team3.

Supplied here (no skeleton, usable as-is):

```rust
pub fn oauth_api_failure_payload(&OAuthApiFailureRecord<'_>, timestamp_ms: i64) -> serde_json::Value;
pub async fn cache_oauth_api_failure(
    connection: &mut redis::aio::ConnectionManager,
    record: &OAuthApiFailureRecord<'_>,
) -> Result<(), OAuthFailureCacheError>;

pub struct OAuthApiFailureRecord<'a> {
    pub url: &'a str,
    pub method: &'a str,
    pub headers: &'a reqwest::header::HeaderMap,
    pub status: u16,
    pub body: &'a str,
    pub worker: &'a str,
    pub operation: &'a str,
    pub channel_id: Option<&'a str>,
    pub context: Option<serde_json::Value>,
    pub secrets: &'a [&'a str],
}
```

* Key: `format!("{OAUTH_API_FAILURE_PREFIX}{timestamp_ms}")` →
  `oauth:failures:api:<Date.now()>`; value: the sanitized JSON payload;
  TTL: `OAUTH_DIAGNOSTIC_TTL_SECONDS` (86 400). Both constants come from
  `utils/twitch.rs`.
* Payload: `utils::twitch::api_failure_diagnostic(..)` (the existing pure
  builder) plus the source's `worker`, `operation`, `channelID`, `context`
  fields in source order, plus the source's
  `process.env.CLIENT_ID || "unknown"` clientId fallback.
* Collector call site (implemented): `page_payload` detects a final 401 for
  `channels/followers` and `channels/followed`, logs the source's
  `Twitch 401 persisted after retries. Continuing workflow.` line and writes one
  record. `from_runtime` always supplies the connection
  (`with_oauth_failure_cache`), so production never skips it. The write error is
  logged and swallowed, exactly like the source's `catch`.
* Source fidelity for this call site: the follow-ledger TS caller passes no
  `requestHeaders`, so the source stores `headers: {}` and derives `clientId`
  from `process.env.CLIENT_ID`; the native record does the same (empty
  `HeaderMap`, env fallback). Source `context` is `{cursor}` and
  `context.channelID` is absent, so `channelID` is omitted.

**Remaining contract for team3-bot-ast (`utils/twitch.rs`, owner: team3).**
`TwitchClient::request` must, when the final response for a *replayed* request is
401 (i.e. `attempts > 1` and the retry budget is exhausted), call the adapter
above with the true request headers, URL, method, status and body before
returning `HelixResult`:

```rust
// Add to TwitchClient (or an injected sink):
pub trait OAuthDiagnosticSink: Send + Sync {
    fn api_failure<'a>(&'a self, record: &'a OAuthApiFailureRecord<'a>)
        -> Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>>;
}
```

The sink is best-effort: it must never change the returned `HelixResult`, and a
write error must be swallowed (the source logs and continues). Until that hook
exists, other Helix callers (commands, clips, moderation) still produce no OAuth
failure records; the follow-ledger path is complete because the collector
observes the exhausted 401 itself.

## 6. Remaining gaps / not ported

1. **OAuth diagnostic sink inside the transport** — §5.2. The concrete adapter
   and the follow-ledger call site exist; `TwitchClient::request` still needs the
   hook so *other* Helix callers record their exhausted 401s. Owner: team3-bot-ast.
2. **Driver convenience wrapper** — `StartTransaction::and_run2` is not used
   (typed error erasure); the explicit start/commit/abort path plus the outer
   retry loop covers the same semantics. See §4.3.
3. **Worker loop** — job pop/requeue/dead-letter, retry limits, `attempt`
   increments and the schedule itself are team3's, using the existing
   `utils::cron_queue::{pop_left_blocking_raw, push_right_job, with_next_attempt,
   get_job_attempt, clear_cron_job_dedupe_by_key}` primitives. This slice ships
   only the producer side and the collector.
4. **HTTP-contract fixtures** — `tests/support/api_auth_support.rs` was not
   reused: including it would drag the Axum `http` feature into a data-only
   feature, and its `Provider` has a fixed route table (`/oauth2/validate`,
   `/helix/users`) that cannot serve `channels/followers`. The suite therefore
   uses the std-thread loopback `Recorder` from `src/utils/test_http.rs`, which
   is already shared by several suites and needs no extra feature, and a real
   disposable Redis/Mongo pair instead of a scripted RESP server. No new support
   file was created.
5. **Non-Twitch platforms.** `RecordFollowLedgerStartInput.platform` accepts any
   string, but the schema enum (and therefore `prepare_insert`) rejects anything
   other than `twitch`, matching the source's validation failure. There is no
   platform adapter for Kick and the source has none either.
6. **`status()` on the sync result** — see §4.7.
7. **`FollowLedgerService` is not `Clone`** — it holds an `AtomicU8`, so callers
   share it behind `Arc` (the worker should). No behavioural effect.

## 6a. Fixtures for the two follow-start paths

### Standalone (non-transactional fallback) — already covered

Any plain `mongod` works; the existing suite
`collector_sync_and_follow_start_against_disposable_mongo` asserts
`last_follow_start_mode() == StandaloneFallback` after a successful
`record_follow_ledger_start`. Driver behaviour: `start_session` succeeds,
`start_transaction` fails with
`ErrorKind::Transaction {"Transactions are not supported by this deployment"}`
(`client/session/action.rs:25-122`, `sdam/description/topology.rs:759-775`), and
the collector runs the same four operations without a session. Both the session
creation and the support check are local (no server round trip), so the extra
attempt costs no network latency; the session is dropped immediately and its
(retired) drop task performs no transaction abort because none ever started.

```
FOLLOW_LEDGER_TEST_MONGO_URI=mongodb://127.0.0.1:27017
FOLLOW_LEDGER_TEST_MONGO_DATABASE=rust_follow_ledger_fixture_<unique>   # empty, dropped after
FOLLOW_LEDGER_TEST_MONGO_ACK=disposable
```

### Replica set (transaction branch)

Suite: `follow_start_commits_in_a_transaction_on_a_replica_set`
(`#[ignore = "requires a lead-owned single-node replica set (FOLLOW_LEDGER_TEST_RS_*)"]`).

Preparation, in this order — the replica set must be **initiated and primary**
before the test runs:

```bash
mongod --replSet rs0 --port 27018 --dbpath /tmp/opencode/fl-rs-<unique> --bind_ip 127.0.0.1
# once, after the server is listening:
mongosh --port 27018 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]})'
mongosh --port 27018 --eval 'while (!db.hello().isWritablePrimary) { sleep(200) }'
```

```
FOLLOW_LEDGER_TEST_RS_MONGO_URI=mongodb://127.0.0.1:27018/?directConnection=true
FOLLOW_LEDGER_TEST_RS_MONGO_DATABASE=rust_follow_ledger_rs_fixture_<unique>   # empty, dropped after
FOLLOW_LEDGER_TEST_RS_ACK=replica-set
```

* `directConnection=true` keeps the driver pinned to the single member; without
  it a single-node set can flap during discovery.
* The test **detects** the topology instead of assuming it:
  `admin.run_command({"hello": 1})` must return `setName`, otherwise the test
  fails with `fixture is not a replica set: hello.setName is missing`.
* Cleanup: the suite drops its own database; the operator stops the `mongod` and
  removes its private `--dbpath` (it is task-owned, never a shared volume).
* What it asserts: the first write reports `FollowStartWriteMode::Transactional`;
  a second write over a reverse active edge commits and the reverse row is
  promoted to `mutual` inside the transaction; a rejected platform returns
  `FollowLedgerError::Validation` (abort path), records no new mode, and leaves
  exactly the two committed rows.

## 6b. Test inventory added in this revision

| Test | Needs | Covers |
| --- | --- | --- |
| `collector_sync_and_follow_start_against_disposable_mongo` (extended) | plain `mongod` + loopback recorder | the **standalone fallback** branch: asserts `last_follow_start_mode() == StandaloneFallback` after a successful follow-start write, plus the existing scan/queue behaviour |
| `follow_start_commits_in_a_transaction_on_a_replica_set` (new, `#[ignore]` naming the replica set) | single-node replica set (`FOLLOW_LEDGER_TEST_RS_*`) | the **transaction branch**: `hello.setName` detection, `Transactional` mode, reverse-edge promotion inside the transaction, and the abort path (invalid platform → `Validation`, no new mode, exactly two rows) |
| `shared_token_storage_is_observed_by_both_roles` (new, pure) | nothing (in-memory `CredentialStore + TokenCache + OAuthExchange + TokenClock`) | GAP F: one `Arc<TwitchTokenStorage>` (`strong_count == 1`), a refresh through the directory role, and the Helix role observing it with **no second OAuth exchange** |
| existing pure tests | nothing | schema, dedupe key/seconds, `followed_at`, pagination, constants, clock, stats merge |

`TokenFixture` in `tests/follow_ledger_data.rs` is a test-only double; it does not
replace the production adapters (`MongoCredentialStore`, `RedisTokenCache`,
`TwitchOAuthClient`, `SystemTokenClock`) wired by `from_runtime`.

## 7. What was and was not verified

* Not compiled, not formatted, not executed: this wave forbids `cargo`,
  `rustfmt`, `node`, tests and containers. The integration team owns compilation.
* Static checks only: file inventory, cross-reads of every native API used
  (`SchemaDefinition`/`SchemaIndex`, `cron_queue`, `twitch`, `twitch_tokens`,
  `twitch_streamers`, `twitch_headers`, mongo/redis/logger entry points),
  `git diff --check` on the added files, and `git status` to confirm no file
  outside the owned list changed.
* Pinned driver sources read for this revision (mongodb 3.9.1 under
  `/root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/mongodb-3.9.1/`):
  `action/session.rs:17` (`start_session`), `action/transaction.rs:38/73/108`
  (`start_transaction`/`commit_transaction`/`abort_transaction`),
  `client/session/action.rs:25/122/377` (`start_transaction_impl`, the
  `Action` impl and the unused `and_run2`), `action/find.rs:175`, `action/update.rs:135`,
  `action/insert_one.rs:76` (`.session()`), `client/session.rs:426` (`Drop`),
  `error.rs:267` (`contains_label`), `error.rs:646-764` (`ErrorKind` variants),
  `sdam/description/topology.rs:759-775` (`TransactionSupportStatus`).
* Points worth a reviewer's eye during compilation:
  * `UpdateOneModel::builder().namespace(...).filter(...).update(...).upsert(true).build()`
    and `collection.bulk_write(Vec<UpdateOneModel>).ordered(false)` — same shape
    as `utils/stream_activity.rs`.
  * `ErrorKind::{Command, Write(WriteFailure::WriteError), BulkWrite}` field
    access (`code`, `write_errors`) — same shape as `utils/bits_rules/store.rs`
    and `utils/dashboard_activity.rs`.
  * `ErrorKind::Transaction` is `#[non_exhaustive]`: matched as
    `ErrorKind::Transaction { message, .. }`.
  * `MongoStreamerStore`/`RedisStreamerCache`/`SharedTwitchTokens` argument
    coercions to `Arc<dyn MetadataStore|DirectoryCache|TokenSource|
    StreamerCredentials>` inside `from_runtime`/`with_shared_tokens`.
  * `Option<&mut ClientSession>::as_deref_mut()` reborrow used to attach one
    session to four builder actions (the session-attachment branches share the
    same action value).
  * `Recorder::start(move |request| ...)` closure shape in the ignored suite.
  * The in-memory `TokenFixture` in `tests/follow_ledger_data.rs` implements
    `CredentialStore + TokenCache + OAuthExchange + TokenClock`; it exists only
    to prove the single-storage sharing without Mongo/Redis.
