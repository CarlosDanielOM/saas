# dima-rust

`dima-rust` is a Rust library for incremental migrations of selected worker and server components. It includes lazy native MongoDB and Redis/Dragonfly client utilities, a stream-activity projector, and its executable. The dimabot cron supervisor runs that executable as its native stream-activity child for the Node runtime; `scripts/saas-ops build cron` compiles and stages it in the existing cron image. The native projector is active in production, reusing the existing cron container and Compose service without adding a new service.

The dependency set provides MongoDB with `mongodb::bson`, Serde, Garde, Tokio, SQLx with PostgreSQL support, the Redis crate (`redis-rs`) for Dragonfly-compatible Redis operations, Axum, and `dotenvy` for explicit environment-file loading. A dependency alone does not configure or connect its backing service.

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

The `stream_activity` binary remains manually runnable for isolated checks and is also the executable supervised by the existing cron host. In the updated supervisor source, native Rust is the default for the Node runtime; `STREAM_ACTIVITY_RUNTIME=typescript` explicitly selects the TypeScript fallback. `tsx` development continues to default to TypeScript unless Rust is selected explicitly. A missing or failed Rust binary does not silently switch runtimes. The process receives only MongoDB and basic locale/certificate environment values, runs as UID/GID 65534 when launched by the root cron process, and does not use the Rust Redis utility. See [STREAM_ACTIVITY.md](STREAM_ACTIVITY.md) for runtime selection, telemetry, fixtures, build, and rollout details.

Check the library from this directory using the commands below. On the production VPS, every Cargo command listed is subject to the [production-host Rust build and test policy](AGENTS.md#production-host-rust-build-and-test-policy); do not run these commands directly on the host:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Build checks and default Rust tests do not require database or cache services; the MongoDB and Redis integration tests use external fixtures and are ignored by default. The stream-activity parity harness is a separate manual Node command documented in [STREAM_ACTIVITY.md](STREAM_ACTIVITY.md). Run service-backed checks only against isolated, disposable data. `cargo run --bin stream_activity -- --help` shows the manual binary options. `Cargo.lock` is tracked and `--locked` ensures the checked dependency graph matches it.
