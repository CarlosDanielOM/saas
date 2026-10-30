# Lossless JSON document baseline benchmark evidence — 2026-10-30

This package preserves the verified baseline matched benchmark. It does not contain or credit the separately authored optimization. [`artifact-index.json`](artifact-index.json) lists every payload under `artifacts/`, `runs/`, and `reproduction-tools/` with original path, raw/stored SHA-256, and raw/stored byte size. All run logs use lossless gzip while retaining their original names in the path; decompression reproduces exact bytes.

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
