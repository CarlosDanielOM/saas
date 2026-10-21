# Stream activity projector

The Rust stream-activity projector is a port of the batch projection in `dimabot/src/utils/stream_activity.ts`. It does not replace activity capture from `dimabot/src/handlers/message.handler.ts` or the activity read APIs. The existing cron supervisor runs its executable as the native stream-activity child instead of the TypeScript projector. It adds no Twitch, bot-runtime, or Redis dependency. The scheduled TypeScript worker entrypoint has since been retired and archived; see [the retirement record](../migration-notes/typescript-worker-retirement.md). Shared TypeScript projection helpers remain available to parity checks and do not provide runtime fallback.

On the production VPS, every Cargo build/run command below is subject to the [production-host Rust build and test policy](AGENTS.md#production-host-rust-build-and-test-policy); do not run Cargo directly on the host.

## Cron integration and rollout

The `stream-activity` worker remains registered once in the existing cron supervisor and always runs its native Rust executable under both Node and `tsx`. The former `STREAM_ACTIVITY_RUNTIME=typescript` selector and `tsx` TypeScript default are retired; neither selects archived code. The supervisor never starts both projectors for the same worker, and a missing or failed Rust executable restarts only that Rust child. The native executable is built and staged by `scripts/saas-ops build cron` into the existing `dima-cron` candidate image. No new production container or Compose service is introduced. Retirement run `cron-d02bf5a387d5` was accepted after all six candidate checks and the 190.459-second production watch passed. Historical release evidence below remains unchanged.

The supervisor launches the native child as UID/GID 65534 when the supervisor runs as root and passes only `MONGO_URI`, `PATH`, `TZ`, `LANG`, `LC_ALL`, `SSL_CERT_FILE`, and `SSL_CERT_DIR`. Rust does not receive Dragonfly credentials and does not use its Redis utility. With `--telemetry-json`, the executable emits bounded batch metadata that the supervisor validates and sends through existing telemetry: `stream_activity_rust.project_batch` duration and `stream_activity_rust.batch_events`, plus native-child `errors` and `restarts`. Separate `/proc` sampling reports `stream_activity_rust.rss_bytes` and `stream_activity_rust.cpu_cores` every ten seconds. The metrics appear in the existing System analytics → Resources → Our processes view under **Stream activity rust worker**. Native mode has no Node heap or event-loop metrics. On shutdown the supervisor sends SIGTERM and allows up to 25 seconds for children to exit before SIGKILL; the cron container stop timeout is 30 seconds.

## Stream-health telemetry

The health protocol shipped in combined cron run `cron-240af282cb85`. Its same-candidate stream suite passed; the bounded production acceptance watch passed. The change leaves projection, lease, and checkpoint behavior unchanged.

When `--telemetry-json` is enabled, the executable emits a health sample at startup and every 30 seconds, between batches. The whole MongoDB probe has a two-second timeout; each of its two read-only queries has a one-second server-side maximum. The first query finds at most one oldest unexpired `processed: false` activity, sorted by `occurredAt` and `_id`, using the existing pending-event index. Its presence sets `hasPending`; the probe does not count or enumerate the queue. The second reads the existing `projector-v1` state by key and returns only its sequence and active batch IDs. The protocol reports the active batch size, never the IDs themselves. The probe does not acquire a lease, create checkpoint state, mutate activities, or change the projection path.

The parser maps these bounded observations to `stream_activity_rust.pending_work`, `oldest_pending_age_ms`, `checkpoint_seq`, and `active_batch_events`. A successful positive batch updates process-local monotonic last-success time; until then, including after a restart, `last_success_age_ms` is unknown. A probe failure or timeout emits `health_errors` and no fabricated pending, age, sequence, or active-batch values. Health errors are separate from native-child `errors` and `restarts`, and cannot fail projection or trigger child restart. The existing admin process-health view renders missing/stale values as unknown and presents the pending field as an existence signal, not a queue count.

## Production rollout

The original stream-only cutover was deployed to the existing `dima-cron` service on 2026-10-21 using `saas-ops` run `cron-a4c96242b30a` (image `sha256:ed9f76cb48f072d0274618a4832d08fe7ed5bebd7cfaac631810e66ed1ed0b8b`; executable SHA-256 `f3c85b9a09a92ffebf2ffbe672a92bbf4d78d40db90beb72761264017239738d`). Candidate verification exercised checkpoint parity and recovery in both directions, a failed-worker restart, MongoDB validator failure handling, telemetry, and graceful shutdown. Rust remained the sole production stream projector after that cutover. Historical cron run `cron-b24a505b7fc8` kept stream activity on Rust and added the raid projector; see the [raid release record](../migration-notes/raid-analytics.md) for its deployment and post-deployment samples. The historical cron run `cron-240af282cb85` includes three native workers and scheduler/health telemetry; its production watch is recorded in [the baseline migration record](../migration-notes/follow-defense-baseline.md). The former rollback image was run `cron-443184ebb89e`, image `sha256:0b47480982664770a9a4a541b98ad4e746a50f38f2e55400c9124fa107d8afe8`. The old `STREAM_ACTIVITY_RUNTIME=typescript` selector is historical and retired; source restoration requires the reviewed process documented in the [retirement record](../migration-notes/typescript-worker-retirement.md).

During the initial production watch, the checkpoint advanced from 27,723 to 27,737 over 27 seconds, analytics displayed the Rust worker's RSS/CPU/batch metrics, and no worker errors or restarts were observed. The initial Rust RSS sample was 7.2 MiB versus 66.2 MiB from the earlier TypeScript observation. These are early operational samples, not a controlled comparison or evidence of whole-SaaS resource savings. Only the cron service was replaced; the other 16 production containers retained their IDs, images, and start times.

## Reused data and schema

The projector reads the existing `stream_activities` outbox collection and writes the existing `stream_activity_aggregates` and `stream_activity_states` collections in the selected MongoDB database. It mirrors the TypeScript schema's field names, BSON types, event kinds, aggregate identities, counter names, and defaults; the TypeScript capture sets the existing 90-day expiration used by projection. It does not capture events, read projected activity for the dashboard, or migrate data.

The TypeScript schemas in `dimabot/src/schemas/stream_activity.schema.ts` remain the schema and index source. They declare six activity indexes, including the two dashboard-query indexes, and four aggregate indexes. The Rust projector does not create, alter, or repair indexes; the required existing indexes must already be present in any database where it is run. The parity harness creates the schema-declared indexes in its own fixture databases and removes only databases it created with its `stream_activity_fixture_` prefix.

Projection record IDs use SHA-256 over the same JSON-array identity tuples as the TypeScript projector. The existing `projector-v1` state document stores a monotonically increasing sequence and a fixed active batch of activity IDs before aggregate writes start. A 60-second owner lease is renewed every 10 seconds. Aggregate writes use sequence fences so retrying the persisted batch does not apply its increments twice. Activities are acknowledged as processed only after the aggregate writes and ownership checks succeed. Non-duplicate write failures are returned while the active checkpoint remains available for retry.

The port targets the stored projection contract. It preserves the owner-fenced lease release and adds fresh owner/lease queries before aggregate writes and before acknowledging a batch. It treats only duplicate-key conflicts from aggregate sequence fences as already-applied writes; other write failures remain errors. Neither change alters the capture or dashboard-read path.

## API and executable

`dima_rust::workers::stream_activity::StreamActivityProjector::new(database)` selects the existing collection names without performing I/O. `project_batch(limit: usize)` returns `mongodb::error::Result<usize>`: the number of activity rows projected, or zero when no eligible batch is available or another owner holds the lease. The query clamps `limit` to 1–1000; the executable defaults to 500.

The `stream_activity` binary does not load conventional `.env` files automatically. `--help` and `--dry-run` exit before loading environment files or connecting to MongoDB. For an actual manual run, pass each selected file with `--env-file PATH`; the executable loads them synchronously before constructing its two-thread Tokio runtime. Existing process environment values take precedence, and earlier files take precedence over later files. Select the database with `--database NAME` or use a database name in `MONGO_URI`.

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

`--once` makes one batch attempt and exits; it can return zero when no rows are pending or another owner holds the lease. Without it, the executable continues until SIGTERM or Ctrl-C, finishing the active batch before shutdown and applying the adaptive idle wait described below when no rows were projected. `--batch-size` sets the batch limit within the 1–1000 clamp.

Continuous mode now adapts its idle polling delay. After successive empty batches, it waits 1, 2, 4, then 5 seconds; the delay stays capped at 5 seconds. Empty results from lease contention use the same backoff, while command errors return immediately. Any positive batch resets the delay and starts the next batch immediately, so queued work drains without idle sleeps. When the worker is idle, new work is normally picked up within about 5 seconds plus the next database query and scheduling time; this is not a hard latency bound. SIGINT or SIGTERM interrupts the idle wait promptly. If a signal arrives during a batch, the process finishes that batch before exiting. The idle fixture for this policy is `tests/stream_activity_idle.mjs`.

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

The idle polling fixture observes only the worker's pending activity query in its task-owned MongoDB profiler and checks the 1, 2, 4, 5, 5-second intervals, discovery of inserted work within the cap plus query/scheduling allowance, immediate backlog drain, reset to a 1-second delay, and prompt SIGINT/SIGTERM interruption. It requires an isolated MongoDB fixture URI and profiler access:

```sh
node tests/stream_activity_idle.mjs
```

It creates and removes only two task-owned databases named with the `stream_activity_fixture_idle_` prefix.

The isolated fixture passed against the current binary: it measured the capped 1/2/4/5/5-second sequence, observed pending work within the cap and immediate backlog draining, and confirmed the delay resets to one second. SIGINT during the five-second idle wait and SIGTERM after reset both exited promptly. Its filtered level-1 profiler assertions did not capture other namespaces.

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

### Batch-size comparison

A separate matrix of 48 worker runs compared batch sizes 100, 250, 500, and 1,000 in TypeScript and Rust on repeated-key and diverse-key synthetic workloads: 24 runs per implementation across three repetitions. Each language/workload/batch cell is the median of three runs of 6,000 events, with a fixed 1,000-event warmup. The table reports Rust worker-process metrics; throughput is measured after warmup, CPU and peak RSS include process startup and shutdown, and batch latency covers successful nonempty batches only.

| Workload | Batch | After-warmup events/s | Peak RSS | CPU | Median batch service time | Median per-run p95 batch service time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Repeated keys | 100 | 3,363.6 | 10.98 MiB | 0.47 s | 29.3 ms | 38.4 ms |
| Repeated keys | 250 | 4,413.9 | 11.77 MiB | 0.30 s | 56.3 ms | 72.4 ms |
| Repeated keys | 500 | 6,860.5 | 11.95 MiB | 0.17 s | 71.3 ms | 94.8 ms |
| Repeated keys | 1,000 | 9,830.0 | 12.51 MiB | 0.11 s | 94.2 ms | 134.8 ms |
| Diverse keys | 100 | 1,622.1 | 12.49 MiB | 0.67 s | 59.8 ms | 70.9 ms |
| Diverse keys | 250 | 2,095.7 | 14.69 MiB | 0.45 s | 114.2 ms | 142.1 ms |
| Diverse keys | 500 | 2,610.2 | 17.32 MiB | 0.32 s | 185.1 ms | 229.4 ms |
| Diverse keys | 1,000 | 2,877.4 | 23.27 MiB | 0.27 s | 330.2 ms | 392.6 ms |

The repeated workload used 3 channels, 300 actors, one time bucket, and 10 emotes; the diverse workload used 24 channels, 1,200 actors, 12 buckets, and 80 emotes. All 48 outputs had exact persisted parity. All 48 recorded pending-query plans used `processed_1_occurredAt_1__id_1`, required no blocking sort, and in the fresh unexpired fixtures examined one key and document per returned row. This does not guarantee the same scan behavior for aged or expired outbox data. MongoDB query plans were captured before each measured run, which also warmed the relevant collection/index pages.

Batch 1,000 delivered 43.3% more throughput than 500 on repeated keys for 0.56 MiB more peak RSS. On diverse keys it delivered 10.2% more throughput but used 34.3% more RSS than batch 500, and median successful batch service time rose from 185 ms to 330 ms. These p95 figures describe batch execution service time, not queueing or end-user latency; at batch 1,000 the diverse run had only six nonempty batches (five after warmup), so its p95 is based on very few observations. Smaller batches reduced per-batch service time and RSS, but also reduced throughput and increased measured worker CPU. The 500-event default remains a balanced choice for the tested mixed workloads, not a universal optimum.

The matrix used Node.js 26.8.2, Rust 1.99.1, MongoDB 8.2.6, one MongoDB CPU, 768 MiB MongoDB memory, a 0.25 GiB WiredTiger cache, TTL monitoring disabled, and `nice -n 10` for worker processes. Reproduce it after building the release fixture with:

```sh
node tests/stream_activity_parity.mjs --benchmark --benchmark-count 6000 --benchmark-runs 3 --benchmark-batches 100,250,500,1000 --benchmark-workloads repeated,diverse
```

Run order rotated across the three repetitions, which reduces but does not eliminate order bias or shared-host drift. Source compilation was outside the measured child processes; the TypeScript reference ran compiled JavaScript without cron bootstrap or telemetry. These worker-only synthetic measurements exclude MongoDB CPU/RAM and do not establish production/API throughput. Raw data is in [stream_activity-batches-2026-10-21.json](benchmarks/stream_activity-batches-2026-10-21.json), and the compact [HTML report](benchmarks/stream_activity-batches-2026-10-21.html) presents the Rust workload comparison.

Grouping rows by logical identity before hashing remains deferred pending a decision. The current code already hashes borrowed tuples and reuses its per-event metric buffer; profile the hot path before proposing additional allocation changes. Adaptive idle backoff is implemented above, trading lower idle query frequency for a pickup delay of up to about five seconds plus database and scheduling time.

A future Rust worker host could share one MongoDB client pool across Rust workers; the current native projector remains its own OS child and does not share the Node worker runtime or its pools. The cron supervisor restarts only the failed child. A Tokio supervisor can isolate task panics and returned errors, but it cannot contain process OOM, abort, native crashes, or runtime-wide stalls. Preserve OS-process boundaries for bot-critical jobs; group only workloads with compatible failure impact, or retain dedicated processes where needed. Separate processes still share container and host resource limits, so process separation alone does not contain container- or host-wide resource failures. Channel partitioning would change the checkpoint and lease protocol and needs a designed migration and parity coverage; do not parallelize the single global projector lease blindly.
