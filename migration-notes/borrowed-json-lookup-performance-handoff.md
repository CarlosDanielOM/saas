# Borrowed JSON key lookup performance handoff

Author-only change, 2026-10-29. The author read source and reviewed the scoped diff; no Cargo, rustfmt, Node, tests, benchmarks, application, container, network or production command was run. The parent owns formatting, immutable-source binding, isolated execution, performance interpretation and any eventual commit. No performance improvement, passing runtime check, migration-completion increment, caller adoption or deployment is claimed here.

The parent supplied baseline source fingerprint `8dbce36238ca2323d795782d1dc7032f66a372df9053a9e6a56d11df4d7f428a` and an exact-release-Rlib diagnostic in `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/receipt-parser-benchmark/lookup-diagnostic`. Its reported ASCII median was about 958 ns for validation/indexing, 57,442 ns for twenty lookups and 57,498 ns for full parse-to-DTO. These are parent-provided baseline observations, not measurements of this change. Source inspection confirmed that `get(&str)` constructed a target `JsString` and that every `get_key` pass decoded every key with `as_string`/`parse_json`.

## Reuse and bounded implementation

Only `dimabot/src/utils/lossless_json_view.rs`, `dimabot/tests/lossless_json_view.rs` and this new handoff are owned by this change. The receipt parser, ledger adapter, Cargo/features/modules, dependencies, date/coercion/DTO policies, benchmark harness, source loaders, oracles and goldens were not edited.

`get(&str)` now compares an unescaped object-key body directly with its borrowed UTF-8 target. The private `unescaped_key` helper removes the ASCII quote boundaries and checks for a backslash; it neither decodes nor allocates. This is safe only because `JsonDocument::parse` has already validated the complete input with the existing `serde_json::RawValue` path and the flat index identifies complete string tokens. Valid unescaped UTF-8 has the same equality relation as its well-formed UTF-16 encoding, including astral and combining characters; no normalization or replacement is applied.

Escaped names continue through the established `as_string`/`parse_json` decoder. `get_key` reuses `get` for a `JsString` with an `as_str` representation. A target with unpaired UTF-16 units cannot match any unescaped UTF-8 key, so that branch decodes only escaped names and compares the resulting `JsString` exactly. There is no new JSON decoder, DOM conversion, unsafe code, cache, global memory or reader dependency.

The original forward object traversal is shared through a private matcher. It still records every matching value and returns the final one; `Span::next` still skips the complete value subtree. Whole-input validation, indexing, scalar decoding, arrays/nonobjects, ordinary own properties including `__proto__`, and all coercion behavior retain their existing paths.

## Authored regressions and remaining risks

Five ordinary tests were added, with no fixture/environment requirement. They cover empty and prefix keys; missing and inherited-looking names; case, UTF-8 astral and composed/decomposed names; raw/escaped duplicate aliases in both orders; quotes, backslashes, slash, NUL, literal escape text and all 32 JSON control characters; lone high/low surrogates, reversed/repeated pairs, mixed paired/unpaired units and U+FFFD distinction; nested object/array traversal and nonobject lookup. Representable scalar lookups compare `get`, `get_key` and the existing owned reader against explicit expected values. Unpaired targets also compare with the owned reader's already decoded, duplicate-resolved fields. Existing validation, 4096-depth and coercion tests remain unchanged.

This removes allocation/decoding only for unescaped key comparisons and target conversion. Escaped-key decoding and linear scans per lookup remain. The Rust compiler, formatting, lint, parity replay and performance behavior have not been checked by this author. The parent must establish the effect independently; the baseline regressions in four pools are not resolved evidence until remeasurement.

## Proposed parent verification

Run these only inside the parent's existing pinned, offline, task-owned capped compiler with a read-only final source snapshot, writable private output/cache, the established CPU/memory/PID/no-swap limits, host headroom checks and production identity comparisons. These are suggested container-interior commands from the `dimabot` snapshot root, never host Cargo commands. Format the two changed Rust files before freezing provenance.

```sh
cargo fmt --all -- --check
cargo check --locked --no-default-features --features lossless-json-view --all-targets
cargo test --locked --no-default-features --features lossless-json-view --test lossless_json_view
cargo clippy --locked --no-default-features --features ai-usage-receipt-parser --all-targets -- -D warnings
cargo test --locked --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser
```

Replay all 1,362 existing actual-source cases in five fresh TZ processes using the existing source-parity protocol and exact final source binding, including the required 4096-depth observations. See [the parser handoff](ai-usage-receipt-parser-handoff.md#parent-verification-commands-not-run) for the oracle mounts/environment and ignored replay command. Retain all required source cases and existing wire/BSON expectations.

Rerun the parent's exact-release lookup diagnostic and all six prepared benchmark pools, including all 192 prepared wire comparisons, using the existing release benchmark test and protocol in [the benchmark handoff](ai-usage-receipt-parser-benchmark-handoff.md). Preserve the original Node 42 trials, prepared inputs, expected wires and benchmark/oracle code. Any necessary final native-source hash rebind belongs to the parent and must be audited after formatting; it must not alter those observations or weaken their checks. Compare each pool, including previously faster rejected/deep-coerced pools, and retain exact source/Rlib/report identities with the results.

The author ran `git diff --check -- dimabot/src/utils/lossless_json_view.rs dimabot/tests/lossless_json_view.rs migration-notes/borrowed-json-lookup-performance-handoff.md` and reviewed the scoped diff. The untracked handoff was also compared against `/dev/null` with `git diff --no-index --check`, producing no whitespace diagnostics (the new-file difference returns status 1). These static checks do not establish compilation, runtime correctness or speed.

## Parent validation update — 2026-10-29

The lookup change was committed locally as `dc417ce21a38ec91070ce310b8c230ad346dcc8e`; its source fingerprint is `d658d2f8014e87dd70c6f0041331939e4aaef04878a836eb4ed268a540aec29f`. The parent subsequently validated the combined lookup, borrowed-wire and borrowed-scalar candidate: strict compiler checks, 1,362-case actual-source parity, five-time-zone producer/BSON replay and all 192 benchmark wire/checksum comparisons passed. Across successive matched benchmark candidates, the six Rust medians were ascii 11.2499, unicode 16.3876, coercion-duplicates 14.0488, rejected 1.6298, deep-ignored 14.5885 and deep-coerced 17.2280 µs/op. These are combined-candidate measurements at the lookup stage, not isolated attribution to the lookup change. Final results and the interrupted benchmark-phase guard are recorded in the [performance note](receipt-parser-performance-2026-10-29.md).
