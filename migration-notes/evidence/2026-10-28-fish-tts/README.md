# Fish TTS evidence — 2026-10-28

Original task artifact directory: `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/`. The frozen native source snapshot SHA-256 is `82dc1017cb864f677438595aa597d26d0764062371ed18a319fb5dfdc6f11440`.

## Validation

- `compiler-1793222683480124413-receipt.json` and `.log.gz`: final compiler matrix receipt and output; source hash above; compiler 179.002 s, total 185.949 s; 6 CPU, 4 GiB, no swap, 256 PID, Cargo 2-job cap; production unchanged. Passed formatting, standalone TTS check/Clippy, all-feature check/Clippy, no-default check, 9 library tests, 16 ordinary HTTP tests, 3 SDK/source fixture checks, one release benchmark, and 4 TTS utility regressions.
- `node-1793223021678187908-receipt.json` and `.log.gz`: final Node source oracle passed in 8.505 s (9.695 s total) against the same source SHA and records production unchanged. It regenerates/checks 39 SDK protocol cases, 7 retry schedules, pending-backoff abort, 11 service cases, 3 public-path cases, and 9 benchmark workloads.
- `compiler-1793222439398514104-receipt.json` and `.log.gz`: preserved failed regression run. Its redaction check exposed that broad replacement could rewrite a static model string containing the API key. The implementation was narrowed to remote-body redaction and a regression was added before the final green compiler run.

- `compiler-1793223195182073204-receipt.json` and `.log.gz`: post-oracle confirmation of the three explicit fixture tests, with the same frozen source hash. `fish-tts-fixtures-before.sha256` and `fish-tts-fixtures-after.sha256` are identical. This rerun confirms the final regenerated fixtures; it is separate from the test counts above.

## Source and fixtures

Frozen source files are `dimabot/src/server/services/tts/{fish_tts,fish_protocol,speech_paths,tts_provider,mod}.rs`, `dimabot/src/utils/ai/openrouter/app_attribution.util.rs`, and `dimabot/tests/tts_providers.rs`. Source oracles and benchmark fixtures are `dimabot/tests/fixtures/fish_tts_reference.mjs`, `fish_sdk_oracle.mjs`, and `fish_msgpack_benchmark.mjs`. The final receipt's `source_hashes` map contains the per-file SHA-256 values. The TypeScript source service and backend tests remain in `dimabot/src/server/services/tts/` as the comparison source.

The source-generated fixtures are preserved losslessly as `fish-tts/{fish-sdk-protocol,fish-tts-reference}.json.gz`; decompress them to the original `.json` names in a disposable fixture directory before replaying. `compressed-fixtures.json` records their uncompressed hashes. The SDK fixture contains 39 raw request encodings, all matched by Rust; 38 were also replayed through actual native loopback HTTP requests. The cue-reinforcement case is encoded directly here and exercised through the full service in the TypeScript service fixture. Eleven direct HTTP error-body cases were checked; the typed malformed-JSON case checks rejection rather than V8-specific parser wording. All 11 TypeScript service scenarios and the two valid public-path results passed; the third path case records the source URIError for an unpaired surrogate outside the Rust path input model. Seven SDK retry schedules are recorded by the actual installed SDK; native retry policy unit tests and HTTP/cancellation tests provide separate evidence rather than claiming a complete one-to-one replay of every schedule.

## Benchmarks

Raw matched artifacts are `fish-tts/node-benchmark.json` and `fish-tts/rust-benchmark.json`; `fish-tts/comparison.json` contains all nine per-workload medians, byte counts, checksums, and ratios. Each compares seven samples with 100 warmups; ordinary workloads use 10,000 iterations and the 65,536-unit workload uses 1,000. Both encode three-field MessagePack and checksum every encoded byte. Byte totals, checksums, and iteration counts match. Rust/Node median ratios range from 0.095 to 0.474 across these cases (0.110 for the 65,536-unit workload). The runs used sequential pinned containers on one shared host, not an interleaved statistical study. These measure encoding plus checksum work; there is no HTTP, provider/network latency, whole-service throughput, CPU, or RSS result.

The pack preserves the finalized receipts, losslessly compressed logs, generated fixtures, raw benchmark pair, comparison, and recorded verifier. `compressed-logs.json` records uncompressed log hashes; `sha256.json` covers every other file in this pack. The verifier uses task-specific absolute paths and is a record of isolated testing, not a release command. The source receipt hash is the scope key for these artifacts; do not combine evidence from other candidate snapshots.

## Production and scope

No deployment or caller cutover occurred. The final compiler receipt records production unchanged. This note records the native Fish HTTP slice only; `SpeechPaths` application configuration, provider registry/callers, Piper/Kokoro, the emote catalog, queues, and broader TTS orchestration remain open.
