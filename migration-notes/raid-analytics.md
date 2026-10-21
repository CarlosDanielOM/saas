# Raid analytics projector

Status as of 2026-10-21: the Rust raid-analytics child is deployed and running in cron run `cron-b24a505b7fc8`. The bounded candidate passed its raid and stream behavior checks, and the initial 165-second production acceptance watch confirmed the native child was the sole raid projector, summaries stayed current, telemetry arrived, and no errors or restarts appeared. Ordinary-load observation continues; this short window is not a steady-state resource profile. The TypeScript worker remains available as an explicit rollback path. This record is canonical for the raid migration; the [`dima-rust` project guide](../dima-rust/AGENTS.md) and [ops guide](../ops/README.md) point here.

This is a projector migration inside the existing `dima-cron` container. It adds no Compose service, API deployment, collection, or new event producer. It preserves the existing raid analytics contract and changes how queued summaries are projected. Early RSS observations are available below, while CPU evidence and representative steady-state resource/throughput measurements are not yet sufficient to quantify runtime savings.

## Existing data and boundaries

The existing TypeScript producer in [`raid_analytics.ts`](../dimabot/src/utils/raid_analytics.ts) consumes Twitch EventSub domain events and writes idempotent records to `raid_analytics_histories`. It queues a dirty summary in `raid_analytics_summaries`. The existing [domain-event consumer](../dimabot/src/domain_events/domain_event_consumers.ts) dispatches raid events, and the [dashboard route](../dimabot/src/server/routes/dashboard.route.ts) reads the summary and can queue a refresh. The Rust projector reuses those same collections and `domain_events`; it does not replace event capture, dashboard reads, or event dispatch. The [TypeScript schemas](../dimabot/src/schemas/raid_analytics.schema.ts) remain the contract and index source.

The projector refreshes one due channel per pass. It recomputes eligible incoming-raid follow windows from retained `channel.follow.received` domain events, then rebuilds the existing seven- and thirty-day summary payloads. The TypeScript and Rust paths must preserve field names, BSON types, defaults, ordering, expiry filters, and ownership semantics. Rust does not create or repair indexes; the existing schema indexes must be present.

The TypeScript observation showed 75 valid stored channel summaries; that count is not 75 refreshes per minute. The TypeScript loop waits one second after each pass, including successful work, so its forced delay caps it at roughly 60 passes per minute. At the fresh pre-deploy sample on 2026-10-21 02:30:17 UTC, 16 channels were due, there were no recorded errors, and the oldest summary update was 75 seconds old. The TypeScript process RSS was 85,544,960 bytes (about 81.6 MiB), the mean over the preceding 15 minutes was 83,117,306.31 bytes (about 79.3 MiB), and mean CPU was 0.0104193776 cores (about 1.04% of one core). The earlier 01:33:40 sample (110,415,872 bytes RSS, 103,585,539 bytes 15-minute mean, 0.012944 cores CPU) is a superseded observation. These snapshots were under uncontrolled load and are not a matched comparison.

The Rust implementation drains due work immediately after a successful pass, then backs off only when idle at 1, 2, 4, and 5 seconds (capped), resetting on work. It processes at most 25 follow windows and runs at most five follow-count query tasks concurrently. A 60-second per-channel lease is renewed every 10 seconds, with owner checks around writes. The first production sample showed 64 summaries refreshed after cutover and one channel due; sustained throughput and representative steady-state resource use still need observation.

## Supervisor and rollback

`dimabot/src/workers/cron.index.ts` supervises one child for this worker. Node production mode selects `/usr/local/bin/raid_analytics` by default when the native runtime is installed. `RAID_ANALYTICS_RUNTIME=typescript` explicitly selects the existing TypeScript worker. The supervisor does not run both projectors for the same worker, and a failed Rust child is restarted rather than silently falling back. `tsx` development continues to use TypeScript unless Rust is selected explicitly.

When launched as root, the supervisor runs the native child as UID/GID 65534 and passes a restricted environment containing MongoDB connection settings and required process/locale/certificate variables. It receives no Dragonfly credentials. The native child emits bounded stdout metadata; the existing TypeScript cron host samples and exports runtime and batch metrics through the existing Dragonfly and analytics path under `raid_analytics_rust.*`. These metrics intentionally do not claim Node heap or event-loop measurements. Telemetry remains in TypeScript; the optional PostgreSQL feature is only dependency readiness for a possible future telemetry port. The production analytics process view showed the native raid worker after rollout.

There is no automatic fallback. The cron deployment replaced the existing cron container, restarting its process tree once; the supervisor continues to isolate worker failures after startup. It did not replace other Compose services or containers. There are no cron worker PID-preservation guarantees across deployment. To roll back this release, use `scripts/saas-ops rollback cron-b24a505b7fc8`; it restores the saved prior image, where stream activity is native and raid analytics is TypeScript. The earlier stream first-cutover receipt is historical and cannot roll back across this newer release. Explicitly setting `RAID_ANALYTICS_RUNTIME=typescript` requires the separately reviewed configuration workflow. The code-only helper rejects configuration drift and does not apply that environment change.

## Candidate validation and release

Use `scripts/saas-ops` from the repository root. On this production VPS, the root [`AGENTS.md`](../AGENTS.md) and [`dima-rust/AGENTS.md`](../dima-rust/AGENTS.md) require the capped, serialized Cargo build path. `scripts/saas-ops build cron` snapshots Rust sources and builds both native binaries in the task-owned, resource-limited compiler container using only the `mongo` feature (`--no-default-features --features mongo`). The full Cargo default foundation remains available to manual/library consumers; normal worker builds exclude optional SQLx/PostgreSQL, Axum, and Redis features. Use the separate `--rust-feature-matrix` flag only for an explicit feature audit. A private, guarded 8 GiB cache retains Cargo dependency artifacts, keyed by toolchain, manifest, lockfile, recipe, features, and profiles; each build still cleans and rebuilds the project package from its frozen snapshot. Cache savings are compile-time savings only; unused dependencies do not imply proportional runtime RSS or CPU savings. Do not run Cargo directly on the production host.

The raid fixture check runs the candidate's real cron supervisor and Rust executable with disposable MongoDB and Dragonfly dependencies. It checks persisted parity against the existing TypeScript projector, schema/default/index compatibility, idempotent history writes, due summary refresh and dedupe, queue/lease ownership/loss/retry, bounded follow queries, native worker selection and UID/environment restriction, bounded telemetry, child restart and shutdown behavior. The fixture allows only databases with the `raid_analytics_fixture_` prefix and removes the databases it created. The relevant artifacts are the [Rust projector](../dima-rust/src/workers/raid_analytics.rs), [Rust executable](../dima-rust/src/bin/raid_analytics.rs), [candidate behavior check](../ops/checks/raid-analytics-rust.mjs), and [fixture settings](../ops/checks/raid-analytics-rust-fixtures/test-env.json). It uses the checked-in isolated boot hook and copies the source validator into its fixture directory:

```sh
set -eu
RAID_FIXTURES=$(mktemp -d /tmp/raid-analytics-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$RAID_FIXTURES"' EXIT
cp ops/checks/raid-analytics-rust-fixtures/cron-boot.mjs "$RAID_FIXTURES/"
cp dima-analytics/src/store.mjs "$RAID_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/raid-analytics-rust-fixtures/test-env.json \
  --fixtures "$RAID_FIXTURES" \
  --check ops/checks/raid-analytics-rust.mjs
```

Also run the [stream-activity behavior check](../ops/README.md#rust-worker-binaries-in-the-cron-target) against this exact candidate run. Both the migrated raid behavior and the already-active stream checkpoint/recovery behavior must pass before promoting the shared cron image.

After the check passes, deploy and clean up the same run ID:

```sh
scripts/saas-ops deploy cron-<run-id>
scripts/saas-ops cleanup cron-<run-id>
```

An earlier prototype drained a synthetic backlog across 16 channels in 1.144 seconds. The final candidate check drained its synthetic 16-channel backlog in 1.105 seconds. These are fixture timings, not production throughput or a matched implementation comparison.

## Build and verification record

The deployed release is run `cron-b24a505b7fc8`, built with the optimized Mongo-only worker recipe. Its image digest is `sha256:78912284ca1a4178e0062007a922f0be70bcf0ecb5ea09c5ab12c9e25d95ad56`, Rust source digest `97fc6387f9090bdceb7fba27c5eff163fc62709dce9ba98cdbc9a16e466a269e`, stream binary SHA-256 `3c7310e99b8d0bbf90328401f064807cc863afa5ef21a189c4e44172e19bc703`, and raid binary SHA-256 `08b562c3350fd104f8b49a80b27d59f9f50ea2cb4ac1178d2fcd6c6fcab7b8e9`. The exact candidate image was promoted; no API, bot, or frontend target was deployed.

The normal Mongo-only cold build `cron-ea84c986d7f0` took 649.777 seconds of Rust build time; the accepted warm build took 102.007 seconds with dependencies reused and both project release binaries explicitly cleared and rebuilt. Both use the same source, manifests, lockfile, recipe, and feature set. The warm receipt confirmed `cache.project_release_clean=true`, and the Cargo log checked/compiled only `dima-rust`, not dependencies. This is compile-time evidence; it makes no runtime RSS or CPU claim. The manual stream fixture example is not included in normal cron candidates.

The separate transition audit `cron-a119f0761077` passed its no-feature, Redis, PostgreSQL, HTTP, and all-feature graph checks plus the Redis-only TLS-provider regression check. Separately, the Mongo-only worker checks passed 18 unit tests and one doc test. The selected worker graph excluded SQLx, Axum, and Redis. Its 934.539-second total included the full matrix and the then-included manual fixture example, so it is not comparable to the normal cold/warm timings.

The helper and supervisor regression suites passed after the final helper update: 56 `ops` tests and 15 TypeScript supervisor/metrics tests. These checks cover the helper lifecycle and shared cron child selection/telemetry code; they supplement the final candidate's disposable MongoDB/Dragonfly raid and stream behavior checks recorded below.

Final candidate run `cron-b24a505b7fc8` passed all 10 raid behavior-check assertions, including persisted parity, lease/retry and recovery cases, restricted UID/environment, telemetry, child restart, and shutdown. The synthetic 16-channel backlog drained in 1.105 seconds. The same candidate passed all five stream behavior-check assertions, including checkpoint parity, restart/fenced recovery, actual Redis and analytics validation, partial-failure handoff without TypeScript duplication, and SIGTERM shutdown. These checks used disposable MongoDB/Dragonfly fixtures; they are not production observations. Their logs and verification receipts are retained with the run.

The cron container started at 2026-10-21 02:31:34.938 UTC with restart count 0. In the first read-only sample at 02:31:57.542 UTC, the native raid child was PID 16, UID 65534, RSS 7,622,656 bytes (about 7.27 MiB); the native stream child was PID 20, UID 65534, RSS 7,442,432 bytes. No TypeScript raid process was present. At that sample, all 75 summaries were valid, 64 had refreshed since cutover, one was due, there were no errors, and the oldest summary update was 02:30:57.416 UTC (about 60 seconds old). Stream checkpoint sequence advanced from 29383 before deployment to 29397, with zero active batches.

The initial analytics overview at 02:31:57.282 UTC accepted `raid_analytics_rust.*` metrics: `project_batch` had 80 frames at 8.7259 ms average with zero errors; `batch_channels` summed to 60 across 80 samples with zero errors; sampled RSS averaged 7,684,096 bytes across two samples. The only CPU sample in that first overview was 0.0149965 cores during the startup burst and is superseded by the later watch samples below. The observed RSS is below the fresh pre-deploy TypeScript observation of 81.6 MiB, but these are unmatched light-load samples; do not infer host-wide savings or a controlled percentage reduction.

At the end of the initial watch, 2026-10-21 02:34:20.465 UTC (about 165.5 seconds after cron start), the native raid PID remained 16 with the same process start ticks; RSS was 7,127,040 bytes (about 6.80 MiB). An intermediate sample at 02:33:10 was 7,692,288 bytes (about 7.34 MiB), and the first sample at 02:31:57 was 7,622,656 bytes (about 7.27 MiB). The analytics RSS mean across 16 samples was 7,667,456 bytes (about 7.31 MiB). The native stream child, PID 20, ran as UID 65534 at 6,868,992 bytes RSS. The cron container restart count stayed 0.

All 75 summaries were valid and refreshed since cutover, with zero due and zero errors at the final sample. The oldest summary was updated at 02:33:38.143 UTC (42 seconds old) and the newest at 02:34:11.902 UTC. The analytics overview recorded 342 `project_batch` frames, 2,332.276729 ms summed duration, 6.8195226 ms average duration, and zero errors. `batch_channels` had 342 frames, sum 225, and zero errors. Native error/restart metric groups were absent, and the raid PID did not change after startup. The stream checkpoint advanced from 29383 before deployment to 29432, with zero active batches. Recent native generic projection errors remained at zero.

Across the watch, 15 CPU samples averaged 0.00713221615389936 cores (about 0.713% of one core), with the last sample at 02:34:00 UTC. The pre-deploy TypeScript 15-minute mean was 0.0104193776 cores (about 1.042% of one core). Those windows and loads are unmatched, so no formal CPU reduction claim follows. Native RSS observations were about 7.31 MiB on average versus the fresh pre-deploy TypeScript sample of about 81.6 MiB under unmatched light load; this is an observation, not a controlled percentage comparison or proof of host-wide savings. This initial acceptance watch is complete, but it does not constitute a steady-state benchmark.

Production scope checks found 17 containers: only the `dima-cron` container ID, image, and start time changed; the other 16, including API and bot containers, remained identical. The legacy TypeScript worker count changed from 38 to 37, with only `raid_analytics.worker.js` removed and all other observed TypeScript worker names unchanged. Candidate test containers and networks were removed and the helper run was cleaned. The exact live and prior rollback images, receipts, and logs were retained; the dedicated Rust cache remains intentionally available under its 8 GiB cap.

## Future work

First measure post-rollout behavior under ordinary production load. Only then consider further changes such as query/index tuning or channel parallelism. Parallelism would change contention and lease behavior, so it needs designed ownership boundaries and parity/recovery coverage before implementation. Do not infer that stream-activity benchmark results transfer to raid analytics.
