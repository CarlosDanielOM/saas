# Receipt wire serialization performance handoff

Author-only change, 2026-10-29. The author read source, reviewed the scoped diff and ran static whitespace checks only. No Cargo, rustfmt, Node, tests, benchmarks, application, network, container or production command was run. The parent owns formatting, final-source provenance, isolated verification, measurement and any eventual commit. No runtime speed, allocation/RSS reduction, migration-completion increment, caller adoption or deployment is claimed.

The parent supplied candidate source fingerprint `d658d2f8014e87dd70c6f0041331939e4aaef04878a836eb4ed268a540aec29f` after the separate borrowed-key lookup change. It reported passing ordinary/strict checks, an unchanged 1,362-case source oracle and 192 prepared benchmark wires; its full five-TZ producer/BSON replay was still running when this task was assigned. The parent's separate exact-Rlib diagnostic reported a prepared-DTO wire median of 9.790 microseconds. That diagnostic is not an additive decomposition of benchmark or production timings and is not evidence about this new change.

## Reuse and ownership

Owned files are `dimabot/src/utils/lossless_json.rs`, `dimabot/src/utils/ai_usage_receipt_parser.rs`, `dimabot/tests/ai_usage_receipt_parser.rs` and this new handoff. The prior lookup implementation/tests, producer, ledger adapter, dependencies, Cargo/features/modules, benchmark code, loaders, oracles and goldens were not edited.

Source discovery traced `ParsedAiUsageReceipt::json` through `as_value` and `ordered_fields`: writing a receipt first built owned field values, cloned string payloads, allocated property-name strings and constructed a second vector before calling the established serializer. The existing producer already writes borrowed owned fields using `JsString::write_json_string`, `write_json_utf8` and `JsonValue::write_json_string`; those encoders and that design are reused here without editing the producer.

The existing lossless module now exposes a small `JsonValueRef` containing null, bool, binary64, borrowed UTF-8, borrowed `JsString`, or borrowed existing `JsonValue`. Its `write_json_string` delegates to the existing encoders, including the owned scalar number path for signed-zero/nonfinite JSON policy. `into_owned` materializes the same raw numbers, UTF-16 strings or nested values for owned callers. The static-name `write_json_fields` appends an object; `fields_to_json_string` builds its output. Canonical numeric keys use the existing `array_index` policy factored into one private string helper shared by both serializers. The existing owned and pretty serializers retain their behavior. The borrowed helper keeps stable numeric ordering and the owned serializer's treatment of manually supplied duplicate fields.

The parser has one callback-scoped array mapping all eighteen normalized fields in source order. The ISO date temporary lives through the callback. `json` writes borrowed references from that array; `ordered_fields`, `as_value` and `get` use it to return owned values, and `try_utf8_fields` continues through `ordered_fields`. Known owned property names use the existing `JsString::from_static`. The normalized JSON APIs share that single field list. Public owned return types and raw-number/UTF-16 values remain owned; present nulls, field order, defaults, missing-key access and Unicode failure behavior retain their existing policies. Parser/coercion/date logic and the BSON adapter were not changed.

The output builder uses saturating capacity arithmetic with an initial-reserve cap of 64 KiB. This is a sizing hint, not an output or memory limit: escaping and nested values may grow the output. The wire path still creates its ISO date string and output buffer and uses the existing allocating number formatter; numeric field names can allocate sorting storage, and borrowed nested values retain the owned serializer's recursion and allocation behavior. No allocator, RSS, whole-process memory or throughput measurement was made by the author.

## Authored checks and outstanding verification

Four ordinary tests were added to the parser integration test, with no fixture/environment requirement. They compare direct borrowed wire with owned serialization and all public owned APIs across all eighteen fields, populated/default receipts, ownership after dropping the DTO, signed-zero bits, nonfinite-quantity normalization, lone/reversed/mixed UTF-16 and astral strings. Optional strings exercise prefixes 126, 127, 128 and 129 around the 128-unit boundary, including a split surrogate pair. Helper cases cover null/bools, finite/nonfinite/raw NaN payload numbers, escaped static keys, UTF-8/UTF-16 strings, nested owned values with numeric and lone-surrogate names, append behavior, empty objects and stable canonical-index ordering with duplicates and boundary/noncanonical names. Expected wire literals and existing owned encoders supply independent assertions; no expected oracle data was changed. The original five ordinary parser tests and the complete ignored replay remain unchanged.

The callback lifetimes, materialization behavior, shared index helper and output policy need compiler/runtime validation. The parent must establish performance independently before accepting a speed claim. Proposed container-interior commands, from the final `dimabot` source snapshot, are:

```sh
cargo fmt --all -- --check
cargo check --locked --no-default-features --features ai-usage-receipt-parser --all-targets
cargo clippy --locked --all-features --all-targets -- -D warnings
cargo test --locked --no-default-features --features lossless-json-view --lib lossless_json::tests
cargo test --locked --no-default-features --features lossless-json-view --test lossless_json_view
cargo test --locked --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser
```

Run these only inside the parent's existing pinned offline task-owned capped compiler, with its read-only final source snapshot, private writable target/output/cache, CPU/memory/PID/no-swap limits, host-headroom checks and production identity comparisons. Never run host Cargo commands. Format the three changed Rust files before freezing source provenance.

Replay the entire existing 1,362-case actual-source corpus in five fresh TZ processes, including producer/BSON and required 4096-depth observations, using [the parser protocol](ai-usage-receipt-parser-handoff.md#parent-verification-commands-not-run). Preserve all source cases, observations, expected wires and BSON expectations. Because the shared lossless module changes, include its existing compact-object ordering tests and the unchanged borrowed-view suite.

Rerun the parent's exact-release stage diagnostic and the existing six-pool benchmark with all 192 prepared wires, using [the benchmark protocol](ai-usage-receipt-parser-benchmark-handoff.md). Retain the original Node 42 trials, prepared inputs, expected wires, oracle and benchmark code. Any final native-source hash rebind belongs to the parent and requires an audit after formatting; it must not change those observations or weaken provenance checks. Compare each pool against the separately accepted lookup candidate and retain source/Rlib/report identities together.

The author reviewed the scoped source/test diff and ran `git diff --check` for these owned paths. The new handoff was also checked against `/dev/null` with `git diff --no-index --check`; a clean new-file difference returns status 1 with no whitespace diagnostics. These static checks do not establish compilation, parity or performance.

## Parent validation update — 2026-10-29

The wire change was committed locally as `9f1e4d47c5d2dbf7c31005e363dd22e686197127`; its source fingerprint is `9a01095527ddb6c9c1222b97454d74f8dc030f81c2843d37f28fb6fce9882f03`. The parent then validated the combined wire and scalar candidate: strict compiler checks, 1,362-case actual-source parity, five-time-zone producer/BSON replay and all 192 benchmark wire/checksum comparisons passed. At the wire-stage benchmark, Rust medians were ascii 8.9767, unicode 14.8817, coercion-duplicates 13.0848, rejected 1.6251, deep-ignored 14.1514 and deep-coerced 14.1977 µs/op. These are combined-candidate results at that stage, not isolated attribution to wire serialization. The subsequent broad-manifest benchmark phase failed only its guard due to a newly added comparison report; a corrected replay passed without rerunning timings. See the [performance note](receipt-parser-performance-2026-10-29.md).
