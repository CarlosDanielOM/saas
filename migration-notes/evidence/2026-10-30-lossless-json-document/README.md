# Lossless JSON document evidence — 2026-10-30

This package records the accepted reusable native Rust flat JSON document capability at immutable source commit `94fd1031381e397d749abf641e2db9fe285f9aa5`. It distinguishes three Node oracle generations, functional compiler attempts, the Clippy correction, and final verification. The artifact index contains raw and stored byte lengths and SHA-256 hashes for every payload under `artifacts/`, `runs/`, and `reproduction-tools/`; gzip entries preserve the original bytes losslessly.

## Frozen source and fixtures

- `artifacts/source-bindings.json` binds 1,491 inputs (1,481 Git plus ten reused SDK inputs) and source tree SHA-256 `d66bd88a1496d50a55b097531e5e9f0c89cd91b5392c136cc1a7d874243ca053`. `artifacts/source-final.json.gz` retains the full source hash map; `artifacts/tested-delta-paths.json` lists the changed native core, existing view adapter, and parser/query regression surfaces.
- `artifacts/attempt3/document/lossless-json-document-reference.json.gz` is the final 31-case document oracle. It records 19 completed V8 canonical cases, ten syntax errors and two valid parses whose 4096-deep stringify raised V8 `RangeError`. Those two probes use the stated shallow-leaf plus delimiter expected-canonical construction; they are not exact complete V8 stringify parity. Attempt-two fixture and the pre-classification oracle generator/source are retained separately.
- Parser and ledger-query fixture root trees and Node binaries are not copied to avoid duplicating large private package captures. Their attempt-two and final provenance manifests, source replay tools, and matching exact logs and receipts are retained.
- `artifacts/oracle-semantic-comparison.json`, `artifacts/cache-maintenance.json`, and `artifacts/production-after-final.json` retain semantic, cleanup, and final identity readback records. The readback reports 18 production records unchanged and zero task-owned resources.

## Exact verification epochs

`runs/` preserves both format passes, all three Node runs, compiler preflight, compiler functional run with the initial Clippy failure, the successful scoped/strict Clippy correction phase, and the final compiler run. The first Node attempt's `JSON.stringify` depth error is kept as a failed oracle collection, not represented as a Rust parser failure. The final run passed the ordinary document/parser/query/view suites, exact document source replay, five source parser time-zone replays, actual-source ledger query replay, minimal and Mongo+Redis checks. Same-source scoped and all-feature strict Clippy passed separately in phase `1793365694436831877`. Exact durations, resource caps, case counts, and caveats are documented in the migration note.

## Reproduction and boundaries

The scripts in `reproduction-tools/` are copied from the exact task tooling, including all three Node and quality attempts, the private dependency-capture copy helper, cache audit helper, source validator, and final readback helper. They are preserved, not rerun as part of this documentation change. No parser or ledger-query package root, copied `node_modules` tree, or Node binary is bundled here. This capability does not include the separate deletion helper, TypeScript retirement, application caller cutover, central dependency-matrix changes, deployment, or any performance claim.
