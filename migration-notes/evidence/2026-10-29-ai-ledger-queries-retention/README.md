# Ledger queries and retention evidence

Two query exports and the batch retention export have concrete shared-client Mongo adapters. Eight query and two retention ordinary tests, all 333 actual-source query scenarios, all 34 retention command/clock/failure scenarios, and separate private Mongo suites passed. Targeted optimized query ordinary/source replay passed as well. The [summary](verification-summary.json) records exact runs and limits. No performance benchmark was measured for these exports.

The [source binding](source-binding.json) maps 1,284 immutable inputs to the local code commit plus ten unchanged SDK references. [Earlier bindings](earlier-source-bindings.json) preserve every changed file from failed executable checks. All receipts/logs, actual-source/typechecking/extraction/compiled artifacts, protocols, public dependency manifests, independent fixture hashes, diagnostic and source-equivalence proof are retained. Compressed payloads retain raw hashes and sizes; public packages and the existing Node executable are not vendored.

The first query replay exposed a NaN sign discrepancy. The pinned cold/warm Node diagnostic distinguishes Number conversion from Math.max; only the new query Math.max branch was corrected, and ordinary bit assertions were strengthened. All 333 source outputs/protocols stayed unchanged. Non-idempotent formatting, fixture Clippy and TypeScript enum-alias errors remain in the record. Checks were not softened.

Runtime checks use the combined feature graph after separate feature-compilation checks. Fresh task-owned Mongo servers isolate each server-scoped failpoint suite. The API retains documented raw-BSON/declared-input boundaries, engine-specific error wording differences and Rust runtime ownership for detached deletes. Final readback verifies 19 unchanged production records and zero task-owned containers/networks/volumes.

No caller adoption, source retirement, deployment or push occurred. Persistence, backfill, broader application bootstrap/model paths and the full Rust migration remain open.
