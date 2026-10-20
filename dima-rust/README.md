# dima-rust

`dima-rust` is a small Rust library for incremental future migrations of selected workers and server components. It now includes a lazy native MongoDB client utility, but has no implemented workers, servers, or deployed integration. The application projects remain the source of production behavior.

The dependency set provides MongoDB with `mongodb::bson`, Serde, Garde, Tokio, SQLx with PostgreSQL support, the Redis crate (`redis-rs`) for Dragonfly-compatible Redis operations, and Axum. Adding a dependency does not imply that its service is configured or connected.

Use Serde to map BSON documents into explicit structs. Garde checks additional field and business constraints only when `validate()` is called. Future ports must explicitly preserve existing collection names, field types, defaults, and indexes.

`dima_rust::utils::mongo::get_mongo_client().await` returns `mongodb::error::Result<&'static Client>`. On first call it reads `MONGO_URI` directly from the process environment (it does not load dotenv files), creates a native MongoDB client, and pings `admin` before caching it in a Tokio `OnceCell`. Failed initialization can be retried. Use the cached client within the application's long-lived Tokio runtime and share it across tasks and threads. Static storage does not keep the driver's originating runtime alive, so do not reuse the client after that runtime or the client has been shut down. Clone the native handle when an owned handle is needed; clones share the same pool. Callers select their database explicitly. A URI database name is available through the driver's default-database behavior, but the utility adds no implicit fallback.

From this directory, the library can be checked with:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

This is a library, so there is no `cargo run` entry point. Build checks and default tests do not require database or cache services; the live-database integration test is ignored by default. `Cargo.lock` is tracked and `--locked` ensures the checked dependency graph matches it.
