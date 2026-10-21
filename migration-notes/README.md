# Rust worker migration notes

This directory is the entry point for fresh sessions working on the Rust worker migrations. Each record states the current rollout status, reused sources, what remains in TypeScript, measured observations versus expected benefits, validation evidence, and rollback limits. Read the project guides and [`ops/README.md`](../ops/README.md) before changing or releasing code. Shared MongoDB and Redis connection behavior, explicit dotenv loading, Cargo feature boundaries, and runtime constraints are documented in the [dima-rust foundation guide](../dima-rust/README.md).

| Migration | Status | Canonical record | Technical reference |
| --- | --- | --- | --- |
| Stream activity | Active in production since 2026-10-21 | [stream-activity.md](stream-activity.md) | [Projector, fixtures, and benchmarks](../dima-rust/STREAM_ACTIVITY.md) |
| Raid analytics | Final phase/health release `cron-23e91b98cf64` and admin bundle `admin-33b3f62b305d` deployed on 2026-10-21; production watch and served-admin smoke check passed | [raid-analytics.md](raid-analytics.md) | [Build, verification, and release evidence](../ops/README.md#rust-worker-binaries-in-the-cron-target) |

The stream fixture benchmarks measure that worker only. They do not predict raid analytics performance. The shared-query experiment was deferred after its controlled trials showed no consistent CPU improvement. The final Rust release and admin bundle passed their scoped checks and were deployed; the bounded production watch, zero-backlog health readback, and served-admin smoke check passed. Keep runtime comparisons separate from production observations, and do not claim a general runtime gain from the short controlled fixtures.
