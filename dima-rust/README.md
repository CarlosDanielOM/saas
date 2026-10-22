# dima-rust

`dima-rust` is a Rust library for incremental migrations of selected worker and server components. Candidate `cron-bf400acbc441` (image `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30`) deployed to the existing cron service at `2026-10-21T22:53:29.834585977Z`, running seven native children. All twelve same-image suites passed: nine standard suites (150 groups) and three supplemental legacy checks (four reported groups). The 32-sample, 332.216-second production watch, final readbacks, container comparison, and cleanup passed; all seven workers are release-accepted. Rollback with `scripts/saas-ops rollback cron-bf400acbc441` restores accepted run `cron-9ff771d91cda`, image `sha256:2a009af0d0fabef6bd2103ef04596ed6451a1ce360c73b32c9146f8ce3878102`, with six Rust workers and the previous TypeScript dashboard worker. The new image has no TypeScript fallback. The prior image's nine exact-image suites passed 120 groups, as did its 190.802-second production watch, readbacks, container comparison, and cleanup before deployment at `2026-10-21T20:58:08.390836997Z`. That release included AI-receipts and roulette backlog scheduling plus coordinated email-template commit `c5288218`; its email check was scoped to that release. See [worker-backlog-scheduling.md](../migration-notes/worker-backlog-scheduling.md) for prior accepted evidence and [dashboard-activity.md](../migration-notes/dashboard-activity.md) for the accepted current deployment. Future cron verification scope follows root [`AGENTS.md`](../AGENTS.md#cron-worker-verification-scope). Historical TypeScript retirement, raid-sessions, and older rollback receipts retain their original evidence in the migration notes. `scripts/saas-ops build cron` stages source-defined binaries in the existing cron image; it adds no service/container. See [migration-notes/README.md](../migration-notes/README.md) and [STREAM_ACTIVITY.md](STREAM_ACTIVITY.md).

Cargo defaults preserve `mongo`, `redis`, `postgres`, and `http` for library/manual consumers. The six prior cron binaries use existing Mongo-only or Mongo/Redis profiles. Dashboard uses `--no-default-features --features mongo,redis,http-client,unicode-collation`; reqwest 0.12.28 and ICU collation are isolated to it. Cargo declares `icu_collator` 2.3.0, and the lockfile resolves 2.3.1. SQLx/PostgreSQL and Axum remain excluded from worker profiles. The seventh binary built and its exact-image suite passed; it is deployed and accepted after the production watch, final readbacks, container comparison, and cleanup passed. See [dashboard-activity.md](../migration-notes/dashboard-activity.md).

Use Serde to map BSON documents into explicit structs. Garde checks additional field and business constraints only when `validate()` is called. Future ports must explicitly preserve existing collection names, field types, defaults, and indexes.

`dima_rust::utils::mongo::get_mongo_client().await` returns `mongodb::error::Result<&'static Client>`. On first call it reads `MONGO_URI` directly from the process environment (it does not load dotenv files), creates a native MongoDB client, and pings `admin` before caching it in a Tokio `OnceCell`. Failed initialization can be retried. Use the cached client within the application's long-lived Tokio runtime and share it across tasks and threads. Static storage does not keep the driver's originating runtime alive, so do not reuse the client after that runtime or the client has been shut down. Clone the native handle when an owned handle is needed; clones share the same pool. Callers select their database explicitly. A URI database name is available through the driver's default-database behavior, but the utility adds no implicit fallback.

`dima_rust::utils::redis::get_redis_client().await` returns `redis::RedisResult<redis::aio::ConnectionManager>`. It reads `DRAGONFLY_HOST` and `DRAGONFLY_PORT` directly from the process environment, matching [`dimabot/src/utils/databases/dragonfly.database.ts`](../dimabot/src/utils/databases/dragonfly.database.ts). It connects over plain TCP to database 0; it does not add a URI, password, TLS, or database-selection option. It does not load dotenv files. The manager is cached in a Tokio `OnceCell` only after connection and `PING` succeed, so failed or cancelled initialization can be retried. The initial connection and ping have a five-second timeout. Returned managers are owned, cheap clones that share one multiplexed TCP socket. The response timeout is unset to preserve blocking command semantics; blocking commands and Pub/Sub should use separate dedicated connections when implemented. Keep using the cached manager within the application's long-lived Tokio runtime; static storage does not keep that runtime alive, and the manager must not be reused after runtime shutdown. The driver reconnects after an I/O disconnect, but a command that encounters the disconnect is returned as an error and is not replayed. Configuration errors do not include raw environment values.

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

Six scheduled responsibilities had accepted Rust releases before dashboard. Dashboard is accepted as the seventh native child after its build, all twelve same-image suites, the full production watch, final readbacks, container comparison, and cleanup passed. Former TypeScript selectors are retired where they existed and do not select archived source. Dashboard API/request-time behavior, queue producers, and shared TypeScript helpers remain active. Failed native children restart without runtime fallback. See [dashboard-activity.md](../migration-notes/dashboard-activity.md) and [migration-notes/README.md](../migration-notes/README.md).

Check the library from this directory using the commands below. On the production VPS, every Cargo command listed is subject to the [production-host Rust build and test policy](AGENTS.md#production-host-rust-build-and-test-policy); do not run these commands directly on the host:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Build checks and default Rust tests do not require database or cache services; MongoDB and Redis integration tests use external fixtures and are ignored by default. The stream, raid, baseline, roulette, AI receipts, raid-sessions, and dashboard checks are documented in the migration notes and [`ops/README.md`](../ops/README.md). Run service-backed checks only against isolated disposable data. Production artifacts are built and staged through `scripts/saas-ops`; `Cargo.lock` is tracked and `--locked` ensures the checked graph matches it. The dashboard binary declares `--help`, `--dry-run`, `--once`, `--telemetry-json`, `--database NAME`, and repeatable `--env-file PATH`; its exact-image suite passed and it is deployed and accepted after the production watch and cleanup passed.

The helper keeps Cargo registry and dependency artifacts in a private persistent cache outside the checkout. Accepted receipts rebuild the six prior accepted worker binaries from each frozen source snapshot. Dashboard candidate `cron-bf400acbc441` completed its capped build and passed twelve same-image suites, the production watch, final readbacks, container comparison, and cleanup before acceptance. The stream fixture remains a manual parity/benchmark tool and is not staged in routine cron candidates. Cache reuse reduces compile work only and does not establish Rust worker RAM or CPU savings.


## Raid change-driven release notice

Raid change-driven release `cron-2ddd455fdd1f` remains accepted historical evidence: its then-current four worker suites and 124.802-second production watch passed. The historical five-worker image was `cron-7b8a6c88303d`; see [migration-notes/raid-change-driven.md](../migration-notes/raid-change-driven.md) and [migration-notes/ai-usage-receipts.md](../migration-notes/ai-usage-receipts.md) for those releases. The [scheduling release record](../migration-notes/worker-backlog-scheduling.md) contains the current image and rollback pointer.
