# Agent delivery commands

Use `scripts/saas-ops` from the repository root. Python 3, Docker Compose, Git, and Node/npm are already available on this host. There are no new Python dependencies.

**`scripts/dima-update` belongs to the human operator. Agents must not run or modify it.** Its manual workflow is separate from these commands.

## Select an explicit target

```bash
scripts/saas-ops list
scripts/saas-ops plan piper
```

No arguments prints help. `list` and `plan` do not change containers or files. Only the targets printed by `list` are accepted: `analytics`, `api`, `bot`, `cron`, `piper`, `embeddings`, `dimafx-server`, `dimadb`, `site`, `admin`, `docs`. There is no `all`, wildcard, free-form container name, automatic Git pull, stack shutdown, or prune command.

The script checks the container's Compose project, service, checkout, and configuration against the selected target. It talks only to the local Unix Docker socket, ignoring Docker/Compose environment overrides. It refuses configuration/environment drift rather than guessing which live configuration to replace. This workflow delivers code/assets; Compose, nginx, networking, credentials, and database migrations need a separately reviewed procedure.

## Analytics first install and releases

`dima-analytics` has a separate first-install procedure because it needs a dedicated PostgreSQL database/role and a read-only MongoDB monitoring account. Do not use `saas-ops deploy analytics` until the service has been installed once.

First, verify the project against disposable PostgreSQL and Dragonfly containers. The bootstrap builds the source and runs integration checks using only those disposable dependencies; verification does not read from or write to production services or data. It removes its temporary containers/network and records a private receipt:

```bash
python3 ops/bootstrap_analytics.py verify /root/saas/dima-analytics /path/to/analytics-receipt.json
```

After verification, install the exact image named in that receipt:

```bash
python3 ops/bootstrap_analytics.py install /path/to/analytics-receipt.json
```

The install command is intentionally first-install only. It refuses if a `dima-analytics` container already exists or if the analytics PostgreSQL role/database already exist during initial provisioning. It creates a mode-`0600` `dima-analytics/.env`, provisions only `observability_app` / `observability` in the existing PostgreSQL service, and creates the MongoDB `observability_monitor` account with `clusterMonitor` plus read access to the application database. It starts only the analytics Compose service with the verified image and applies the Compose configuration hash label expected by the standard `analytics` helper target. The script checks that `/root/databases/docker-compose.yaml` is unchanged before and after installation; it does not edit or redeploy the database Compose project. If a post-start readiness or image check fails, it removes only the new analytics container after confirming its image and Compose-project ownership; the generated `.env` and any database/MongoDB accounts remain for inspection. If provisioning stops partway through, inspect the receipt, `.env`, and created accounts before retrying; it deliberately does not roll back or rotate those credentials automatically.

For later analytics code releases, use the ordinary helper target and supply a behavior check that exercises the changed analytics behavior:

```bash
scripts/saas-ops list
scripts/saas-ops plan analytics
scripts/saas-ops build analytics
scripts/saas-ops verify analytics-<run-id> --check <analytics-behavior-check>
scripts/saas-ops deploy analytics-<run-id>
scripts/saas-ops cleanup analytics-<run-id>
```

The helper deploys the exact verified image and manages only the `analytics` service. Database/schema and Compose configuration changes remain separately reviewed operations.

## Container workflow

### Rust worker binaries in the cron target

```bash
scripts/saas-ops plan cron
scripts/saas-ops build cron
```

Use the exact `cron-<run-id>` printed by `build` for the later steps.

#### Scope behavior checks by worker impact

Fully verify every new or changed worker against the exact candidate image. Retest an existing worker only when its code, a relevant dependency, or shared runtime behavior changes with a concrete path to affecting that worker. A new Cargo optional feature, registry entry, or rebuilt shared image alone is not evidence of an existing-worker behavior change. Scope regression checks to the actual impact and explain the connection before expanding them; this is workflow guidance, not a user-approval gate. After replacing the cron container, check startup and health for all existing workers. Keep exact-candidate checks for changed behavior, deployment readiness and rollback safeguards, and all hard build limits described here and in [`dima-rust/AGENTS.md`](../dima-rust/AGENTS.md).

The compiler defaults to 6 GiB RAM and requires at least 14 GiB of host `MemAvailable` at startup, with a minimum 8 GiB kept available during compilation. If the host has at least 12 GiB but less than 14 GiB available at startup, select the supported lower cap explicitly with `scripts/saas-ops build cron --rust-memory-gib 4`; the 4 GiB cap also keeps memory-swap equal to the memory limit (no swap) and preserves the 8 GiB runtime headroom floor. Both choices retain the 6 CPU cap, two Cargo jobs, 256 PID limit, pinned compiler image, global build lock, and private 8 GiB Cargo cache. This option is only valid for `build cron`; other targets reject it. The helper option and its operations tests now verify the strict 4/6 choices, default 6 GiB, and cron-only restriction. On 2026-10-21, observed `MemAvailable` was about 13.8 GiB, below the default cap's 14 GiB startup requirement, so the combined candidate selected the explicit 4 GiB cap. Combined candidate `cron-240af282cb85` compiled at 4 GiB in 176.782 seconds with a warm cache hit; it did not establish a speedup against the earlier 6 GiB build.

`scripts/saas-ops build cron` snapshots `dima-rust` read-only and compiles the six prior worker binaries plus dashboard, which uses `--no-default-features --features mongo,redis,http-client,unicode-collation`. Earlier run `cron-a2475374437e` failed its dashboard check; `cron-3e611730d572` passed check/Clippy across all three profiles and its first two tests before the strict cache cap stopped dashboard test compilation. Both were cleaned without an accepted image. Candidate `cron-bf400acbc441` then completed its capped build and passed all twelve same-image suites before deployment. It is accepted with seven native children in the existing cron service. The full five-minute production watch passed (32 samples, 332.216 seconds), as did final readbacks and helper cleanup. Current image is `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30`, deployed at `2026-10-21T22:53:29.834585977Z`. Rollback `scripts/saas-ops rollback cron-bf400acbc441` restores accepted run `cron-9ff771d91cda` (image `sha256:2a009af0d0fabef6bd2103ef04596ed6451a1ce360c73b32c9146f8ce3878102`) with six Rust workers and the prior TypeScript dashboard worker; the new image has no TypeScript fallback. See [worker backlog evidence](../migration-notes/worker-backlog-scheduling.md) and [dashboard migration record](../migration-notes/dashboard-activity.md). Dashboard alone adds reqwest 0.12.28 and ICU collation; the two pre-existing worker profile graphs for six binaries remain unchanged. The validated Rust 1.99.1 Alpine/musl pin and compiler caps/headroom policy are unchanged.

The 2026-10-21 helper verification passed all 59 operations unit tests and the real Docker smoke check. An isolated no-op container created through the actual Rust compiler argument builder verified Docker limits of 6 CPUs, 6,442,450,944 bytes for both memory and memory-swap, and 256 PIDs; its kernel cgroups reported `cpu.max=600000 100000`, `memory.max=6442450944`, `memory.swap.max=0`, and `pids.max=256`. The probe used two Cargo jobs and a read-only source snapshot, with no network or production credentials. The container was removed, and all 17 production containers remained unchanged. That helper probe did not compile Rust; subsequent compiler evidence is recorded below.

The lower-memory option update passed all 66 operations tests. The new tests verify the default 6 GiB choice, accepted explicit values 4 and 6, rejection on non-cron targets, recording the selected cap in the run receipt, and resource/headroom guards. A capped format-only container confirmed the helper applied 4 GiB memory and memory-swap limits with the existing CPU, PID, and Cargo-job settings, and formatting passed for the two changed stream Rust files. This was helper/format verification; the completed compiler result is recorded below.

Combined candidate `cron-240af282cb85` passed Rust compilation using the 6 CPU/4 GiB/no-swap/256-PID limits and two Cargo jobs. Cgroups reported `cpu.max=600000 100000`, `memory.max=4294967296`, `memory.swap.max=0`, and `pids.max=256`. Rust build time was 176.782 seconds with a warm cache hit for `7d05fe536973…`. The OCI image digest is `sha256:9208e3d8e0a12b47ae793598fb1dac53e7f70cab0ab4c338097e3fbc5981f0ac`. `MemAvailable` samples were 13.6 GiB at startup and 13.2 GiB minimum observed; a single Docker stats sample showed 177.62% CPU and 227.5 MiB memory. These samples do not establish peak use. Formatting, checks, Clippy, tests, and all three release binaries passed for both feature profiles. The `mongo` profile passed 18 library, four raid, and five stream unit tests plus one doc test; the `mongo,redis` profile passed 39 library, six baseline, four raid, and five stream unit tests plus one doc test. Binary SHA-256 values: stream `90ec50122a150777eeb653add24582bb5aed0feadaed8f2c445b0a3113ca3ae3`, raid `dd57789e9305a9e5c5642f830d5b0d74e066b835cb79a83f95524de22f78a1fe`, baseline `2cab7f440f304558e208d24eecfeda4908ee1217039d8183ad085b72fcb5017d`. The 19 focused Node tests and 66 operations tests passed. The same candidate passed all three worker runtime suites and was deployed; bounded production acceptance evidence is recorded below. This compiler result alone does not establish runtime acceptance.

Cargo registry and target artifacts live in the private persistent directory `~/.local/state/saas-ops-rust-cache/v1`, outside the checkout. Entries are keyed by immutable toolchain image, Cargo manifest and lockfile, build recipe, feature set, profiles, and relevant Cargo build environment. For dashboard builds, `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0`, and `CARGO_INCREMENTAL=0` are explicit recipe inputs recorded in the cache identity, plan, and receipt. Cache key is `aeafe0c7aeeb3233e3dee9cf0232759f45eeb945356bff515cb16ad4c4fd7a0d`. These settings constrain dev/test artifacts only; release optimization is unchanged. The helper validates directory ownership markers, refuses symlinked paths, and caps the dedicated cache at 8 GiB. Candidate `cron-bf400acbc441` built in 1479.073 seconds at the 4 GiB/6 CPU/two-job/256-PID/no-swap limits; the cache ended at 3,594,080,256 bytes. Formatting, tree check, check, Clippy, tests, release build, and seven dry runs passed across all three profiles. Earlier candidate/cache failure details remain in the migration note. Receipts include cache key/hit, cache sizes, build duration, selected features/environment, dependency-graph digests, and binary digests. These describe compile work, not runtime RAM or CPU. The Mongo-only feature-matrix audit verified the earlier 4 CPU/4 GiB cap and two Cargo jobs; a sample used about two CPUs and 314 MiB. This is historical evidence and does not validate the newly authorized 6 CPU/6 GiB ceiling.

The accepted historical two-binary Mongo-only build comparison used identical Rust source, manifests, lockfile, recipe, and feature set. Cold run `cron-ea84c986d7f0` took 649.777 seconds of Rust build time with a cache miss. Warm run `cron-b24a505b7fc8` took 102.007 seconds; the helper explicitly cleared project release artifacts, rebuilt the two optimized worker binaries present in that release at optimization level 3, and reused dependency artifacts. The warm Cargo log showed only `dima-rust` being checked/compiled, not dependencies. Check, Clippy, unit-test compile, and release portions were 2.19 s, 2.13 s, 27.31 s, and 64 s warm, compared with 105 s, 1.98 s, 151 s, and 381 s cold. The warm receipt recorded `cache.project_release_clean=true`. This measures that historical build path, not the current four-binary build or runtime performance. A prior warm attempt was rejected as evidence after it revealed that Cargo's package clean removed development artifacts but could leave release worker binaries; that superseded 37.277-second result is not an accepted warm measurement.

The accepted warm candidate is `cron-b24a505b7fc8`: image digest `sha256:78912284ca1a4178e0062007a922f0be70bcf0ecb5ea09c5ab12c9e25d95ad56`, Rust source digest `97fc6387f9090bdceb7fba27c5eff163fc62709dce9ba98cdbc9a16e466a269e`, stream binary SHA-256 `3c7310e99b8d0bbf90328401f064807cc863afa5ef21a189c4e44172e19bc703`, and raid binary SHA-256 `08b562c3350fd104f8b49a80b27d59f9f50ea2cb4ac1178d2fcd6c6fcab7b8e9`. Its cache entry key is `81f8698b6c9283255500b6fd0d039852dbdbcc006767540cf08d924c027ff125`; the worker dependency graph digest is `b0ca9ebda109dbabf12f88ffad26195bf2342159ee22a588fef81b557edcc17f`. The accepted release-clean hygiene step has digest `b263c182497db8e0b4087833cf28ecf9d172e4b1eb2f79b29988b14070b606bf`. The dedicated cache was 7.328 GB total (about 6.8 GiB), including an older matrix-audit key, under its 8 GiB cap; the active entry was 3.639 GB (about 3.4 GiB).

The optional dependencies remain available for shared/manual consumers through Cargo defaults: `mongo`, `redis`, `postgres`, and `http`. `postgres` enables SQLx/PostgreSQL, `http` enables Axum, and `redis` enables the Dragonfly-compatible client; the MongoDB feature includes explicit dotenv loading support. Telemetry remains in the TypeScript cron host: native children emit bounded stdout metadata, and Node samples and exports worker/process metrics through the existing Dragonfly and analytics path. The Mongo-only Rust workers do not need Redis or SQLx. PostgreSQL support is dependency readiness for a future telemetry port; telemetry itself has not moved to Rust. Run `scripts/saas-ops build cron --rust-feature-matrix` only for an explicit transition audit of no-feature, Redis-only, Postgres-only, HTTP-only, and all-feature graphs plus the Redis TLS-provider regression check. Matrix run `cron-a119f0761077` passed all five feature checks and the Redis-only TLS-provider check; Mongo-only tests passed 18 unit tests and one doc test, and the selected worker graph excluded SQLx, Axum, and Redis. The audit's 934.539-second total included the matrix and the then-included manual fixture example, so it is not a normal cold/warm build comparison. This matrix remains separate from ordinary cron builds and uses a separate disposable target directory.

For stream-activity candidate verification, the behavior check runs the actual cron supervisor and native child against disposable MongoDB and Dragonfly containers. It checks worker selection, Rust/TypeScript parity and checkpoint recovery, telemetry, per-child restart behavior, and signal shutdown. Its source fixtures are copied into a private temporary directory so the test uses the existing source fixture module and analytics validator without duplicating those sources in `ops/`. The check's dummy environment selects native Rust explicitly. Use this invocation against the exact candidate run; its fixture-copy steps keep the test source-backed without checking in duplicate fixture sources:

```bash
set -eu
STREAM_ACTIVITY_FIXTURES=$(mktemp -d /tmp/stream-activity-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$STREAM_ACTIVITY_FIXTURES"' EXIT
cp ops/checks/stream-activity-rust-fixtures/cron-boot.mjs "$STREAM_ACTIVITY_FIXTURES/"
cp dima-rust/tests/fixtures/stream_activity.mjs "$STREAM_ACTIVITY_FIXTURES/activity.mjs"
cp dima-analytics/src/store.mjs "$STREAM_ACTIVITY_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/stream-activity-rust-fixtures/test-env.json \
  --fixtures "$STREAM_ACTIVITY_FIXTURES" \
  --check ops/checks/stream-activity-rust.mjs
```

After a candidate check passes, deploy and clean up that same run:

```bash
scripts/saas-ops deploy cron-<run-id>
scripts/saas-ops cleanup cron-<run-id>
```

The original raid port check is retained as historical evidence in `ops/checks/raid-analytics-rust.mjs`. For the current raid behavior check and all future cron candidates, use [`ops/checks/raid-analytics-change-driven.mjs`](checks/raid-analytics-change-driven.mjs), with the same isolated MongoDB/Dragonfly setup and fixture directory below. It adds change detection, unchanged refresh preservation, late-follow repair, persisted deadlines, queue duplicates, cache adoption, and bounded follow repair. Use the [current raid release record](../migration-notes/raid-change-driven.md) for accepted candidate coverage. Stage the existing fixture hook and validator as shown, then invoke the current check:

```bash
set -eu
RAID_FIXTURES=$(mktemp -d /tmp/raid-analytics-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$RAID_FIXTURES"' EXIT
cp ops/checks/raid-analytics-rust-fixtures/cron-boot.mjs "$RAID_FIXTURES/"
cp dima-analytics/src/store.mjs "$RAID_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/raid-analytics-rust-fixtures/test-env.json \
  --fixtures "$RAID_FIXTURES" \
  --check ops/checks/raid-analytics-change-driven.mjs
```

The fixture check restricts database names to `raid_analytics_fixture_*` and removes only databases it creates. It covers schema/default/index compatibility, idempotent history writes, due summary refresh and dedupe, lease ownership/loss/retry, bounded follow queries, telemetry, child UID/environment, restart behavior, and shutdown. Once candidate verification passes, deploy only the same cron run, verify native raid telemetry and summary refreshes in production, then clean up. Replacing the cron container restarts all of its child processes once; this preserves worker definitions and failure isolation, not unrelated worker PIDs. A cron-only deployment leaves other Compose service/container identities alone.

### Follow-defense baseline Rust worker

The follow-defense baseline projector reuses the TypeScript contract and existing ledger, stream-session, attack-log, Dragonfly queue, and cache schemas. Its migration record is [`migration-notes/follow-defense-baseline.md`](../migration-notes/follow-defense-baseline.md). Candidate verification runs the actual cron supervisor and native child against disposable MongoDB and Dragonfly services. It compares every persisted JSON field with the unchanged TypeScript refresh and covers complete UTC-day boundaries, attack-day exclusions, threshold floor and sparse-history nulls, cache TTL, next-hour success receipt, failure retry and old-cache preservation, recovery, child isolation/UID, restart, telemetry, and graceful SIGTERM while the child is idle. The fixture does not exercise SIGTERM during an in-flight aggregate. The scheduler and telemetry extension is covered by the deployed combined candidate: its checks exercised the 30-second Redis-only health probe and two-second timeout, unknown/error health states, monotonic last-success age, 1/2/4/5-second idle backoff, eight-success burst and cooldown, three concurrent MongoDB phase timings including failures and omitted cancelled work, and admin process-health/phase rendering without inflating job totals. The MongoDB phase durations overlap by design. Copy the cron hook and the exact analytics-store validator to a private fixtures directory:

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

The historical dashboard release `cron-bf400acbc441` passed nine exact-image suites (150 PASS groups) plus three candidate-specific supplemental legacy cron checks (four reported PASS groups). These historical results do not establish a standing suite count. For future releases, follow [Scope behavior checks by worker impact](#scope-behavior-checks-by-worker-impact): fully verify new or changed workers, run existing-worker behavior suites where code/dependency/shared-runtime impact is concrete, and check startup and health for all existing workers after cron replacement. Do not substitute the historical `raid-analytics-rust.mjs` check for the current raid check. See [`migration-notes/dashboard-activity.md`](../migration-notes/dashboard-activity.md). When a baseline scheduler/telemetry change is included, run its focused check and verify the admin bundle if its UI changed.

### Dashboard activity Rust worker (accepted production release)

The dashboard worker reuses the current source collections, API queue producers/readers, and shared TypeScript helper contracts; it adds no production service or Mongo schema/index. Candidate `cron-bf400acbc441` built and passed its exact-image fixture check plus all eight other then-run standard checks and three candidate-specific supplemental legacy checks, then deployed to the existing cron service at `2026-10-21T22:53:29.834585977Z`. All twelve same-image suites passed (nine suites totaling 150 groups plus three supplements totaling four reported groups). The 32-sample, 332.216-second production watch, final readbacks and comparisons, and helper cleanup passed. Seven native children are accepted on image `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30`. Rollback with `scripts/saas-ops rollback cron-bf400acbc441` restores `cron-9ff771d91cda`, the six-worker image with its prior TypeScript dashboard worker. The new image has no TypeScript fallback. This is historical candidate acceptance evidence, not a future suite-count requirement. To reproduce the isolated MongoDB/Dragonfly fixture check for a future candidate, use:

```bash
set -eu
DASHBOARD_RUST_FIXTURES=$(mktemp -d /tmp/dashboard-activity-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$DASHBOARD_RUST_FIXTURES"' EXIT
cp ops/checks/dashboard-activity-rust-fixtures/*.mjs "$DASHBOARD_RUST_FIXTURES/"
cp ops/checks/dashboard-activity-rust-fixtures/*.pem "$DASHBOARD_RUST_FIXTURES/"
cp dima-analytics/src/store.mjs "$DASHBOARD_RUST_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/dashboard-activity-rust-fixtures/test-env.json \
  --fixtures "$DASHBOARD_RUST_FIXTURES" \
  --check ops/checks/dashboard-activity-rust.mjs
```

The full fixture design, assertions, and limits are in [`ops/checks/dashboard-activity-rust-fixtures/README.md`](checks/dashboard-activity-rust-fixtures/README.md). Seven TLS-provider fixture host tests passed, including the strict TypeScript/native threshold regression. Dashboard suite `cron-bf400acbc441` passed all 36 groups after fixture-only corrections to separate the CA root from its non-CA server leaf and to construct the exact binary 80% eligibility boundary; no image change was needed. All twelve same-image suites passed before deployment. The production watch, final readbacks/container comparison, and cleanup all passed. Persistent evidence is under `/root/.local/state/saas-ops/649a957c15888e53/cron-bf400acbc441/dashboard-activity-acceptance`; see [`migration-notes/dashboard-activity.md`](../migration-notes/dashboard-activity.md).

### Roulette completion Rust worker

The roulette completion child moves due-draw settlement to native Rust while retaining the existing `roulette_channels` collection, document shape, numeric times, and TypeScript API/bot revision compare-and-set contract. The `roulette-actions` TypeScript child remains responsible for winner-action AST execution. This adds no collection, index, schema migration, or admin telemetry surface; native progress uses the existing `roulette_completion_rust` metric family. Source scope, fixtures, check coverage, status, and evidence limits are recorded in [`migration-notes/roulette-completion.md`](../migration-notes/roulette-completion.md).

Run the focused roulette behavior check on the exact cron candidate. The check's fixture hook and test environment live in the repository; stage the hook plus the exact analytics validator into a private fixture directory:

```bash
set -eu
ROULETTE_FIXTURES=$(mktemp -d /tmp/roulette-completion-rust-fixtures.XXXXXX)
trap 'rm -rf -- "$ROULETTE_FIXTURES"' EXIT
cp ops/checks/roulette-completion-rust-fixtures/cron-boot.mjs "$ROULETTE_FIXTURES/"
cp dima-analytics/src/store.mjs "$ROULETTE_FIXTURES/analytics-store.mjs"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/roulette-completion-rust-fixtures/test-env.json \
  --fixtures "$ROULETTE_FIXTURES" \
  --check ops/checks/roulette-completion-rust.mjs
```

This runs the candidate supervisor and native binary against disposable MongoDB and Dragonfly dependencies. Coverage includes parity for `keep`, `remove-copy`, and `remove-item`; fresh-clock revision retries and safe coexistence with API/bot snapshots; 100-entry history; visibility and auto-hide deadlines; idle/blocked one-second polling, immediate continuation while fresh due rows remain, and the 100-document bound; the separate action child; telemetry counts for successful CAS transitions with concurrent no-ops excluded; raw BSON type parity; native environment/UID; database write rejection with no partial completion; a forced API winner and deterministic stale-CAS race; roulette-only SIGKILL recovery; SIGTERM during a held Mongo CAS; and the 20-second pass watchdog, below the supervisor's 25-second shutdown grace. Candidate `cron-bf400acbc441` passed its dashboard suite and the other eight then-run standard suites (150 groups total), plus three candidate-specific supplemental legacy cron checks (four groups total). The 32-sample production watch, final readbacks/container comparison, and cleanup all passed. These are historical candidate results, not a standing suite count; future checks follow [Scope behavior checks by worker impact](#scope-behavior-checks-by-worker-impact). The coordinated email-template check was specific to release `cron-9ff771d91cda`. The former `ROULETTE_COMPLETION_RUNTIME=typescript` selector is retired and does not select archived source; rollback uses `scripts/saas-ops rollback cron-bf400acbc441` to restore `cron-9ff771d91cda`.

Feature-acceptance run `cron-99f8d5165ff2` deployed and passed exact-image suites for stream, raid, follow-defense baseline, and roulette. Run `cron-2ddd455fdd1f` then accepted raid's change-driven refresh update. The subsequent run `cron-7b8a6c88303d`, image `sha256:458d9186c5e48e684962bea9f85092d89b1e765cca3d283ebf819696ff50269c`, deployed all five native workers after their exact-image checks passed. Its 190.624-second production watch, analytics readbacks, and cleanup passed; only `dima-cron` changed. Its saved helper rollback target was run `cron-2ddd455fdd1f`, image `sha256:050be8612ffa176e791c0ec16adeb0fde50b0e287d31ad02364c805fa9bdd783`. See the [AI receipts record](../migration-notes/ai-usage-receipts.md), [roulette acceptance record](../migration-notes/roulette-completion.md), and [current raid record](../migration-notes/raid-change-driven.md) for release details; no performance claim is supported by the observed samples.

### AI usage receipts Rust worker

The Rust `ai-usage-receipts` child entered production in accepted run `cron-9ff771d91cda`; its exact-image check, production acceptance, and cleanup passed. The release removed the extra post-batch wait while preserving configured idle/error/lease polling, queue retry/dead-letter policy, bounded work, account/global lease handling, dashboard maintenance, watchdogs, and shutdown behavior. Receipt producers, Polar API calls and backfill, and API reads stay in TypeScript. The worker reuses the existing MongoDB ledger/dashboard collections and Redis/Dragonfly receipt queues, processing list, dead-letter queue, global lease, account locks, and dashboard generation keys; it adds no collection, index, dependency, or service. The feature uses the existing `mongo,redis` baseline profile. Full contract and release evidence are in [`migration-notes/worker-backlog-scheduling.md`](../migration-notes/worker-backlog-scheduling.md); the earlier acceptance record remains historical in [`migration-notes/ai-usage-receipts.md`](../migration-notes/ai-usage-receipts.md).

Run the focused check against the exact cron candidate. It stages the source-backed cron fixture and the exact analytics store validator into a private fixture directory:

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

The disposable check exercises the actual supervisor and native binary with the native production default, restricted to fixture databases and a private Redis service. It covers receipt parsing and retention, plan caching, global and per-account lock ownership/heartbeats, crash reclaim, queue claim/ack/retry/dead-letter and generation updates, idempotent Mongo upserts and aggregate repair, BSON/timestamp compatibility with Mongoose, dashboard refresh, IANA-timezone grouping for requested report windows, completed-UTC pacing history, health snapshots/warnings for both usage queues, and telemetry. It also exercises disabled/once/dry-run/CLI behavior, native child selection and environment/UID, signal draining, the per-job/dashboard/health 20-second watchdog, ordinary job failures without unnecessary process restart, and timeout recovery with retained processing payloads and lock TTLs. The watchdog applies per active job or maintenance operation; it must not interrupt a legitimate batch of up to 1,000 jobs. Immediate continuation requires a clean successful full batch, enabled configuration, no stop or lost heartbeat, and fenced global-lease release success; partial or unsuccessful nonfatal outcomes and unavailable/lost leases retain the configured poll interval. Fatal storage/watchdog errors still exit for supervisor recovery. The AI native candidate passed its 23-group exact-image suite on `cron-9ff771d91cda`; future suite selection follows [Scope behavior checks by worker impact](#scope-behavior-checks-by-worker-impact). See [the scheduling release record](../migration-notes/worker-backlog-scheduling.md).

Baseline-only candidate `cron-d33c17d71dd8` built under the 6 CPU/6 GiB/no-swap/256-PID compiler limits with `CARGO_BUILD_JOBS=2`. The capped sequential Rust build took 186.583 seconds with a cache hit for key `7d05fe536973…`; cache size moved from 6,014,689,280 to 6,038,589,440 bytes. Formatting, check, Clippy, tests, and release-binary dry runs passed for both profiles. Its OCI image digest is `sha256:ad59fc1c70d5456aa738c9fe43c603bbdf3f27069b9a6fb2af98c79192fb2c8b`, and the baseline binary digest is `4d181da9b6efbb050e9d843fea9dbd53fb3872888bd5c295c1c8659f833100d2`. Host `MemAvailable` samples ranged from 14.1 GiB at start to 12.1 GiB minimum observed; these are samples, not peak-memory measurements. One Docker CPU/memory stats sample read 201.70% CPU and 1.225 GiB memory. This was the first compile under the new ceiling, so no controlled comparison or faster-build claim is supported. Its baseline check passed all 11 PASS groups, including exact cache parity and a 24-due-channel synthetic burst in 3,971 ms. Those `burst-*` fixture channels had no matching Mongo history, so this is not representative of full production load or a throughput benchmark. It was never deployed and was cleaned up after stream-health was added to the requested scope; the combined candidate is recorded above. See [`migration-notes/follow-defense-baseline.md`](../migration-notes/follow-defense-baseline.md) and [`dima-rust/STREAM_ACTIVITY.md`](../dima-rust/STREAM_ACTIVITY.md#stream-health-telemetry).

Candidate build `cron-443184ebb89e` passed with image digest `sha256:0b47480982664770a9a4a541b98ad4e746a50f38f2e55400c9124fa107d8afe8`. Its cold sequential dual-profile Rust build took 1,019.773 seconds with a cache miss; guarded eviction left 6,014,689,280 bytes under the 8 GiB cache limit. Formatting, check, and Clippy passed for both profiles; the Mongo-only profile passed 21 unit tests and one doc test, and the `mongo,redis` profile passed 40 unit tests and one doc test. All three optimized binaries passed dry-run, the TypeScript cron image built, 27 focused Node tests and 57 operations tests passed, and the real Docker helper smoke check passed. Same-candidate disposable runtime checks passed all eight baseline groups, 11 raid assertions, and five stream assertions. The baseline fixture's first attempt was interrupted during reference Redis/telemetry connection cleanup; the corrected run passed and is the accepted result. The helper cleaned up the task-owned verification resources.

The exact candidate image was deployed. The cron container started at `2026-10-21T04:30:59.841137155Z` with restart count zero. The bounded production acceptance watch passed from 04:31:16.009 to 04:35:19.193 UTC across 24 samples. Native baseline PID 53 stayed at UID 65534 with stable start ticks; no TypeScript baseline child was present, and the process tree had 36 TypeScript workers and three Rust children. RSS averaged 6,619,136 bytes (min 6,590,464; max 7,036,928). One natural refresh completed at 04:35:16.800; the final cache read found 29 valid entries, zero due channels, and eight null thresholds. Stream checkpoint advanced 30,750→30,773 with zero active batches; raid errors remained zero. Only cron changed among 17 containers. The 04:36:03 cache readback confirmed a 604,753-second TTL and a next-refresh delay of 3,600,011 ms. Analytics confirmed baseline batch/RSS/CPU metrics with no error or restart groups. The pre-deploy TypeScript RSS and CPU window is unmatched; this is a short observed RSS difference, with no CPU or throughput gain claim. The prior/rollback image digest is `sha256:9761707adb51d527674488bcce9f8a5a6277167c814e567013b0828d73678e39`. The generic admin metrics path handles `follow_defense_baseline_rust`; this deployment did not include an admin bundle. Cleanup for `cron-443184ebb89e` succeeded with no task-owned resources remaining; its receipt remains deployed, temporary source snapshots were removed, and live/prior images were retained. A cron release restarts its process tree once and leaves other Compose services untouched. `FOLLOW_DEFENSE_BASELINE_RUNTIME=typescript` was a historical separately reviewed configuration rollback selector; it is retired and does not select archived source. See [`migration-notes/follow-defense-baseline.md`](../migration-notes/follow-defense-baseline.md) for the watch record.

Historical final raid phase/health release `cron-23e91b98cf64` used image digest `sha256:9761707adb51d527674488bcce9f8a5a6277167c814e567013b0828d73678e39`. It retained the original four aggregation queries per channel (7-day summary and reciprocity, then 30-day summary and reciprocity) and emitted timings for claim, follow queries/writes, both periods, reciprocity, publish, and release. With this sequence, `reciprocityMs` sums the two attempted query durations. The supervisor attached the enclosing batch outcome to each reached phase; the admin page excludes phase rows from job/failure totals. Backlog probes ran every 30 seconds between batches. Probe errors did not fail projection or emit fabricated zero gauges; the admin Observability → Servers → Our processes view kept missing or stale readings unknown and marked readings stale after 90 seconds. It shows latest 10-second analytics buckets, which may aggregate multiple samples. These changes reused the current metrics/analytics ingestion path and required no analytics service schema change. The bounded production acceptance watch passed. This remains historical evidence from its release; later combined releases were `cron-99f8d5165ff2`, `cron-2ddd455fdd1f`, and the historical five-worker run `cron-7b8a6c88303d`. See [the scheduling release record](../migration-notes/worker-backlog-scheduling.md) for the current image and rollback pointer.

The capped Rust build for `cron-23e91b98cf64` took 101.849 seconds with cached dependencies and both release binaries rebuilt under the pinned Rust 1.99.1 image. It passed 21 unit tests and one doc test; the native metrics parser's 11 tests and the `ops` suite's 56 tests passed. The raid behavior check passed all 11 assertions, including a 16-channel fixture drain in 1.111 seconds; the stream behavior check passed all five assertions; and the benchmark passed 27 strict parity runs. The production watch ran from 03:14:05.377 UTC through 03:15:45.719 UTC (about 100.34 seconds). At the end, both native child PIDs were stable at UID 65534, the cron container restart count was zero, all 75 summaries were current with zero due/errors, and the stream sequence reached 30005 with no active batches. All eight phase metrics and successful health samples reached the existing analytics database; no native error/restart groups appeared. The last watch health snapshot reported 44 due at 03:15:10, while the direct summary query at 03:15:45 showed zero; a separate 03:16:40 health bucket then reported success and zero backlog. The admin served-bundle check passed with mocked APIs across three widths and both themes. Only cron changed among 17 containers; static admin publication required no frontend container restart. Task-owned test containers, networks, and preview resources were cleaned up; verified live/prior rollback images and receipts remain preserved.

The proposed shared reciprocity query is deferred. Two full parity trials recorded 54 successful runs in [raid-analytics-query-experiment-2026-10-21.json](../dima-rust/benchmarks/raid-analytics-query-experiment-2026-10-21.json). Combined six-repetition medians showed whole-process CPU per channel changing −3.77% on quiet fixtures, +1.32% on moderate, and +4.82% on dense; busy-workload CPU did not consistently improve, and trial directions varied. The experimental candidate included instrumentation, so these results cannot isolate the query change. Two interrupted benchmark attempts exhausted file descriptors in disposable MongoDB after repeated database/index creation; accepted runs reused two fixture databases and index sets, reseeding outside timed runs. No production limits or settings changed. The shared-query build `cron-bade84f34ce6` was never deployed and has been cleaned up.

The admin bundle `admin-33b3f62b305d` passed isolated health-state, deduplication, and filter checks at 320, 390, and 1280 px in both themes, with no axe findings or horizontal overflow, then was deployed as the exact verified bundle. The visible tab label is **Servers**; `resources` is the internal route/state name. The final Rust comparison is recorded in [raid-analytics-2026-10-21.json](../dima-rust/benchmarks/raid-analytics-2026-10-21.json): 27 strict-parity runs across TypeScript, the previous Rust worker, and the release candidate. Those short fixtures do not support a general runtime improvement claim; the phase/health instrumentation is included and ordinary production observation remains necessary.

Because the cron image also contains the already-deployed stream child, rerun the stream-activity behavior check against this same candidate run before deployment. A raid-only fixture pass does not cover stream checkpoint/recovery behavior after a shared cron image change.

The latest accepted production cron run before TypeScript worker-entrypoint retirement is `cron-7b8a6c88303d`, image `sha256:458d9186c5e48e684962bea9f85092d89b1e765cca3d283ebf819696ff50269c`; its helper rollback restores run `cron-2ddd455fdd1f`, image `sha256:050be8612ffa176e791c0ec16adeb0fde50b0e287d31ad02364c805fa9bdd783`, which contains the previously accepted four native workers and the accepted change-driven raid refresh. Its historical rollback command was `scripts/saas-ops rollback cron-7b8a6c88303d`. Rollback is tied to the newest cron release receipt, so that older command cannot be used after this retirement deployment. The former `*_RUNTIME=typescript` keys for the five scheduled workers are retired and no longer select TypeScript. Candidate verification, release, historical evidence, and the manual restoration boundary are documented in [the TypeScript worker retirement record](../migration-notes/typescript-worker-retirement.md). The code-only cron helper rejects configuration drift and does not silently change environment configuration.

Retirement release `cron-d02bf5a387d5` with image `sha256:b1e5f225d2488e76b455837bbc562ba646b2a69d3ac9d7f6a9316cf02798239b` was deployed and accepted after all six exact-image checks (74 groups), the 190.459-second production watch, analytics readbacks, container comparison, and helper cleanup passed. Only `dima-cron` changed; the other 16 checked containers retained their identities. At that release, `scripts/saas-ops rollback cron-d02bf5a387d5` restored `cron-7b8a6c88303d` (image `sha256:458d9186c5e48e684962bea9f85092d89b1e765cca3d283ebf819696ff50269c`). Full evidence and queue/error caveats are recorded in [the retirement record](../migration-notes/typescript-worker-retirement.md).

### Raid sessions Rust worker

The native `raid_sessions` child owns bounded retention extension, journal backfill and late-follower attribution, and moderation-request admission. It reuses the existing MongoDB collections and Redis follow-defense state. TypeScript session producers, APIs and shared raid utilities remain active; `follow-defense-actions` continues to execute Twitch bans. No HTTP provider, new index/schema/configuration key, or production service is added. No `RAID_SESSIONS_RUNTIME` selector existed in the TypeScript worker; do not document a hypothetical fixture key as a retired selector.

Verify the native Rust path with [`ops/checks/raid-sessions-rust.mjs`](checks/raid-sessions-rust.mjs) and the existing end-to-end [`ops/checks/raid-sessions.mjs`](checks/raid-sessions.mjs) against the same exact cron candidate. The native suite defines 20 runtime groups against disposable MongoDB and Redis fixtures, including more than 200 skipped raw journal rows, 100+100 partial batches, future-only waits, and an error after an earlier full batch; all 20 passed on candidate `cron-7a8ca7924412` in 79.712 seconds. The end-to-end check passed eight groups on the same image. It runs its `SAAS_TARGET=cron` branch for TypeScript producers/shared raid utilities, action-executor handoff, and native admission. Its HTTP API and bot-specific branches do not run in this task, so this candidate does not claim HTTP route runtime coverage or API/bot deployment. The native executable bounds each backfill/admission batch at 200 and applies a hard 20-second initialization/tick watchdog ahead of the 60-second request lease. It continues immediately when a backfill or admission batch is full at 200 or other ready work remains; it waits one second only when idle, future-only, or after a failed tick. This changes the archived TypeScript loop's unconditional post-tick pause while preserving bounded work, fairness, request deadlines, and the existing TypeScript action-executor pacing. Ordinary tick failures emit unsuccessful bounded batch telemetry and retry after one second; the hard OS watchdog exits nonzero with no batch frame and the exact diagnostic `Raid session active work exceeded 20-second watchdog; durable work retained for recovery`, retaining the request lease. Initialization failures may also exit before a batch frame. The process accepts explicit `--env-file` paths but does not load dotenv automatically.

At the time of raid-sessions release `cron-7a8ca7924412`, standard cron verification required its two checks, the other five native worker suites, and the Rust-only cron retirement check: eight checks against the same candidate image. That release passed all eight checks (102 groups) on image `sha256:c7c8203e245b263f462ee1c6ca4c1007418408ac190d9ad9b9013ec2e4801fa8`; deployment and bounded production acceptance passed. The 19-sample 190.742-second watch, analytics readbacks, container comparison, and helper cleanup are recorded in [`migration-notes/raid-sessions.md`](../migration-notes/raid-sessions.md). Its rollback command was current at the time; the current release rollback is `scripts/saas-ops rollback cron-bf400acbc441`, which restores `cron-9ff771d91cda`. The initial production baseline had no due retention, backfill, request, or action work, and these paths remained quiet during the watch, so no performance claim is supported.

### Rust-only cron retirement check

The TypeScript worker retirement release adds a sixth same-image runtime check alongside the five native worker suites. It runs the actual supervisor with `CRON_WORKER_RUNTIME=tsx` and all five former TypeScript selectors set, checks that the archive and retired entrypoints are absent from the candidate image, exercises native stream projection, and injects ENOENT/nonzero exits to verify the supervisor restarts only the corresponding Rust child. The check also confirms the Rust-only registry and entrypoint selection.

Stage only the fixture boot hook into a private fixture directory; `test-env.json` is read directly from the repository:

```bash
set -eu
RUST_ONLY_FIXTURES=$(mktemp -d /tmp/rust-only-cron-fixtures.XXXXXX)
trap 'rm -rf -- "$RUST_ONLY_FIXTURES"' EXIT
cp ops/checks/rust-only-cron-fixtures/cron-boot.mjs "$RUST_ONLY_FIXTURES/"
scripts/saas-ops verify cron-<run-id> \
  --dependency mongo --dependency redis \
  --test-env ops/checks/rust-only-cron-fixtures/test-env.json \
  --fixtures "$RUST_ONLY_FIXTURES" \
  --check ops/checks/rust-only-cron.mjs
```

If a future reviewed change intentionally restores TypeScript, update the matching retirement assertions and supervisor tests; verify the revised candidate and preserve functional coverage for each behavior changed by the restoration.

The migration status and TypeScript baseline are documented in [`migration-notes/raid-analytics.md`](../migration-notes/raid-analytics.md); do not treat stream-worker measurements as raid-worker performance evidence.

The stream-only first-cutover release was run `cron-a4c96242b30a`, deployed on 2026-10-21. It updated only the existing `dima-cron` image and added no Compose service/container or API/bot deployment. It is now the historical prior-image baseline; after a newer cron deployment, rollback must use that newer run's receipt. The raid candidate run `cron-b24a505b7fc8` passed all 10 raid and all five stream behavior-check assertions against disposable dependencies and was deployed to the existing cron target at 2026-10-21 02:31 UTC. The exact promoted image digest is `sha256:78912284ca1a4178e0062007a922f0be70bcf0ecb5ea09c5ab12c9e25d95ad56`. The container started at 02:31:34.938 UTC with restart count 0. In the first sample at 02:31:57.542 UTC, native raid PID 16 ran as UID 65534 at 7,622,656 bytes RSS, native stream PID 20 ran as UID 65534 at 7,442,432 bytes RSS, and no TypeScript raid process was present. All 75 summaries were valid, 64 had refreshed since cutover, one was due, and no errors appeared; stream sequence advanced from 29383 to 29397 with zero active batches. The first CPU sample was during startup; the later acceptance-window samples are recorded below. No API, bot, or frontend target was part of this release. See [`migration-notes/raid-analytics.md`](../migration-notes/raid-analytics.md) for the full baseline and telemetry samples.

The initial production acceptance watch completed at 02:34:20.465 UTC, about 165.5 seconds after startup. The raid child stayed at PID 16 with unchanged start ticks, finished at 7,127,040 bytes RSS, and averaged 7,667,456 bytes RSS across 16 analytics samples. All 75 summaries had refreshed, zero were due, the oldest was 42 seconds old, and there were no errors or restarts. The stream checkpoint reached sequence 29432 with zero active batches. Fifteen CPU samples averaged 0.00713221615389936 cores (0.713% of one core); the pre-deploy TypeScript 15-minute mean was 0.0104193776 cores (1.042%), but the windows and load were unmatched, so no CPU reduction is claimed. Across 17 checked containers, only cron changed; the other 16 including API and bot remained identical. The TypeScript worker count fell from 38 to 37 only because `raid_analytics.worker.js` exited. The candidate run's temporary containers and networks were removed; the live image, rollback image, receipts, logs, and guarded Rust cache were retained. This short acceptance watch is not a steady-state benchmark.

```bash
scripts/saas-ops build piper
# Copy the exact run ID printed above into the following commands:
scripts/saas-ops verify piper-<run-id> --seed-models --check ops/checks/piper.py
scripts/saas-ops deploy piper-<run-id>
scripts/saas-ops status piper-<run-id>
scripts/saas-ops cleanup piper-<run-id>
```

`<run-id>` is a placeholder for the generated twelve hexadecimal characters; do not type it literally. Each build prints complete next-step commands with its actual ID. `build` snapshots the current Git-visible project files (including uncommitted changes) outside the served checkout, excluding `.env*`, data, dependencies, and generated output. Review the working tree first so unrelated changes are not included. It builds a uniquely tagged candidate without changing production image tags or containers.

`verify` starts the candidate with its actual runtime command, runs readiness checks and the supplied behavior script, then removes its test containers/network even on failure. Test containers have generated names and ownership labels, CPU/memory/PID limits, no Docker socket or host mounts, and no inherited production environment. They use `--network none` unless disposable dependencies are requested. Test images remain available for promotion until cleanup.

Checks are `.py`, `.mjs`, or `.sh` files. They are copied into the candidate and executed there with Python, Node, or sh respectively, so use a runtime installed in that image. Checks must be self-contained or use modules available inside the image. Their working directory is the image's normal working directory. Container checks can call their service on loopback. The checked-in Piper and dimadb scripts establish baseline behavior; **extend or replace them to verify the actual change**. A passing generic health check does not establish that a new feature works.

Piper's `--seed-models` copies `/voices` from its allowlisted production container into private temporary storage, then copies those files into the disposable candidate. Production voices are never mounted or modified. This avoids downloading voices inside a network-isolated test. For a custom-ID change, provide fixtures and a check that exercises those IDs and the required error cases.

For other fixtures, use `--fixtures /path/to/disposable-fixtures`; they are copied to `/tmp/saas-fixtures` inside the candidate. Symlinks are rejected. Use a materialized model directory for embedding tests rather than an HF cache containing symlinks, and configure the model/cache location with test settings.

Services needing databases or dummy configuration can use:

```bash
scripts/saas-ops verify api-<run-id> \
  --dependency mongo --dependency redis \
  --test-env /path/to/test-settings.json \
  --check /path/to/api-behavior.mjs
```

`--test-env` accepts a JSON object of uppercase environment names and string values. Use dummy credentials and URLs such as `mongodb://mongo:27017/saas_ops_test` and `redis://redis:6379`, with the variable names required by the service's source. No production `.env` is loaded. The three allowlisted dependency images—PostgreSQL, MongoDB, and Dragonfly—must already be present locally; each runs in disposable storage on a new internal network with `postgres`, `mongo`, or `redis` aliases. They are not attached to production networks. API/bot/worker tests may also need provider mocks or test-mode initialization; prepare those as part of the feature task. The tool fails verification instead of falling back to production dependencies. It does not supply a complete fixture environment for every backend feature.

`deploy` requires a passed verification receipt, cleaned-up tests, an unchanged candidate, unchanged production configuration, and the same baseline production container. It preserves the previous image, then uses a single-service Compose configuration with the **exact tested image ID**, `--no-build`, `--no-deps`, and `--pull never`. It never rebuilds the candidate during deployment. Startup/readiness failure triggers a targeted rollback. Perform any additional feature-specific, non-destructive production checks required by the task; an HTTP readiness check cannot establish all external integrations.

## Frontend workflow

```bash
scripts/saas-ops preview site --port 4201
# Inspect mobile/desktop layouts and changed flows, then Ctrl-C to stop.
scripts/saas-ops build site
scripts/saas-ops verify site-<run-id> --check ops/checks/web.py
scripts/saas-ops deploy site-<run-id>
scripts/saas-ops cleanup site-<run-id>
```

Use `admin` or `docs` for those sites. `preview` installs dependencies and starts `ng serve`/Astro in a temporary source copy bound to loopback. Ctrl-C stops the process group and removes that copy. Browser requests can still point at production APIs depending on the frontend environment: use mocks or controlled test data for mutating interactions.

`build` runs `npm ci` and the production build in an unserved snapshot. `verify` serves the exact built bundle on an ephemeral loopback port and runs the supplied check with `SAAS_PREVIEW_URL` and `SAAS_TARGET`. A custom browser check can use that URL to test the built feature. The supplied `web.py` checks HTML and referenced local scripts/styles; it does not replace visual and interaction checks.

`deploy` verifies the live nginx mount, backs up the complete current bundle, copies assets first, and atomically replaces each HTML file last. It preserves the mounted directory inode, so Docker continues serving the correct directory. Obsolete HTML pages are removed; previous non-HTML assets are retained for open browser tabs. This is **per-file replacement, not an atomic whole-site switch**. The operation avoids clearing the live directory during an Angular/Astro build. A future release-directory/mount migration can provide whole-site atomic switching.

The tool verifies the served entrypoints through the exact nginx container and restores the previous bundle on failure. It never restarts nginx for asset changes. `dimadb` ships its frontend inside its container; use the container workflow for its release. Directly served `dimafx` client files are not a supported publication target; follow its isolated-copy workflow in `dimafx/AGENTS.md`.

## Rollback, cleanup, and recovery

```bash
scripts/saas-ops rollback piper-<run-id>
scripts/saas-ops cleanup piper-<run-id>
```

Rollback is allowed only while the receipt still matches the current release; an old run cannot overwrite a newer deployment. Cleanup checks generated names plus repository/run ownership labels and removes containers by inspected immutable ID. It never removes unrelated containers, named production volumes, or networks with remaining attachments. Failed tests can be retried after cleanup; rebuilding is required if the candidate image was removed.

Receipts, resolved Compose configuration, test logs, and rollback artifacts live outside the checkout in `~/.local/state/saas-ops/<checkout-hash>/`, with directory permissions `0700` and private JSON files `0600`. Resolved Compose files contain credentials: do not publish or paste them. Cleanup removes temporary source/dependency installations and seeded fixtures, but retains release receipts and rollback artifacts. It intentionally does not perform broad image/cache/old-asset garbage collection.

Operations take an exclusive per-checkout lock. SIGINT/SIGTERM invoke normal cleanup/rollback paths. A host crash or SIGKILL can interrupt those paths: use `status RUN` and `cleanup RUN` for leftover tests. A receipt stuck in `deploying`, `rolling-back`, or `rollback-failed` needs inspection of that exact target and saved artifacts; do not bypass its state checks by editing the receipt or running a stack-wide command.

These scripts prevent common targeting and lifecycle mistakes. They are not a security boundary against an agent with root access or a substitute for meaningful tests.

## Verify changes to these scripts

```bash
python3 -m py_compile ops/saas_ops.py
python3 -m unittest discover -s ops/tests -v
python3 ops/tests/docker_smoke.py
```

The unit suite simulates deployment and failures without touching production. The opt-in Docker test builds a small fixture on the locally available dimadb image, checks passing/failing runtime verification and cleanup, and confirms existing container identities are unchanged. It never deploys a production service.

### Isolating unrelated working changes

`build TARGET --source-dir /path/to/worktree` and `preview TARGET --source-dir /path/to/worktree`
accept an isolated worktree of this same Git repository. Prepare only the intended feature there;
the snapshot includes its current tracked and untracked project files. Invoke the helper from the
production checkout. Production Compose ownership, configuration, release baselines, run receipts,
and publication destinations still belong to that checkout. A different repository or a project
subdirectory is rejected. This lets a verified feature ship without including another contributor's
unfinished changes or altering their files.

Combined candidate `cron-240af282cb85` passed baseline (11 groups; 24 synthetic due channels drained in 4,022 ms), raid (11 groups; 16 fixture channels in 1,109 ms), and stream (six groups) checks against the same image before deployment. The synthetic baseline burst channels had no matching Mongo history; these timings do not represent full production load. The stream check's initial attempt lacked its staged `activity.mjs` fixture and ran no assertions; the corrected run passed. The admin artifact `admin-0fca439bcb95` (`4714c791fe7161baeabcc0bc4edee9f6169c86b7df5999973109152185226867`) passed preview and served-bundle checks at 320/390/1280 px in both themes, axe/overflow checks, and `/observability` fallback validation. Both releases are deployed. The 20-sample, 190.001-second production watch passed from 05:18:31.313 to 05:21:41.314 UTC. Both natural baseline refreshes completed; final cache state was 29/29 valid, zero due, and eight null thresholds. No native errors, restarts, or health errors appeared. The other 16 production containers were unchanged, served admin assets matched the verified bundle, and cleanup completed with rollback artifacts preserved. See [`migration-notes/follow-defense-baseline.md`](../migration-notes/follow-defense-baseline.md) for sampled RSS, CPU, cache, and analytics details. The earlier source-imposed 23-second wait is not a measured TypeScript throughput result.


### Current raid analytics behavior check and release

The current raid behavior check is [`ops/checks/raid-analytics-change-driven.mjs`](checks/raid-analytics-change-driven.mjs), with 20 runtime groups. The older [`raid-analytics-rust.mjs`](checks/raid-analytics-rust.mjs) is historical and does not cover change-driven behavior. Reuse the existing raid fixture directory, test environment, cron boot hook, and staged analytics-store validator described above. Historical release `cron-2ddd455fdd1f` was accepted after all four exact-image worker suites and the 124.802-second production watch passed. Its recorded rollback target was `cron-99f8d5165ff2` (image `sha256:7b4656ed97fa73431d192c754bef504672b167e020909c7bdc6d4e727f54bcc8`). See [migration-notes/raid-change-driven.md](../migration-notes/raid-change-driven.md).
