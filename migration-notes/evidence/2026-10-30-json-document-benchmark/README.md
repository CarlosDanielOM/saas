# Lossless JSON document benchmark evidence — 2026-10-30

This package preserves the verified baseline matched benchmark and separate candidate epochs. Candidate 1 was not accepted as a performance improvement; candidate 2 is accepted as a local allocation improvement. The baseline figures remain independent of both candidate results. [`artifact-index.json`](artifact-index.json) lists every payload under `artifacts/`, `runs/`, `reproduction-tools/`, `candidate1/`, and `candidate2/` with original path, raw/stored SHA-256, and raw/stored byte size. All run logs use lossless gzip while retaining their original names in the path; decompression reproduces exact bytes.

## Source and measurement binding

`artifacts/source-bindings.json` binds commit `ac54f24a5def1db0c928e7a06e32def38cbd42a2`, tree `5fcf0145e5a67b8b0d7942016923e824e5ddc2e8b7a5d7dfbdbf6e95f8c5032d`, and 1,495 inputs (1,485 Git plus ten reused SDK inputs); all hashes match. `source-final.json.gz` is the immutable source map. `failed-compile-source.json.gz` and `failed-format-source.json.gz` preserve the exact source maps from the two failed compiler attempts. `snapshot-isolation.json` records the excluded channel fish drafts and confirms they were preserved.

`artifacts/round1/` contains losslessly gzipped exact workload input, Node provenance, Node report, and Rust report. Independent input/provenance pins and all pins including both report hashes are preserved separately. The input SHA-256 is `0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c`; provenance SHA-256 is `17bdce824857127e76ab56d31451ac8a3a2903936436fa33522017ec9e5af280`. Node v24.22.1 / V8 13.6.233.17-node.58 was pinned by binary SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`. No Node or SDK binary is copied into this package.

The baseline operation is full JSON parse, root own-property lookup of `error`, JSON truthiness, then selected JSON serialization or `null`. Node uses built-in `JSON.parse`, `Object.hasOwn`, and `JSON.stringify`; Rust uses `JsonDocument::parse`, `get`, `truthy`, and `to_json_string`. Five 32-case pools use 20 warmup passes and seven samples; each sample has 500 complete pool passes except the large ignored-payload pool, which uses 100. The run verifies expected ASCII output/checksums and rechecks input/provenance pins. It excludes Arc-owned copying and network costs.

## Run records

`runs/` preserves exact logs and receipts for formatting `1793367623335843496`; compiler failure `1793367645817467273` (Clippy constant assertion); compiler failure `1793367681862868082` (rustfmt change to the new guard); successful strict/release compiler `1793367719218480854`; Node preparation `1793367747282655631`; Node benchmark `1793367766770861259`; Rust benchmark compiler/run `1793367777919017771`; and final Node verification `1793367852328348358`, which checked the artifacts without retiming.

The final production readback is `artifacts/production-after-round1.json`: all 18 records unchanged and zero task-owned resources. The compiler cap was six CPUs, 4 GiB memory/no swap, two Cargo jobs and a 256 PID limit. No formal statistical test, whole-application, RSS/memory, or production-latency claim is made.

## Reproduction and results

`reproduction-tools/` preserves the compile, Node preparation, Node benchmark, Rust benchmark, no-retiming check, source validator and final readback scripts. They are retained for provenance and were not run during this documentation task.

See [`../../lossless-json-document-benchmark.md`](../../lossless-json-document-benchmark.md) for all five medians, seven-sample ranges, Node/Rust median ratios, mixed result interpretation, and failed-attempt context. No mutable `snapshot.json`, SDK binaries, or Node binary is included.


## Candidate 1: first revision, not accepted

`candidate1/` preserves the measured first revision independently from the accepted baseline epoch and any later candidate. It is based on Git commit `af54d3a3c6ba256012d5254edd140f1b748065b5` plus two source overrides, with 1,495 verified inputs and source-tree SHA-256 `c14213d652809da3666cc0a8c7c74e7a3bdf1bc7e9ed1c7ee528c743253a780e`. It uses the same benchmark input hash as baseline and records its own provenance/report hashes.

Semantic checks and the benchmark passed after an operational cache-guard interruption and same-source compiler resume. Performance is mixed: the large-payload Rust median improved 59.7%, while small, wide, deep-selected, and escaped-string Rust medians regressed 17.3%, 20.7%, 24.2%, and 9.2%, respectively. Candidate 1 is **not accepted as a performance improvement**. Candidate 2 is preserved separately in `candidate2/`; its source and results do not change this candidate 1 conclusion.

Its 51 payloads are all indexed in `artifact-index.json` with origin, raw/stored hashes, and byte sizes. The package contains immutable candidate source and test overrides, source binding, semantic oracle outputs (excluding 445 copied public package files), round-two input/provenance/Node/Rust reports and independent pins, logs and receipts for all eight runs, cache maintenance records, final production readback, and reproduction scripts. Log and large JSON payload compression is lossless. No mutable snapshot or duplicate Node/SDK binary is included.


## Candidate 2: accepted local allocation improvement

`candidate2/` contains the complete evidence for the accepted local allocation improvement. Its source is commit `b4b22630222b3ffd24a9c6f35c234e57eccf2279`, tree SHA-256 `5753a16fe447d7a8e5c1e005e4dd83265c350ffa482a5f2fdc7c98a862972213`, with all 1,495 source inputs verified. The workload input is unchanged from the baseline and candidate 1. Candidate 2 removes pending allocation on scalar roots, uses array continuation frames instead of a per-array-index `Vec`, borrows unescaped keys, preserves the raw/escaped UTF-8 and UTF-16 comparison boundary, and bounds reservation to 4,096. It adds no dependency or public API.

The quality run passed formatting, source oracle checks, shared-core and configured feature checks, strict Clippy, and relevant exact-source replays. Counts verified from the run evidence: 31 document cases, 1,362 parser cases across five time zones, 333 query cases, and 126 deletion cases. Final production readback found 18 records unchanged and zero task-owned resources. The frozen input explicitly excludes three unverified Fish draft files and working-only Fish wiring.

The two pinned rounds retain their measured order: round 3 ran Node then Rust; round 4 ran Rust then Node. Each report has five workloads, all seven samples, per-round independent report pins, and identical input/provenance pins. Rust was consistently 1.9–2.2× faster than Node on large ignored payloads and 4.7–4.8× on deep selected values. Node was about 3× faster on wide objects. Small-string ranges overlap and the winner changes; escaped ranges overlap in round 3, while Node is faster with non-overlapping ranges in round 4. This supports a local allocation improvement in the measured operation only. No allocation count, RSS, whole-application, or production-latency claim is made. This change did not retire TypeScript; total migration remains incomplete.

All 65 candidate 2 payloads are indexed with origin, raw/stored SHA-256 and sizes. The package includes full semantic fixtures without copied public package files, two round input/provenance/Node/Rust sets, independent pins, 11 run logs and receipts, cache maintenance and final readback, and reproductions including the now-fixed chart generator. No mutable snapshot, SDK binary, Node binary, or copied 445-file package tree is included. The root [rendered benchmark chart](../../../artifacts/json-document-benchmarks.html) is linked as-is; it was already rendered and is not regenerated by this package task.
