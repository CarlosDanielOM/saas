# Expressive TTS tag types evidence — 2026-10-29

## Result

The implementation commit is `3b74f7b3fd639acc2052945f15dcbf8334577c7a`; the source tree SHA-256 is `58d448c24c85b0e2ddcf8d9a1490f24883107ec9bf565c30c50ce4390359f073`. The local public tag/config type contract is covered and verified. Whole-project source-retirement reconciliation and application caller inventory remain open; this slice does not adopt callers or complete the migration.

`ExpressiveTtsTag` uses a private checked catalog index, exact canonical parsing, `FromStr`, `as_str`, and catalog-order iteration. `ExpressiveTtsTagSettings` uses a private catalog-sized bool array, complete typed access, shared normalization, and source-ordered JSON output. Existing map APIs remain available with lexical iteration. No dependency, manifest, lockfile, default, worker profile, or algorithm changed.

## Implementation and source oracle

- Rust type implementation and module export: `dimabot/src/utils/tts/tag_types.rs`, `dimabot/src/utils/tts/mod.rs`.
- Typed tests: `dimabot/tests/expressive_tag_types.rs`.
- Actual-TypeScript oracle and wire capture: `dimabot/tests/fixtures/expressive_tts_reference.mjs`, `dimabot/tests/expressive_source.rs`.
- Node receipt: [node-1793240971993488017-receipt.json](node-1793240971993488017-receipt.json); compressed log: [node-1793240971993488017.log.gz](node-1793240971993488017.log.gz).
- Formatter receipt: [format-1793240819016642967-receipt.json](format-1793240819016642967-receipt.json); compressed log: [format-1793240819016642967.log.gz](format-1793240819016642967.log.gz). Formatting passed after the acknowledged API release and applied formatting to one Rust test file.
- Source corpus: [expressive-tts-reference.json.gz](expressive-tts-reference.json.gz). Its four source groups contain 1,229 filter, 185 reinforcement, 314 normalization, and 204 voice cases (1,932 total). Normalization includes exact `JSON.stringify` output for each of the 314 wires.

## Native verification

- Compiler receipt: [compiler-1793241065037267404-receipt.json](compiler-1793241065037267404-receipt.json); compressed log: [compiler-1793241065037267404.log.gz](compiler-1793241065037267404.log.gz).
- [verification-summary.json](verification-summary.json) records 17 ordinary test executions: three library, five expressive-lossless, three typed-tag, one JavaScript, two credit, and three TTS. One explicit expressive fixture replayed all 1,932 cases, including all 314 typed-record JSON wires.
- Strict formatting, standalone TTS all-target check and Clippy, all-features all-target check and Clippy, and no-default-features check passed. The verified caps were six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. Peak cache was 7,606,558,720 bytes; minimum available memory was 9,828,257,792 bytes.
- Fixture hashes matched before and after: [before](tts-tag-types-fixtures-before.sha256) and [after](tts-tag-types-fixtures-after.sha256).
- Four recorded verifier files: [format verifier](recorded-verifier/apply_format.py), [Node verifier](recorded-verifier/tts-tag-types-node.sh), [Rust verification script](recorded-verifier/tts-tag-types.sh), and [validation utility](recorded-verifier/validate.py). Compressed fixture/log indexes are [compressed-fixtures.json](compressed-fixtures.json) and [compressed-logs.json](compressed-logs.json).
- [cleanup.json](cleanup.json) confirms all 19 inspected production records were unchanged during validation against the user-acknowledged API baseline, and that no task-owned containers, networks, or volumes remained. Provider, Mongo, and worker suites were not rerun because those implementations were unchanged and the new types have no callers there.
- [tts-tag-types-preflight-inventory-difference.json](tts-tag-types-preflight-inventory-difference.json) records that the baseline transition was already present before testing: 19 records were inspected, `/dima-server` reflected the acknowledged release, and the other 18 matched. No production mutation was made by this migration session.
- No benchmark was run; there is no runtime CPU, RSS, memory-saving, or speedup result for this follow-up.
- [sha256.json](sha256.json) inventories the evidence artifacts.

## Production baseline and independent source delta

The user acknowledged expected release `api-bc6455f1979f` at `2026-10-29T02:11:45.979275752Z` as a small `pet.talk` TTS parser/filter fix. The [production baseline transition](production-baseline-transition-api-bc6455f1979f.json) records the original fingerprint `7eaaaad042c277d84cf49c184f2d7cf5806a641c687772acd8ca69cfc2403c53`, the acknowledged fingerprint `50903c6a12f924a8fa842db591bb68472fe98c522309d790a03743714add3536`, and 18 other unchanged records. The original production-before snapshot remains preserved at `/root/.local/state/rust-full-migration-20261028-lu443ytp/production-baselines/before-api-bc6455f1979f.json`; this candidate's cleanup comparison uses the acknowledged fingerprint.

The read-only source delta is commit `9d35bd1ece3304627bdadee637e899d51cc6d7ad`. It changes `runtime.ts` and adds two source obligations beyond the frozen 806-file baseline: `speech_text.ts` and `speech_text.test.ts`. The externally observed files, patch, and manifest are preserved under [external-source-api-bc6455f1979f](external-source-api-bc6455f1979f/): [runtime.ts](external-source-api-bc6455f1979f/dimabot/src/pets/runtime.ts), [speech_text.ts](external-source-api-bc6455f1979f/dimabot/src/pets/speech_text.ts), [speech_text.test.ts](external-source-api-bc6455f1979f/dimabot/src/pets/speech_text.test.ts), [patch](external-source-api-bc6455f1979f/pet-talk-change.patch.gz), and [manifest](external-source-api-bc6455f1979f/manifest.json). These remain open native pet runtime obligations; their preservation is a source reference, not a completed archive or port.
