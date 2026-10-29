# Channel TTS settings evidence — 2026-10-29

This index describes the scoped local implementation of the archived channel TTS settings source. The task-owned rawpack is under `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/`; its receipts, exact candidate hashes, full logs, and cleanup details are authoritative. The `channel-tts-settings/` subdirectory contains the source-oracle data, benchmark inputs/results, Mongo evidence and final comparison.

## Source and implementation

- Frozen source row: `src/schemas/channel_tts_settings.schema.ts`, SHA-256 `5e943f59906bdf4f63dbb52497ccc8607c6fb069cf8b9af0521a4652245c64c2`.
- Exact archived copy: `archives/dimabot-typescript/2026-10-28/src/schemas/channel_tts_settings.schema.ts`; archive manifest and `archive-check.json` record the source/archive comparison.
- Native schema and persistence: `dimabot/src/schemas/channel_tts_settings.schema.rs`.
- Defaults and pure normalizer: `dimabot/src/utils/tts/settings.rs`.
- Lossless owned JSON shared core: `dimabot/src/utils/lossless_json.rs`; existing `server/services/tts/lossless_json.rs` path is a re-export.
- Reused existing native code: `utils/tts/mod.rs` (provider, Kokoro default, expressive tag selector/catalog), `utils/tts_defaults.rs`, `utils/bson_compat.rs`, `utils/js_string.rs`, `utils/json_number.rs`, and the schema/users repository modules.
- Cargo feature: `channel-tts-settings = [application-schemas, tts-utilities]`; no Cargo.lock/dependency or default/deployed-profile change.

## Behavior evidence

The final post-archive source-oracle record is `node-fixtures-1793233234807630079`; it passed 308 settings-pure cases, 11 Mongoose schema cases, and replayed real isolated Mongo write behavior. The source probe established that `doc.set(normalized)` marks the nested `filters` path dirty even for identical input; the Rust dirty planner was corrected and replayed. The final candidate record is `compiler-fixtures-1793233281096683230`, source tree SHA-256 `0b8de5bf5986e9a546449eb466f54777bfcc7249fa4ebadb09f722a046f5e3c7`. It passed 114 ordinary Rust test executions, four explicit source-backed fixture executions (308 settings-pure cases, 11 Mongoose schema cases, isolated real Mongo replay, and 276 prior credit-fallback cases), and one release benchmark invocation. The 114 ordinary executions cover 56 library tests plus the named TTS/schema/provider/catalog groups. All formatting, standalone and all-feature all-target checks, Clippy with warnings denied, and no-default-feature check passed. Ordinary plus explicit test executions total 118; including the separate benchmark invocation gives 119 recorded operations.

The final compiler script took 22.436 seconds (32.278 seconds total); its task-owned compiler used a 6 CPU, 4 GiB, no-swap, 256 PID, two-job cap. The final Node script took 21.509 seconds (25.126 seconds total). The recorded minimum available memory was 11,500,703,744 bytes; warm cache was 7,507,410,944 bytes. The receipt reports `production_unchanged: true`. The final source/archive check verified all 17 archived hashes and byte equality for the schema. The archive now contains 17 files; 789 TypeScript files remain in the live application tree. Intermediate failures and corrected candidates remain in the artifact history and are not final-candidate failures.

## Comparative microbenchmarks

The initial five-workload run and final six-workload run each used seven samples and 100 warmups, with prepared inputs and output bytes/checksums compared within each run. Both measure normalization plus JSON/UTF-8 serialization and byte summing; they exclude JSON parsing, VM startup, Mongo and I/O. The initial run used a different input set from the final run, which added the saved-all-tags representative case. Values are median microseconds per operation:

| Workload | Initial Node | Initial Rust | Final Node | Final Rust | Final Rust/Node |
|---|---:|---:|---:|---:|---:|
| Empty settings | 35.1891042 | 19.565698 | 34.6010716 | 20.3305421 | 0.588× |
| Provider selection (Kokoro) | 34.6571319 | 20.973041 | 33.4866481 | 20.9332211 | 0.625× |
| Numeric normalization | 35.1373412 | 23.5158873 | 33.629628 | 22.450364 | 0.668× |
| Expressive tags | 39.3068324 | 14.1292985 | 37.2891049 | 14.2223032 | 0.381× |
| Large settings | 142.038051 | 44.988952 | 146.001651 | 41.358985 | 0.283× |
| Saved settings with all 75 tags | — | — | 36.8612615 | 17.6927251 | 0.480× |

The final six-workload input SHA-256 is `bb94b740b0e3fd2bba00eac974280acf76155198b06f972bf1b7b6edbcb32db3`; final Node/Rust output bytes and checksums match. The common five cases are comparable only with their own input/workload definitions; the initial and final input hashes differ. Runs were sequential on a shared host, not interleaved statistical experiments; ratios are descriptive fixture measurements without significance or causal claims. They establish no production latency, CPU, or RSS result. Do not attribute runtime results to a model.

## Limits and operational disposition

Supported input is ordinary JSON data. The native BSON boundary explicitly rejects non-plain BSON types and depth greater than 128; int64 promotion is limited to ±2^53; lone UTF-16 surrogate replacement occurs only at BSON persistence. These constraints and the application-adoption gaps are detailed in [the migration note](../../channel-tts-settings-2026-10-29.md).

Testing used task-owned isolated resources; the final verification reports production unchanged and task-owned resource cleanup complete, with the private evidence cache retained. Source code was committed locally as `e4308e57`. No production deployment, caller cutover, or push occurred. The rawpack retains the before/after production identity evidence, cleanup record, source hashes, archive check, fixtures and verifier logs.

## Committed artifacts

- [Verification summary](verification-summary.json), [archive check](archive-check.json), [cleanup/production integrity](cleanup.json), and [artifact hashes](sha256.json).
- Final [compiler receipt](compiler-fixtures-1793233281096683230-receipt.json) and [log](compiler-fixtures-1793233281096683230.log.gz), [Node receipt](node-fixtures-1793233234807630079-receipt.json) and [log](node-fixtures-1793233234807630079.log.gz).
- [Compressed fixture index](compressed-fixtures.json), [compressed log index](compressed-logs.json), [before](channel-tts-settings-fixtures-before.sha256) and [after](channel-tts-settings-fixtures-after.sha256) fixture integrity.
- [Final comparison](final-benchmark/comparison-final.json), [inputs](final-benchmark/channel-tts-settings-benchmark-inputs.json), [Node samples](final-benchmark/channel-tts-settings-node-benchmark.json), [Rust samples](final-benchmark/channel-tts-settings-rust-benchmark.json), and [interactive comparison](comparison.html). The initial five-workload data and comparison are retained under `initial-benchmark/`, and the six-workload pre-retirement pair under `pre-retirement-benchmark/`.
- [Source dirty-path proof](dirty-path-probe.json) and [probe harness](recorded-verifier/channel_tts_dirty_probe.mjs).
- Recorded [compiler checks](recorded-verifier/channel-tts-settings.sh), [source oracle commands](recorded-verifier/channel-tts-settings-node.sh), [isolated resource driver](recorded-verifier/validate.py), and [format application helper](recorded-verifier/apply_format.py). The driver retains task-specific absolute paths as a verification record, not a deployment command.

Decompress the fixture files to their original JSON names in a disposable directory before replay. The failed compiler/API, timestamp parity, and style-check iterations and the pre-retirement accepted candidate have separate receipts/logs in this directory; their source hashes remain distinct from the final candidate.
