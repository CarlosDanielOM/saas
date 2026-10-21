# AI usage receipts Rust migration

**Status: accepted in production.** Candidate run `cron-7b8a6c88303d` with image `sha256:458d9186c5e48e684962bea9f85092d89b1e765cca3d283ebf819696ff50269c` was deployed at `2026-10-21T17:53:10.675491527Z`; the container started with zero restarts. All five exact-image worker suites passed before deployment, including the 18-group AI receipts suite. The 190.624-second production watch, scoped analytics readback, and task cleanup passed. The saved rollback target is run `cron-2ddd455fdd1f`, image `sha256:050be8612ffa176e791c0ec16adeb0fde50b0e287d31ad02364c805fa9bdd783`.

The port moves only the scheduled `ai-usage-receipts` consumer into the existing cron image. It does not add a service, collection, index, schema migration, or dependency. The candidate uses the existing MongoDB and Dragonfly clients and the baseline `mongo,redis` Cargo profile. Native default selection is intended for the production Node supervisor; `AI_USAGE_RECEIPTS_RUNTIME=typescript` remains the explicit TypeScript rollback selector through the separately reviewed configuration workflow. `tsx` continues to use the TypeScript worker by default. A failed native child is restarted by the existing supervisor and never silently falls back to TypeScript.

## Existing TypeScript contract

The source contract is implemented across:

- [`ai_usage_receipts.worker.ts`](../dimabot/src/workers/ai_usage_receipts.worker.ts): worker lifecycle, polling, queue operations, plan-tier cache, dashboard refresh cadence, queue health, and shutdown.
- [`ai_usage_queue_health.ts`](../dimabot/src/utils/ai_usage_queue_health.ts): Redis queue names and claim, acknowledge, retry, dead-letter, and health-monitoring operations.
- [`ai_usage_ledger.ts`](../dimabot/src/utils/ai_usage_ledger.ts): receipt validation, idempotent ledger writes, retention, and UTC daily aggregate repair under an account lock.
- [`ai_usage_lock.ts`](../dimabot/src/utils/ai_usage_lock.ts): global/account owner and heartbeat lock protocol.
- [`ai_usage_dashboard.ts`](../dimabot/src/utils/ai_usage_dashboard.ts): due dashboard refresh and usage pacing history.

The native worker parses the current producer's RFC3339/ISO timestamps and ISO date-only values. Compatibility with arbitrary free-form date strings accepted by JavaScript `Date` is not established. A read-only production contract probe on 2026-10-21 17:14:18.814 UTC inspected 47,924 receipt documents and found no non-enum categories or adjustment types and no nonnumeric credit values; it did not export receipt data. The native worker must preserve the queue key names and serialized payload contract; reclaim the processing list after an interrupted consumer; acknowledge only after receipt and aggregate persistence; retry ordinary failures and route exhausted/invalid jobs to the existing dead-letter queue; and increment the same generation key after successful completion. Receipt IDs remain idempotent across retries. MongoDB BSON values, timestamps, collection names, defaults, retention tiers, and daily aggregates must remain compatible with the existing Mongoose implementation. The 60-second channel plan cache and global and per-account lease semantics also remain part of the contract.

Dashboard maintenance refreshes at most 20 due dashboards. Requested report windows group usage by the configured IANA timezone; the pacing baseline includes only completed UTC days and excludes today's partial activity. The worker also maintains health snapshots and suppressible warnings for both the receipt and backfill queues. Polar calls/backfill, receipt creation by AI producers, and HTTP/API reads remain TypeScript and outside this worker migration.

Native batches process at most 1,000 queue events. Telemetry uses the existing generic worker instrumentation with prefix `ai_usage_receipts_rust` and batch event `batch_receipts`; the child emits bounded batch-only frames with no channel labels. A 20-second watchdog applies to one active receipt or one dashboard/health operation, not to a full queue batch. On a signal, the worker stops claiming new units and drains active work. If an active unit exceeds its watchdog, processing payloads and ownership TTLs remain available for retry and repair. An ordinary invalid or failed receipt is handled through existing retry/dead-letter behavior without an unnecessary child restart; worker/bootstrap/timeout failures remain eligible for supervisor recovery. The executable loads only explicitly selected `--env-file` paths and does not automatically load dotenv files.

## Candidate verification

The candidate behavior check is [`ai-usage-receipts-rust.mjs`](../ops/checks/ai-usage-receipts-rust.mjs). Its fixtures use disposable MongoDB databases matching `ai_usage_receipts_fixture_*` and a task-owned Redis dependency. The check starts the actual candidate supervisor and native child with production-default native selection, and restricts database writes and Redis keys to fixture resources. Use the exact `cron-<run-id>` returned by `scripts/saas-ops build cron`:

```bash
set -eu
AI_USAGE_RECEIPTS_FIXTURES=$(mktemp -d /tmp/ai-usage-receipts-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$AI_USAGE_RECEIPTS_FIXTURES"' EXIT
cp ops/checks/ai-usage-receipts-rust-fixtures/* "$AI_USAGE_RECEIPTS_FIXTURES/"
cp dima-analytics/src/store.mjs "$AI_USAGE_RECEIPTS_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/ai-usage-receipts-rust-fixtures/test-env.json \
  --fixtures "$AI_USAGE_RECEIPTS_FIXTURES" \
  --check ops/checks/ai-usage-receipts-rust.mjs
```

The focused check covers the Rust value parser and exact Mongoose compatibility, existing queue and lock behavior, aggregate/dashboard parity, pacing history and IANA timezone handling, both queue health states, telemetry, worker runtime selection and child environment/UID, bounded batch behavior, signal draining, timeout recovery, and ordinary item failures. It also verifies that the TypeScript receipt consumer does not run beside the native child. The existing Node and operations suites and executable supervisor-hook tests cover the shared integration path. All five native worker behavior checks must pass against the same exact candidate image before deployment.

The lead rerun passed TypeScript no-emit, 45 focused Node tests (41 migration tests and four telemetry tests), 67 operations tests, and five executable hook tests. A read-only production contract review confirmed the four usage collections' unique and TTL index contracts. The accepted candidate `cron-7b8a6c88303d` used the pinned Rust 1.99.1 toolchain and a 4 GiB memory/memory-swap cap, six CPUs, 256 PIDs, and two Cargo jobs. The capped Rust build took 253.152 seconds with a warm cache hit; the full build took 288.302 seconds wall time. Formatting, check, and Clippy passed for both profiles. The Mongo profile passed 44 library, four raid, four roulette, and five stream tests plus one doc test. The Mongo/Redis profile passed 78 library, two AI receipt, six baseline, four raid, four roulette, and five stream tests plus one doc test. All 28 frozen Rust and runtime source files matched the checkout before deployment.

All five exact-image behavior suites exited zero on image `sha256:458d9186c5e48e684962bea9f85092d89b1e765cca3d283ebf819696ff50269c`: AI receipts 18 groups (79.357 seconds), roulette 13 (48.433 seconds), stream six (135.327 seconds), change-driven raid 20 (129.218 seconds, including a 70,112 ms quiet-history observation), and follow-defense baseline 11 (114.420 seconds), 68 groups total. The initial isolated socket-reconnect fixture assumed the child would retain its PID; diagnostics instead showed it exited after failed lock acquisition while preserving the queued raw event. The corrected auxiliary-supervisor test passed one-child restart, raw-payload preservation, exactly one ledger/day/generation write, and unchanged sibling workers. This was a test correction only; no runtime code rebuild was needed. The natural 60-second plan-cache expiry was not waited out, and the 30-second account-lock heartbeat cannot occur within the 20-second active-unit watchdog window. These are the known test limits.

Earlier candidate `cron-3754dd6d8f2a` used the earlier raid source and was superseded before deployment; it has no accepted runtime evidence.

## Production acceptance

The 19-sample watch ran from `2026-10-21T17:53:25.739Z` to `2026-10-21T17:56:36.363Z` (190.624 seconds). All five native children remained at stable PIDs and start ticks as UID 65534; AI receipts was PID 95, with no TypeScript receipt child and one TypeScript backfill child. The receipt queue, processing list, and dead-letter list stayed empty; queue-health snapshots remained fresh with no failure reasons. Receipt count (47,924) and daily aggregate count (1,441) did not change, so the watch saw no natural receipt writes; fixture tests cover write and recovery behavior.

All nine live usage dashboards had `dirty=0` and fresh timestamps, from the oldest refresh at `17:55:51.991Z` through the newest at `17:56:12.135Z`; the detailed readback followed at `17:56:51Z`. The backfill queue drained naturally from 142 to zero, with no processing or dead-letter items at the end. Its monitor showed two cumulative failures and no active warning reasons; there were no new backfill failure log messages during this release. Stream checkpoints advanced 32,491→32,506 and 30,039→30,055 with no sampled active batches; raid errors remained zero.

Analytics recorded 200 idle samples each for `batch_receipts` and `project_batch`, 20 successful RSS and CPU samples, and no native error or restart groups for any of the five workers. The container comparison found only `dima-cron` changed; the other 16 production container IDs, images, start times, and restart counts were unchanged. Cleanup for `cron-7b8a6c88303d` succeeded with no task-owned containers or networks remaining; the source and Rust snapshots were removed while live and rollback images and receipts were retained. The sanitized evidence archive is `/root/.local/state/saas-ops/649a957c15888e53/cron-7b8a6c88303d/ai-usage-acceptance`.

AI RSS ranged from 7,831,552 to 7,876,608 bytes (mean 7,850,091.789 bytes) during this quiet watch; it is an unmatched idle observation, not a performance comparison. There were no natural production receipt writes during the watch, so fixture results establish the write and recovery paths without representing production load. No performance or resource improvement is claimed.

If a regression requires rollback, use `scripts/saas-ops rollback cron-7b8a6c88303d` to restore the prior image from `cron-2ddd455fdd1f`; image rollback does not change `AI_USAGE_RECEIPTS_RUNTIME`. Selecting TypeScript requires the separate reviewed configuration workflow.
