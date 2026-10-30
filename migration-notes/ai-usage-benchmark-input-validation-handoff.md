# AI usage benchmark input validation handoff

Parent verification status: **input preparation and checks passed** for producer and PostHog benchmark inputs in the final frozen source snapshot. These modes regenerated or checked the prepared inputs and wire values without executing timed loops or writing timing reports. They establish no benchmark result or runtime performance and do not revalidate historical reports. The resolver itself is included in source-hash metadata; changed harness/source-reader hashes mean old reports were not newly checked by this procedure. Raw logs and receipts are in [the source-retirement evidence bundle](evidence/ai-usage-source-retirement-evidence/README.md). The overall migration matrix rollup is 18 complete and 23 partial features; the retired source helper counts as one completed local feature, and its test is not an independent feature.

The parent used the equivalent task-owned paths in the isolated Node snapshot with the pinned Node runtime and dependency capture. For later reproduction from the repository root, with the same Node executable and installed `dimabot/node_modules` TypeScript dependency used for preparation and checking (no special environment variables are required), use task-owned paths:

```sh
mkdir /tmp/ai-usage-producer-input-OWNER
node dimabot/tests/fixtures/ai_usage_producer_benchmark.cjs --prepare /tmp/ai-usage-producer-input-OWNER
node dimabot/tests/fixtures/ai_usage_producer_benchmark.cjs --check-input /tmp/ai-usage-producer-input-OWNER
node dimabot/tests/fixtures/posthog_tracking_benchmark.cjs --prepare /tmp/posthog-tracking-input-OWNER
node dimabot/tests/fixtures/posthog_tracking_benchmark.cjs --check-input /tmp/posthog-tracking-input-OWNER
```

Replace `OWNER` with unique task-specific names. The producer directory must already exist and be empty; it receives only `ai-usage-producer-benchmark-input.json`. The PostHog directory must not exist; preparation creates it and writes only `input.json`. Each check requires exactly its single input file and reconstructs and compares all bytes, including metadata, generated pool values, wires, and checksums. The source loaders and pinned source resolver execute during preparation and checking, including their existing guards. Both commands must run against unchanged sources and the same runtime/dependencies because those are represented in metadata. The original `--write` and `--check` retain their report responsibilities; these modes do not check native or Node timing reports.
