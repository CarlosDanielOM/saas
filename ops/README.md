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

`scripts/saas-ops build cron` first snapshots `dima-rust` read-only and compiles the two production worker binaries in one globally serialized, task-owned toolchain container. Routine cron builds use `--no-default-features --features mongo`; a `cargo tree` guard rejects SQLx, Axum, or Redis in this worker graph. The compiler is Rust 1.99.1 on Alpine/musl, pinned to the already validated immutable image `rust@sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9`. Preserve this pin unless a toolchain change is explicitly reviewed and validated. The helper checks host CPU/load, disk, and `MemAvailable` (at least 12 GiB before build and 8 GiB while it runs), verifies the applied limits (4 CPUs, 4 GiB RAM with no swap, 256 PIDs), and sets `CARGO_BUILD_JOBS=2`. Within those caps it runs formatting, Mongo-only check, Clippy, tests, release builds of `stream_activity` and `raid_analytics`, and each binary's `--dry-run`. It records source/toolchain/dependency-graph/binary digests, stages the binaries only into the cron candidate snapshot, then builds the ordinary cron image. The stream fixture example is a manual parity/benchmark tool and is not compiled or staged in routine candidates. Cargo never runs on the host or inside BuildKit. A resource or build failure stops the candidate without relaxing limits or using host fallback.

Cargo registry and target artifacts live in the private persistent directory `~/.local/state/saas-ops-rust-cache/v1`, outside the checkout. Entries are keyed by immutable toolchain image, Cargo manifest and lockfile, build recipe, feature set, and profiles. The helper validates directory ownership markers, refuses symlinked paths, and caps the dedicated cache at 8 GiB. It retains dependency artifacts but explicitly clears the project's release artifacts before every run and rebuilds both worker binaries from that run's frozen source snapshot. Receipts include cache key/hit, cache sizes, build duration, selected features, and dependency-graph digest. These reduce or describe compile work; they are not runtime RAM or CPU measurements. The Mongo-only feature-matrix audit verified the 4 CPU/4 GiB cap and two Cargo jobs; a sample during compilation used about two CPUs and 314 MiB.

The accepted ordinary Mongo-only build comparison used identical Rust source, manifests, lockfile, recipe, and feature set. Cold run `cron-ea84c986d7f0` took 649.777 seconds of Rust build time with a cache miss. Warm run `cron-b24a505b7fc8` took 102.007 seconds; the helper explicitly cleared project release artifacts, rebuilt both optimized worker binaries at release optimization level 3, and reused dependency artifacts. The warm Cargo log showed only `dima-rust` being checked/compiled, not dependencies. Check, Clippy, unit-test compile, and release portions were 2.19 s, 2.13 s, 27.31 s, and 64 s warm, compared with 105 s, 1.98 s, 151 s, and 381 s cold. The warm receipt recorded `cache.project_release_clean=true`. This measures build-path time, not runtime performance. A prior warm attempt was rejected as evidence after it revealed that Cargo's package clean removed development artifacts but could leave release worker binaries; that superseded 37.277-second result is not an accepted warm measurement.

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

For the raid-analytics Rust migration, use the same `cron` target and exact run-ID flow. Its focused behavior check runs the candidate cron supervisor with the actual native raid child against disposable MongoDB and Dragonfly containers, compares persisted results with the existing TypeScript projector, and checks runtime selection, restricted child environment, lease/retry behavior, child recovery/shutdown, and bounded telemetry. The check is `ops/checks/raid-analytics-rust.mjs`; its isolated setup copies the supervisor hook and analytics-store validator into a private fixture directory:

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
  --check ops/checks/raid-analytics-rust.mjs
```

The fixture check restricts database names to `raid_analytics_fixture_*` and removes only databases it creates. It covers schema/default/index compatibility, idempotent history writes, due summary refresh and dedupe, lease ownership/loss/retry, bounded follow queries, telemetry, child UID/environment, restart behavior, and shutdown. Once candidate verification passes, deploy only the same cron run, verify native raid telemetry and summary refreshes in production, then clean up. Replacing the cron container restarts all of its child processes once; this preserves worker definitions and failure isolation, not unrelated worker PIDs. A cron-only deployment leaves other Compose service/container identities alone.

Final phase/health release `cron-23e91b98cf64` is deployed with image digest `sha256:9761707adb51d527674488bcce9f8a5a6277167c814e567013b0828d73678e39`. It retains the original four aggregation queries per channel (7-day summary and reciprocity, then 30-day summary and reciprocity) and emits timings for claim, follow queries/writes, both periods, reciprocity, publish, and release. With this sequence, `reciprocityMs` sums the two attempted query durations. The supervisor attaches the enclosing batch outcome to each reached phase; the admin page excludes phase rows from job/failure totals. Backlog probes run every 30 seconds between batches. Probe errors do not fail projection or emit fabricated zero gauges; the admin Observability → Servers → Our processes view keeps missing or stale readings unknown and marks readings stale after 90 seconds. It shows latest 10-second analytics buckets, which may aggregate multiple samples. These changes reuse the current metrics/analytics ingestion path and require no analytics service schema change. The bounded production acceptance watch passed.

The capped Rust build for `cron-23e91b98cf64` took 101.849 seconds with cached dependencies and both release binaries rebuilt under the pinned Rust 1.99.1 image. It passed 21 unit tests and one doc test; the native metrics parser's 11 tests and the `ops` suite's 56 tests passed. The raid behavior check passed all 11 assertions, including a 16-channel fixture drain in 1.111 seconds; the stream behavior check passed all five assertions; and the benchmark passed 27 strict parity runs. The production watch ran from 03:14:05.377 UTC through 03:15:45.719 UTC (about 100.34 seconds). At the end, both native child PIDs were stable at UID 65534, the cron container restart count was zero, all 75 summaries were current with zero due/errors, and the stream sequence reached 30005 with no active batches. All eight phase metrics and successful health samples reached the existing analytics database; no native error/restart groups appeared. The last watch health snapshot reported 44 due at 03:15:10, while the direct summary query at 03:15:45 showed zero; a separate 03:16:40 health bucket then reported success and zero backlog. The admin served-bundle check passed with mocked APIs across three widths and both themes. Only cron changed among 17 containers; static admin publication required no frontend container restart. Task-owned test containers, networks, and preview resources were cleaned up; verified live/prior rollback images and receipts remain preserved.

The proposed shared reciprocity query is deferred. Two full parity trials recorded 54 successful runs in [raid-analytics-query-experiment-2026-10-21.json](../dima-rust/benchmarks/raid-analytics-query-experiment-2026-10-21.json). Combined six-repetition medians showed whole-process CPU per channel changing −3.77% on quiet fixtures, +1.32% on moderate, and +4.82% on dense; busy-workload CPU did not consistently improve, and trial directions varied. The experimental candidate included instrumentation, so these results cannot isolate the query change. Two interrupted benchmark attempts exhausted file descriptors in disposable MongoDB after repeated database/index creation; accepted runs reused two fixture databases and index sets, reseeding outside timed runs. No production limits or settings changed. The shared-query build `cron-bade84f34ce6` was never deployed and has been cleaned up.

The admin bundle `admin-33b3f62b305d` passed isolated health-state, deduplication, and filter checks at 320, 390, and 1280 px in both themes, with no axe findings or horizontal overflow, then was deployed as the exact verified bundle. The visible tab label is **Servers**; `resources` is the internal route/state name. The final Rust comparison is recorded in [raid-analytics-2026-10-21.json](../dima-rust/benchmarks/raid-analytics-2026-10-21.json): 27 strict-parity runs across TypeScript, the previous Rust worker, and the release candidate. Those short fixtures do not support a general runtime improvement claim; the phase/health instrumentation is included and ordinary production observation remains necessary.

Because the cron image also contains the already-deployed stream child, rerun the stream-activity behavior check against this same candidate run before deployment. A raid-only fixture pass does not cover stream checkpoint/recovery behavior after a shared cron image change.

If deployed release `cron-23e91b98cf64` regresses, use that run's rollback receipt to restore the prior `cron-b24a505b7fc8` image, which contains native stream and raid workers. Rollback is tied to the newest cron release receipt and cannot be performed through the historical stream first-cutover run after a later deployment. Selecting `RAID_ANALYTICS_RUNTIME=typescript` through configuration is a separate reviewed config workflow; the code-only cron helper rejects configuration drift and does not silently apply that environment change.

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
