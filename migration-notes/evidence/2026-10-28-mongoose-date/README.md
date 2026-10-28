# Mongoose Date casting evidence — 2026-10-28

This pack records source-oracle parity, native schema integration, disposable MongoDB persistence, quality checks, and the paired synthetic caster benchmark for the [feature note](../../mongoose-date-2026-10-28.md). It does not establish full Mongoose/schema parity or production readiness.

## Final source-matched verification

The final compiler/fixture run is [compiler-fixtures-1793219493832792474](compiler-fixtures-1793219493832792474-receipt.json), with its compressed log. The paired Node oracle is [node-1793219446583406943](node-1793219446583406943-receipt.json), also with a compressed log. Their source-tree SHA-256 is identical:

`95b1258b52f1569839461f7954eb2e1267c75c605e1167a8bc1feeba601e1078`

The lead checked that the current files still match the final manifest and that all five generated timezone fixtures remained byte-identical before and after the native run. Strict formatting, standalone `application-schemas` all-target check and Clippy, all-feature all-target check and Clippy, and no-default-feature all-target check passed. No package, version, or lockfile change was made.

The compiler container was limited to 6 CPUs, 4 GiB memory with no swap, 256 PIDs, two Cargo jobs, and an 8 GiB private Cargo cache. The 228.627-second verification script took 240.588 seconds including bootstrap and fetch. Peak cache use was 6,852,071,424 bytes; minimum available memory was 8,823,791,616 bytes, above the 4 GiB floor. The receipt verifies these limits and `production_unchanged: true`.

The oracle was pinned to Node 24.22.1, V8 13.6.233.17-node.58, ICU 78.3, tzdata 2026e, and Mongoose 8.24.2. Node's bundled ICU supplied its timezone rules. The isolated Rust compiler used the task-owned OS tzdata package 2026e-r0. The source fixture generated 80 cases in each of UTC, America/New_York, Europe/Berlin, Australia/Lord_Howe, and Pacific/Apia. In every timezone, native checks matched all 80 cases across the direct caster, a synthetic schema, and the actual admin schema: 1,200 case/path comparisons. Separate checks covered missing required fields and defaults.

The final run recorded 64 ordinary Rust test executions: five date parity tests, 54 library tests, three application-schema tests, and two additional focused checks. Three explicitly run disposable MongoDB fixtures also passed: the new admin repository persistence test and two existing application-schema fixtures. Four explicit release benchmark invocations passed. These are separate categories; they are not a unique behavior-coverage score. The regular harness reported three ignored occurrences: two MongoDB fixtures were subsequently run explicitly and passed, while the separate application-schema benchmark was not run in this wave.

## Source and fixture manifest

Each generated fixture records SHA-256 hashes for the actual oracle script, `admin.schema.ts`, and Mongoose's `lib/cast/date`, `lib/schema/date`, `lib/schemaType`, and `lib/error/cast` sources. The UTC fixture metadata lists those hashes directly. The paired Node and Rust receipts list the complete frozen source manifest. The five copied JSON fixture hashes are recorded separately in [`mongoose-date-fixtures-before.sha256`](mongoose-date-fixtures-before.sha256) and [`mongoose-date-fixtures-after.sha256`](mongoose-date-fixtures-after.sha256); the lead confirmed the before/after manifests match.

The [negative control](mongoose-date-negative-control.json) restores only `dimabot/src/schemas/schema.rs` from HEAD `112866a0` and runs the expanded corpus against the old shared date cast. It fails as expected for the JSON string `"0"`: the old integration reports a date cast error at path `d`, while Mongoose produces 2000-01-01 UTC (`946684800000` ms). The native helper already handles this value, so the negative control isolates the missing shared-schema integration. Its compiler receipt and log preserve this intentional failure; it is not a failed final candidate.

## Synthetic benchmark

The benchmark compares the actual Mongoose 8.24.2 caster in Node with the Rust BSON helper using prepared UTC fixture values. Four workloads use 10,000 operations per sample, one 10,000-operation warmup, and seven measured samples. Fixture decoding, setup, JSON, and file I/O are outside the timed loop. All seven paired samples matched case indices, checksum, valid, null, and invalid counts. Values below are the median elapsed microseconds per operation and the Rust/Node elapsed-time ratio:

| Workload | Cases | Node (µs/op) | Rust (µs/op) | Rust / Node elapsed time |
| --- | ---: | ---: | ---: | ---: |
| Numeric | 16 | 0.1841109 | 0.0164077 | 0.08912× |
| String | 28 | 0.2968582 | 0.2059498 | 0.69376× |
| Invalid | 30 | 47.1121648 | 0.0561672 | 0.001192× |
| Mixed | 80 | 17.1098786 | 0.0889646 | 0.005200× |

The benchmark scope matters. The Node invalid path throws and allocates assertion errors with stack details; Rust returns typed errors without formatting those details. Invalid and mixed ratios include materially different error work, so they do not compare equivalent production error reporting. The mixed fixture is 37.5% invalid. The Rust numeric path avoids JavaScript Date object allocation, while its string path reuses borrowed numeric-string input and the parser. These are implementation-shape observations, not isolated causal timings. No production latency, throughput, CPU, RSS, or error-rate claim follows. No regression appeared within these four caster workloads; that does not remove regressions recorded in the separate JS Date parser, AST, or pure-helper comparisons.

Raw paired outputs are `mongoose-date-{node,rust}-{numeric,string,invalid,mixed}.json`; [mongoose-date-comparison.json](mongoose-date-comparison.json) contains the medians and matching counts. The earlier Node receipt [node-1793219071841352690](node-1793219071841352690-receipt.json) and compressed log preserve the first oracle-generation receipt; the final oracle receipt supersedes it for the source-matched run.

## Files and reproduction record

- `fixtures/{UTC,America_New_York,Europe_Berlin,Australia_Lord_Howe,Pacific_Apia}.json` — source-generated expected outcomes and provenance.
- `compiler-fixtures-1793219493832792474-receipt.json` and `.log.gz` — final candidate verification and limits.
- `node-1793219446583406943-receipt.json` and `.log.gz` — final source-oracle generation.
- `compiler-1793219256581157263-receipt.json` and `.log.gz` — intentional negative-control failure.
- `mongoose-date-node-*.json`, `mongoose-date-rust-*.json`, `mongoose-date-comparison.json` — raw timing samples and summary.
- [`recorded-verifier/mongoose-date.sh`](recorded-verifier/mongoose-date.sh), [`validate.py`](recorded-verifier/validate.py), and [`apply_format.py`](recorded-verifier/apply_format.py) — recorded verification and result validation helpers.

No production data or services were used; the receipts record unchanged production identity. No deployment or push occurred. Exact application adoption remains pending, and the input-model and timezone-data limitations in the [feature record](../../mongoose-date-2026-10-28.md) remain.
