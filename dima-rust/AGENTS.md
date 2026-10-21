# dima-rust Agent Guide

`dima-rust/` contains a Rust library and a manually invoked stream-activity projector binary for incremental future worker/server migrations. Read the root [`AGENTS.md`](../AGENTS.md) first; its production-host and scope rules take precedence.

The library includes lazy native MongoDB and Redis/Dragonfly client utilities and a bounded MongoDB stream-activity projector. Its binary is an explicit manual entry point, not registered with dimabot's supervisor or Compose services; there is no supported deployment target. Keep additions within an explicitly requested scope. Do not treat a utility or the manual binary as authorization to connect to production services or migrate existing application behavior. Use isolated, disposable MongoDB data for runtime checks.

## Production-host Rust build and test policy

This checkout is on the production VPS. Before compiling or running Rust checks/tests here, inspect available CPU, memory, disk, and production load. Serialize work so only one task-owned Docker compiler container is active across the parent and delegates, with enforced cgroup limits `--cpus=1 --memory=2g --memory-swap=2g --pids-limit=256` (`--memory-swap` equals the memory limit, so it allows no swap); set `CARGO_BUILD_JOBS=1`. These limits apply to dependency builds, build scripts, linkers, and generated test or fixture binaries too. A job count or `nice`/`ionice` scheduling is supplemental, not a substitute for hard limits; an otherwise unlimited Docker container is not sufficient. Use a read-only source snapshot or copy and task-owned Cargo target/cache; do not mount `.env` files, production data, the Docker socket, or use host networking. Network access may be needed to fetch dependencies, but tests must use isolated disposable fixtures only. Monitor host load and stop if production load rises; CPU and memory caps do not guarantee zero I/O impact. If capacity is insufficient or a limited container fails, stop or postpone rather than relaxing limits or falling back to host execution. A non-production development machine may run Cargo locally with `CARGO_BUILD_JOBS=1`.

The previous stream-activity validation ran Cargo compilation and Rust test/benchmark binaries directly on the host with `CARGO_BUILD_JOBS=2` and `nice -n 10`; only its MongoDB fixture was in a container limited to 1 CPU and 768 MiB. The Cargo job count and `nice` setting are not hard host limits and do not meet this policy. No capped Rust build/test workflow has been implemented or validated here yet; before the next Rust validation, prepare a task-owned capped toolchain container and verify its applied cgroup limits.

## Library conventions

Dependencies include MongoDB and its `mongodb::bson` module, Serde, Garde, Tokio, SQLx with PostgreSQL support, `redis-rs` for Dragonfly-compatible Redis operations, and Axum. Map BSON documents into explicit structs with Serde, and call Garde `validate()` for additional field or business constraints. Future ports must preserve existing collection names, field types, defaults, and indexes.

`dima_rust::utils::mongo::get_mongo_client().await` returns `mongodb::error::Result<&'static Client>`. It reads `MONGO_URI` from the process environment on first use without loading dotenv files, pings `admin` before caching the client in a Tokio `OnceCell`, and leaves failed initialization retryable. Use it within the application's long-lived Tokio runtime and share it across tasks and threads. Static storage does not keep the originating runtime alive; do not reuse the cached client after that runtime or the client has been shut down. Clone the native handle when needed; clones share the same pool. Callers select the database explicitly. The URI's default database may be used through driver behavior, but the utility adds no implicit fallback.

`dima_rust::utils::redis::get_redis_client().await` returns `redis::RedisResult<redis::aio::ConnectionManager>`. It reads `DRAGONFLY_HOST` and `DRAGONFLY_PORT` from the process environment, matching `dimabot/src/utils/databases/dragonfly.database.ts`, without loading dotenv files. It uses plain TCP with database 0 and adds no URI, password, TLS, or database-selection configuration. A Tokio `OnceCell` caches the manager only after the first connection and `PING` succeed; failed or cancelled initialization can be retried. The five-second bound applies to this initial connection and ping. The cached manager is an owned, cheap clone that shares a multiplexed TCP socket. Its response timeout is unset to preserve blocking command semantics; blocking commands and Pub/Sub should use separate dedicated connections when implemented. Use it within the application's long-lived Tokio runtime; static storage does not keep that runtime alive, and the cached manager must not be reused after runtime shutdown. The driver reconnects after an I/O disconnect, while a command that encounters the disconnect is returned to its caller and is not replayed. Configuration errors omit raw environment values. This utility does not load dotenv files; an executable must load explicitly selected files before creating the Tokio runtime.

Run library checks from this directory. On the production VPS, every Cargo command below is subject to the [production-host Rust build and test policy](#production-host-rust-build-and-test-policy); do not run these commands directly on the host:

```sh
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Use `cargo run --bin stream_activity -- --help` for the manual binary. Cargo build checks and default Rust tests need no database or cache services; the MongoDB and Redis integration tests use external fixtures and are ignored by default. The stream-activity parity harness is a separate manual Node command documented in [`STREAM_ACTIVITY.md`](STREAM_ACTIVITY.md). Run service-backed checks only against isolated, disposable data. Keep `Cargo.lock` tracked and use `--locked` for the documented checks.
