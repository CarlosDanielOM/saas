# Advanced moderation benchmark parent handoff

These files are authored, not executed or verified. The parent owns compiler/resource limits, production comparison, isolated mounts, scheduling and validation. Do not run concurrently with any compiler or other benchmark. Preserve all artifacts on failure. No production credentials, network requests, or messaging are needed.

First complete the isolated release test build with Cargo JSON output and the successful compiler receipt. The build must use the pinned musl compiler image and produce the `moderation_advanced_benchmark` integration test under `/target-cache/.../release/deps/`, `--no-default-features --features moderation-advanced`, release test profile (`opt-level=3`, `debug_assertions=false`). Save every JSON message through the final successful `build-finished` line. The exporter checks exact source target, feature presence and absence of `default`, receipt source manifest, limits and production status, and static ELF headers. Cargo's feature list alone cannot establish every command-line argument; retain the parent compiler command and receipt as separate evidence.

Host export after receipt exists (substitute actual absolute paths and use a fresh output directory):

```sh
python3 /tmp/dimabot-full-migration-tools/export_advanced_benchmark.py \
  --receipt "$RECEIPT" --build-log "$BUILD_LOG" \
  --target-root "$STATE/target" \
  --output-dir "$STATE/artifacts/moderation-advanced/benchmark-export-attempt1"
```

Mount the resulting export directory at `/artifacts/moderation-advanced/benchmark-export-attempt1`, receipt and complete build log under `/artifacts`, the same source snapshot at `/source`, the private Node 24 RE2 fixture at `/artifacts/moderation-advanced/re2-node24/re2`, and tools at `/task-tools`. Keep original installed Node ABI 147 package unchanged. The parent must supply independent SHA-256 values calculated after preparation and successful compiler receipt; don't reuse prior attempts' unknown hashes. `SOURCE_TREE_SHA256` is the receipt's `source_tree_sha256`. Save the actual command and all hashes with parent evidence. The `source-report.json` and input below must have passed the source actor's `--check` in the same pinned image; Rust actor independently checks all five workload fields before timing. Run source `--check` again after coordinator completion.

In the separately capped, task-owned Node container, with `/source/dimabot` working directory, use the following invocation (replace angle-bracket values, paths as necessary, and use a fresh report directory outside both source and fixture directory):

```sh
export DIMA_ADVANCED_SOURCE_ROOT=/source/dimabot
export DIMA_ADVANCED_RE2_FIXTURE_ROOT=/artifacts/moderation-advanced/re2-node24/re2
export DIMA_ADVANCED_RE2_FIXTURE_BINARY_SHA256=94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb
export DIMA_ADVANCED_RE2_FIXTURE_MANIFEST_SHA256=e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664
export DIMA_ADVANCED_RE2_FIXTURE_PROVENANCE_SHA256=4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c
export DIMA_ADVANCED_PAIRED_SOURCE_ROOT=/source/dimabot
export DIMA_ADVANCED_PAIRED_NODE=/usr/local/bin/node
export DIMA_ADVANCED_PAIRED_BINARY=/artifacts/moderation-advanced/benchmark-export-attempt1/moderation_advanced_benchmark
export DIMA_ADVANCED_PAIRED_FIXTURE=/artifacts/moderation-advanced/benchmark-attempt1/input.json
export DIMA_ADVANCED_PAIRED_SOURCE_REPORT=/artifacts/moderation-advanced/benchmark-attempt1/source-report.json
export DIMA_ADVANCED_PAIRED_PROVENANCE=/artifacts/moderation-advanced/benchmark-export-attempt1/binary-provenance.json
export DIMA_ADVANCED_PAIRED_RECEIPT='<absolute mounted receipt>'
export DIMA_ADVANCED_PAIRED_BUILD_LOG='<absolute mounted complete Cargo JSON log>'
export DIMA_ADVANCED_PAIRED_REPORT_DIR=/artifacts/moderation-advanced/paired-attempt1
export DIMA_ADVANCED_PAIRED_ROUNDS=250
export DIMA_ADVANCED_PAIRED_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_ADVANCED_PAIRED_BINARY_SHA256='<independent sha256>'
export DIMA_ADVANCED_PAIRED_FIXTURE_SHA256='<independent sha256>'
export DIMA_ADVANCED_PAIRED_SOURCE_REPORT_SHA256='<independent sha256>'
export DIMA_ADVANCED_PAIRED_PROVENANCE_SHA256='<independent sha256>'
export DIMA_ADVANCED_PAIRED_RECEIPT_SHA256='<independent sha256>'
export DIMA_ADVANCED_PAIRED_BUILD_LOG_SHA256='<independent sha256>'
export DIMA_ADVANCED_PAIRED_SOURCE_TREE_SHA256='<receipt source_tree_sha256>'
export DIMA_ADVANCED_PAIRED_BENCHMARK_SHA256='<independent sha256 of tests/fixtures/moderation_advanced_benchmark.cjs>'
export DIMA_ADVANCED_PAIRED_LOADER_SHA256='<independent sha256 of tests/fixtures/moderation_advanced_source.cjs>'
node tests/fixtures/moderation_advanced_benchmark.cjs --check /artifacts/moderation-advanced/benchmark-attempt1
node /task-tools/advanced_paired_coordinator.cjs
node tests/fixtures/moderation_advanced_benchmark.cjs --check /artifacts/moderation-advanced/benchmark-attempt1
```

Coordinator creates a new report directory, 70 exclusive sample files, and combined report with exact order, per-actor raw stdout/stderr and environment, post-run hashes, and workload medians. On failure after output directory creation it writes the combined failed report, retaining completed sample files. Missing/invalid report directory or filesystem write errors can prevent failure-artifact creation; the parent should capture outer stdout/stderr and exit status. Each actor has a 120-second deadline and each output stream is capped at 1 MiB. The coordinator kills only its own current child. The source `--check` applies to fixture files; the coordinator independently validates each sample's checksum and fields.
