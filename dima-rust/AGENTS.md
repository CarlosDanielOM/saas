# dima-rust Agent Guide

Read the repository-root [`AGENTS.md`](../AGENTS.md) first; its production workflow, scope limits, and other root rules take precedence over this project guide. For cron migrations, follow the root [cron worker verification scope](../AGENTS.md#cron-worker-verification-scope).

**Status:** Since 2026-11-13 these sources are not built, tested, or deployed by the cron workflow. Production workers are TypeScript. This directory remains reference pending the owner's decision; its library utilities were never used in production. See the [return record](../migration-notes/typescript-workers-return.md).

The worker and supervisor sources describe the historical Rust implementation. Do not connect experiments to production data.

## Production-host Rust build and test policy

Rust builds are not part of `saas-ops build cron`. Any separately authorized Rust validation on the production host must use an isolated, resource-capped environment and disposable data; do not run Cargo directly on the host. Preserve the prior ceiling of 6 GiB compiler memory, 6 CPUs and 2 Cargo jobs, and a 4 GiB available-memory reserve. Stop if service pressure rises or the reserve is breached. Historical build evidence is in the migration notes.

## Library conventions

Cargo features keep capabilities independent. The default feature set retains the complete foundation for library/manual consumers: `mongo`, `redis`, `postgres`, and `http`. MongoDB-only workers and their binaries are built with `--no-default-features --features mongo`; SQLx/PostgreSQL, Axum, and Redis are optional and excluded from that worker graph. `dotenvy` is part of the MongoDB feature for explicit environment-file loading. Map BSON documents into explicit structs with Serde, and call Garde `validate()` for additional field or business constraints. Future ports must preserve existing collection names, field types, defaults, and indexes. See [`README.md`](README.md) for the shared MongoDB, Redis, and dotenv foundation.

The opt-in service features (`email`, `posthog`, `qdrant`, `s3`, `otel`, `jwt`, `re2-compat`, `socketio`, `audio`) are library foundations for TypeScript util ports, recorded in [`migration-notes/ts-util-foundations.md`](../migration-notes/ts-util-foundations.md). Keep them out of `default` and out of worker profiles unless a worker needs one, and review its dependencies first. Each disables crate defaults and uses rustls. Network tests use the loopback recorder in `src/utils/test_http.rs` or ignored fixture tests; never point them at production services. Regenerate the RE2 corpus with `node dima-rust/tests/fixtures/re2_parity.mjs` when changing `re2_compat`.

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

The seven worker binaries and the cron index expose `--help` as documented in their source guides. Cargo build checks and default Rust tests need no database or cache services; MongoDB/Redis integration tests use external fixtures and are ignored by default. Run service-backed checks only against isolated disposable data. Keep `Cargo.lock` tracked and use `--locked` for documented checks. See [`migration-notes/telemetry-counter-release.md`](../migration-notes/telemetry-counter-release.md) for the historical run and [`migration-notes/worker-shared-utils.md`](../migration-notes/worker-shared-utils.md) for the historical shared-utility run.


## Raid change-driven release notice

Historical raid analytics release `cron-2ddd455fdd1f` was accepted after all four exact-image worker suites and the 124.802-second production watch passed. Its recorded rollback target was `cron-99f8d5165ff2` (image `sha256:7b4656ed97fa73431d192c754bef504672b167e020909c7bdc6d4e727f54bcc8`). See [`migration-notes/raid-change-driven.md`](../migration-notes/raid-change-driven.md).
