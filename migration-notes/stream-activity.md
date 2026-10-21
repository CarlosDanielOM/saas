# Stream activity Rust migration

**Status:** Active in production since 2026-10-21. **Source commit:** `0e0242a`. **Delivery:** `saas-ops` cron run `cron-a4c96242b30a`, deployed to the existing `dima-cron` service. This record is the migration history; the detailed contract, procedures, fixtures, and benchmark artifacts remain in [`dima-rust/STREAM_ACTIVITY.md`](../dima-rust/STREAM_ACTIVITY.md).

## Scope and reuse

Rust ports the existing batch projection from `dimabot/src/utils/stream_activity.ts`. It reuses the existing `stream_activities` outbox, `stream_activity_aggregates`, and `stream_activity_states`. The TypeScript capture path in `dimabot/src/handlers/message.handler.ts` and dashboard read APIs remain in place. The TypeScript implementation remains available through the explicit `STREAM_ACTIVITY_RUNTIME=typescript` rollback setting.

The native executable runs as a separately supervised child of the existing cron host. It adds no service or Compose container. A failed child is restarted without silently switching implementations. See the technical reference for environment restrictions, telemetry, lease and checkpoint contracts, migration limits, and follow-up opportunities.

## Benefits and evidence

The three-run isolated fixture benchmark on 2026-10-20 measured 90.727% lower worker-process RSS, 88.235% lower worker-process CPU, and 36.664% higher throughput after the first batch for Rust on its synthetic 6,000-event workload. A separate 48-run batch matrix on 2026-10-21 measured persisted parity across the tested batch sizes and workloads. These are fixture results, not production/API throughput evidence or whole-SaaS savings; full methods and caveats are in the benchmark sections and artifacts linked below.

Early production observations after deployment showed checkpoint progress and no worker errors or restarts during the initial watch. Rust process RSS samples were 7.0–7.2 MiB versus an earlier TypeScript observation of 66.2 MiB, about 89% lower in those observations. At roughly 11 minutes of light load, sampled CPU was 0.36% of one core. These were early samples, not a controlled comparison, steady-state profile, peak-RSS measurement, or proof of host-wide savings.

Expected benefit is a smaller worker process and lower resource use for this projection workload. The production samples are consistent with lower RSS but do not establish its peak or generalize the fixture percentage to production. No model-routing or broader runtime claim follows from these measurements.

## Validation and release

Before deployment, the capped cron candidate passed focused TypeScript/Rust persisted parity and checkpoint recovery, telemetry, validator failure handling, worker restart, and graceful shutdown checks against disposable MongoDB and Dragonfly dependencies. The stream-only first-cutover release was `cron-a4c96242b30a`; it is now a historical prior-image baseline. Historical cron run `cron-b24a505b7fc8` kept the stream projector on Rust and added the raid projector; the same candidate passed all five stream behavior-check assertions, and its post-deployment checkpoint advanced from sequence 29383 to 29397 with zero active batches. The latest cron run is `cron-443184ebb89e`, which adds the follow-defense baseline; its production acceptance watch is recorded in [follow-defense-baseline.md](follow-defense-baseline.md). The current cron rollback restores the prior `cron-23e91b98cf64` image. The TypeScript path remains the explicit rollback.

Evidence and procedures:

- [Full behavior and deployment record](../dima-rust/STREAM_ACTIVITY.md)
- [Initial synthetic benchmark results](../dima-rust/benchmarks/stream_activity-2026-10-20.json)
- [Batch matrix results](../dima-rust/benchmarks/stream_activity-batches-2026-10-21.json)
- [Cron candidate workflow and check](../ops/README.md#rust-worker-binaries-in-the-cron-target)

The next optimization candidates documented in the technical reference remain proposals, not deployed changes. Any partitioning or shared-worker changes require explicit checkpoint/lease design and parity coverage.
