# Emote-spam evaluator: source parity and native verification

**Status: verified opt-in evaluator scope; no caller adoption or deployment.** The native port implements the complete selected numeric evaluator contract. This does not complete the broader moderation feature: moderation settings, message-fragment counting, rule registry/application, and enforcement remain in TypeScript.

## Source and scope

The source is `dimabot/src/utils/moderation/rules/emote_spam.rule.ts`. Its two exports are `EmoteSpamEvaluationResult` and `evaluateEmoteSpamRule`; its only import is the type-only `Pick<IModerationRule, 'maxEmoteCount'>`. The TypeScript rule requires `maxEmoteCount: number`. The schema field was extracted from the actual schema AST without loading Mongoose. The source snapshot is pinned to commit `33bb8f46`; the source-tree SHA-256 is `0b49c85bb833d183b42618c081d644f0c7f51bd98d341269317559d4c4d95dd7`.

The Rust counterpart is `dimabot/src/utils/moderation/emote_spam.rs`: `EmoteSpamRule { max_emote_count: f64 }`, `EmoteSpamInput { emote_count: Option<f64> }`, and `EmoteSpamEvaluationResult { triggered, emote_count }`. It uses only the Rust standard library for evaluation. `None` models the source's nullish fallback to zero. The original non-nullish binary64 count is retained, and triggering uses strict `>` comparison. The declared input is a non-null typed object; arbitrary runtime casts, JavaScript coercion, and prototype behavior are outside this contract.

The opt-in `moderation-emote-spam` feature adds `serde_json` with `float_roundtrip` for the external replay and gates the existing JavaScript-compatible JSON-number formatting path. The evaluator itself remains std-only. No new crate or lockfile change was required, and the feature does not depend on the credit-policy domain. These replay dependencies are not production runtime adapters.

## Verification evidence

The Node oracle (`1793302248517993453`) passed source AST/export checks, type-only import and schema-field checks, source-pin hashes, and write/check over 360 cases. It executes the actual TypeScript exports and records result bits and JSON serialization. The corpus preserves NaN, infinities, signed zero, and precision-neighbor cases. The 1,305-file snapshot inventory is distinct from the 360 oracle cases.

The independent provenance readback verified source, schema, native implementation, SDK, Node, and oracle hashes and confirmed all 360 cases are present and unique. Artifact copies and readbacks are in the [indexed repository evidence](evidence/2026-10-29-moderation-emote-spam/README.md), including the full reference, source/native binding, independent provenance readback, raw run logs/receipts and final production/resource readback. All 31 indexed hashes and compressed raw payloads were independently verified.

Compiler run `1793302248518831893` passed formatting, scoped Clippy, two ordinary tests. Compiler run `1793302461772086894` passed the ignored native replay for all 360 cases, comparing result bits, trigger decisions, and ordered JSON wire output in 0.01 seconds; it also passed no-feature, Mongo/Redis worker-profile, and all-features/all-targets checks plus `Clippy -D warnings`. These are correctness and build checks, not a performance benchmark.

The exact source was compiled under the configured limits: 6 CPUs, 4 GiB memory with memory-swap equal to memory (no swap), 256 PIDs, and two Cargo jobs. The compiler script took 105.179 seconds; total elapsed was 111.715 seconds. The task-owned cache was 3,666,329,600 bytes, and minimum available host memory was 8,732,250,112 bytes. The final readback reported 19 production records unchanged and zero remaining task-owned resources. No application services or production data services were used by the pure verification.

## Migration status and evidence location

This establishes local coverage for the selected pure evaluator at its declared numeric contract, not total emote-spam or moderation migration completeness. TypeScript retirement, live callers, caller adoption, deployment, push, and performance benchmarking were not part of this work. Broader moderation and its application-specific dependencies remain unmigrated.

See the [handoff](moderation-emote-spam-handoff.md) for a short source and contract summary. No application or Node source was retired.
