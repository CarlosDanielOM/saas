# Raid analytics projector

Historical raid status as of 2026-10-21: final raid phase/health release `cron-23e91b98cf64` and admin bundle `admin-33b3f62b305d` were deployed. Its bounded production acceptance watch and a later zero-backlog health readback passed; the shared reciprocity-query experiment was deferred. Feature-acceptance run `cron-99f8d5165ff2` deployed raid, stream, follow-defense baseline, and roulette completion; all four exact-image runtime suites, the 19-sample production watch, and cleanup passed. The change-driven refresh was accepted in `cron-2ddd455fdd1f` with 20 raid runtime groups and a 124.802-second watch; see [its release record](raid-change-driven.md). Latest production run `cron-7b8a6c88303d` deployed all five native workers; all five exact-image suites and the 190.624-second combined production watch passed. The earlier rollout, benchmarks, health samples, and rollback evidence remain below as historical project context; the [`dima-rust` project guide](../dima-rust/AGENTS.md) and [ops guide](../ops/README.md) point here.

This is a projector migration inside the existing `dima-cron` container. It adds no Compose service, API deployment, collection, or new event producer. It preserves the existing raid analytics contract and changes how queued summaries are projected. The controlled fixtures below measure worker behavior under bounded synthetic load; the production watch is still short and does not establish steady-state resource or throughput changes.

## Existing data and boundaries

The existing TypeScript producer in [`raid_analytics.ts`](../dimabot/src/utils/raid_analytics.ts) consumes Twitch EventSub domain events and writes idempotent records to `raid_analytics_histories`. It queues a dirty summary in `raid_analytics_summaries`. The existing [domain-event consumer](../dimabot/src/domain_events/domain_event_consumers.ts) dispatches raid events, and the [dashboard route](../dimabot/src/server/routes/dashboard.route.ts) reads the summary and can queue a refresh. The Rust projector reuses those same collections and `domain_events`; it does not replace event capture, dashboard reads, or event dispatch. The [TypeScript schemas](../dimabot/src/schemas/raid_analytics.schema.ts) remain the contract and index source.

The projector refreshes one due channel per pass. It recomputes eligible incoming-raid follow windows from retained `channel.follow.received` domain events, then rebuilds the existing seven- and thirty-day summary payloads. The TypeScript and Rust paths must preserve field names, BSON types, defaults, ordering, expiry filters, and ownership semantics. Rust does not create or repair indexes; the existing schema indexes must be present. The deployed release retains the original sequence: build the 7-day aggregate, query its outgoing reciprocity, build the 30-day aggregate, then query its outgoing reciprocity. This remains four aggregation queries per channel. A proposed shared outgoing lookup across periods was benchmarked and deferred; the deployed release does not include it.

The TypeScript observation showed 75 valid stored channel summaries; that count is not 75 refreshes per minute. The TypeScript loop waits one second after each pass, including successful work, so its forced delay caps it at roughly 60 passes per minute. At the fresh pre-deploy sample on 2026-10-21 02:30:17 UTC, 16 channels were due, there were no recorded errors, and the oldest summary update was 75 seconds old. The TypeScript process RSS was 85,544,960 bytes (about 81.6 MiB), the mean over the preceding 15 minutes was 83,117,306.31 bytes (about 79.3 MiB), and mean CPU was 0.0104193776 cores (about 1.04% of one core). The earlier 01:33:40 sample (110,415,872 bytes RSS, 103,585,539 bytes 15-minute mean, 0.012944 cores CPU) is a superseded observation. These snapshots were under uncontrolled load and are not a matched comparison.

The Rust implementation drains due work immediately after a successful pass, then backs off only when idle at 1, 2, 4, and 5 seconds (capped), resetting on work. It processes at most 25 follow windows and runs at most five follow-count query tasks concurrently. A 60-second per-channel lease is renewed every 10 seconds, with owner checks around writes. The first production sample showed 64 summaries refreshed after cutover and one channel due; sustained throughput and representative steady-state resource use still need observation.

## Follow-up telemetry and admin health view

The final follow-up candidate emits bounded phase durations for claim, follow queries, follow writes, 7-day summary, 30-day summary, reciprocity, publish, and release. Only reached phases have values. A phase records attempted work even when it fails, and Node tags each emitted phase with the enclosing batch's outcome. With the original per-period query sequence, `reciprocityMs` is the sum of both attempted reciprocity query durations. The admin Observability page presents phase averages under the cron queue refresh details; phase rows are parts of a refresh and do not add jobs or failures to the job totals. These are database/projector phase timings, not a complete per-channel critical-path accounting.

With `--telemetry-json`, the child also probes due summaries every 30 seconds, between projection batches, with a two-second whole-probe timeout and bounded Mongo query times. It reports due-channel count, oldest due age when any channel is due, and age of the last successful non-idle refresh. A probe failure does not fail projection and does not manufacture a zero backlog. After process restart, last-success age stays unknown until a batch succeeds. Missing, mixed, or stale readings remain unknown or uncertain in admin; the Observability → Servers → Our processes view marks observations stale after 90 seconds. Displayed values summarize the latest 10-second analytics bucket, which can include multiple samples. This path reuses the existing TypeScript cron metrics and analytics ingestion; it adds no analytics service schema or deployment requirement.

The admin bundle `admin-33b3f62b305d` passed health-state, deduplication, and filter checks at 320, 390, and 1280 px in both themes, with no axe findings or horizontal overflow. Its published-bundle check passed against the served admin assets with all API calls mocked; it does not claim authenticated live-backend UI behavior. The visible tab is labeled **Servers**; `resources` is its internal route/state name.

## Deferred query-sharing experiment

The proposal to share one outgoing reciprocity aggregate across the 7- and 30-day results was tested in two full parity trials and deferred. The artifact [raid-analytics-query-experiment-2026-10-21.json](../dima-rust/benchmarks/raid-analytics-query-experiment-2026-10-21.json) records 54 successful runs and combined six-repetition Rust medians across quiet, moderate, and dense fixtures. Each run refreshed ten channels; the first two were limited warmup and excluded from measured projection throughput. The experimental candidate included phase/health instrumentation, so differences do not isolate the query change.

| Workload | Projection throughput change | Whole-process CPU per channel change |
| --- | ---: | ---: |
| Quiet | +14.46% | −3.77% |
| Moderate | +4.53% | +1.32% |
| Dense | +0.42% | +4.82% |

Busy-workload CPU did not improve consistently, and the second trial reversed the moderate/dense throughput directions. The experiment therefore does not support a general runtime CPU claim. The deployed release retains the original four-query sequence. The final TypeScript / previous Rust / release comparison is recorded separately below in `dima-rust/benchmarks/raid-analytics-2026-10-21.json`.

Two earlier interrupted benchmark attempts exhausted file descriptors in the disposable MongoDB fixture after repeatedly creating databases and indexes. The accepted trials reused exactly two owned databases and their index sets, deleting and reseeding fixture data outside timed runs. No production limits or settings changed. This correction is included in the experiment artifact.

## Final release benchmark

The final three-runtime benchmark passed 27 strict persisted-parity runs across quiet, moderate, and dense workloads. It rotated three repetitions per runtime/workload over ten channels, with the first two channels treated as limited warmup. All child processes ran sequentially as UID 65534 in the same 2-CPU/3-GiB candidate cgroup against identical MongoDB data and indexes. Whole-process CPU includes startup and shutdown; worker peak RSS is sampled after the final batch and excludes shutdown; projection throughput excludes startup, notification gaps, health probes, and shutdown.

| Workload | Final Rust RSS / TypeScript RSS | Final Rust CPU ms/channel / TypeScript | Final Rust projection channels/s / TypeScript |
| --- | ---: | ---: | ---: |
| Quiet | 7.26 / 88.80 MiB | 5.30 / 69.27 | 136.57 / 95.19 |
| Moderate | 7.62 / 102.18 MiB | 24.72 / 144.68 | 29.46 / 17.78 |
| Dense | 7.80 / 102.89 MiB | 27.40 / 146.01 | 21.16 / 16.78 |

These are short synthetic projector-engine measurements, not production forecasts: they exclude MongoDB resource use, supervisor cost, API load, and the TypeScript worker's production one-second delay. The final Rust binary includes phase/health instrumentation. Against the pre-instrumentation Rust binary, the final dense fixture was about 18.5% slower in measured projection throughput and used about 8% more whole-process CPU per channel; the quiet and moderate comparisons varied. The query experiment and final candidate do not support a claim that the new Rust release improves CPU or throughput over the prior Rust release. Continue ordinary-load observation before drawing operational conclusions.

## Supervisor and rollback

`dimabot/src/workers/cron.index.ts` supervises one child for this worker. Node production mode selects `/usr/local/bin/raid_analytics` by default when the native runtime is installed. `RAID_ANALYTICS_RUNTIME=typescript` explicitly selects the existing TypeScript worker. The supervisor does not run both projectors for the same worker, and a failed Rust child is restarted rather than silently falling back. `tsx` development continues to use TypeScript unless Rust is selected explicitly.

When launched as root, the supervisor runs the native child as UID/GID 65534 and passes a restricted environment containing MongoDB connection settings and required process/locale/certificate variables. It receives no Dragonfly credentials. The native child emits bounded stdout metadata; the existing TypeScript cron host samples and exports runtime and batch metrics through the existing Dragonfly and analytics path under `raid_analytics_rust.*`. These metrics intentionally do not claim Node heap or event-loop measurements. Telemetry remains in TypeScript; the optional PostgreSQL feature is only dependency readiness for a possible future telemetry port. The production analytics process view showed the native raid worker after rollout.

There is no automatic fallback. Each deployed cron release replaces the existing cron container, restarting its process tree once; the supervisor continues to isolate worker failures after startup. It does not replace other Compose services or containers. There are no cron worker PID-preservation guarantees across deployment. The rollback target saved by historical run `cron-b24a505b7fc8` was the prior image with native stream activity and the TypeScript raid worker; no rollback was performed for that run, and its receipt cannot roll back across a newer deployment. The rollback target saved by historical run `cron-23e91b98cf64` was the `cron-b24a505b7fc8` image with native stream and raid workers; no rollback was performed. At the time of this historical release, `cron-443184ebb89e` was the newest cron run; its receipt restored `cron-23e91b98cf64`. Current run and rollback details are in the release banner above. Selecting `RAID_ANALYTICS_RUNTIME=typescript` requires the separately reviewed configuration workflow. The code-only helper rejects configuration drift and does not apply that environment change.

## Candidate validation and release

Use `scripts/saas-ops` from the repository root. On this production VPS, the root [`AGENTS.md`](../AGENTS.md) and [`dima-rust/AGENTS.md`](../dima-rust/AGENTS.md) require the capped, serialized Cargo build path. `scripts/saas-ops build cron` snapshots Rust sources and builds both native binaries in the task-owned, resource-limited compiler container using only the `mongo` feature (`--no-default-features --features mongo`). The full Cargo default foundation remains available to manual/library consumers; normal worker builds exclude optional SQLx/PostgreSQL, Axum, and Redis features. Use the separate `--rust-feature-matrix` flag only for an explicit feature audit. A private, guarded 8 GiB cache retains Cargo dependency artifacts, keyed by toolchain, manifest, lockfile, recipe, features, and profiles; each build still cleans and rebuilds the project package from its frozen snapshot. Cache savings are compile-time savings only; unused dependencies do not imply proportional runtime RSS or CPU savings. Do not run Cargo directly on the production host.

The historical first-port check ran the candidate supervisor and Rust executable with disposable MongoDB and Dragonfly dependencies, covering TypeScript parity, schema/default/index compatibility, idempotent history writes, refresh and dedupe, queue/lease behavior, bounded follow queries, child selection and UID/environment, telemetry, recovery, and shutdown. Its original script [`raid-analytics-rust.mjs`](../ops/checks/raid-analytics-rust.mjs) is retained for that historical evidence; it is not the current release check. Use the 20-group [`raid-analytics-change-driven.mjs`](../ops/checks/raid-analytics-change-driven.mjs) for all future cron candidate verification. See [raid-change-driven.md](raid-change-driven.md) for its scope and accepted exact-image evidence. The older fixture's settings and hooks remain relevant to both checks.

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

### Historical initial Rust rollout

The first Rust raid release was run `cron-b24a505b7fc8`, built with the optimized Mongo-only worker recipe. Its image digest is `sha256:78912284ca1a4178e0062007a922f0be70bcf0ecb5ea09c5ab12c9e25d95ad56`, Rust source digest `97fc6387f9090bdceb7fba27c5eff163fc62709dce9ba98cdbc9a16e466a269e`, stream binary SHA-256 `3c7310e99b8d0bbf90328401f064807cc863afa5ef21a189c4e44172e19bc703`, and raid binary SHA-256 `08b562c3350fd104f8b49a80b27d59f9f50ea2cb4ac1178d2fcd6c6fcab7b8e9`. That release changed only the cron target; no API, bot, or frontend target was part of it.

The normal Mongo-only cold build `cron-ea84c986d7f0` took 649.777 seconds of Rust build time; the accepted warm build took 102.007 seconds with dependencies reused and both project release binaries explicitly cleared and rebuilt. Both use the same source, manifests, lockfile, recipe, and feature set. The warm receipt confirmed `cache.project_release_clean=true`, and the Cargo log checked/compiled only `dima-rust`, not dependencies. This is compile-time evidence; it makes no runtime RSS or CPU claim. The manual stream fixture example is not included in normal cron candidates.

The experimental shared-query candidate `cron-bade84f34ce6` built with image digest `sha256:6babaafc6457617f25e411c482a76b6f79ca8f8b9cbf2c0862f2dbb876794a74`. Its capped Mongo-only Rust build took 104.798 seconds with a cache hit while clearing and rebuilding both release binaries; `rustc 1.99.1`, 21 unit tests, and one doc test were confirmed. The native metrics parser's 11 tests and the `ops` suite's 56 tests passed. This image was used only for the controlled experiment, was never deployed, and has been cleaned up.

Historical final raid release `cron-23e91b98cf64` used the same pinned Rust 1.99.1 image and Mongo-only feature. The capped Rust build took 101.849 seconds with dependency cache reuse and both release binaries cleared and rebuilt. It passed 21 unit tests, one doc test, 11 native metrics parser tests, 56 `ops` tests, all 11 raid behavior assertions (including a 16-channel fixture drained in 1.111 seconds), all five stream behavior assertions, and 27 strict-parity benchmark runs. The exact image was deployed. The benchmark artifact at [raid-analytics-2026-10-21.json](../dima-rust/benchmarks/raid-analytics-2026-10-21.json) records verification metadata and selected digests, including 97 Mongo file-descriptor samples with a peak of 95 under a 1024 soft limit; private helper receipts remain in the run state. The separate admin bundle passed eight health states at 320, 390, and 1280 px in both themes with no axe findings or horizontal overflow, then was deployed as exact verified bundle `admin-33b3f62b305d`.

The separate transition audit `cron-a119f0761077` passed its no-feature, Redis, PostgreSQL, HTTP, and all-feature graph checks plus the Redis-only TLS-provider regression check. Separately, the Mongo-only worker checks passed 18 unit tests and one doc test. The selected worker graph excluded SQLx, Axum, and Redis. Its 934.539-second total included the full matrix and the then-included manual fixture example, so it is not comparable to the normal cold/warm timings.

The helper and supervisor regression suites passed after the final helper update: 56 `ops` tests and 15 TypeScript supervisor/metrics tests. These checks cover the helper lifecycle and shared cron child selection/telemetry code; they supplement the final candidate's disposable MongoDB/Dragonfly raid and stream behavior checks recorded below.

Final candidate run `cron-b24a505b7fc8` passed all 10 raid behavior-check assertions, including persisted parity, lease/retry and recovery cases, restricted UID/environment, telemetry, child restart, and shutdown. The synthetic 16-channel backlog drained in 1.105 seconds. The same candidate passed all five stream behavior-check assertions, including checkpoint parity, restart/fenced recovery, actual Redis and analytics validation, partial-failure handoff without TypeScript duplication, and SIGTERM shutdown. These checks used disposable MongoDB/Dragonfly fixtures; they are not production observations. Their logs and verification receipts are retained with the run.

The cron container started at 2026-10-21 02:31:34.938 UTC with restart count 0. In the first read-only sample at 02:31:57.542 UTC, the native raid child was PID 16, UID 65534, RSS 7,622,656 bytes (about 7.27 MiB); the native stream child was PID 20, UID 65534, RSS 7,442,432 bytes. No TypeScript raid process was present. At that sample, all 75 summaries were valid, 64 had refreshed since cutover, one was due, there were no errors, and the oldest summary update was 02:30:57.416 UTC (about 60 seconds old). Stream checkpoint sequence advanced from 29383 before deployment to 29397, with zero active batches.

The initial analytics overview at 02:31:57.282 UTC accepted `raid_analytics_rust.*` metrics: `project_batch` had 80 frames at 8.7259 ms average with zero errors; `batch_channels` summed to 60 across 80 samples with zero errors; sampled RSS averaged 7,684,096 bytes across two samples. The only CPU sample in that first overview was 0.0149965 cores during the startup burst and is superseded by the later watch samples below. The observed RSS is below the fresh pre-deploy TypeScript observation of 81.6 MiB, but these are unmatched light-load samples; do not infer host-wide savings or a controlled percentage reduction.

At the end of the initial watch, 2026-10-21 02:34:20.465 UTC (about 165.5 seconds after cron start), the native raid PID remained 16 with the same process start ticks; RSS was 7,127,040 bytes (about 6.80 MiB). An intermediate sample at 02:33:10 was 7,692,288 bytes (about 7.34 MiB), and the first sample at 02:31:57 was 7,622,656 bytes (about 7.27 MiB). The analytics RSS mean across 16 samples was 7,667,456 bytes (about 7.31 MiB). The native stream child, PID 20, ran as UID 65534 at 6,868,992 bytes RSS. The cron container restart count stayed 0.

All 75 summaries were valid and refreshed since cutover, with zero due and zero errors at the final sample. The oldest summary was updated at 02:33:38.143 UTC (42 seconds old) and the newest at 02:34:11.902 UTC. The analytics overview recorded 342 `project_batch` frames, 2,332.276729 ms summed duration, 6.8195226 ms average duration, and zero errors. `batch_channels` had 342 frames, sum 225, and zero errors. Native error/restart metric groups were absent, and the raid PID did not change after startup. The stream checkpoint advanced from 29383 before deployment to 29432, with zero active batches. Recent native generic projection errors remained at zero.

Across the watch, 15 CPU samples averaged 0.00713221615389936 cores (about 0.713% of one core), with the last sample at 02:34:00 UTC. The pre-deploy TypeScript 15-minute mean was 0.0104193776 cores (about 1.042% of one core). Those windows and loads are unmatched, so no formal CPU reduction claim follows. Native RSS observations were about 7.31 MiB on average versus the fresh pre-deploy TypeScript sample of about 81.6 MiB under unmatched light load; this is an observation, not a controlled percentage comparison or proof of host-wide savings. This initial acceptance watch is complete, but it does not constitute a steady-state benchmark.

Production scope checks found 17 containers: only the `dima-cron` container ID, image, and start time changed; the other 16, including API and bot containers, remained identical. The legacy TypeScript worker count changed from 38 to 37, with only `raid_analytics.worker.js` removed and all other observed TypeScript worker names unchanged. Candidate test containers and networks were removed and the helper run was cleaned. The exact live and prior rollback images, receipts, and logs were retained; the dedicated Rust cache remains intentionally available under its 8 GiB cap.

## Final release production acceptance

The final release started at 03:14:05.377403158 UTC. The acceptance sample at 03:15:45.719 UTC was about 100.34 seconds after startup, exceeding the 90-second watch target. Raid PID 16 (7,802,880 bytes RSS) and stream PID 20 (7,426,048 bytes RSS) retained their start ticks; both ran as UID 65534. The cron container restart count was zero. All 75 summaries were valid and refreshed since cutover, with zero due, zero scheduled due, and zero errors. Stream checkpoint sequence advanced from 29992 at the first sample to 30005, with zero active batches.

The existing analytics database received all eight phase metric keys. `followWriteMs` first appeared at 03:15:20; the other seven phase metrics were present by 03:15:30. The 03:15:10 health snapshot had `health_query=1`, `last_success_age_ms=1.529471`, 44 due channels, and oldest due age 1,890 ms; `health_errors` was absent. The direct summary query at the final 03:15:45 sample found zero due. These are separate, timestamped observations from periodic health polling and the final direct database check. Native error and restart groups were absent.

At 03:16:40, a later analytics bucket reported `health_query=1`, `backlog_channels=0`, and `last_success_age_ms=3007.760648`, with no `health_errors`. This independently confirmed a healthy zero-backlog telemetry sample after the acceptance watch.

Only the cron container changed among the 17 checked containers, leaving the other 16 identities, images, and start times unchanged. Admin static publication did not restart nginx. The published bundle check passed all eight health states, filtering, and phase-total behavior at 320, 390, and 1280 px in both themes, with no axe findings or overflow; all API calls were mocked, so this is not an authenticated live-backend UI check. Task-owned test containers, networks, and the development preview were removed; live and rollback images, bundles, and receipts were retained, and the guarded Rust build cache remains available under its cap.

## Future work

Continue ordinary-load observation after the successful bounded acceptance watch; it is not a steady-state resource profile. The final controlled TypeScript / deployed Rust / release comparison is in `dima-rust/benchmarks/raid-analytics-2026-10-21.json`, while the shared-query experiment remains separately recorded and deferred. Any later query/index tuning or channel parallelism needs its own source-backed parity, recovery, and resource evidence. Do not infer that stream-activity benchmark results transfer to raid analytics.


## Current raid change-driven release

The accepted change-driven release `cron-2ddd455fdd1f` passed all four exact-image worker suites and the 124.802-second production watch; this is historical raid-feature evidence. The later five-worker release is `cron-7b8a6c88303d`; its rollback target is run `cron-2ddd455fdd1f`, image `sha256:050be8612ffa176e791c0ec16adeb0fde50b0e287d31ad02364c805fa9bdd783`. See [raid-change-driven.md](raid-change-driven.md) for the change-specific release record and [ai-usage-receipts.md](ai-usage-receipts.md) for the latest cron release.
