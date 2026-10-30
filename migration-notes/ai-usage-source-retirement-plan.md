# AI usage context source retirement plan

The user has authorized retirement after a file is fully migrated. This inventory plan does not itself perform retirement of `dimabot/src/utils/ai_usage_event.ts` or `ai_usage_event.test.ts`. The helper’s declared pure behavior has a verified local mapping, but the parent retains the matrix completion and retirement decision. Once the verified retirement checks are satisfied, preserve the source bytes at `archives/dimabot-typescript/<date>/src/utils/ai_usage_event.ts` and bind them to baseline SHA-256 `87ff158c166652ea1eb64199ea4c9c6250b35db90399cb658ef6c3086628de60` in the archive manifest.

## Readers requiring an archive-aware path

Update every listed input before removing the live source path:

- Actual-source runtime/oracle readers: `tests/fixtures/ai_usage_lossless_reference.cjs`, `ai_usage_producer_source.cjs`, `ai_usage_producer_reference.cjs`, `ai_usage_receipt_parser_reference.cjs`, `posthog_tracking_source.cjs`, `posthog_tracking_reference.cjs`, and `polar_cache_usage_reference.cjs`.
- Structural/type/source-binding readers: `ai_usage_receipt_parser_source.cjs`, `ai_usage_producer_benchmark.cjs`, `ai_usage_daily_reducer_benchmark.cjs`, `ai_usage_ledger_backfill_reference.cjs`, `ai_usage_ledger_persistence_reference.cjs`, `ai_usage_ledger_queries_reference.cjs`, `ai_usage_persistence_e2e_benchmark.cjs`, and `posthog_tracking_benchmark.cjs`.
- Static source hashes: `tests/fixtures/bot_utils_parity.json` and the helper source hash maps in the source readers above.
- Rust source pins: `tests/ai_usage_lossless.rs` reads and hashes the source; `tests/ai_usage_receipt_parser.rs` and `tests/ai_usage_producer_benchmark.rs` include it in source bindings; `tests/posthog_tracking.rs` uses its `source!` hash macro.
- Direct TypeScript test imports: `src/utils/ai_usage_event.test.ts` and `src/utils/ai_usage_ledger.test.ts` import the helper. Review the former test’s own archive disposition and update the latter only if its tested context factory is retired.
- Import-only consumer fixture: `tests/fixtures/twitch_streamers_behavior_reference.mjs` injects the schema-version constant as a stub and does not read or hash this source. Confirm that remains true when updating the source harness.

The helper has runtime dependents through `src/utils/polarsh.ts` (context construction and metadata enrichment) and `src/utils/posthog_events.ts` (schema-version constant); type-only dependents include `src/utils/ai_usage_ledger.ts`, `src/utils/ai_usage_receipts.ts`, and `src/utils/tts_usage.ts`. Keep those paths in the retirement inventory. Existing TypeScript runtime adoption is a separate migration decision; retiring a utility must not be described as migrating its application callers.

## Reusable resolver and post-retirement validation

Add one test-only resolver in the Node fixture support area. Its input is a logical source ID plus the expected baseline hash. Before archival, the logical ID resolves to the live TS file. After archival, it resolves only to the exact archive-manifest path. In both cases it checks the same expected SHA-256 and fails closed if the source is absent, the manifest omits it, or the bytes differ. Do not permit a generic fallback among `.js`, `.ts`, `.tsx`, or declaration files, and do not let a changed live file shadow an archived source after the retirement switch.

Rewire the Node runtime readers, AST/type-contract readers, source-hash maps, and benchmark input manifests to use that resolver. Keep each reader’s current scope and assertions; this should only change source selection and provenance. Update `bot_utils_parity.json` and Rust source-sensitive tests explicitly. Rust integration tests should validate the archive-manifest path/hash or the generated oracle’s declared source provenance rather than retaining a hard-coded read of the removed live path. Do not erase the source pin.

Before deleting the live file, run the entire pre-retirement reader list against the live path and capture the baseline hashes. After moving it, verify that the logical resolver selects the archived bytes, regenerate and check the 132-record lossless corpus from that archive, then run the ignored exact-wire Rust replay. Re-run all listed source readers that depend on this file, including producer, receipt-parser, PostHog, ledger/backfill, daily-reducer, persistence, and benchmark oracles. Run the relevant Rust source-pin tests and archive-manifest checks. A final `rg` for `ai_usage_event`, direct `readFileSync`, TS import specifiers, and the 64-character source hash must show only intentional archive-aware references and documented history. Review the separate `ai_usage_event.test.ts` matrix disposition and preserve its behavior in native evidence before retiring the test file.

This plan establishes no deployment or caller cutover. The accepted evidence and source replay for the helper are indexed in [`evidence/2026-10-30-ai-usage-lossless/README.md`](evidence/2026-10-30-ai-usage-lossless/README.md).
