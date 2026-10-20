# dima-rust Agent Guide

`dima-rust/` is a basic Rust library scaffold for incremental future worker/server migrations. Read the root [`AGENTS.md`](../AGENTS.md) first; its production-host and scope rules take precedence.

The scaffold has no implemented workers, servers, or service connections, and no supported deployment target. Keep additions within an explicitly requested scope. Do not treat adding a crate as authorization to connect to production services or migrate existing application behavior. Future deployments require a reviewed supported workflow; do not start services or consume production data just to verify this library.

Dependencies include MongoDB and its `mongodb::bson` module, Serde, Garde, Tokio, SQLx with PostgreSQL support, `redis-rs` for Dragonfly-compatible Redis operations, and Axum. Map BSON documents into explicit structs with Serde, and call Garde `validate()` for additional field or business constraints. Future ports must preserve existing collection names, field types, defaults, and indexes.

Run local library checks from this directory:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
```

There is no binary entry point, so `cargo run` does not apply. These commands build/check code without requiring database or cache services. Keep `Cargo.lock` tracked and use `--locked` for the documented checks.
