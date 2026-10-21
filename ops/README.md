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

### Rust stream-activity worker in the cron target

```bash
scripts/saas-ops plan cron
scripts/saas-ops build cron
```

Use the exact `cron-<run-id>` printed by `build` for the later steps.

`scripts/saas-ops build cron` first snapshots `dima-rust` read-only and compiles the musl executable and fixture in one globally serialized, task-owned toolchain container. The helper checks host CPU/load, disk, and `MemAvailable` (at least 12 GiB before build and 8 GiB while it runs), verifies the applied limits (4 CPUs, 4 GiB RAM with no swap, 256 PIDs), and sets `CARGO_BUILD_JOBS=2`. Inside those caps it runs formatting, check, Clippy, default tests, the release binary/fixture build, and binary `--dry-run`. It records source/toolchain/binary digests, stages the binary only into the cron candidate snapshot, then builds the ordinary cron image. Cargo never runs on the host or inside BuildKit. A resource or build failure stops the candidate without relaxing limits or using host fallback.

For candidate verification, the behavior check runs the actual cron supervisor and native child against disposable MongoDB and Dragonfly containers. It checks worker selection, Rust/TypeScript parity and checkpoint recovery, telemetry, per-child restart behavior, and signal shutdown. Its source fixtures are copied into a private temporary directory so the test uses the existing Rust fixture generator and analytics validator without duplicating those sources in `ops/`. The check's dummy environment selects native Rust explicitly. The following is the verification invocation used for the deployed run; its fixture-copy steps keep the test source-backed without checking in duplicate fixture sources:

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

The native Rust projector is active in production from run `cron-a4c96242b30a`, deployed on 2026-10-21. That release updated only the existing `dima-cron` image; it added no Compose service/container and did not deploy the API or bot targets. For future changes, use the same exact run ID for deploy and cleanup and verify production before reporting a rollout complete.

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
