# Stream activity projector

The Rust stream-activity projector is a manual port of the batch projection in `dimabot/src/utils/stream_activity.ts`. It does not replace activity capture from `dimabot/src/handlers/message.handler.ts`, the existing TypeScript worker in `dimabot/src/workers/stream_activity.worker.ts`, or the activity read APIs. It adds no Twitch, bot-runtime, or Redis dependency, and it is not registered with the dimabot cron supervisor or Compose services.

## Reused data and schema

The projector reads the existing `stream_activities` outbox collection and writes the existing `stream_activity_aggregates` and `stream_activity_states` collections in the selected MongoDB database. It mirrors the TypeScript schema's field names, BSON types, event kinds, aggregate identities, counter names, and defaults; the TypeScript capture sets the existing 90-day expiration used by projection. It does not capture events, read projected activity for the dashboard, or migrate data.

The TypeScript schemas in `dimabot/src/schemas/stream_activity.schema.ts` remain the schema and index source. They declare six activity indexes, including the two dashboard-query indexes, and four aggregate indexes. The Rust projector does not create, alter, or repair indexes; the required existing indexes must already be present in any database where it is run. The parity harness creates the schema-declared indexes in its own fixture databases and removes only databases it created with its `stream_activity_fixture_` prefix.

Projection record IDs use SHA-256 over the same JSON-array identity tuples as the TypeScript projector. The existing `projector-v1` state document stores a monotonically increasing sequence and a fixed active batch of activity IDs before aggregate writes start. A 60-second owner lease is renewed every 10 seconds. Aggregate writes use sequence fences so retrying the persisted batch does not apply its increments twice. Activities are acknowledged as processed only after the aggregate writes and ownership checks succeed. Non-duplicate write failures are returned while the active checkpoint remains available for retry.

The port targets the stored projection contract. It preserves the owner-fenced lease release and adds fresh owner/lease queries before aggregate writes and before acknowledging a batch. It treats only duplicate-key conflicts from aggregate sequence fences as already-applied writes; other write failures remain errors. Neither change alters the capture or dashboard-read path.

## API and manual executable

`dima_rust::workers::stream_activity::StreamActivityProjector::new(database)` selects the existing collection names without performing I/O. `project_batch(limit: usize)` returns `mongodb::error::Result<usize>`: the number of activity rows projected, or zero when no eligible batch is available or another owner holds the lease. The query clamps `limit` to 1–1000; the executable defaults to 500.

The standalone `stream_activity` binary does not load conventional `.env` files automatically. `--help` and `--dry-run` exit before loading environment files or connecting to MongoDB. For an actual run, pass each selected file with `--env-file PATH`; the executable loads them synchronously before constructing its two-thread Tokio runtime. Existing process environment values take precedence, and earlier files take precedence over later files. Select the database with `--database NAME` or use a database name in `MONGO_URI`.

Build and inspect the manual command:

```sh
cargo build --locked --release --bin stream_activity
cargo run --locked --release --bin stream_activity -- --help
cargo run --locked --release --bin stream_activity -- --dry-run --batch-size 500
```

For one batch against a disposable fixture, set `STREAM_ACTIVITY_FIXTURE_URI` and `STREAM_ACTIVITY_FIXTURE_DB` in your shell to the fixture connection string and database name, then run:

```sh
MONGO_URI="$STREAM_ACTIVITY_FIXTURE_URI" cargo run --locked --release --bin stream_activity -- --database "$STREAM_ACTIVITY_FIXTURE_DB" --once
```

`--once` makes one batch attempt and exits; it can return zero when no rows are pending or another owner holds the lease. Without it, the executable continues until SIGTERM or Ctrl-C, finishing the active batch before shutdown and waiting one second only when no rows were projected. `--batch-size` sets the batch limit within the 1–1000 clamp.

The driver uses MongoDB client-level `bulk_write`, which requires MongoDB 8.0 or later. The parity harness currently checks for MongoDB 8.2 or later; the runtime parity checks for this port used MongoDB 8.2.6. This evidence does not establish runtime behavior on MongoDB 8.0 or 8.1.

## Parity and benchmark fixture

The manual parity harness compares persisted TypeScript and Rust results using generated disposable databases. It checks mixed event types, defaults and hashes, duplicate chatter identities across batches, empty state initialization, held leases, recovery from partial or already-processed batches, non-duplicate write validation failures, concurrent projectors, and unchanged dashboard state. The reference compiles the relevant TypeScript modules without bot bootstrap or telemetry.

The harness requires MongoDB 8.2 or later with TTL monitoring disabled, plus the Node dependencies installed for `dimabot` so it can load the existing Mongoose schemas and compile the TypeScript reference. Set `STREAM_ACTIVITY_TEST_URI` to an isolated disposable MongoDB fixture URI before running it from `dima-rust/`:

```sh
cargo build --locked --release --example stream_activity_fixture
node tests/stream_activity_parity.mjs
```

The harness creates uniquely named `stream_activity_fixture_` databases, initializes their indexes from the TypeScript schemas, and drops only the databases it created. Do not point it at a database containing application data.

Persisted snapshot comparison normalizes numeric BSON encodings such as Int32, Int64, and Double to numbers; ObjectIds and dates are compared by their normalized values. String values, field presence, and default document shape remain significant. The parity cases pass on the current implementation, including mixed-event snapshots and empty-checkpoint defaults. They also cover held leases, partial-write retry, already-processed recovery, MongoDB validation error 121 with checkpoint retention and retry, concurrent projectors, and preservation of the dashboard state document.

The manual CLI fixture checks help and dry-run without a URI or readable env file, selected env-file loading and environment precedence, the URI default database and explicit `--database` override, missing database/file failures, and clean idle shutdown on SIGTERM and SIGINT. Build the binary and run it with the same isolated fixture variable:

```sh
cargo build --locked --release --bin stream_activity
node tests/stream_activity_cli.mjs
```

This harness also creates and drops only uniquely named `stream_activity_fixture_cli_` databases under the explicitly supplied fixture URI.

The optional `--benchmark` mode generates a shared workload and verifies persisted parity for every run. Defaults are 6,000 events and three runs; supported values are 1,000–100,000 events and one to five runs:

```sh
node tests/stream_activity_parity.mjs --benchmark --benchmark-count 6000 --benchmark-runs 3
```

The completed benchmark used Node.js 26.8.2, Rust 1.99.1, MongoDB 8.2.6, one MongoDB CPU, 768 MiB MongoDB memory, a 0.25 GiB WiredTiger cache, TTL monitoring disabled, and `nice -n 10` for the worker processes. Each implementation processed the same generated 6,000-event workload in batches of 500 across three runs. All six benchmark outputs had exact persisted parity.

| Three-run median | TypeScript reference | Rust projector | Observed difference |
| --- | ---: | ---: | ---: |
| Peak worker-process RSS | 128.9023 MiB | 11.9531 MiB | 90.727% lower in this fixture |
| Worker-process user + system CPU | 1.53 s | 0.18 s | 88.235% lower in this fixture |
| Throughput after the first 500 events | 4,915.379 events/s | 6,717.554 events/s | 36.664% higher in this fixture |
| Spawn-inclusive elapsed time | 1,611.685 ms | 919.185 ms | — |

The harness alternates which implementation runs first. RSS and CPU include worker startup and shutdown; elapsed time includes process spawn. After-first-batch throughput excludes the first 500 events and includes the final empty poll. The TypeScript side runs compiled JavaScript in Node; its child does not load the TypeScript compiler, bot bootstrap, cron supervisor, or telemetry. These figures measure the worker processes only and exclude MongoDB CPU/RAM. The fixture used an isolated database, but the benchmark ran on the shared production host, so it is not a whole-host isolation study. The first batch is a limited warmup, not a full JIT warm-up study.

These are measurements of this synthetic fixture and configuration. They do not establish API throughput, production traffic behavior, or memory savings for 40 workers, and they do not isolate which individual implementation choices caused the difference. The full run data is in [stream_activity-2026-10-20.json](benchmarks/stream_activity-2026-10-20.json); the test procedure is in [stream_activity_parity.mjs](tests/stream_activity_parity.mjs).

Future work should profile before changing the implementation. The current code already hashes borrowed tuples and reuses its per-event metric buffer. Further experiments could measure logical-identity grouping or buffer reservations, vary batch size, profile the existing MongoDB queries and indexes, or try adaptive idle backoff with its latency tradeoff. A future Rust worker host could share one MongoDB client pool across workers; this standalone binary does not provide that integration. Channel partitioning would change the checkpoint and lease protocol and needs a designed migration and parity coverage; do not parallelize the single global projector lease blindly.
