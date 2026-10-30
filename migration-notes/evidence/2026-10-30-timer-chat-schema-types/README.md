# Timer and chat schema named-type evidence

This package preserves two evidence epochs: the accepted native named-type feature and its separately validated TypeScript source retirement. The [artifact index](artifact-index.json)
records origin and raw/stored SHA-256 and byte lengths for every payload under
`artifacts/`, `runs/`, and `reproduction-tools/`. Large files are gzip
compressed without changing their raw bytes. The index uses the paths that
exist in this package; small files such as `artifacts/source-bindings.json`
remain uncompressed.

## Accepted immutable feature wave

- `artifacts/source-bindings.json` binds commit
  `c9caf56d5f58db2f7bce78c74e73dfcb341bd562` to 1,488 inputs and tree SHA-256
  `7d5e76b86489cfe78b5e44d3ca505a06ec298db152576b5c50a314649779836d`.
- `artifacts/source-final.json.gz` preserves the exact source input hash map;
  `artifacts/tested-delta-paths.json` lists the five native modules, test and
  oracle included in the validation.
- `artifacts/attempt1/oracle/timer-chat-schema-types-reference.json` is the
  pinned source/BSON fixture. It covers ten exports, 42 interface members,
  six UTF-16 string BSON cases and five numeric BSON cases.
- `artifacts/snapshot-isolation.json` records three separate unverified
  JSON-core drafts excluded from this wave and a `lossless_json_view.rs`
  restoration made only in the frozen snapshot to preserve concurrent author
  changes.
- `artifacts/production-after-final.json` records the final identity
  readback: 18 production records unchanged and zero task-owned resources.

## Exact final runs

`runs/final/` contains exact format, Node and capped compiler logs and receipts.
Node run `1793363982448192537` passed in 5.266 seconds total, with the
31-model/194-case actual Mongoose oracle unchanged. Compiler run
`1793364010422445658` passed in 131.279 seconds total under the 6 CPU, 4 GiB
no-swap, two Cargo job and 256 PID limits. Minimum available memory was
9,187,057,664 bytes and private cache peak was 8,248,705,024 bytes. The run
passed the named-type ordinary tests, additional-schema ordinary tests, exact
source replay, formatting, scoped Clippy, minimal, Mongo+Redis and all-feature
strict checks. No Mongo CRUD was run; the explicit additional-schema Mongo
test remained ignored. No benchmark or performance result is included.

## Verified retirement epoch

The `retirement/` subtree records the separate post-retirement validation. `retirement/artifacts/source-bindings.json` binds commit `6ff13fe929c0915f6e424c2f081eb96e3795e0d7` and tree SHA-256 `06d19561a1f9a97ce0b4c7a8d442ce6ed841457f68dd0bec8a575941c41ac888` to 1,491 inputs (1,481 Git plus 10 reused SDK); all hashes match. `source-final.json.gz` preserves the immutable final source map. No mutable state snapshot is included.

`archive-verification.json` records 40 to 45 archived snapshots, exact hashes for all 45 entries, and unchanged prior entries and metadata. Five semantic comparisons matched. Their fixtures and comparison record are included under `retirement/artifacts/attempt1/` and `oracle-semantic-comparison.json`. The action-log regression comparison records provenance-only changes in `Cargo.toml`, source resolver, and source guard.

Final Node run `1793366711705641175`, format run `1793366593205430608`, and capped compiler run `1793367075031965693` passed. The compiler used 19.977 seconds total / 9.560 seconds compiler-step time, with 14,263,578,624 bytes minimum available memory and 8,479,768,576 bytes private-cache peak. `retirement/runs/interrupted/` preserves compiler attempt `1793366759535595789` and its interrupted-state record; no driver receipt exists, so it is not counted as passing. Final readback records 18 production records unchanged and zero task-owned resources.

No new benchmark or MongoDB runtime/CRUD check was performed for this retirement. Existing model/type dependencies were accepted in the earlier named-type epoch. Caller adoption and production deployment are not established. The central matrix updates only the five affected feature rows; its rollup is 32 locally complete, 25 partial, 45 archived snapshots, 761 live baseline TypeScript files including six excluded React Email templates, and a null total-completion percentage.

## Reproduction tools

`reproduction-tools/` contains the named-type epoch scripts. `retirement/reproduction-tools/` contains the retirement binder and Node/compiler check scripts. They are preserved as evidence, not rerun by this documentation task. No Node, Cargo, tests,
network, containers, production or staging operations were run here.
