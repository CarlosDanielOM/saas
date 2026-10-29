# PostHog prepared-payload benchmark handoff

## Parent validation update — initial baseline

The initial release benchmark and final `--check` passed in `compiler-1793264871810743273` / `node-1793265499179357802`; the pinned Node run left the benchmark input SHA unchanged. The measured baseline and honest slower/faster split are recorded in the [combined migration note](posthog-receipt-2026-10-29.md). The later payload optimization is unverified, so these are initial baseline measurements only and must not be described as optimized results or production performance.

Initial baseline benchmark: **measured and source-paired** in parent compiler receipt `compiler-1793264871810743273`; the final pinned Node `--check` passed in `node-1793265499179357802` with input SHA unchanged. This is a synthetic payload microbenchmark, not a production performance result. The author-time status below describes the state before parent execution.

The comparison measures the four actual TypeScript capture wrappers through a one-object SDK boundary mock, JSON.stringify, UTF-8 Buffer creation, and a wrapping sum of every byte. The Rust side calls the public prepared-event builders, constructs the same ordered outer object, serializes it directly with the lossless writer, and sums its UTF-8 bytes. The AI usage pool uses the typed `NativeUsageRecorded` path; other pools use prepared lossless values. Inputs and context construction, module loading, SDK metadata, queueing, transport, HTTP, and clock I/O are outside the measurement. Identity and shutdown are excluded because identity deduplication makes the workload stateful. Six pools each have 32 varied inputs; 192 complete source wires and checksums must match before native timing starts. There are 32,000 warmups and seven trials per pool, 256,000 operations per regular trial and 32,768 for large messages. Every trial retains its checksum and raw duration, with min, median, and max. Results are synthetic and do not establish production latency.

The loader transpiles the actual source once in the normal CommonJS realm, forbids unexpected imports and random IDs, and substitutes the SDK entirely. Pinned versions and hashes bind source, package and lockfiles, lossless reader/writer, loader, native code, and both harnesses into the fixture and both reports. `--check` independently regenerates all inputs and provenance and validates both saved reports without timing. Native SHA-256 validation uses the existing `sha2` dependency enabled only for the opt-in `posthog-benchmark` verification feature. The runtime and benchmark avoid an unnecessary MongoDB dependency graph. The independent SHA must come from the parent, not from fixture metadata. Parent should guard fixture SHA before and after the entire isolated run and retain the reports without modifying the input. Exclusive file creation prevents replacing prior results.

Parent execution, inside the already-authorized capped isolated read-only snapshot with pinned Node/TypeScript and task-owned writable directory (substitute actual paths):

```sh
node dimabot/tests/fixtures/posthog_tracking_benchmark.cjs --write "$TASK_BENCH_DIR"
sha256sum "$TASK_BENCH_DIR/input.json"
# Independently copy the displayed 64-character hash into POSTHOG_BENCH_INPUT_SHA256.
POSTHOG_BENCH_DIR="$TASK_BENCH_DIR" POSTHOG_BENCH_INPUT_SHA256="<independent-sha256>" cargo test --manifest-path dimabot/Cargo.toml --release --no-default-features --locked --features posthog-benchmark --test posthog_tracking_benchmark -- --ignored --exact prepared_payload_benchmark --nocapture
sha256sum "$TASK_BENCH_DIR/input.json"
node dimabot/tests/fixtures/posthog_tracking_benchmark.cjs --check "$TASK_BENCH_DIR"
```

The directory must not exist before `--write`; it must be task-owned and writable in the isolated runner. These commands are workload commands only, not permission to run Cargo on the production host: apply the Rust guide's container, limits, source snapshot, headroom, production identity checks, and cleanup. Initial measured results are in the [combined migration note](posthog-receipt-2026-10-29.md). The later optimization work remains unverified. No deployment or caller adoption is implied.
