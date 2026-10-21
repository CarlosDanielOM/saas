# Rust worker migration notes

This directory is the entry point for fresh sessions working on the Rust worker migrations. Each record states the current rollout status, reused sources, what remains in TypeScript, measured observations versus expected benefits, validation evidence, and rollback limits. Read the project guides and [`ops/README.md`](../ops/README.md) before changing or releasing code. Shared MongoDB and Redis connection behavior, explicit dotenv loading, Cargo feature boundaries, and runtime constraints are documented in the [dima-rust foundation guide](../dima-rust/README.md).

| Migration | Status | Canonical record | Technical reference |
| --- | --- | --- | --- |
| Stream activity | Active in production since 2026-10-21 | [stream-activity.md](stream-activity.md) | [Projector, fixtures, and benchmarks](../dima-rust/STREAM_ACTIVITY.md) |
| Raid analytics | Deployed in cron run `cron-b24a505b7fc8` on 2026-10-21; initial 165-second production acceptance watch passed, with ongoing ordinary-load observation | [raid-analytics.md](raid-analytics.md) | [Build, verification, and release evidence](../ops/README.md#rust-worker-binaries-in-the-cron-target) |

The stream fixture benchmarks measure that worker only. They do not predict raid analytics performance. Update a migration record only with source-backed findings; separate observed results from anticipated benefits and leave a migration pending until its runtime check and production acceptance are confirmed.
