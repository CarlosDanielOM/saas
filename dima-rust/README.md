# dima-rust

`dima-rust` is a small Rust library scaffold for incremental future migrations of selected workers and server components. It currently contains no implemented workers, servers, or database/cache connections. The application projects remain the source of production behavior.

The dependency set provides MongoDB with `mongodb::bson`, Serde, Garde, Tokio, SQLx with PostgreSQL support, the Redis crate (`redis-rs`) for Dragonfly-compatible Redis operations, and Axum. Adding a dependency does not imply that its service is configured or connected.

Use Serde to map BSON documents into explicit structs. Garde checks additional field and business constraints only when `validate()` is called. Future ports must explicitly preserve existing collection names, field types, defaults, and indexes.

From this directory, the library can be checked with:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
```

This is a library, so there is no `cargo run` entry point. These build checks do not require database or cache services. `Cargo.lock` is tracked and `--locked` ensures the checked dependency graph matches it.
