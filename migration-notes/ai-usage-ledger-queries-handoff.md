# AI ledger history/query slice — verified local slice

2026-10-29: bounded author-only implementation of `loadAiUsagePacingHistory`, `loadAiUsageLedgerTransactions`, `AiUsagePacingHistory`, and their required input/output types from `dimabot/src/utils/ai_usage_ledger.ts`. The delegate used static reads, searches, hashes, and Git/whitespace inspection only. No Cargo, rustfmt, Node, tests, network, application, container, or production command ran. No commit, push, deployment, TS retirement, caller adoption, or performance claim is made. Parent integration, isolated source/native validation, and targeted release-profile replay have passed as recorded below. Evidence packaging and source readback are complete: 1,284 inputs bind to the local code commit; 19 production records are unchanged and no task-owned resources remain.

Only four new files belong to this handoff:

- `dimabot/src/utils/ai_usage_ledger_queries.rs`: concrete shared-client `MongoAiUsageLedgerQueries`, pure preparation/query/decode functions, full window and pacing interfaces, raw lean transaction carrier, explicit fixture clocks and current-time convenience.
- `dimabot/tests/ai_usage_ledger_queries.rs`: eight ordinary independent tests and ignored `actual_source_complete_replay` / `private_mongo_adapters_data_pool_errors_and_cancellation` checks.
- `dimabot/tests/fixtures/ai_usage_ledger_queries_reference.cjs`: actual-source, offline Mongoose oracle; fresh external exclusive `--write DIR`, exact read-only `--check DIR`.
- This note. Existing files, worker implementations, other draft scopes, benchmarks, goldens, Cargo/module wiring, and routing/ledger notes were not edited by the delegate.

## Discovery and reuse

| Source / dependency | Reuse and specific gap |
| --- | --- |
| `ai_usage_ledger.ts` lines 343–416 | Complete two function bodies. Pacing reads daily rollups after state coverage; transactions read lean receipts with original `{occurredAt:-1, entryId:-1}` sort and current expiry. No writer/backfill/retention operation belongs to this slice. |
| `ai_usage_receipts.ts` | Type-only `AiUsageWindow` (all six metadata/date/day fields retained) and `AiUsageTransaction`; transaction read called from `getCachedAiUsageTransactions`. Its caller adds cache/backfill/status behavior, outside this slice. |
| `ai_usage_event.ts` | Type-only entry-kind/category/unit/resource unions; raw BSON transaction fields deliberately retain legacy values rather than falsely enforce these compile-time unions. |
| `ai_usage_dashboard.ts`, `ai_credit_display.ts` | Consumers of the pacing interface. Dashboard has a different completed-day statistical baseline; its optional active/recent/variance fields are part of the equivalent native interface but absent from this export's five-property result. No current runtime caller of `loadAiUsagePacingHistory` was found. |
| Native `ai_usage_ledger_reads.rs` | Reuses `MongoAiUsageLedgerReads::get_ai_usage_ledger_state`, raw `LedgerField`, state/error types, and the existing `date_method`, `ordinary_json`, `version_number`, `array_coercion_value` compatibility helpers. Parent changed only those helpers' visibility to `pub(crate)`; bodies were not duplicated. This remains dependent on parent acceptance of that slice. |
| Native receipt/daily schemas | `schema().native_collection(database)` supplies the exact application collections. Daily Mongoose pluralization is `ai_usage_dailies`; receipts are `ai_usage_receipts`. Construction creates handles, not collections/indexes/connections. |
| `ai_usage_receipt_parser.rs` | `RetentionTier::from_value(...).days()` supplies strict tier matching and the existing 30/60/90 policy. No additional retention day table was added. Parser remains a broader compile dependency; extracting a lower-coupling shared policy can be considered later, outside this author scope. |
| `JsDate`, `JsString`, lossless JSON/settings/BSON core | Reuses TimeClip/ISO, UTF-16 identities, Node Number promotion and String/Number coercion. No parallel date parser or numeric interpreter. |
| `ai_usage::classify_adjustment` | Reuses the complete native classifier through a comparison-only projection, preserving source/operation coercion order and method-shadow errors. Raw copied values never pass through serde_json. |
| `ai_usage_receipts/{ledger,dashboard,values}.rs` | Existing deployed private receipt aggregation/rollup/dashboard code was traced and left unchanged. It aggregates receipts and maintains daily data; pacing's source instead sums stored daily `spentCredits` over inclusive UTC date strings with expiry. A distinct query is appropriate; no overlapping worker aggregate algorithm was copied. |

Collectors/producers, the native receipt parser/worker, receipt/daily/state schemas, the state read helpers, dashboard baseline, receipt-loading caller, and billing/admin retention consumers were traced before implementation. This adds the missing native request-time adapter, not another collector, writer, rollup, registry entry, worker, or cache.

The exact transaction mapper has **16** own fields, not the queued receipt's 18-field identity shape. Order is `id, requestId, occurredAt, entryKind, category, operation, source, adjustmentType, provider, model, quantity, unit, credits, resourceType, resourceId, itemized`. `ordered_fields()` keeps properties whose value is undefined; missing, explicit null, BSON wrappers, NaN, negative zero and malformed lean fields are not flattened through serde. `source || null` and `adjustmentType || classifyAdjustment(doc)` preserve source truthiness and short-circuits, including truthy invalid explicit adjustment values. ISO runs before classification. Collection cursor materialization finishes before mapping, so a late read error wins over an earlier malformed row.

Pacing uses UTC midnight minus `retentionDays-1`, accepts only valid Date account creation values, awaits state even with invalid now, short-circuits missing state or late coverage, then evaluates historyStart ISO before now ISO. It preserves fractional elapsed days, minimum one day, cap at retention, extended-year `.slice(0,10)`, aggregate first-row selection, `value || 0`, Number coercion, Math.max NaN propagation, and positive zero. Report version/backfill timestamp do not gate this source function.

## Proposed opt-in wiring (parent only)

```toml
ai-usage-ledger-queries = ["ai-usage-ledger-reads", "ai-usage-receipt-parser"]
```

```rust
#[cfg(feature = "ai-usage-ledger-queries")]
pub mod ai_usage_ledger_queries;
```

This composes existing features/packages only; no new dependency or lockfile change is required. Mongo already supplies SHA-256, futures and Tokio for tests; parser supplies classification, JS dates, lossless views and retention. Keep the gate outside defaults and deployed profiles. Module wiring is absent until the parent adds it.

## Authored evidence and compatibility bounds

The oracle pins Node 24.22.1 / V8 13.6.233.17-node.58, TS 5.9.3, Mongoose 8.24.2, BSON 6.10.4, full source/schema/package/toolchain hashes. It AST-selects 22 declarations: both exports, their actual retention/category/state/classification closure, the full pacing/window/transaction/schema interfaces, and source type aliases. Strict synthetic typechecking uses these actual types with collection signatures. Runtime executes actual complete source bodies and source Mongoose schemas, replacing only collection `findOne`, `find`, and `aggregate` cursor replies. Mongoose performs actual query casting. Network and connection paths are blocked before application evaluation. There is no handwritten expected implementation or Mongo matching simulation.

The declared corpus exceeds 300 records (actual generated count awaits execution). It records fixed clock reads, full call order, actual cast filter/projection/sort/pipeline/options bytes, original BSON reply bytes, exact result own-key order, UTF-16 units, f64 bits, errors/category/path/message/code, and source/native/dependency/executable/extraction/typecheck/compiled hashes. Scenarios include retention/account boundaries, missing/malformed states, invalid dates and evaluation order, extended ISO years, Number/Math.max and wrapper promotion, original sort/filter boundaries, every missing/null output property, category normalization, source/adjustment/classifier short-circuits, BSON nested values, native RegExp, Symbol, Code/scope, deprecated DBPointer→DBRef promotion, raw Date wire outside TimeClip, and driver rejection. Node BSON is the reference for wrapper bytes; BSON3.1's disabled optional serde_json support is not assumed.

The native private-Mongo test covers real daily `$sum`/Date type bracketing, inclusive UTC keys, strict expiry, Decimal128, receipt half-open windows/sort/type bracketing/array matching, raw malformed results, state short-circuits/errors, late `getMore` rejection before mapping, supplied pool and clone reuse, no constructor commands/index installs/writes, real find/aggregate failures, unpolled drops and in-flight cancellation followed by usable reads. It only accepts:

```text
DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
DIMA_TEST_MONGO_URI=mongodb://ai-ledger-queries-mongo-fixture:27017
DIMA_AI_LEDGER_QUERIES_RESOURCE_TOKEN=<unique loweralnum ASCII 8..32 characters>
DIMA_AI_LEDGER_QUERIES_TEST_DATABASE=ai_ledger_queries_test_<same token>
```

The parent supplies the exact private alias in an owned, labeled, resource-capped fresh Mongo server with `enableTestCommands=1`. failCommand is server-scoped; this test must never target a shared server. It requires a fresh database, writes an ownership marker, catches test panics, disables its owned failpoint, verifies ownership before dropping only its database, and shuts down its client. Parent owns container/network cleanup and production identity comparisons.

Compatibility covers declared String/Date inputs and ordinary lean BSON under Node default promotion. Plan tier unknown data is represented by lossless JSON; any additional non-string object has the same free-tier decision. Arbitrary getters/functions/custom prototypes, nondefault BSON promotion settings, corrupt wire, arbitrary JS Symbols/BigInts, and engine resource exhaustion are outside the contract. Raw carriers retain original wire values; test encoding accounts for Node-promoted classes. Comparison-only Date/RegExp/UUID/DBRef marker strings are safe only because none can equal classifier ASCII tokens; this is not a general String(value) API. Shared reader unsupported-legacy errors remain explicit. Engine-specific TypeError wording is captured by the oracle; native errors expose category/field/method rather than claiming identical engine messages.

There are **no source pacing sleeps, polling intervals, backoffs, leases, or scheduler waits** in either export, and the adapter adds none. Driver waiting/retry configuration remains supplied by the caller. The private test's 1-second blocked command and 5-second observation deadlines are disposable fixture instrumentation only.

## Isolated commands specified for the parent verification

After wiring, use the parent's one capped compiler/source-copy workflow. Preserve the 6 CPU, selected 4/6 GiB memory and equal memory-swap, 256 PID, two-job, 8 GiB cache and 4 GiB host reserve requirements. No host Cargo and no extra compiler. Format first, freeze the snapshot, and then generate hashes; the oracle binds implementation, tests, Cargo and module wiring.

```bash
rustfmt --edition 2024 src/utils/ai_usage_ledger_queries.rs tests/ai_usage_ledger_queries.rs
cargo check --locked --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries
cargo clippy --locked --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries -- -D warnings
cargo test --locked --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries
```

In the parent's pinned isolated Node environment, pre-create a fresh external directory and set `DIMA_AI_LEDGER_QUERIES_NODE_BINARY` / `DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR`. No package download is needed or performed.

```bash
"$DIMA_AI_LEDGER_QUERIES_NODE_BINARY" tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR"
"$DIMA_AI_LEDGER_QUERIES_NODE_BINARY" tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR"
```

Mount the complete external fixture directory, exact Node executable and explicit dependency root read-only for Rust replay. Set `DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT` to the root containing the oracle's `node_modules/`. Missing, empty or stale fixtures/env fail. Run only in the capped isolated environment:

```bash
cargo test --locked --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact
cargo test --locked --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries private_mongo_adapters_data_pool_errors_and_cancellation -- --ignored --exact
```

The latter also requires the exact Mongo ownership environment above. The parent recorded check, lint, oracle, ordinary/release replay, private-Mongo, and cleanup results below. Authored local export coverage is separate from dependency-complete migration: the broader source row, unrelated ledger writers/backfill, higher-level receipt/window/dashboard/cache callers and their dependency closure remain open. Nothing was deployed.


## Parent verification — 2026-10-29

Frozen TypeScript source SHA-256: `553a83009ddd381bb94b28cb8dd5f736699bbded3581e2f95dfd20be7091c006` (1,284 input bindings). The selected feature is opt-in `ai-usage-ledger-queries = [ai-usage-ledger-reads, ai-usage-receipt-parser]`; it adds no package, lockfile, default-feature, or deployed-profile change. The scoped exports are `loadAiUsagePacingHistory` and `loadAiUsageLedgerTransactions` plus their full window/pacing interfaces. The native module reuses the existing state reader, receipt parser, schemas, BSON/date/coercion helpers and shared client. The source file remains a broader partial row; persistence, backfill/rebuild/model/bootstrap/API/caller work is still open.

The parent’s capped isolated strict all-target feature check, all-feature check, Clippy with `-D warnings`, and no-default-feature compiler check passed (run `compiler-1793284032019891565`; 126.21 s script / 135.056 s total; peak cache 8,447,475,712 bytes; minimum available memory 9,546,145,792 bytes). The eight ordinary query tests passed. The actual-source Node oracle passed 333 scenarios and typechecked 22 declarations. Final native replay passed all 333 against a fresh private Mongo fixture, including sort/aggregate, legacy BSON, driver error, pool reuse and cancellation (`compiler-fixtures-1793284318631963243`; 9.985 s script / 21.742 s total). An earlier replay caught V8 `Math.max` NaN sign-bit behavior: Rust’s initial NaN bits differed. A pinned Node diagnostic established the source behavior, the native `Math.max` branch was corrected without changing shared Number conversion, and three ordinary cases were strengthened to assert total/average f64 bits. Regenerated oracle outputs, protocols, packages and dependencies were unchanged; only the two native source bindings changed. Corrective oracle write/check passed (`node-1793284231647154788`).

The targeted release-profile run passed all eight ordinary query tests and the 333-case source replay: `compiler-1793284759267735157` (152.01 s script / 160.525 s phase; peak cache 8,352,686,080 bytes; minimum available memory 10,539,753,472 bytes). Final pinned Node checks passed both oracles (`node-1793285417559374117`; 3.502 s script / 4.784 s total). The eight related code/wiring/test/oracle files were committed as `4896f1187db57e9c551214c2e51524096dd9c33a`, bound to the same frozen source SHA-256 above and 1,284 inputs. The parent readback reports all 19 production records unchanged. Source bindings and readback evidence are preserved under `migration-notes/evidence/2026-10-29-ai-ledger-queries-retention/`; packaging is complete, with 19 unchanged production records and no task-owned resources remaining. No deployment, source retirement, caller adoption, or performance benchmark is claimed.
