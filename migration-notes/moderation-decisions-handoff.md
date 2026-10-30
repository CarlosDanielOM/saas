# Moderation decision store handoff (2026-10-30)

The accepted native store and shared compiler are committed as `1575f7edc76b5e51639bc76c16d473ddb459aa3f`. This handoff records the verified scope and its remaining boundaries; the TypeScript source and callers remain active.

## Reused behavior and local gap closed

- `decisions.ts` owns three exports: `moderationDecisionID`, `createModerationDecision`, and `awaitSemanticDecision`. The schema and existing collection are owned by `schemas/moderation_decision.schema.ts`; the Rust store reuses that collection and repository.
- The shared `variations::compile_rule_variation_entries_value` helper is reused for rule compilation, with the shared compiler projection and selective raw-BSON patching preserving unrelated stored fields. `JsString::to_json_string` preserves JavaScript UTF-16 JSON escaping for identifier hashing. Existing `advanced_policy.rs`, `bson_compat`, `mongoose_date`, and the moderation decision schema provide policy, numeric, date, and model support.
- Creation follows the source's `findOneAndUpdate({_id}, {$setOnInsert: ...}, {upsert:true, new:true, setDefaultsOnInsert:true})` operation shape: flat update preparation then one atomic Mongo upsert. It does not use `SchemaDefinition::construct`/`prepare_insert`, which would run validation and minimization not enabled by the source query.
- The wait path reads the existing durable row, returns completed decisions, and on deadline uses a compare-and-set update limited to pending/processing before its final read. Errors preserve operation order; no application retry is added.

## Final evidence

The final accepted runs are `node-1793346195791403743` and `compiler-fixtures-1793346251694408763`, bound to source tree `631224c9ae10bd9e8df7bbf5f7446dfc6b4c229a1990b4fd7d2d83c066c6bd8d`. The pinned source oracle matched 6 hash, 19 create, and 16 await records. It also exercised the actual Mongoose query casting/default path and compared the Node BSON wire shape. Two ordinary Rust tests and eight ignored isolated tests passed. The regression run passed six compiler checks, three provider checks, the 175-case compiler source replay, 38 variation-job source cases, four native job checks, and bootstrap coverage. Scoped, minimal, Mongo/Redis, and all-feature strict checks passed.

The evidence package retains all 11 phase receipts and logs from run interval `1793344777438566339`–`1793346251694408763`, including earlier failed attempts and the successful pre-fix wait phase. It also includes both attempt reference outputs, source-provenance files and manifest, attempt comparison, parent facts, exact source bindings, reproduction drivers/environments, and final production readback. The frozen binding contains 1,432 Git inputs verified against the accepted commit and ten SDK inputs reused from the verified `cache-and-types` binding. Final readback records 18 production records unchanged and zero task-owned resources remaining.

## Pacing and accepted differences

`awaitSemanticDecision` keeps the source's 80 ms wait for future completion and caps that sleep to the remaining deadline. This intentionally avoids the source's possible post-deadline overshoot. Ready completed work returns without a pause; no backlog cadence was introduced.

The shared compiler removes redundant whole-rule materialization. Cache FIFO access history can differ for trusted rules with more than 1,000 entries or concurrent interleavings; cache keys and per-call identity remain unchanged. The actual-source replay covers the normal decision path rather than arbitrary user-provided hooks or object behavior.

The first BSON wire comparison found that an own-undefined `symbolVersion` property serializes as BSON `null` under Node BSON's default `ignoreUndefined=false`. The accepted helper applies that behavior only to compiler-generated sentinels, preserving unrelated raw BSON. URI-level BSON overrides are not inferred. The typed JSON/BSON contract does not claim arbitrary JavaScript prototypes, getters, sparse arrays, proxies, hooks, or engine-specific error text.

## Preserved failure and iteration history

The evidence bundle retains failures instead of replacing them with the final green run:

- The initial Clippy/compiler attempt failed and was corrected.
- An SDK source read-not-found failure remains in the run history.
- The first actual Mongoose/Node BSON comparison failed on the own-undefined `symbolVersion` write shape; the helper and fixture were corrected, then the final actual-source replay and wire probe passed.
- A wait verification phase passed before the final fixture reader correction; the final accepted source and compiler-fixtures phases subsequently passed.
- The attempt-two source reference changed only its independently bound reader hash; all 41 source cases and the query probe stayed unchanged.

Exact error details, logs, and immutable receipts are indexed in [the evidence package](evidence/2026-10-30-moderation-decisions/README.md).

## Still open

The native helper/store do not complete the broader application-specific dependency chain. General Mongoose document behavior remains outside the verified flat insert subset. Semantic-worker success orchestration and its provider/model service, billing and Polar charging, moderation consequences, route/handler integration, and caller adoption remain open. No benchmark or performance conclusion exists. TypeScript retirement, deployment, and push did not occur and are not implied by the accepted local checks.
