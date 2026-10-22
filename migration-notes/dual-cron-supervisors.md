# Dual cron supervisors — accepted release

**Status: accepted.** Lead accepted run `cron-7629f95f5dfd` / image `sha256:f848743bc0f0817656d2399dd00a4e08e5828d2a0261096c551bb48302ae000f` at `2026-10-22T17:27:24.628939Z`. It was deployed to the existing `dima-cron` container, which started at `2026-10-22T17:16:25.975940939Z`. The 32-sample production watch passed in 340.474 seconds, from `17:20:25.214Z` to `17:26:05.688Z`; final readbacks and helper cleanup passed. Rollback with `scripts/saas-ops rollback cron-7629f95f5dfd` restores the prior accepted run `cron-2056ce9d790c`, image `sha256:adac7d8de9b5c5cfb138f8051a05123ac02a6c3467cc85784873ee85370d892f`.

A fresh pre-deployment baseline covered 19 containers, 90 indexes, and 19 collections. The promoted release receipt identifies container `2b9fb5223df565145f7b5e332901613e05a598a4482281ccb749099402370741`, the image above, and the start time above.

## Ownership model

The implementation keeps one `dima-cron` container and assigns each runtime its own registry and supervision boundary:

- `dima-rust/src/supervisor/` and `dima-rust/src/bin/cron_index.rs` define the Rust index for seven native workers. Rust owns their allowlisted child environments, process lifecycle, per-child restart policy, process metrics, bounded telemetry framing, and Redis/Dragonfly export. A failed native child is restarted by Rust without a TypeScript fallback.
- `dimabot/src/workers/cron.index.ts` owns the 19 TypeScript definitions (18 enabled in the reported production configuration, with EventSub reconciliation disabled); three definitions retain their existing environment flags. `cron_native_bridge.ts` starts and owns exactly one detached Rust index; Node does not own native worker definitions, individual native children, or their metrics.
- Node remains PID 1 and coordinates both owners. When starting as root it launches the Rust index with UID/GID 65534 and a restricted environment. Rust applies a narrower allowlist to each native worker. The bridge does not accept an arbitrary command or executable.
- The Rust CLI supports standalone `--once`, `--dry-run`, `--workers`, and `--events-json` operation; worker selection is restricted to registered names.

The eventual direction is to retire the TypeScript index only after the final TypeScript responsibility migrates and that cutover is separately reviewed. That sunset is not part of this release. Worker pacing is unchanged. The default restart wait remains 5 seconds with a 1-second minimum; process metrics are sampled every 10 seconds. Those waits protect restart recovery, bounded polling/export, cooperative shutdown, pipe closure, and final telemetry export. The worker-level idle, future-work, rate-limit, lease, and retry waits remain unchanged. For `CRON_WORKER_RESTART_DELAY_MS` values above `2147483647`, Rust uses the 5-second fallback; Node's timer would overflow and clamp to 1 ms. This invalid-value edge is an intentional supervisor compatibility difference; normal configured values preserve the existing waits.

## Failure and shutdown behavior

A native child exit is handled inside Rust and restarts only that child. If the Rust index exits unexpectedly, including with status zero, the Node bridge kills the process group created for the index before stopping the cron host with a nonzero status. This prevents Docker recovery from starting a second host while orphaned native children remain. The bridge never restarts an index over surviving children.

Shutdown sends SIGTERM to both owners concurrently. TypeScript children have a 25-second grace period. Rust allows 25 seconds for child shutdown and a shared 2-second pipe/close/export window (27 seconds total); the Node bridge allows 28 seconds, within the existing Compose 30-second stop budget. The Rust close/export allowance is shared, not stacked per worker.

## Build and verification evidence

`ops/rust_build.sh` builds `cron_index` as an eighth native binary in the isolated `cron-supervisor` profile. It enables Redis and excludes MongoDB, SQLx, Axum, reqwest, and the ICU collation crate (`icu_collator`). Redis 1.7.1 requires `url` 2.5.8 → `idna` 1.1 → `idna_adapter` 1.2.2, bringing ICU normalization, properties, and provider crates; this closure is also in the accepted baseline graph. The corrected dependency guard excludes collation only, with no dependency changes. The seven worker binaries retain their existing profiles. The image adds no service or Compose container.

Candidate verification is complete for the build and exact-image suites:

| Evidence | Result |
| --- | --- |
| Capped four-profile compile (509.562 seconds), Clippy, tests, release builds | Passed; 367 test instances, five ignored external-fixture instances; eight release binaries dry-run passed |
| Rust supervisor tests | 34 library, two binary, and two doc test instances passed |
| Existing Rust worker dependency graphs | All three unchanged |
| TypeScript supervisor checks / typecheck | 32 tests passed; TypeScript check passed |
| Operations / fixture hook suites | 68 operations tests and 25 hook tests passed |
| Telemetry fixture replay | 274 TypeScript fixtures replayed |
| Frozen source/build identity | 835 files matched the candidate image |
| Exact-image behavior suites | Nine suites passed, 147 groups: supervisors 6, Rust-only 6, stream 6, raid 20, baseline 11, roulette 19, AI receipts 23, raid sessions 20, dashboard 36 |
| Deployment | Run `cron-7629f95f5dfd`, image `sha256:f848743bc0f0817656d2399dd00a4e08e5828d2a0261096c551bb48302ae000f`, deployed; container start identity recorded above |
| Initial production-watch probe | Historical first attempt stopped before sampling because it counted 14 internal domain-event consumers as duplicate primaries; corrected probe changed no application code |
| Corrected probe and offline checks | Separately tracked 14 source-backed domain-event consumers and 25 registered worker primaries; 58 offline topology groups and seven Python tests passed |
| Production watch | Passed 32 samples in 340.474 seconds (`17:20:25.214Z`–`17:26:05.688Z`); two supervisors, 25 registered workers, and 14 domain-consumer children remained stable |
| Final readbacks | Passed: eight candidate binary hashes matched; 90 index specifications across 19 collections were unchanged; queues were empty with no failure-counter changes; analytics was fresh for all seven native workers and the Rust index with no errors, restarts, or drops; logs showed 18 TypeScript and seven Rust starts with no exits/errors |
| Container comparison | Passed: 19 containers before and after; only `dima-cron` changed, with no additions |
| Cleanup and acceptance | Helper returned zero; no task-owned containers, networks, or volumes remained; temporary format copy, fixtures, and failed binaries were removed; rollback artifacts were retained. Lead acceptance recorded at `2026-10-22T17:27:24.628939Z` |

Application review corrected the dependency guard to exclude `icu_collator` only and added ICU normalizer/provider to positive mock graphs. Other application corrections bounded diagnostics to 64 lines and used a detached `CLOEXEC` raw file-descriptor writer; a 100 ms drain fits within the 27-second Rust deadline. Runtime teardown uses `shutdown_background` after async owners and children finish to avoid waiting on residual DNS work. Metrics use an explicit allowlist. Clippy compatibility corrections are included in the final build.

The final Rust build log confirms both blocking-job subprocess tests passed. `cron-supervisors-verified.log` confirms the exact-image 20,000-frame unread-stdout cooperative SIGTERM check passed. Earlier review notes that listed these checks as pending came from intermediate attempts and are superseded by the final logs.

Fixture-only corrections fixed the database suffix and `ESRCH` process-disappearance behavior without changing runtime code or image. Separately, the first probe attempt stopped before sampling after counting the 14 internal consumers started by `domain_events.worker.ts` / `domain_event_execution.ts` as duplicate primary workers. Source review confirmed they are internal forks; the corrected probe tracks them separately from 25 registered primaries. Its offline source-backed tests passed, and the production watch and final readbacks later passed. This probe correction made no application change and did not indicate an application regression.

No performance improvement is claimed. Historical accepted release evidence remains in [worker-shared-utils.md](worker-shared-utils.md). The acceptance receipt is `/root/.local/state/dual-cron-supervisors-20261022/acceptance.json`; the read-only watch report is `/root/.local/state/dual-cron-supervisors-20261022/probes/evidence-cron-7629f95f5dfd/observation-report.json`. The release evidence archive is `/root/.local/state/saas-ops/649a957c15888e53/cron-7629f95f5dfd/dual-cron-supervisors-acceptance`.

## Source map

- [Rust index CLI](../dima-rust/src/bin/cron_index.rs)
- [Rust supervisor](../dima-rust/src/supervisor/)
- [TypeScript cron host](../dimabot/src/workers/cron.index.ts)
- [Node-to-Rust bridge](../dimabot/src/workers/cron_native_bridge.ts)
- [Candidate behavior check](../ops/checks/cron-supervisors.mjs)
- [Rust build profiles](../ops/rust_build.sh)
- [Operations workflow](../ops/README.md)
