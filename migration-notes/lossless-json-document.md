# Reusable flat JSON document — 2026-10-30

**Status: accepted native Rust utility capability.** The source-bound implementation at commit `94fd1031381e397d749abf641e2db9fe285f9aa5` adds a reusable flat JSON document and view layer, while preserving the established `lossless_json_view` API as the TTS coercion adapter. The immutable source binding covers 1,491 inputs (1,481 Git inputs and ten reused SDK inputs), tree SHA-256 `d66bd88a1496d50a55b097531e5e9f0c89cd91b5392c136cc1a7d874243ca053`, and matching input hashes.

This is a shared Rust capability, not retirement of a TypeScript feature. No original TypeScript file was retired, no production deployment or caller cutover occurred, and no central dependency-matrix row is attributable to this utility alone. The unrelated flat deletion helper remains separate future work; it was not validated or accepted here.

## Design and compatibility boundary

`JsonDocument` validates the complete input with the existing JSON parser, then builds a flat span index over the validated bytes. `JsonView` borrows that document and its index. Documents can retain borrowed input or own it through `Cow`; a selected subtree can become an owned document without self-references. The implementation uses an iterative indexer and canonical writer rather than constructing a recursively owned JSON tree. Memory is proportional to input tokens and the flat span index.

The utility retains existing scalar, binary64, UTF-16 string, duplicate-key, and JavaScript array-index ordering policies. Object lookup is last-key-wins, `__proto__` remains an ordinary own key, and the canonical writer uses a heap work stack. Full-input syntax validation happens before accessors can shortcut string leaves. The existing `lossless_json_view` module reexports `JsonDocument`, `JsonView`, and `ArrayIter` and keeps its established TTS settings coercion methods on the shared view types. Its feature gate and Cargo dependency graph did not change; no crate or lockfile dependency was added.

The shared core was also checked against the existing AI usage receipt parser and ledger-query consumers as regression coverage. Native receipt and ledger-query readers reach the shared core through the established view API. TypeScript application callers remain unadopted. No benchmark was accepted, and verification timings below are not performance claims.

## Oracle interpretation and resource limits

The pinned Node oracle uses Node `v24.22.1`, V8 `13.6.233.17-node.58`, and Node binary SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`. The final fixture contains 31 document cases: 19 completed V8 canonicalizations, ten V8 `SyntaxError` cases, and two valid inputs for which `JSON.stringify` throws `RangeError` at depth 4096. Those two are parse-success/resource-limited serialization probes, not invalid JSON and not exact full-output parity cases. For the known repeated array/object probes, the oracle forms `expectedNativeCanonical` from a separately canonicalized shallow leaf and known delimiters, then checks Rust parsing and that construction. The fixture does not claim an exact complete V8 output for a stringify operation that V8 itself could not complete.

The first Node attempt (`1793364591190997086`) stopped because `JSON.stringify` raised a stack `RangeError` at depth 4096. This was an oracle-generation limitation, not a native parser failure. After explicitly classifying the V8 stages, attempt two and the final oracle generation passed. The Rust implementation's iterative parsing/indexing and writing do not claim parity for arbitrary V8 stack/resource exhaustion. Existing settings `String(array)` resource limits remain separate.

## Verification record

The successful final pinned-Node run `1793365976700379925` passed in 34.549 seconds total (30.512 seconds of check work). It generated and checked the 31-case document fixture, 1,362 source-parser cases across five time zones, and 333 actual-source ledger query scenarios. The document fixture SHA-256 was `53b76098859b1c6422aaeb558313a71d442d8f382b61fb1951e29b708f30fda8`; repeated generation produced the same hash. The parser/query replay checks are integration regression evidence, not benchmarks.

Final capped compiler run `1793366116696093196` passed in 252.971 seconds total (243.197 seconds compiler work). It passed the ordinary document/parser/query/view tests, the ignored exact document oracle replay, five timezone parser replays, the actual-source query replay, the minimal and Mongo+Redis checks. The final release profile also passed the exact document source replay and the source parser/query replays. Limits were six CPUs, 4 GiB memory with no swap, two Cargo jobs and 256 PIDs; minimum available memory was 10,077,163,520 bytes and private cache peak was 8,362,602,496 bytes.

The first functional compiler preflight `1793364758157952589` passed 27 ordinary tests before an oracle fixture was available. Compiler run `1793365040870937927` passed its functional and source replay checks but stopped at scoped Clippy's `unnecessary_map_or` warning. The code was changed to `is_none_or` without changing the semantic oracle; the follow-up formatting/scoped and strict Clippy phase `1793365694436831877` passed. The final compiler run above then passed the fresh source replays and remaining checks; the same-source scoped and all-feature strict Clippy results are recorded in the separate correction phase. All compiler phases used the same stated caps. Format runs `1793364461384436580` and `1793364916218202675` passed.

The source wave records 18 production records unchanged and zero task-owned resources at final readback. Verification used isolated captures. The cache-maintenance audit records removal only of completed private debug test executables: 267,935,744 allocated bytes freed, from 8,515,395,584 to 8,247,459,840 bytes. No shared cache or production resource was changed.

## Evidence and scope

The [evidence package](evidence/2026-10-30-lossless-json-document/README.md) indexes source bindings, frozen input manifests, attempt fixtures, oracle comparison, cache audit, final readback, exact run receipts/logs and reproduction helpers. Raw payload sizes and SHA-256 hashes are indexed alongside stored hashes; compressed payloads are losslessly gzip encoded. Parser/query fixture package trees and pinned Node binaries are intentionally not duplicated: their immutable manifests and exact generation tools are retained instead.

This change adds no new crate or Cargo lockfile dependency. It does not retire TypeScript, adopt TypeScript application callers, deploy, push, claim migration completion, or establish a performance improvement. The central dependency matrix remains unchanged by this shared utility acceptance.
