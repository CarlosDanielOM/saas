# Shared Rust logger utility

Reviewed 2026-10-27. The opt-in Rust library scope passed capped quality, source-parity, adapter, and disposable-cache verification. This is library acceptance only: TypeScript callers and deployed worker profiles are unchanged, and no production deployment or caller adoption occurred.

## Scope and API

The opt-in library module is `dima_rust::utils::logger` (`logger` Cargo feature). `logger-redis` adds the Redis adapter; `logger-otel` adds the OpenTelemetry adapter. These features are outside Cargo defaults and deployed worker profiles. The utility is explicitly constructed with `LoggerConfig`, `SinkHandles`, `Clock`, and `IdSource`. It reads no environment, opens no connections, installs no global logger/provider, and creates no background tasks. TypeScript logger callers, workers, and worker profiles remain unchanged.

Core APIs include `Logger::new`, async `log`/`log_lazy`, `flush`, `shutdown`, per-sink `LogReport`, and `LoggerStats`. The `MetadataCollector` is a bounded in-memory sink for an embedding telemetry consumer; context fields are allowlisted. `RedisCacheSink` takes a caller-owned `ConnectionManager`; `OtelLoggerSink` takes an existing SDK logger/provider. Adapters do not configure clients, providers, exporters, or global lifecycle.

## Compatibility and intentional differences

The parity target preserves UTC timestamp formatting, the `logger:<platform>:<channelId>:<level>:<id>` key family, JSON payload shape, default platform/channel key behavior, and a seven-day cache TTL. Deliberate differences from TypeScript are:

- One atomic Redis `SET ... EX` replaces separate `SET` and `EXPIRE`; UUID-based IDs replace timestamp/random IDs.
- Selected sinks run concurrently and each call reports individual sink status. There is no queue or batching. Missing required console/cache sinks and their failures appear in the report; optional metadata and OTEL sinks can be skipped.
- Default sampling keeps all calls. Minimum-level admission and `log_lazy` can avoid payload construction for filtered calls. Deterministic low-priority sampling is configurable.
- Whole-call admission and cache item/byte budgets are bounded, with capacity reserved for warning and higher levels. Payload byte and nesting-depth bounds reject out-of-policy values instead of silently rewriting them.
- The input domain is JSON. JavaScript cycles, `BigInt`, functions, `undefined`, and other non-JSON values are not represented. Metadata export uses an explicit context-field allowlist. Extremely deep owned JSON values are rejected and disposed iteratively, avoiding recursive drop overflow.
- A successful OpenTelemetry SDK `emit` means local SDK acceptance only; it does not confirm export or collector delivery. The embedding caller owns provider `force_flush` and shutdown outside logger lifecycle.
- Core JSON retains null, but the OTEL adapter maps JSON null to the string `"null"` because `AnyValue` has no null representation. Adapter option attributes use normalized OTEL-supported values.
- Cancellation drops owned sink futures. A Redis timeout cannot retract a command already sent, so server outcome may be unknown. OS stdout/stderr writes through `StdConsole` cannot be interrupted by an async deadline.

The disposable adapter fixture confirms 32 Redis `SET` calls and zero `EXPIRE` calls, reducing the source path's cache write from two commands to one in that fixture. No broader latency, throughput, or performance claim is made.

## Reuse and ownership boundaries

The adapter reuses the existing Redis client and OTEL foundations, UUID generation, and the established timestamp format. The core does not depend on worker modules or the private AI-usage cache logger. The existing TypeScript [`logger.ts`](../dimabot/src/utils/logger.ts), telemetry recording path, OAuth diagnostics, and every worker remain authoritative until a later explicit caller migration. The dedicated logger sink preserves per-call bounds without changing timeout settings on the shared Redis connection.

The plan-cache fence is now accepted as a separate opt-in library utility; see [plan-cache-fence.md](plan-cache-fence.md). The `TwitchStreamers` Rust class port remains a separate task pending its consumer inventory and mixed credential-writer review. No logger caller adoption or deployed worker-profile change is included.

## Verification evidence

The final frozen candidate matched 170 Rust build/source/test files byte-for-byte to the checkout. Under the pinned Rust image and unchanged resource policy (6 CPUs, 4 GiB memory and equal memory-swap cap, no swap, 256 PIDs, two Cargo jobs), the warm-cache quality run passed formatting; no-feature, core, logger-redis-only, logger-otel-only, and combined checks; and core plus combined Clippy. It completed in 76.422 seconds. This is build-time evidence, not a speed benchmark. Startup available memory was 12,876,988,416 bytes; minimum available memory during the run was 11,634,827,264 bytes (above the 4 GiB floor); private Cargo cache peak was 1,099,669,504 bytes (below its 8 GiB limit).

Core tests passed 17/17. Combined tests passed 31/31, including the repeated 17 core tests, Redis-feature coverage, safe iterative disposal of extreme JSON depth, and an actual logger-to-OTEL-adapter export through an explicit loopback provider. The same generated source oracle passed all 56 cases in both core and combined profiles. Two doctests passed in each profile and in an explicit doc-test repeat; these are repeated executions, not distinct doctests. Four deployed worker dependency graphs were byte-identical to baseline.

The isolated disposable Dragonfly adapter check persisted 32 records with unique keys and seven-day TTLs; command stats showed 32 `SET` and zero `EXPIRE` calls. This confirms the intended cache write reduction from two Redis commands to one in this fixture. It does not establish broader latency, throughput, or production performance. One initial disposable Dragonfly fixture did not start because its 128 MiB `--maxmemory` was below Dragonfly's 256 MiB minimum. The fixture was corrected to 256 MiB within the unchanged 512 MiB container cap; the final adapter check passed. This was a fixture configuration error, not a product failure.

The final acceptance summary records 19 production containers unchanged by identity/image/start/restart/status, zero task-owned containers or networks remaining, and no cleanup errors. Task-owned source snapshots, baseline copies, compiler targets, and Cargo caches were removed. Quality and acceptance receipts are retained under `/root/.local/state/rust-logger-20261027-732f5sks/artifacts/` (`quality-receipt.json`, `acceptance-summary.json`, `quality-tests.log`, and `quality-adapters.log`). The logger core and adapters are accepted as opt-in library code only. There is no TypeScript caller adoption, worker-profile change, or deployment.

## References

- Rust core: [`logger.rs`](../dima-rust/src/utils/logger.rs)
- Redis adapter: [`redis.rs`](../dima-rust/src/utils/logger/redis.rs)
- OTEL adapter: [`otel.rs`](../dima-rust/src/utils/logger/otel.rs)
- Local tests: [`tests.rs`](../dima-rust/src/utils/logger/tests.rs)
- Adapter checks: [`logger_adapters.rs`](../dima-rust/tests/logger_adapters.rs)
- Parity oracle: [`logger_parity.rs`](../dima-rust/tests/logger_parity.rs) and [`logger_parity.json`](../dima-rust/tests/fixtures/logger_parity.json)
- Reproducible source harness: [`logger_reference.mjs`](../dima-rust/tests/fixtures/logger_reference.mjs)
- TypeScript source: [`logger.ts`](../dimabot/src/utils/logger.ts)
- Cache/logger review: [`cache-logger-pre-port-review.md`](cache-logger-pre-port-review.md)
- Deferred TwitchStreamers port: [`twitch-streamers-pre-port-review.md`](twitch-streamers-pre-port-review.md)
