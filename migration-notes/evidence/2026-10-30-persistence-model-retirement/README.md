# Persistence model retirement evidence

This package records the source retirement of four OAuth models and the
moderation action-log model. The final feature note is
[`migration-notes/persistence-model-retirement.md`](../../persistence-model-retirement.md).
The JSON [artifact index](artifact-index.json) records original and stored
SHA-256 values and byte lengths for every retained payload. Large payloads are
losslessly gzip-compressed; log bytes are not normalized. Each index entry
contains its original private-state path or immutable Git blob reference and compression status. The index
accounts for all 35 payload files under `runs/`, `artifacts/`, and
`reproduction-tools/`.

## Frozen source and archive proofs

- `artifacts/source-bindings.json` binds the final read-only snapshot to
  commit `6af3a89731e4219d66a4dfa99a7ce128a0edb825`, 1,480 input hashes, and
  source-tree SHA-256
  `18d0d5c5dcf9353e69ad85d9237cdf365c97fecff11adde29038b3cfe75d9e80`.
- `artifacts/source-final.json.gz` preserves the full input hash map.
- `artifacts/archive-verification.json` records all 36 archive paths and hashes;
  the five newly archived model files match their pre-retirement Git bytes.
- `artifacts/snapshot-isolation.json` records the contributor edits restored
  only in the validation snapshot and the future unwired drafts excluded.
- `artifacts/tested-delta-paths.json` identifies the exact five retired paths,
  their archive paths, test/fixture paths, and source reader.
- `artifacts/archive-manifest.json` preserves the resulting archive manifest.
- `artifacts/oracle-semantic-comparison.json` records equality of the five
  application-fixture golden fields and the nine action-log semantic fields
  across the old and fresh 32-case epochs.
- `artifacts/pre-archive/source-final.json.gz` preserves the earlier 1,477-input action-log snapshot; its Git source is `3a9a4f59`.

## Validation epochs

`runs/pre-archive-action-log/` preserves the earlier accepted moderation
action-log schema validation: pinned Node fixture generation/check, native
compiler-fixtures phase, formatting receipt and exact raw logs. It includes
`cache-maintenance.json`, the scoped audit for removing 21 completed task-owned
debug test executables (542,461,952 allocated bytes). This pre-retirement
acceptance is historical evidence for the native model, not a post-retirement
source check.

`runs/post-archive-retirement/` preserves the final Node and compiler-fixtures
receipts/logs, and the formatting receipt/log. The Node check passed against
the final 1,480-input snapshot. The compiler phase passed the actual archive
reader, app schema replay, action-log native tests, isolated Mongo CRUD/index
and Mongoose replay, formatting, scoped Clippy, no-default all-target check,
and all-feature all-target Clippy. The compiler receipt records limits,
minimum available memory, private cache peak, source-tree hashes, elapsed
times and unchanged production readback.

`runs/historical-leaf-cache/` retains the earlier moderation-leaf cache audit,
including its minimum-free threshold assertion failure. It is not a result of
this retirement phase and does not claim cleanup success.

The private evidence artifacts were read only for packaging. No validation
process was started by this evidence-preparation task.

## Reproduction tools

`reproduction-tools/` contains exact copies of the repository's snapshot
validator, Node and Rust fixture phase scripts, and final readback helper when
present in the task tool directory. The scripts retain their original bytes
and hashes. They document how the parent ran the isolated phases; this package
does not authorize rerunning them outside the original capped isolated
workflow.
