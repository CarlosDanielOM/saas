# dima-rust

`dima-rust` is a Rust library for incremental migrations of selected worker and server components. The latest image, `sha256:adac7d8de9b5c5cfb138f8051a05123ac02a6c3467cc85784873ee85370d892f`, deployed to the existing cron service in run `cron-2056ce9d790c` at `2026-10-22T05:15:05.047669035Z`, with seven native children. Nine exact-image suites passed (150 groups) and source identity passed; the 32-sample production watch across 332.257 seconds, final readbacks, binary identities, analytics/log checks, and cleanup passed. The release is accepted. Rollback with `scripts/saas-ops rollback cron-2056ce9d790c` restores previously accepted run `cron-bf400acbc441`, image `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30`, with seven native workers and the private helper implementations. The previous dashboard release's acceptance evidence remains in [dashboard-activity.md](../migration-notes/dashboard-activity.md). See [worker-shared-utils.md](../migration-notes/worker-shared-utils.md) for the candidate details and [migration-notes/README.md](../migration-notes/README.md) for migration status. `scripts/saas-ops build cron` stages source-defined binaries in the existing cron image; it adds no service/container.

Cargo defaults preserve `mongo`, `redis`, `postgres`, and `http` for library/manual consumers. The six prior cron binaries use existing Mongo-only or Mongo/Redis profiles. Dashboard uses `--no-default-features --features mongo,redis,http-client,unicode-collation`; reqwest 0.12.28 and ICU collation are isolated to it. Cargo declares `icu_collator` 2.3.0, and the lockfile resolves 2.3.1. SQLx/PostgreSQL and Axum remain excluded from worker profiles. The shared-utility release retained all three dependency graphs byte-identically; its build and tests passed, and production acceptance passed. See [worker-shared-utils.md](../migration-notes/worker-shared-utils.md) and [dashboard-activity.md](../migration-notes/dashboard-activity.md) for current and historical evidence.

## Opt-in consolidated utility foundations

The library also exposes `utils::{command_cooldown,keywords,chat_events,ai_usage,eventsub,domain_events}` behind independent features `command-utils`, `keywords`, `chat-events`, `ai-usage`, `eventsub`, and `domain-events`. `bot-utils` enables those six together. `utils::twitch` and `utils::polar` are separately gated by `twitch-client` and `polar-client`. All are opt-in, outside Cargo defaults and deployed worker profiles; TypeScript remains unchanged and no production caller is wired. These are reusable cores, not complete migrations. Existing worker utilities stay in place.

The stateful boundaries are injected: implement `CooldownStore` for command cooldown reads/leases, `KeywordStorage` for keyword persistence/cache coordination, and `TokenSource` for Twitch credentials and permission/expiry policy. Rust MongoDB/Redis adapters are not wired. Twitch and Polar provide real HTTP transport that can be tested against loopback servers; an OAuth adapter must persist rotated credentials before using them. EventSub canonicalization supports legal flat string conditions, and domain-event helpers project envelopes and build keys; with `mongo`, BSON projection preserves BSON values.

```rust
use dima_rust::utils::{eventsub, keywords};

let entries = [keywords::KeywordEntry {
    id: "greeting".into(), text: "hello".into(),
    match_mode: keywords::KeywordMatchMode::Anywhere,
}];
let index = keywords::compile_keyword_index(entries);
assert_eq!(keywords::match_keywords(&index, "hello world").len(), 1);
let condition = eventsub::Condition::from([("broadcaster_user_id", "123")]);
let key = eventsub::subscription_key("channel.follow", "2", &condition);
```

The source mappings, behavioral limits, and verification commands are in [ts-util-foundations.md](../migration-notes/ts-util-foundations.md).

Use Serde to map BSON documents into explicit structs. Garde checks additional field and business constraints only when `validate()` is called. Future ports must explicitly preserve existing collection names, field types, defaults, and indexes.

## Shared worker utilities

The `mongo` feature exposes small compatibility and process helpers in `utils::{bson_compat,js_compat,utc_time,worker_process}`. `bson_compat::js_number` and `normalize_document` preserve the Node BSON Number read/write boundary for selected payloads; callers decide which documents to normalize. `utc_time::utc_midnight` and `inclusive_day_start` provide UTC calendar arithmetic without choosing a worker's query endpoints or scheduling policy. `js_compat::trim` supplies JavaScript whitespace trimming and is shared with other opt-in helpers.

For example, normalize a document only at the same write boundary used by the source worker, or derive an inclusive 30-day calendar start:

```rust,no_run
use dima_rust::utils::{bson_compat, utc_time};
use mongodb::bson::{DateTime, doc};

let mut payload = doc! { "count": 4.0 };
bson_compat::normalize_document(&mut payload);
let start = utc_time::inclusive_day_start(30, DateTime::now());
```

`worker_process` provides `load_env_files(&[PathBuf])`, `spawn_shutdown_signal(watch::Sender<bool>)`, and `IdleBackoff`. Explicit environment files load synchronously before runtime threads; inherited variables win, then earlier files win over later files. The signal task only notifies a cooperative stop receiver, while the worker owns its current-unit drain and signal-task cleanup. `IdleBackoff` waits 1, 2, 4, then 5 seconds across empty batches and resets to no wait when a batch does work. These helpers are intended to preserve existing callers' behavior; they do not define a shared worker runtime or scheduling policy. The deployed candidate `cron-2056ce9d790c` includes them across all seven native workers; its exact-image suites passed, and production acceptance passed. See [worker-shared-utils.md](../migration-notes/worker-shared-utils.md).

In production the Node cron supervisor still loads and allowlists the child environment, spawns workers, records metrics, restarts failed children, and sends SIGTERM followed by SIGKILL after its 25-second grace period. Rust's explicit `--env-file PATH` support serves manual executable invocations before runtime threads start; it does not load `.env` automatically and is not a second production bootstrap. See [worker-shared-utils.md](../migration-notes/worker-shared-utils.md) for source mappings and the pending verification scope.

`dima_rust::utils::mongo::get_mongo_client().await` returns `mongodb::error::Result<&'static Client>`. On first call it reads `MONGO_URI` directly from the process environment (it does not load dotenv files), creates a native MongoDB client, and pings `admin` before caching it in a Tokio `OnceCell`. Failed initialization can be retried. Use the cached client within the application's long-lived Tokio runtime and share it across tasks and threads. Static storage does not keep the driver's originating runtime alive, so do not reuse the client after that runtime or the client has been shut down. Clone the native handle when an owned handle is needed; clones share the same pool. Callers select their database explicitly. A URI database name is available through the driver's default-database behavior, but the utility adds no implicit fallback.

`dima_rust::utils::redis::get_redis_client().await` returns `redis::RedisResult<redis::aio::ConnectionManager>`. It reads `DRAGONFLY_HOST` and `DRAGONFLY_PORT` directly from the process environment, matching [`dimabot/src/utils/databases/dragonfly.database.ts`](../dimabot/src/utils/databases/dragonfly.database.ts). It connects over plain TCP to database 0; it does not add a URI, password, TLS, or database-selection option. It does not load dotenv files. The manager is cached in a Tokio `OnceCell` only after connection and `PING` succeed, so failed or cancelled initialization can be retried. The initial connection and ping have a five-second timeout. Returned managers are owned, cheap clones that share one multiplexed TCP socket. The response timeout is unset to preserve blocking command semantics; blocking commands and Pub/Sub should use separate dedicated connections when implemented. Keep using the cached manager within the application's long-lived Tokio runtime; static storage does not keep that runtime alive, and the manager must not be reused after runtime shutdown. The driver reconnects after an I/O disconnect, but a command that encounters the disconnect is returned as an error and is not replayed. Configuration errors do not include raw environment values.

Opt-in service foundations mirror `dimabot/src/utils` helpers for future ports: `email` (Resend), `posthog`, `qdrant` (gRPC on `QDRANT_GRPC_PORT`, default 6334), `s3`, `otel` (OTLP logs to PostHog), `jwt` (Node-identical activation tokens), `re2-compat` (RE2 semantics on `regex`), `socketio` (socketioxide with socket.io defaults), and `audio` (MP3/WAV durations). `http` also provides the legacy permissive CORS layer. None is in `default` or a worker profile, and nothing in production uses them yet. Crate choices, parity evidence, and known differences are in [migration-notes/ts-util-foundations.md](../migration-notes/ts-util-foundations.md).

For example, Redis commands use the driver's `AsyncCommands` API:

```rust,no_run
async fn read_cache_value() -> Result<Option<String>, Box<dyn std::error::Error>> {
    use redis::AsyncCommands;

    let mut cache = dima_rust::utils::redis::get_redis_client().await?;
    let value: Option<String> = cache.get("example:key").await?;
    Ok(value)
}
```

Adding `dotenvy` does not load files automatically. The manual `stream_activity` executable accepts repeatable `--env-file PATH` arguments and loads those files synchronously before building its two-thread Tokio runtime. Existing process variables take precedence, and earlier files take precedence over later files. The MongoDB and Redis library utilities never load dotenv files. For custom executables, load explicitly selected files before creating Tokio and calling either client utility. For example:

```rust,no_run
async fn run_application() -> Result<(), Box<dyn std::error::Error>> {
    // Start the application and use get_mongo_client() here.
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_path("path/to/.env.local")?;
    dotenvy::from_path("path/to/.env")?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_application())?;
    Ok(())
}
```

Replace the example paths with the files the executable is configured to load. The library itself does not load environment files.

Seven scheduled responsibilities had accepted Rust releases before the current shared-utility refactor. The current image retains those responsibilities with shared helpers; its build and nine exact-image suites passed, and the production watch (32 samples, 332.257 seconds), final readbacks, and cleanup passed. The release is accepted. Former TypeScript selectors are retired where they existed and do not select archived source. Dashboard API/request-time behavior, queue producers, and shared TypeScript helpers remain active. Failed native children restart without runtime fallback. See [worker-shared-utils.md](../migration-notes/worker-shared-utils.md), [dashboard-activity.md](../migration-notes/dashboard-activity.md), and [migration-notes/README.md](../migration-notes/README.md).

Check the library from this directory using the commands below. On the production VPS, every Cargo command listed is subject to the [production-host Rust build and test policy](AGENTS.md#production-host-rust-build-and-test-policy); do not run these commands directly on the host:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Build checks and default Rust tests do not require database or cache services; MongoDB and Redis integration tests use external fixtures and are ignored by default. The stream, raid, baseline, roulette, AI receipts, raid-sessions, and dashboard checks are documented in the migration notes and [`ops/README.md`](../ops/README.md). Run service-backed checks only against isolated disposable data. Production artifacts are built and staged through `scripts/saas-ops`; `Cargo.lock` is tracked and `--locked` ensures the checked graph matches it. The dashboard binary declares `--help`, `--dry-run`, `--once`, `--telemetry-json`, `--database NAME`, and repeatable `--env-file PATH`; it was accepted in release `cron-bf400acbc441`. The current shared-utility release also passed the dashboard suite, production watch, and cleanup.

The helper keeps Cargo registry and dependency artifacts in a private persistent cache outside the checkout. The latest run `cron-2056ce9d790c` rebuilt all seven worker binaries from its frozen source snapshot under the existing capped build policy. Formatting, check, Clippy, tests, release builds, binary dry runs, and nine same-image suites passed; the production watch, final readbacks, cleanup, and lead acceptance passed. The stream fixture remains a manual parity/benchmark tool and is not staged in routine cron candidates. Cache reuse reduces compile work only and does not establish Rust worker RAM or CPU savings.


## Raid change-driven release notice

Raid change-driven release `cron-2ddd455fdd1f` remains accepted historical evidence: its then-current four worker suites and 124.802-second production watch passed. The historical five-worker image was `cron-7b8a6c88303d`; see [migration-notes/raid-change-driven.md](../migration-notes/raid-change-driven.md) and [migration-notes/ai-usage-receipts.md](../migration-notes/ai-usage-receipts.md) for those releases. The [scheduling release record](../migration-notes/worker-backlog-scheduling.md) documents its historical image and rollback pointer; see [worker-shared-utils.md](../migration-notes/worker-shared-utils.md) for the current accepted run and acceptance checks.
