# Fish voice catalog migration evidence — 2026-10-28

This index covers the Fish catalog baseline candidate, failed iterations, and the final optimized candidate. Keep baseline and final-snapshot evidence separate; failed iterations are retained as history and are not final-code failures.

## Source and baseline identity

- Baseline abbreviated source revision: `26a54cec`.
- Baseline frozen source SHA-256: `b145e6789dd4bab805c4496310d3597de2a2a1f0fbd19484049634e9be10a8e4`.
- Baseline compiler run: `1793227228012731753`.
- Baseline Node oracle run: `1793227081100728697`.
- Optimized source revision: `344502ed`.
- Final frozen source SHA-256: `c7686221891ebbee134e8f4399fea7586481057b05760434ec0933eb84206485`.
- Final compiler run: `1793228464989174096`.
- Final Node source-oracle run: `1793228300161265309`.
- [`verification-summary.json`](verification-summary.json) consolidates candidate identity, test counts, source scenario counts, benchmark-input identity, and migration/deployment status.

The final matrix reports 58 ordinary test executions (10 library, nine catalog, six Kokoro, 13 Piper, 16 Fish, and four TTS/JS-string regressions), six explicit fixture executions, and one release benchmark invocation. Formatting, standalone/all-feature checks, Clippy, and no-default-feature checks passed. The source oracle replayed all 126 catalog scenarios: 15 resolve, 28 parse, 59 normalize, 10 get, 12 search, and two sequence cases. The two cache traces total 108 steps; 123 source HTTP calls were recorded and all were fixture controlled. The prepared-NaN case was replayed. The remaining explicit fixtures were two provider replays (34 cases) and three Fish fixtures. No external provider was contacted.

The final compiler script took 145.912 seconds (153.739 seconds total) with six CPUs, 4 GiB memory/no swap, 256 PIDs, and two Cargo jobs. Peak cache: 7,246,712,832 bytes. Minimum available memory: 10,573,561,856 bytes. Production unchanged: true. The baseline compiler script took 157.473 seconds (165.278 seconds total), with peak cache 7,245,889,536 bytes, minimum available memory 10,791,972,864 bytes, and production unchanged. These are per-run resource observations, not speed or efficiency claims.

## Benchmark scope and preserved initial result

The paired benchmark uses prepared objects, not JSON parsing or HTTP. TypeScript executes normalization, `JSON.stringify`, UTF-8 `Buffer` conversion, and a checksum over every output byte. Rust executes normalization, the lossless JSON serializer, UTF-8 bytes, and the same full-byte checksum. Each side used 100 warmups and seven samples, with 10,000 iterations per ordinary workload and 1,000 for the large workload. All output bytes and checksums matched.

Initial medians (microseconds per operation) were:

| Workload | Node | Rust | Rust / Node |
|---|---:|---:|---:|
| valid | 2.566394 | 1.6963551 | 0.661× |
| cuts | 10.091748 | 15.1674329 | 1.503× |
| gender | 5.7555384 | 8.1026978 | 1.408× |
| large | 155.67234 | 437.766028 | 2.812× |

The cuts, gender, and large workloads were slower in this initial Rust candidate. Keep this baseline and its raw samples alongside the final pair. Both runs use the same prepared-input hash: `317abf0b1d4a186a9e172e4ebe7ff6f1270ad17de8ccb98e01c4c0404409caa5`.

The final medians (microseconds) were:

| Workload | Node | Rust | Rust / Node | Final Rust / initial Rust |
|---|---:|---:|---:|---:|
| valid | 2.0500612 | 0.6123702 | 0.299× | 0.361× |
| cuts | 9.8888634 | 9.6632318 | 0.977× | 0.637× |
| gender | 4.9162564 | 1.8951952 | 0.385× | 0.234× |
| large | 134.655906 | 62.157969 | 0.462× | 0.142× |

All four final output JSON strings/UTF-8 bytes, byte totals, and full-byte checksums matched for seven samples. The cuts medians are within roughly 2.3%; describe this as near parity without a significance or faster claim. Node and Rust values both varied between runs, and measurement was sequential, not interleaved; do not infer causal speedup or production performance.

The benchmark uses sequential pinned containers on a shared host, without interleaved/randomized sampling. It is a synthetic prepared-normalizer/serialization microbenchmark. It does not measure provider or HTTP latency, whole-service throughput, CPU, or RSS and cannot support production-performance claims.

## Oracle fixture iteration notes

The catalog source fixture is [`fish_catalog_reference.mjs`](../../../dimabot/tests/fixtures/fish_catalog_reference.mjs); Rust replay is in [`fish_voice_catalog.rs` integration tests](../../../dimabot/tests/fish_voice_catalog.rs). The first oracle expectation incorrectly allowed an ID ending in LF; the source rejects it before fetch. After correcting the fixture, source replay passed. The negative-zero raw input was corrected before the accepted baseline because `JSON.stringify(-0)` emits `0`. These are fixture-preparation corrections, not Rust semantic defects. The failed Node receipt `node-1793226039825661692` is preserved as history.

Two compiler iterations are also retained: `compiler-1793226556489146737` stopped on two style lints, and `compiler-1793226856401964075` stopped on the test helper's two-chunk parsing. Those were corrected before the accepted baseline and final runs. They were not runtime behavior failures.

## Artifact index

- Final receipts: [`compiler-1793228464989174096-receipt.json`](compiler-1793228464989174096-receipt.json), [`node-1793228300161265309-receipt.json`](node-1793228300161265309-receipt.json); compressed logs [`compiler-1793228464989174096.log.gz`](compiler-1793228464989174096.log.gz), [`node-1793228300161265309.log.gz`](node-1793228300161265309.log.gz). Their uncompressed SHA-256 values and byte lengths are in [`compressed-logs.json`](compressed-logs.json).
- Baseline receipts: [`compiler-1793227228012731753-receipt.json`](compiler-1793227228012731753-receipt.json), [`node-1793227081100728697-receipt.json`](node-1793227081100728697-receipt.json), with compressed logs and hashes indexed in `compressed-logs.json`.
- Failed iteration history: compiler receipts/logs for runs `1793226556489146737` and `1793226856401964075`, plus Node run `1793226039825661692`, are retained at this directory root.
- Generated TypeScript source fixture: [`fish-catalog-reference.json.gz`](fish-catalog-reference.json.gz); its decompressed SHA-256 and byte count are in [`compressed-fixtures.json`](compressed-fixtures.json). [`fish-catalog-fixtures-before.sha256`](fish-catalog-fixtures-before.sha256) and [`fish-catalog-fixtures-after.sha256`](fish-catalog-fixtures-after.sha256) record unchanged fixtures before/after final validation.
- Initial benchmark: [`initial-benchmark/comparison-initial.json`](initial-benchmark/comparison-initial.json), source inputs, and raw Node/Rust samples. Final benchmark: [`final-benchmark/comparison.json`](final-benchmark/comparison.json), source inputs, and raw Node/Rust samples. Both comparison files contain source/input identity and per-workload byte/checksum data.
- Reproducibility helpers are archived under [`recorded-verifier/`](recorded-verifier/). `compressed-logs.json` and `compressed-fixtures.json` index decompressed hashes; the full candidate source-file hashes are preserved in compiler and Node receipts.

Final exact-snapshot validation and paired benchmark evidence are recorded. No deployment, caller adoption, TypeScript retirement, or push occurred; no production service was changed.

The [comparison](comparison.html) displays the final workload medians. [`cleanup.json`](cleanup.json) records the post-check production identity and task-resource audit; [`sha256.json`](sha256.json) covers this pack. Decompress the source fixture to its original JSON name in a disposable fixture directory before replaying. The recorded verifier uses task-specific absolute paths and is a test record, not a release command.
