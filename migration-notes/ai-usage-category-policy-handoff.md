# AI usage receipt category reuse handoff

**Authored, execution unverified.** The prior verified state does not verify this refactor. Review and freeze the complete parent candidate before formatting and running isolated checks. No application caller or worker was switched by this change.

## Policy and boundaries

`ai_usage_ledger.ts` defines `VALID_CATEGORIES` and `safeCategory`: only a primitive string exactly equal to one of seven categories or `uncategorized` is accepted, otherwise the result is `uncategorized`. Its producer, persistence and transaction paths use that closure. `ai_usage_receipts.ts` defines `RECEIPT_CATEGORIES` and `receiptCategory`, likewise defaulting unmatched inputs. The seven closed `Category` variants already map to their literal strings in the `string_enum!` table in `ai_usage.rs`; `uncategorized` is a receipt fallback, not a `Category` variant.

The new `Category::parse_token` is generated from that same table, and `normalize_receipt_category(Option<&str>) -> &'static str` maps a parsed token to `as_str`, or to `uncategorized`. Thus explicit `uncategorized` takes the fallback path but has the same output as before. Exact comparison does not trim, change case, normalize Unicode, or coerce values. The macro also exposes equivalent table-derived parsers on the other generated string enums; it changes no variants, Serde mappings or layout.

The producer still obtains its value through the lossless context getter and admits only a valid `JsonValue::String` UTF-8 view. The parser still obtains `JsonView` text as `JsString` and borrows its valid UTF-8 view for the immediate call; lone surrogates fall back without replacement or receipt-data conversion. The query still selects only BSON String or Symbol through `primitive_string`, preserving existing promotion and fallback behavior. Those boundary selections and all other evaluation, ordering and persistence logic are unchanged. Static comparison shows the seven recognized outputs and all fallback outputs are identical; execution must establish parity independently. The new persistence adapter should use the same API at its own existing strict input boundary. The deployed worker has a separate feature graph and private category implementation; it remains a future reuse gap, not an impacted worker change.

Feature dependencies already bring `ai-usage` into producer and parser, and queries through parser; no Cargo dependency or feature change is needed. The standalone regression test is gated by `ai-usage` and covers the seven expected values, the explicit fallback, absence, unknown/case/whitespace/control and Unicode inputs. Actual-source fixture replay remains necessary to verify caller boundaries.

## Source identities before parent formatting

SHA-256 values below identify this authoring snapshot, not a tested build. Recompute after integration or formatting.

| File | SHA-256 |
| --- | --- |
| `dimabot/src/utils/ai_usage.rs` | `3d365161ec34ba2d16c435f9bae1131309028736d570907c6d554d2278ee6c2d` |
| `dimabot/src/utils/ai_usage_producer.rs` | `a88c45ec85088e3e5787c1f22f8b6d68e4f03d5bbf70d28a1db203e4ceaa73ce` |
| `dimabot/src/utils/ai_usage_receipt_parser.rs` | `8aff674bb2f0dbebd575288a62f94caf68291fb23fc9839fd165cfe7a594e321` |
| `dimabot/src/utils/ai_usage_ledger_queries.rs` | `6bca2b85e5c8876e586e616d0767cfa0163099c88d51ef2d540079bd0ce3873a` |
| `dimabot/tests/ai_usage_category_policy.rs` | `6569502bc0ca6ec962d53e836016aeed6102276c5d59f90db7d4fd2985aab45f` |
| `dimabot/src/utils/ai_usage_ledger.ts` | `3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5` |
| `dimabot/src/utils/ai_usage_receipts.ts` | `d92832339b0306249c054816e2105c3fc601a7c27994b6dc7f1b8bec7e607a87` |

## Parent verification status — 2026-10-29

The parent ran the category refactor checks in capped, task-owned isolated containers. Raw receipts and logs remain under `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/`; these results describe that frozen parent candidate and do not change the authoring-snapshot hashes above.

- `compiler-1793289358032795786` passed: producer source replay covered all 338 cases; parser source replay covered all 1,362 cases across five time zones; query source replay covered all 333 cases. Receipt reports 307.256 seconds in the compiler step and 315.433 seconds total, with `production_unchanged: true`.
- `compiler-1793289145686467400` ran the ordinary test and worker groupings, and the all-features check passed, but the entire compiler phase failed. Strict Clippy stopped on the persistence-only `clippy::unnecessary_map_or` lint in `src/utils/ai_usage_ledger_persistence.rs` (`map_or(true, ...)`, for which Clippy suggested `is_none_or`). This is not a full strict-check pass and does not indicate a category behavior failure.
- `compiler-1793289702168491160` passed the focused `category_policy_check.sh` run: queries-feature all-target Clippy with `-D warnings`, plus no-feature all-target check. The receipt binds source tree SHA-256 `0100e807d1bababe04a548b0d252a796cbc9742dcad90c496f4e28fef197e665`, records 16.828 seconds in the compiler step and 25.351 seconds total, and reports `production_unchanged: true`.
- `ledger-persistence/attempt2/category-functional-immutability.json` records functional equality for producer, parser, queries and retention reference data. Producer comparison explicitly remapped the isolated input namespace from `producer-fixture-ledgerpersist20261029:` to `producer-fixture-wire20261029native1:`; provenance metadata/hash fields were omitted where indicated. This is functional-data comparison evidence, not a full strict persistence verification.

These receipts establish the reported feature-specific source replays and focused category compiler gates only. They provide no benchmark or performance result for this refactor. They do not establish full ledger verification, full migration completion, TypeScript source retirement, caller/worker adoption, deployment, or push. The production-unchanged receipt fields apply to the recorded runs.

## Reproduction and later integration

Reference fixtures bind native source hashes. For a later integrated candidate, regenerate producer, receipt-parser, ledger-queries, ledger-persistence and retention reference artifacts in fresh external directories, then run each corresponding `--check` and relevant actual-source replay. Functional results must remain identical; source provenance metadata necessarily changes. Producer and parser benchmark fixtures also bind affected source files, so their old source identities cannot attest a changed candidate; no benchmark execution or performance conclusion is required for this change. Follow the existing parser, queries, persistence and retention handoffs for fixture environment, timezone and isolated resource details. The persistence fixture also requires its lock reference. Never reuse production resources.

For any remaining verification, use a capped, isolated snapshot. Include `cargo fmt --all -- --check` and `cargo test --locked --no-default-features --features ai-usage --test ai_usage_category_policy`, then the existing producer, parser and queries feature tests and actual-source replays, and persistence/retention replay as affected by integration. Parser replay uses its five documented time zones. Validate source fixture write/check protocols with pinned Node and preserve their generated hashes and outputs. For private Mongo/Dragonfly checks, create fresh uniquely named task-owned resources and follow the persistence handoff; never use production or shared resources. Respect the repository Rust isolation and host resource policy.
