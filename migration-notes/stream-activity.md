# Stream activity Rust migration

**Status:** Active in production since 2026-10-21. Its six-group stream suite and the combined production watch passed on latest run `cron-7b8a6c88303d`; the earlier combined production watch passed on `cron-99f8d5165ff2`. **Source commit:** `0e0242a`. **Delivery:** first `saas-ops` cron run `cron-a4c96242b30a`, deployed to the existing `dima-cron` service. This record is the migration history; the detailed contract, procedures, fixtures, and benchmark artifacts remain in [`dima-rust/STREAM_ACTIVITY.md`](../dima-rust/STREAM_ACTIVITY.md).

This status and the selector descriptions recorded below are historical deployment facts. The scheduled TypeScript worker entrypoint has since been retired; the former `STREAM_ACTIVITY_RUNTIME=typescript` selector is no longer supported. Retirement was accepted in `cron-d02bf5a387d5`; see [the current retirement record](typescript-worker-retirement.md).

## Scope and reuse

Rust ports the existing batch projection from `dimabot/src/utils/stream_activity.ts`. It reuses the existing `stream_activities` outbox, `stream_activity_aggregates`, and `stream_activity_states`. The TypeScript capture path in `dimabot/src/handlers/message.handler.ts`, shared projection utility, and dashboard read APIs remain in place. The old `STREAM_ACTIVITY_RUNTIME=typescript` setting was a historical rollback selector and is retired; it does not select the archived worker entrypoint.

The native executable runs as a separately supervised child of the existing cron host. It adds no service or Compose container. A failed child is restarted without silently switching implementations. See the technical reference for environment restrictions, telemetry, lease and checkpoint contracts, migration limits, and follow-up opportunities.

The Rust source now includes a bounded process-health probe for pending activity, checkpoint progress, active-batch size, and last successful work. This health telemetry shipped in combined cron run `cron-240af282cb85`; the bounded production acceptance watch passed. It reads the existing collections without changing the projection or lease contract; details are in the [technical reference](../dima-rust/STREAM_ACTIVITY.md#stream-health-telemetry).

## Benefits and evidence

The three-run isolated fixture benchmark on 2026-10-20 measured 90.727% lower worker-process RSS, 88.235% lower worker-process CPU, and 36.664% higher throughput after the first batch for Rust on its synthetic 6,000-event workload. A separate 48-run batch matrix on 2026-10-21 measured persisted parity across the tested batch sizes and workloads. These are fixture results, not production/API throughput evidence or whole-SaaS savings; full methods and caveats are in the benchmark sections and artifacts linked below.

Early production observations after deployment showed checkpoint progress and no worker errors or restarts during the initial watch. Rust process RSS samples were 7.0–7.2 MiB versus an earlier TypeScript observation of 66.2 MiB, about 89% lower in those observations. At roughly 11 minutes of light load, sampled CPU was 0.36% of one core. These were early samples, not a controlled comparison, steady-state profile, peak-RSS measurement, or proof of host-wide savings.

Expected benefit is a smaller worker process and lower resource use for this projection workload. The production samples are consistent with lower RSS but do not establish its peak or generalize the fixture percentage to production. No model-routing or broader runtime claim follows from these measurements.

## Validation and release

Before deployment, the capped cron candidate passed focused TypeScript/Rust persisted parity and checkpoint recovery, telemetry, validator failure handling, worker restart, and graceful shutdown checks against disposable MongoDB and Dragonfly dependencies. The stream-only first-cutover release was `cron-a4c96242b30a`; it is now a historical prior-image baseline. Historical cron run `cron-b24a505b7fc8` kept the stream projector on Rust and added the raid projector; the same candidate passed all five stream behavior-check assertions, and its post-deployment checkpoint advanced from sequence 29383 to 29397 with zero active batches. Feature-acceptance cron run `cron-99f8d5165ff2` contains all four native workers and stream-health telemetry. Its stream suite passed six groups on the exact image. The 19-sample production watch and cleanup passed; see the roulette record for the combined release observations. That run's receipt restored prior run `cron-240af282cb85`, image `sha256:9208e3d8e0a12b47ae793598fb1dac53e7f70cab0ab4c338097e3fbc5981f0ac`; it is historical rollback evidence. Production later advanced through `cron-2ddd455fdd1f` to `cron-7b8a6c88303d`; see the AI receipts record for the latest combined release and rollback pointer. The TypeScript path remains the explicit runtime rollback.

Evidence and procedures:

- [Full behavior and deployment record](../dima-rust/STREAM_ACTIVITY.md)
- [Initial synthetic benchmark results](../dima-rust/benchmarks/stream_activity-2026-10-20.json)
- [Batch matrix results](../dima-rust/benchmarks/stream_activity-batches-2026-10-21.json)
- [Cron candidate workflow and check](../ops/README.md#rust-worker-binaries-in-the-cron-target)

The next optimization candidates documented in the technical reference remain proposals, not deployed changes. Any partitioning or shared-worker changes require explicit checkpoint/lease design and parity coverage.
