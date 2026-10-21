# dima-rust

`dima-rust` is a Rust library for incremental migrations of selected worker and server components. Current accepted production run `cron-7a8ca7924412` uses image `sha256:c7c8203e245b263f462ee1c6ca4c1007418408ac190d9ad9b9013ec2e4801fa8`; `scripts/saas-ops rollback cron-7a8ca7924412` restores prior accepted run `cron-d02bf5a387d5`, image `sha256:b1e5f225d2488e76b455837bbc562ba646b2a69d3ac9d7f6a9316cf02798239b`. It includes lazy native MongoDB and Redis/Dragonfly client utilities and workers supervised as children by dimabot's existing cron host. Six native worker entrypoints are integrated in source; candidate `cron-7a8ca7924412` includes raid sessions; all eight exact-image suites passed 102 groups and production acceptance passed. TypeScript retirement run `cron-d02bf5a387d5`, digest `sha256:b1e5f225d2488e76b455837bbc562ba646b2a69d3ac9d7f6a9316cf02798239b`, was accepted after all six exact-image checks, the 190.459-second production watch, analytics readback, container comparison, and cleanup passed. The TypeScript retirement run’s rollback target was `cron-7b8a6c88303d`, digest `sha256:458d9186c5e48e684962bea9f85092d89b1e765cca3d283ebf819696ff50269c`; the previous rollback baseline is `cron-2ddd455fdd1f`, digest `sha256:050be8612ffa176e791c0ec16adeb0fde50b0e287d31ad02364c805fa9bdd783`. See [migration-notes/typescript-worker-retirement.md](../migration-notes/typescript-worker-retirement.md) for acceptance evidence. The five previously accepted responsibilities always use Rust under Node and `tsx`; raid sessions is integrated in source and candidate `cron-7a8ca7924412` passed all eight exact-image suites (102 groups) and production acceptance. Former TypeScript runtime selectors are retired where they existed; no raid-sessions selector existed. `scripts/saas-ops build cron` compiles and stages the source-defined binaries in the existing cron image without adding a service or container. See [migration-notes/README.md](../migration-notes/README.md) for migration records and [STREAM_ACTIVITY.md](STREAM_ACTIVITY.md) for stream-projector behavior and benchmarks.

Cargo features keep the shared foundation available without compiling every capability into each binary. Defaults preserve `mongo`, `redis`, `postgres`, and `http` for library/manual consumers. The stream-activity, raid-analytics, and roulette-completion cron binaries use `--no-default-features --features mongo`; the follow-defense baseline, AI usage receipts, and raid-sessions binaries use `--no-default-features --features mongo,redis`. SQLx/PostgreSQL and Axum remain optional and are excluded from all six cron worker graphs. AI usage receipts is deployed in run `cron-7b8a6c88303d`; its production acceptance watch and cleanup passed. A dependency alone does not configure or connect its backing service. The normal cron build validates these profiles sequentially in one capped compiler and records separate dependency graphs; `scripts/saas-ops build cron --rust-feature-matrix` performs an explicit transition audit of the optional graphs.

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

The `stream_activity`, `raid_analytics`, `follow_defense_baseline`, `roulette_completion`, and `ai_usage_receipts` binaries were deployed in accepted run `cron-d02bf5a387d5`; all five worker suites and the sixth Rust-only retirement check passed against the exact image. `raid_sessions` is the sixth native worker in the current source and passed its exact-image suites and production acceptance; see [migration-notes/raid-sessions.md](../migration-notes/raid-sessions.md). The retirement run's production watch, analytics readback, container comparison, and cleanup passed; see [migration-notes/typescript-worker-retirement.md](../migration-notes/typescript-worker-retirement.md). All six scheduled responsibilities always use Rust under Node and `tsx`; their former `*_RUNTIME=typescript` selectors are retired and do not select archived source. Raid analytics' change-driven refresh was accepted in run `cron-2ddd455fdd1f`; its 20-group exact-image check and production watch are recorded in [migration-notes/raid-change-driven.md](../migration-notes/raid-change-driven.md). Use `ops/checks/raid-analytics-change-driven.mjs` for future candidate checks; the earlier raid check is historical. Roulette completion uses the existing `roulette_channels` MongoDB collection and remains separate from the `roulette-actions` TypeScript child, which executes winner-action ASTs. API and request-time behavior and shared TypeScript helpers remain active. Failed native children restart without runtime fallback. See [migration-notes/README.md](../migration-notes/README.md) for worker contracts, evidence, and rollout status.

Check the library from this directory using the commands below. On the production VPS, every Cargo command listed is subject to the [production-host Rust build and test policy](AGENTS.md#production-host-rust-build-and-test-policy); do not run these commands directly on the host:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Build checks and default Rust tests do not require database or cache services; the MongoDB and Redis integration tests use external fixtures and are ignored by default. The stream-activity, raid, baseline, roulette-completion, AI usage receipts, and raid-sessions candidate checks are documented in [STREAM_ACTIVITY.md](STREAM_ACTIVITY.md), [migration-notes/README.md](../migration-notes/README.md), and [ops/README.md](../ops/README.md). Run service-backed checks only against isolated, disposable data. `cargo run --bin stream_activity -- --help`, `cargo run --bin raid_analytics -- --help`, `cargo run --bin follow_defense_baseline -- --help`, `cargo run --bin roulette_completion -- --help`, and `cargo run --bin raid_sessions -- --help` show the binary options. The `ai_usage_receipts` executable supports `--help`; production artifacts are built and staged through `scripts/saas-ops`. `Cargo.lock` is tracked and `--locked` ensures the checked dependency graph matches it.

The helper keeps Cargo registry and dependency artifacts in a private persistent cache outside the checkout. It explicitly rebuilds all six worker release binaries for each run so executables come from the current frozen source snapshot; the stream fixture example is a manual parity/benchmark tool and is not part of routine cron candidates. This cache reduces repeated compile work; it does not establish Rust worker RAM or CPU savings, since the linker may already remove unused code.


## Raid change-driven release notice

Raid change-driven release `cron-2ddd455fdd1f` remains accepted historical evidence: its then-current four worker suites and 124.802-second production watch passed. The latest five-worker image is `cron-7b8a6c88303d`; see [migration-notes/raid-change-driven.md](../migration-notes/raid-change-driven.md) for the raid change and [migration-notes/ai-usage-receipts.md](../migration-notes/ai-usage-receipts.md) for the current release and rollback pointer.
