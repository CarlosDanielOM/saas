# Follow-defense baseline Rust migration

**Status as of 2026-10-21: deployed in cron run `cron-443184ebb89e`; same-candidate checks and the bounded production acceptance watch passed.** The prior image is preserved as the rollback image.

## Reused sources and contract

The baseline was already calculated by `dimabot/src/utils/follow_defense_baseline.ts` and consumed by `dimabot/src/utils/follow_defense.ts`. It reads the existing `follow_relationship_ledgers`, `streamsessions`, and `follow_attack_logs` collections represented by the Mongoose schemas. The Rust projector reuses those collections and the existing Dragonfly due queue and per-channel cache; it creates no collection or index. This migration moves the scheduled aggregation into a supervised native child while preserving the existing JSON and cache behavior. The route, getter, API, bot, and TypeScript calculation remain the consumer and explicit rollback paths.

The projector uses the preceding **30 complete UTC days**, ending at today's UTC midnight. It groups follows and eligible completed offline streams by UTC day, and excludes days containing an `attack` mode record from both sources. `averageDaily = max(total ledger follows, total stream follows) / max(1, 30 - excludedDays)`. `averageStream = total stream follows / eligible stream count`, or `0` when there are no eligible streams. `attackThreshold` is `ceil(max(500, 2 × averageDaily, 2 × averageStream))` only when at least seven sample days and three eligible streams exist; otherwise the JSON field is present as `null`. A successful refresh writes `follow:defense:baseline:<channelID>` with a seven-day TTL and reschedules that channel in `follow:defense:baseline:due` for one hour later. A failed query keeps a 60-second retry score and the previous cache. The existing getter requests a refresh for missing or stale data, deduplicated for 60 seconds, and returns `null` after two days of staleness so lost cache data cannot lower a large channel to the fixed threshold.

The TypeScript worker polls at one-second intervals and has a 30-second watchdog. The native child is selected by the existing cron supervisor; ordinary tick/query failures remain in that child and retry through the queue receipt, while a process failure is handled by the supervisor's normal same-worker restart. `FOLLOW_DEFENSE_BASELINE_RUNTIME=typescript` selects the TypeScript rollback implementation through the separately reviewed configuration workflow. Native mode passes MongoDB and Dragonfly connection settings plus basic runtime variables to a child running as UID/GID 65534 when launched by root. It does not run the TypeScript and Rust projectors together.

## Pre-change observation

At **2026-10-21 04:05:24 UTC**, the TypeScript worker had PID 53 and RSS 91,430,912 bytes. The analytics 15-minute window contained 90 samples, with mean RSS 90,773,048.89 bytes and mean CPU 0.0040892524 cores. The cache read found 29 valid entries, zero due channels, and eight entries with a null threshold. These are timestamped pre-change observations under ordinary production load, not a controlled comparison or benchmark. Do not infer a Rust resource reduction from them.

## Candidate build

Candidate `cron-443184ebb89e` built successfully with image digest `sha256:0b47480982664770a9a4a541b98ad4e746a50f38f2e55400c9124fa107d8afe8`. The cold sequential dual-profile Rust build took 1,019.773 seconds with a cache miss. The guarded cache eviction left 6,014,689,280 bytes under its 8 GiB limit. Both dependency profiles passed formatting, check, and Clippy; Mongo-only tests passed 21 unit tests and one doc test, and the `mongo,redis` profile passed 40 unit tests and one doc test. All three optimized binaries built and passed `--dry-run`, and the TypeScript cron image build passed. The helper's 27 focused Node tests, 57 operations tests, and real Docker helper smoke check also passed. The build matched all 22 Rust snapshot source files to the current checkout. Rust source digest: `9c4e32c4967d821404231817ade16f1bc5b35a2f79894f01ed2adcd8b294c6ad`. Binary SHA-256 values: baseline `4f5a83bad88ef0ec9daee71b40e1d4938a4aa5e36c4f57f471e294647561f306`, stream `bed26ad327085391fd773006ce0840f16d55e395ed2be080c8753d4bbd876561`, raid `c4199581b450384ebe33111021ad35ef376ff8843abd8b0e36c013fc81bd415d`. This build evidence does not establish candidate runtime behavior or production status.

## Candidate verification and rollout

The same-candidate focused `cron` behavior checks passed against disposable MongoDB and Dragonfly services: eight baseline behavior groups, 11 raid-analytics assertions, and five stream-activity assertions. The baseline fixture's first attempt was interrupted while cleaning up its reference Redis/telemetry connection; that attempt is not counted as acceptance evidence. The corrected check compares parity against the unchanged TypeScript refresh at the Rust calculation timestamp and covers daily/stream dominant cases, the 500 floor, sparse null thresholds, attack-day exclusions and UTC boundaries, seven-day cache TTL and one-hour scheduling, a 60-second retry with old-cache preservation, recovery, child UID/environment, restart isolation, telemetry, and graceful SIGTERM while the child is idle. The fixture does not exercise SIGTERM during an in-flight aggregate. The helper removed the task-owned verification resources after the accepted run. It copies the existing cron fixture hook and the exact analytics-store validator into a private fixture directory:

```bash
set -eu
BASELINE_FIXTURES=$(mktemp -d /tmp/follow-defense-baseline-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$BASELINE_FIXTURES"' EXIT
cp ops/checks/follow-defense-baseline-rust-fixtures/cron-boot.mjs "$BASELINE_FIXTURES/"
cp dima-analytics/src/store.mjs "$BASELINE_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/follow-defense-baseline-rust-fixtures/test-env.json \
  --fixtures "$BASELINE_FIXTURES" \
  --check ops/checks/follow-defense-baseline-rust.mjs
```

Candidate `cron-443184ebb89e` deployed successfully as image digest `sha256:0b47480982664770a9a4a541b98ad4e746a50f38f2e55400c9124fa107d8afe8`. The cron container started at `2026-10-21T04:30:59.841137155Z` with restart count zero. Its prior/rollback image digest is `sha256:9761707adb51d527674488bcce9f8a5a6277167c814e567013b0828d73678e39`.

The production acceptance watch ran from **04:31:16.009 to 04:35:19.193 UTC** across 24 samples. Native baseline PID 53 retained its start ticks and UID 65534; no TypeScript baseline child was present, and the cron process tree had 36 TypeScript workers and three Rust children. Baseline RSS averaged 6,619,136 bytes, ranging from 6,590,464 to 7,036,928 bytes (about 6.28 to 6.71 MiB). One natural baseline refresh completed at 04:35:16.800. At the final watch sample, 29 caches were valid, zero channels were due, and eight thresholds were null. Stream checkpoint advanced from 30,750 to 30,773 with zero active batches; raid errors remained zero. Only the cron container changed among 17 checked containers; the other 16 remained unchanged.

The cache readback at **04:36:03.552 UTC** confirmed a 604,753-second TTL and a next-refresh score 3,600,011 ms after `calculatedAt`, matching the seven-day cache lifetime and one-hour refresh schedule within elapsed-time precision. The analytics readback at **04:36:03.727 UTC** contained `follow_defense_baseline_rust` metrics: 300 `project_batch` observations with zero errors, 300 `batch_channels` observations summing to one, 30 RSS samples averaging 6,654,361.6 bytes, and 29 CPU samples averaging 0.00065507449 cores. No worker error or restart groups appeared. The generic admin metrics path handles this prefix; no admin bundle or frontend release was part of the deployment.

The native watch RSS mean (6,619,136 bytes) was lower than the pre-deploy TypeScript 15-minute mean (90,773,048.89 bytes), but the windows and workloads were unmatched. This is a short observed RSS difference, not a controlled comparison or proof of host-wide savings. The pre-deploy TypeScript CPU mean was 0.0040892524 cores; the unmatched Rust window does not support a CPU or throughput gain claim. The acceptance watch passed for the recorded interval; it is not a steady-state benchmark. `scripts/saas-ops cleanup cron-443184ebb89e` also succeeded, leaving no task-owned verification resources; the release receipt remains deployed, source snapshots were removed, and the live/prior images were retained.

A cron release replaces the cron container and its process tree once; it does not replace unrelated services. If deployed behavior regresses, use the newest cron run's rollback receipt. The runtime setting rollback is a separate configuration workflow.
