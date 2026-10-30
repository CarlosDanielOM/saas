# AI usage context helper — source and dependency review

2026-10-30 source-backed review of `dimabot/src/utils/ai_usage_event.ts`. This is a bounded pure-helper review, not a whole AI usage, billing, or application migration. The scoped native compatibility work was verified at commit `08ab85ddb3f1277a934699f8ea3d0b4d31d41ff2`; evidence is in [`evidence/2026-10-30-ai-usage-lossless/`](evidence/2026-10-30-ai-usage-lossless/README.md). The matrix row remains **partial pending the parent’s completion and retirement decision**. No source retirement, caller adoption, deployment, push, or runtime-performance claim is made.

## Feature and import closure

The source exports twelve declarations: constants `AI_USAGE_SCHEMA_VERSION` and `AI_USAGE_PRICING_VERSION`; four string unions (`AiUsageEntryKind`, `AiUsageCategory`, `AiUsageUnit`, `AiUsageResourceType`); interfaces `AiUsageContextInput`, `AiUsageContext`, and `PolarUsageMetadataShape`; and functions `createAiUsageContext`, `toPolarUsageMetadata`, and `enrichPolarUsageMetadata`. Private helpers `classifyLegacyReason`, `optionalFinite`, and `optionalText` are also covered by the source replay. The module has one direct import, runtime `randomUUID` from `node:crypto`; it has no relative imports, barrels, or side-effect imports.

The native implementation is in `dima_rust::utils::ai_usage` and the lossless ordinary-JSON API is in `dima_rust::utils::ai_usage_lossless`, gated by `ai-usage-lossless`. The version constants, classification table, enums/context types, normalized construction, canonical metadata fields, and accounting-first/canonical-last spread behavior are represented. `uuid` supplies v4 IDs only when the normalized entry ID is absent. ECMAScript trimming reuses `js_compat::trim`; lossless strings and object ordering/coercion reuse `JsString`, `JsonValue`, `json_number`, and the existing JavaScript-compatible truthiness/string routines. These are concrete crate or standard-library implementations, not missing application adapters.

The compatibility boundary is explicit: the lossless APIs accept ordinary own-property JSON objects, not getters, executable hooks, custom prototypes, symbols, or sparse arrays. An omitted optional JSON property models the source’s absent/`undefined` read; `null` remains distinct. Metadata conversion requires its required context fields. Accounting input is object-shaped. Context construction retains finite quantities and omits non-finite values; an already-built metadata context preserves a present quantity, including `null` or a non-finite `JsonNumber`. Duplicate JSON keys use replacement without reordering; numeric keys follow ECMAScript property order. The typed Serde context API remains unchanged. The caller may represent the TypeScript default input `{}` with an empty object; no classification or field behavior depends on application services.

## Runtime and type dependents

Direct source consumers are `polarsh.ts` (runtime context construction and metadata enrichment) and `posthog_events.ts` (runtime schema-version constant, type-only `AiUsageContext`). `ai_usage_ledger.ts`, `ai_usage_receipts.ts`, and `tts_usage.ts` import context/category/resource types only. `ai_usage_event.test.ts` and `ai_usage_ledger.test.ts` are test consumers. Their surrounding Polar, PostHog, ledger, receipt, and TTS application flows remain separately scoped TypeScript paths; they do not add a transitive runtime dependency to this pure helper. Keeping those callers in TypeScript is caller-adoption status, not an unimplemented dependency of the helper itself.

The two existing 69-line TypeScript test groups cover additive canonical metadata/accounting-field preservation and legacy classification/privacy behavior. The native typed-context tests cover classifications, default/override/omission rules, metadata spread, finite quantities, UUID fallback, and absent prompt/text fields. The lossless source oracle additionally typechecks and executes actual TypeScript with a deterministic UUID provider; 130 context cases and two metadata-only cases were replayed byte-for-byte by the ignored Rust replay. The final candidate passed two ordinary Rust tests plus that one ignored full replay, along with the scoped feature checks recorded in the evidence package. This supports a local pure-helper mapping; it is not a claim that other accounting call paths have been migrated.

No remaining application-specific adapter is required to complete the declared pure-helper behavior. Deployment and caller adoption are separate. The parent’s requested default status for the matrix is retained as partial until the explicit inventory decision; this does not identify a local feature gap. Total migration completion remains null and was not audited here.

## Retirement impact inventory

Before retiring `ai_usage_event.ts`, update every source oracle or benchmark that reads, hashes, parses, or resolves it. The current set found by path and import scans is:

| Reader | Current dependency |
| --- | --- |
| `tests/fixtures/ai_usage_lossless_reference.cjs` | Reads, hashes, parses, typechecks, compiles, and executes the actual helper; its exact path is the lossless oracle input. |
| `tests/fixtures/ai_usage_producer_source.cjs`, `ai_usage_producer_reference.cjs` | Loads the helper for producer execution and binds its source declaration/hash. |
| `tests/fixtures/ai_usage_receipt_parser_reference.cjs`, `ai_usage_receipt_parser_source.cjs` | Loads or validates the helper’s imports, declarations, and source hash for receipt parsing. |
| `tests/fixtures/ai_usage_producer_benchmark.cjs` | Includes helper source in the benchmark binding. |
| `tests/fixtures/ai_usage_daily_reducer_benchmark.cjs` | Extracts the four shared type aliases. |
| `tests/fixtures/ai_usage_ledger_backfill_reference.cjs`, `ai_usage_ledger_persistence_reference.cjs`, `ai_usage_ledger_queries_reference.cjs` | Hash the helper and extract its shared type aliases for source contracts. |
| `tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs` | Hashes the helper and extracts its shared type aliases. |
| `tests/fixtures/posthog_tracking_source.cjs`, `posthog_tracking_reference.cjs`, `posthog_tracking_benchmark.cjs` | Compiles/loads the helper, binds the schema constant and source, or includes it in benchmark inputs. |
| `tests/fixtures/polar_cache_usage_reference.cjs` | Resolves the helper through its receipt source and hashes it as a dependency. |
| `tests/fixtures/bot_utils_parity.json` | Stores the helper source hash used by the parity harness. |
| `tests/fixtures/twitch_streamers_behavior_reference.mjs` | Supplies a local `AI_USAGE_SCHEMA_VERSION` stub for an unrelated consumer; it does not read or pin the helper source. |

Rust source-sensitive readers also need review: `tests/ai_usage_lossless.rs` hashes and reads the source for exact replay provenance; `tests/ai_usage_receipt_parser.rs` and `tests/ai_usage_producer_benchmark.rs` include it in source bindings; `tests/posthog_tracking.rs` uses its source-hash macro. `src/utils/ai_usage.rs` and `src/utils/ai_usage_lossless.rs` contain documentation references only. A repository-wide post-retirement search must also find import specifiers and source path construction that do not contain the literal `.ts` extension.

## Bounded post-retirement oracle plan

When the parent freezes the verified retirement change, add one small resolver shared by Node source fixtures. It should accept the logical path `src/utils/ai_usage_event.ts`, use the live source only before archival, and after archival resolve only to the exact manifest-listed archived snapshot. In either mode it must verify the expected SHA-256 (`87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60`) and fail closed on a missing or changed file; do not silently choose a similarly named TS/JS file. Rewire all readers in the table, including benchmark input lists and JSON hash maps, to this resolver while retaining each reader’s own purpose and assertions.

After the source move, regenerate the actual-source corpus from the archived bytes, compare its source hash to the archive manifest and pre-retirement binding, and replay it with the ignored Rust test. Rerun the listed producer, receipt-parser, PostHog, ledger/backfill, daily-reducer, persistence, and benchmark oracle/check paths whose inputs include this module. Update Rust source-pin helpers to resolve the archived path or validate the oracle’s explicit archive provenance; do not leave them pointing at the removed live path. Separately review and retire `ai_usage_event.test.ts` only with its own source/test inventory disposition. This keeps native feature evidence runnable after retirement without retaining a live TypeScript copy or weakening source provenance.

## Evidence limits

The two Node oracle runs generated byte-identical 132-record corpora (130 context and two metadata cases). Frozen provenance records 1,452 inputs: 1,442 Git-bound inputs at the verified code commit and ten reused SDK inputs from the prior `moderation-variations` `cache-and-types.archiveVerifiedSdkInputs` binding. The frozen JSON corpus, run receipts/logs, source hashes, and readback are retained; no complete source clone is copied. The initial Node/compiler pair included un-wired accounting test support; it remains retained history and is excluded from the accepted final source binding. Parent corrections to the CommonJS export binding and independent provenance/replay checks were applied before the initial accepted execution. See the evidence README for exact run limits and hashes.
