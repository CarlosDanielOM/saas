# dima-rust Agent Guide

`dima-rust/` is a Rust library for incremental future worker/server migrations. Read the root [`AGENTS.md`](../AGENTS.md) first; its production-host and scope rules take precedence.

The library includes a lazy native MongoDB client utility, but has no implemented workers, servers, or deployed integration and no supported deployment target. Keep additions within an explicitly requested scope. Do not treat the utility as authorization to connect to production services or migrate existing application behavior. Future deployments require a reviewed supported workflow; do not start services or consume production data just to verify this library.

Dependencies include MongoDB and its `mongodb::bson` module, Serde, Garde, Tokio, SQLx with PostgreSQL support, `redis-rs` for Dragonfly-compatible Redis operations, and Axum. Map BSON documents into explicit structs with Serde, and call Garde `validate()` for additional field or business constraints. Future ports must preserve existing collection names, field types, defaults, and indexes.

`dima_rust::utils::mongo::get_mongo_client().await` returns `mongodb::error::Result<&'static Client>`. It reads `MONGO_URI` from the process environment on first use without loading dotenv files, pings `admin` before caching the client in a Tokio `OnceCell`, and leaves failed initialization retryable. Use it within the application's long-lived Tokio runtime and share it across tasks and threads. Static storage does not keep the originating runtime alive; do not reuse the cached client after that runtime or the client has been shut down. Clone the native handle when needed; clones share the same pool. Callers select the database explicitly. The URI's default database may be used through driver behavior, but the utility adds no implicit fallback.

Run local library checks from this directory:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

There is no binary entry point, so `cargo run` does not apply. Build checks and default tests need no database or cache services; the live-database integration test is ignored by default. Keep `Cargo.lock` tracked and use `--locked` for the documented checks.
