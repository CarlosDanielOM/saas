# UTF-16 TTS follow-up evidence — 2026-10-28

This evidence pack supports [`utf16-tts-2026-10-28.md`](../../utf16-tts-2026-10-28.md). The source change is commit `5f1c1c1f`, verified against source tree SHA-256 `58017cad9f477975be038e1dc251ecb6550befc985e876b9f992e9131dbac173`.

## Artifacts

- `node-1793212201254161097-receipt.json` and `.log.gz`: Node source-oracle run with 18 actual Node/BSON cases and 27 TTS source cases. Oracle/preparation may load TypeScript; the separate measured benchmark worker reports `compilerLoaded: false`.
- `compiler-1793212513585649188-receipt.json` and `.log.gz`: capped Rust verification. The receipt records formatting, TTS-feature check, strict Clippy, five normal test executions, one explicitly invoked release benchmark, one ignored-by-default benchmark that was explicitly run, plus successful all-feature/all-target check, strict Clippy, and no-default-feature/all-target check.
- `tts-normalization-ts.json` and `tts-normalization-rust.json`: seven raw samples per fixture, iteration counts, output lengths, checksums, source hashes, and computed medians.
- `prepared/`: source-oracle JavaScript and fixture inputs used for the recorded runs.
- `recorded-verifier/`: preserved verifier scripts; they are evidence artifacts and were not executed on the host.
- `compressed-logs.json`: index of the compressed logs.
- `comparison.html` and `comparison-data.json`: the paired timing chart and its derived values.

## Benchmark interpretation

The timing covers normalization plus a UTF-16 checksum. It excludes JSON serialization, I/O, provider calls, and production request handling. The Node log records v24.22.1; its measured worker reports `compilerLoaded: false` in the benchmark JSON. The Rust result is a release build on 1.99.1. Source/harness hashes match the frozen compiler receipt. Workloads, output lengths, iteration counts and all seven sample checksums match between implementations. These results describe only the four included workloads.

The Rust compiler run used 6 CPUs, 4 GiB memory/no swap, two Cargo jobs, a 256 PID cap, and an 8 GiB cache ceiling. Recorded cache peak was 6,193,299,456 bytes, minimum available memory was 10,508,357,632 bytes, and `production_unchanged` was true. No Cargo dependency was added and `Cargo.lock` was unchanged.
