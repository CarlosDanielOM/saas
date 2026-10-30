# AI usage context lossless evidence

This evidence package records bounded Rust parity work for `src/utils/ai_usage_event.ts`. The accepted final snapshot is commit `08ab85ddb3f1277a934699f8ea3d0b4d31d41ff2`, source-tree SHA-256 `628038fa15652be3c11e3b301bb9c519421c6fd872eeb2b21c59c0cae7e81ef4`.

## Final source and native checks

The final Node run `node-1793347937036370605` checked the actual TypeScript oracle and wrote/checked an exact 132-record corpus: 130 context cases plus two metadata cases. Node was v24.22.1, V8 13.6.233.17-node.58, TypeScript 5.9.3. Its source bindings cover 1,452 inputs: 1,442 Git inputs at the candidate commit and ten SDK inputs reused from the prior [`moderation-variations` source binding](../2026-10-30-moderation-variations/source-bindings.json), `cache-and-types.archiveVerifiedSdkInputs`. The final corpus SHA-256 is `442013548f86179ab01de38d2c609d4fddc47f187f029281d035898574e8b598`. `attempt1` and `attempt2` corpus files are byte-identical.

The matching final capped compiler run is `compiler-1793347937036016292`. It ran the two ordinary lossless tests and one ignored actual-source replay (three passed), scoped strict Clippy, no-default all-target check, Mongo/Redis all-target check, and all-feature all-target strict Clippy. Limits were six CPUs, 4 GiB memory with swap disabled, 256 PIDs, and two Cargo jobs. The compiler step was 95.994 seconds; total phase time was 105.093 seconds. Read-only production comparison reported unchanged production and zero remaining task-owned resources; see `production-readback.json`.

The earlier `format-1793347708507063984` snapshot preserves the pre-format source and is history only. The first Node/compiler pair used 1,453 inputs, including un-wired accounting test support. The accepted final pair uses the later 1,452-input snapshot named above, with that unrelated input excluded. Parent corrections to the CommonJS export binding and independent source/native provenance plus ignored-replay checks preceded the first oracle execution. The initial verbal context count of 129 was corrected to the actual 130; all 130 context and two metadata records were visited.

## Files

- `corpora/attempt1/` and `corpora/attempt2/` — compact source-generated JSON corpus, not a source clone.
- `runs/` — five run receipts and five raw logs for the inclusive run interval `1793347708507063984`–`1793347937036370605`. Receipt source-hash maps bind the frozen inputs.
- `parent-final-facts.json` — corrected final counts, source tree, accepted run identities, contract, and limits.
- `production-readback.json` — read-only final comparison.
- `reproduction-tools/` — lossless oracle and quality commands plus the needed existing freezer chain, formatter, validator, and final-readback helper. The freezer chain references earlier verified source-binding evidence rather than copying the upstream source tree.
- `verification-summary.json` and `input-provenance.json` — concise machine-readable evidence index.

No runtime-performance measurement, caller adoption, deployment, retirement, or total migration completion is claimed. The matrix row remains partial pending the parent’s completion and retirement decision.

The [artifact hash index](artifact-sha256.json) binds every retained payload except the index itself. Raw and stored hashes coincide for these uncompressed payloads.
