# AI usage ledger-state reads evidence

The three source helpers for coverage, status and raw state have a concrete shared-client Mongo adapter. Six ordinary tests, all 216 actual-source scenarios, private Mongo query/error/pool/cancellation tests, strict checks and final pinned source checks passed. The [summary](verification-summary.json) records runs, limits and boundaries. No performance was measured.

The [source binding](source-binding.json) maps 1,278 immutable inputs to the local code commit plus ten unchanged SDK references. Earlier compiler/test-helper API and Clippy failures retain exact changed bytes and source bindings. All run receipts/logs, source oracle/declarations/typecheck/compiled code, and fixture before/after hashes are retained. Public package bytes and the reused Node executable are independently hashed, with their manifest retained instead of vendoring dependencies. Compressed payloads retain raw size/hash.

The isolated Mongo has its own task-owned internal network and enables test commands solely for the exact guarded runtime script. Source/state clocks, comparison ordering, malformed lean fields, BSON promotion, UTF-16 replacement, query casting/projection, type bracketing, driver failures and cancellation/pool recovery are covered within the documented declared-input boundary. The native DTO carries raw BSON rather than claiming JavaScript prototype identity or identical exception wording.

Final readback verifies 19 unchanged production records and zero task-owned containers, networks or volumes. No caller adoption, TypeScript retirement, deployment or push occurred. Persistence, history/transaction queries, backfill, retention and broader ledger dependencies remain separate work.
